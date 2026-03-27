/**
 * Tool Output Compressor — ELLIE-1057
 * Compresses large CLI/tool results before context injection.
 * Keeps errors, findings, decisions. Drops verbose logs and repeated patterns.
 * Stores originals in shadow store for on-demand expansion.
 * Inspired by Context-Gateway internal/pipes/tool_output/
 */

import { log } from "./logger.ts";
import { estimateTokens } from "./relay-utils.ts";
import { shadowStore } from "./shadow-context-store.ts";
import { CompressionCache, compressionCache } from "./compression-cache.ts";

const logger = log.child("compression:tool-output");

const MIN_TOKENS_THRESHOLD = 512;
const MAX_TOKENS_THRESHOLD = 50_000;
const TARGET_RATIO = 0.25; // Keep ~25% of tool output

// Metrics
let totalCompressed = 0;
let totalPassthrough = 0;
let totalTokensSaved = 0;

/**
 * Check if tool output should be compressed.
 */
function shouldCompress(output: string): boolean {
  const tokens = estimateTokens(output);
  return tokens >= MIN_TOKENS_THRESHOLD && tokens <= MAX_TOKENS_THRESHOLD;
}

/**
 * Try TOON encoding for structured JSON arrays (40-60% savings without LLM call).
 * Returns compressed string or null if not applicable.
 */
function tryToonEncoding(output: string): string | null {
  try {
    const parsed = JSON.parse(output.trim());
    if (!Array.isArray(parsed) || parsed.length < 3) return null;

    // Check if all items have same keys
    const keys = Object.keys(parsed[0]);
    const allSameKeys = parsed.every((item: any) => {
      const itemKeys = Object.keys(item);
      return itemKeys.length === keys.length && keys.every(k => itemKeys.includes(k));
    });
    if (!allSameKeys) return null;

    // Build table format
    const header = keys.join(" | ");
    const rows = parsed.map((item: any) =>
      keys.map(k => String(item[k] ?? "").slice(0, 80)).join(" | ")
    );
    return `[${parsed.length} items]\n${header}\n${rows.join("\n")}`;
  } catch {
    return null;
  }
}

/**
 * Compress tool output using Haiku.
 */
async function compressWithHaiku(toolName: string, output: string, targetTokens: number): Promise<string> {
  const { spawn } = await import("bun");
  const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

  const prompt = `Compress this ${toolName} tool output to under ${targetTokens} tokens.

RULES:
- Keep ALL errors, warnings, and failure messages verbatim
- Keep key findings, results, and actionable information
- Remove verbose logs, repeated patterns, and boilerplate
- Keep file paths and line numbers for errors
- For test output: keep pass/fail counts and failing test names
- For grep/search: keep matching lines, drop context lines
- Return ONLY the compressed output, no preamble

TOOL OUTPUT:
${output}`;

  const args = [
    CLAUDE_PATH, "-p",
    "--output-format", "text",
    "--no-session-persistence",
    "--allowedTools", "",
    "--model", "haiku",
  ];

  try {
    const proc = spawn(args, {
      stdin: new Blob([prompt]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDECODE: "", ANTHROPIC_API_KEY: "" },
    });

    const timer = setTimeout(() => proc.kill(), 15_000);
    const result = await new Response(proc.stdout).text();
    clearTimeout(timer);
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      logger.warn("Haiku tool compression failed", { toolName, exitCode });
      return output;
    }
    return result.trim();
  } catch (err) {
    logger.warn("Haiku tool compression error", { toolName, error: String(err) });
    return output;
  }
}

export interface ToolCompressionResult {
  output: string;
  compressed: boolean;
  originalTokens: number;
  resultTokens: number;
  shadowId?: string;
  method: "passthrough" | "toon" | "haiku";
}

/**
 * Compress a tool result if it exceeds the threshold.
 */
export async function compressToolOutput(
  toolName: string,
  output: string
): Promise<ToolCompressionResult> {
  const originalTokens = estimateTokens(output);

  if (!shouldCompress(output)) {
    totalPassthrough++;
    return {
      output,
      compressed: false,
      originalTokens,
      resultTokens: originalTokens,
      method: "passthrough",
    };
  }

  // Check cache
  const cacheKey = CompressionCache.cacheKey(output, TARGET_RATIO);
  const cached = compressionCache.get(cacheKey);
  if (cached) {
    const shadowId = shadowStore.store({
      label: `tool:${toolName}`,
      original: output,
      compressed: cached.compressed,
      originalTokens,
      compressedTokens: cached.compressedTokens,
    });
    totalCompressed++;
    totalTokensSaved += originalTokens - cached.compressedTokens;
    return {
      output: `${cached.compressed}\n[tool output compressed — expand: ${shadowId}]`,
      compressed: true,
      originalTokens,
      resultTokens: cached.compressedTokens,
      shadowId,
      method: "haiku",
    };
  }

  // Try TOON encoding first (fast, no API call)
  const toon = tryToonEncoding(output);
  if (toon) {
    const toonTokens = estimateTokens(toon);
    if (toonTokens < originalTokens * 0.7) {
      const shadowId = shadowStore.store({
        label: `tool:${toolName}`,
        original: output,
        compressed: toon,
        originalTokens,
        compressedTokens: toonTokens,
      });
      totalCompressed++;
      totalTokensSaved += originalTokens - toonTokens;
      logger.info("TOON encoded tool output", { toolName, originalTokens, toonTokens });
      return {
        output: `${toon}\n[tool output compressed — expand: ${shadowId}]`,
        compressed: true,
        originalTokens,
        resultTokens: toonTokens,
        shadowId,
        method: "toon",
      };
    }
  }

  // Haiku compression
  const targetTokens = Math.max(100, Math.floor(originalTokens * TARGET_RATIO));
  const compressed = await compressWithHaiku(toolName, output, targetTokens);
  const compressedTokens = estimateTokens(compressed);

  // Only use if it saved meaningful tokens
  if (compressedTokens >= originalTokens * 0.9) {
    totalPassthrough++;
    return {
      output,
      compressed: false,
      originalTokens,
      resultTokens: originalTokens,
      method: "passthrough",
    };
  }

  // Cache and shadow store
  compressionCache.set(cacheKey, {
    compressed,
    originalTokens,
    compressedTokens,
    ratio: 1 - (compressedTokens / originalTokens),
    cachedAt: Date.now(),
  });

  const shadowId = shadowStore.store({
    label: `tool:${toolName}`,
    original: output,
    compressed,
    originalTokens,
    compressedTokens,
  });

  totalCompressed++;
  totalTokensSaved += originalTokens - compressedTokens;

  logger.info("Compressed tool output", {
    toolName, originalTokens, compressedTokens,
    ratio: Math.round((1 - compressedTokens / originalTokens) * 100) + "%",
  });

  return {
    output: `${compressed}\n[tool output compressed — expand: ${shadowId}]`,
    compressed: true,
    originalTokens,
    resultTokens: compressedTokens,
    shadowId,
    method: "haiku",
  };
}

/** Get compression metrics */
export function getToolCompressionMetrics() {
  return {
    totalCompressed,
    totalPassthrough,
    totalTokensSaved,
    cacheStats: compressionCache.stats(),
    shadowStats: shadowStore.stats(),
  };
}

// Export for testing
export { MIN_TOKENS_THRESHOLD, MAX_TOKENS_THRESHOLD, TARGET_RATIO, shouldCompress, tryToonEncoding };
