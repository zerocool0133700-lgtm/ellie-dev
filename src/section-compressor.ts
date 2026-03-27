/**
 * Section Compression Engine — ELLIE-1055
 * Compresses low-priority prompt sections instead of suppressing them.
 * Uses Claude Haiku for fast, cheap summarization.
 * Integrates with compression cache (ELLIE-1062) and shadow store (ELLIE-1056).
 *
 * Priority tiers:
 *   1-5: Include (full content)
 *   6-8: Compress (summarize via Haiku)
 *   9:   Suppress (remove entirely)
 */

import { log } from "./logger.ts";
import { estimateTokens } from "./relay-utils.ts";
import { CompressionCache, compressionCache } from "./compression-cache.ts";
import { shadowStore } from "./shadow-context-store.ts";

const logger = log.child("compression:engine");

const COMPRESS_MIN_PRIORITY = 6;
const COMPRESS_MAX_PRIORITY = 8;
const SUPPRESS_PRIORITY = 9;

// Don't compress sections smaller than this (not worth the API call)
const MIN_TOKENS_TO_COMPRESS = 100;

// Default compression target: keep 30% of original
const DEFAULT_TARGET_RATIO = 0.3;

// Claude CLI path for Haiku calls
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

export interface CompressionResult {
  label: string;
  action: "include" | "compress" | "suppress";
  originalTokens: number;
  resultTokens: number;
  shadowId?: string; // Set if compressed — enables expansion
}

export interface CompressedSection {
  label: string;
  content: string;
  priority: number;
  originalTokens: number;
  compressed: boolean;
  shadowId?: string;
}

/**
 * Compress a single section's content using Haiku.
 * Returns compressed text, or original if compression fails.
 */
async function compressWithHaiku(
  label: string,
  content: string,
  targetTokens: number
): Promise<string> {
  const { spawn } = await import("bun");

  const prompt = `Summarize this context section in under ${targetTokens} tokens. Keep key facts, decisions, and actionable information. Remove verbose explanations and examples. Return ONLY the summary, no preamble.

SECTION (${label}):
${content}`;

  const args = [
    CLAUDE_PATH,
    "-p",
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
      env: {
        ...process.env,
        CLAUDECODE: "",
        ANTHROPIC_API_KEY: "",
      },
    });

    const timeoutMs = 15_000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    const output = await new Response(proc.stdout).text();
    clearTimeout(timer);
    const exitCode = await proc.exited;

    if (exitCode !== 0 || timedOut) {
      logger.warn("Haiku compression failed, keeping original", { label, timedOut, exitCode });
      return content; // Graceful fallback
    }

    return output.trim();
  } catch (err) {
    logger.warn("Haiku compression error, keeping original", { label, error: String(err) });
    return content; // Graceful fallback
  }
}

/**
 * Process a prompt section through the compression engine.
 * Returns the (potentially compressed) section with metadata.
 */
export async function compressSection(
  label: string,
  content: string,
  priority: number,
  targetRatio: number = DEFAULT_TARGET_RATIO
): Promise<CompressedSection> {
  const originalTokens = estimateTokens(content);

  // Priority 9: suppress entirely
  if (priority >= SUPPRESS_PRIORITY) {
    return {
      label,
      content: "",
      priority,
      originalTokens,
      compressed: false,
    };
  }

  // Priority 1-5: include as-is
  if (priority < COMPRESS_MIN_PRIORITY) {
    return {
      label,
      content,
      priority,
      originalTokens,
      compressed: false,
    };
  }

  // Priority 6-8: compress
  // Skip if too small to bother
  if (originalTokens < MIN_TOKENS_TO_COMPRESS) {
    return {
      label,
      content,
      priority,
      originalTokens,
      compressed: false,
    };
  }

  // Check cache first (skip for time-sensitive sections)
  if (!compressionCache.shouldBypass(label)) {
    const cacheKey = CompressionCache.cacheKey(content, targetRatio);
    const cached = compressionCache.get(cacheKey);
    if (cached) {
      // Store in shadow for expansion even on cache hit
      const shadowId = shadowStore.store({
        label,
        original: content,
        compressed: cached.compressed,
        originalTokens,
        compressedTokens: cached.compressedTokens,
      });

      return {
        label,
        content: `${cached.compressed}\n[compressed — expand: ${shadowId}]`,
        priority,
        originalTokens,
        compressed: true,
        shadowId,
      };
    }
  }

  // Compress via Haiku
  const targetTokens = Math.max(50, Math.floor(originalTokens * targetRatio));
  const compressed = await compressWithHaiku(label, content, targetTokens);
  const compressedTokens = estimateTokens(compressed);

  // Only use compression if it actually saved tokens
  if (compressedTokens >= originalTokens * 0.9) {
    logger.debug("Compression not effective, keeping original", { label, originalTokens, compressedTokens });
    return {
      label,
      content,
      priority,
      originalTokens,
      compressed: false,
    };
  }

  // Cache the result
  if (!compressionCache.shouldBypass(label)) {
    const cacheKey = CompressionCache.cacheKey(content, targetRatio);
    compressionCache.set(cacheKey, {
      compressed,
      originalTokens,
      compressedTokens,
      ratio: 1 - (compressedTokens / originalTokens),
      cachedAt: Date.now(),
    });
  }

  // Store in shadow for expansion
  const shadowId = shadowStore.store({
    label,
    original: content,
    compressed,
    originalTokens,
    compressedTokens,
  });

  logger.info("Section compressed", {
    label,
    originalTokens,
    compressedTokens,
    ratio: Math.round((1 - compressedTokens / originalTokens) * 100) + "%",
    shadowId,
  });

  return {
    label,
    content: `${compressed}\n[compressed — expand: ${shadowId}]`,
    priority,
    originalTokens,
    compressed: true,
    shadowId,
  };
}

/**
 * Process multiple sections through the compression engine.
 * Only compresses when total tokens exceed budget.
 */
export async function compressSections(
  sections: Array<{ label: string; content: string; priority: number }>,
  budget: number,
  targetRatio: number = DEFAULT_TARGET_RATIO
): Promise<{ sections: CompressedSection[]; metrics: CompressionMetrics }> {
  // First pass: estimate total tokens
  const withTokens = sections.map(s => ({
    ...s,
    tokens: estimateTokens(s.content),
  }));
  const totalTokens = withTokens.reduce((sum, s) => sum + s.tokens, 0);

  // Under budget — no compression needed
  if (totalTokens <= budget) {
    return {
      sections: withTokens.map(s => ({
        label: s.label,
        content: s.content,
        priority: s.priority,
        originalTokens: s.tokens,
        compressed: false,
      })),
      metrics: {
        totalOriginalTokens: totalTokens,
        totalCompressedTokens: totalTokens,
        sectionsCompressed: 0,
        sectionsSuppressed: 0,
        tokensSaved: 0,
      },
    };
  }

  // Over budget — compress priority 6-8 sections, suppress priority 9
  const results: CompressedSection[] = [];
  let sectionsCompressed = 0;
  let sectionsSuppressed = 0;
  let tokensSaved = 0;

  // Sort by priority descending — compress highest priority number first
  const sorted = [...withTokens].sort((a, b) => b.priority - a.priority);
  let currentTokens = totalTokens;

  for (const section of sorted) {
    // Already under budget — include remaining as-is
    if (currentTokens <= budget && section.priority < COMPRESS_MIN_PRIORITY) {
      results.push({
        label: section.label,
        content: section.content,
        priority: section.priority,
        originalTokens: section.tokens,
        compressed: false,
      });
      continue;
    }

    const compressed = await compressSection(section.label, section.content, section.priority, targetRatio);
    results.push(compressed);

    if (compressed.compressed) {
      const saved = section.tokens - estimateTokens(compressed.content);
      currentTokens -= saved;
      tokensSaved += saved;
      sectionsCompressed++;
    } else if (section.priority >= SUPPRESS_PRIORITY) {
      currentTokens -= section.tokens;
      tokensSaved += section.tokens;
      sectionsSuppressed++;
    }
  }

  // Re-sort by original order (priority ascending for prompt assembly)
  results.sort((a, b) => a.priority - b.priority);

  return {
    sections: results,
    metrics: {
      totalOriginalTokens: totalTokens,
      totalCompressedTokens: totalTokens - tokensSaved,
      sectionsCompressed,
      sectionsSuppressed,
      tokensSaved,
    },
  };
}

export interface CompressionMetrics {
  totalOriginalTokens: number;
  totalCompressedTokens: number;
  sectionsCompressed: number;
  sectionsSuppressed: number;
  tokensSaved: number;
}

// Export for testing
export { COMPRESS_MIN_PRIORITY, COMPRESS_MAX_PRIORITY, SUPPRESS_PRIORITY, MIN_TOKENS_TO_COMPRESS };
