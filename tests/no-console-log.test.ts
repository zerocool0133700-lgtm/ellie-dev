/**
 * Tests for ELLIE-562: Standardize logging — no console.log in src/
 *
 * Verifies that all logging goes through the structured logger (src/logger.ts)
 * instead of raw console.log/warn/error calls.
 *
 * Allowed exceptions:
 *   - src/logger.ts itself (it's the implementation that writes to console)
 *
 * This test reads the actual source files and scans for console.* usage,
 * acting as a lint guard that catches regressions.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SRC_DIR = join(import.meta.dir, "..", "src");

/** Recursively collect all .ts files under a directory. */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Files that are allowed to use console.* directly.
 * logger.ts is the structured logger implementation — it writes to console internally.
 */
const ALLOWED_FILES = new Set(["logger.ts"]);

/** Match console.log, console.warn, console.error (but not in comments). */
const CONSOLE_PATTERN = /^\s*(?!\/\/|\/?\*)\S*.*\bconsole\.(log|warn|error)\b/;

interface Violation {
  file: string;
  line: number;
  text: string;
}

function findConsoleViolations(): Violation[] {
  const violations: Violation[] = [];
  const files = collectTsFiles(SRC_DIR);

  for (const filePath of files) {
    const rel = relative(SRC_DIR, filePath);
    const basename = rel.split("/").pop()!;

    if (ALLOWED_FILES.has(basename)) continue;

    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (CONSOLE_PATTERN.test(line)) {
        violations.push({
          file: rel,
          line: i + 1,
          text: line.trim(),
        });
      }
    }
  }

  return violations;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ELLIE-562 — no console.log in src/", () => {
  it("has zero console.log/warn/error calls outside logger.ts", () => {
    const violations = findConsoleViolations();

    if (violations.length > 0) {
      const report = violations
        .map((v) => `  ${v.file}:${v.line} → ${v.text}`)
        .join("\n");
      throw new Error(
        `Found ${violations.length} console.log/warn/error call(s) in src/ that should use the structured logger:\n${report}`
      );
    }

    expect(violations).toHaveLength(0);
  });

  it("logger.ts is allowed to use console.*", () => {
    const loggerPath = join(SRC_DIR, "logger.ts");
    const content = readFileSync(loggerPath, "utf-8");
    // logger.ts should have console calls — it's the implementation
    expect(content).toContain("console.log");
    expect(content).toContain("console.warn");
    expect(content).toContain("console.error");
  });

  it("all src/ .ts files (except logger.ts) import from logger.ts", () => {
    const files = collectTsFiles(SRC_DIR);
    const missingLogger: string[] = [];

    for (const filePath of files) {
      const rel = relative(SRC_DIR, filePath);
      const basename = rel.split("/").pop()!;

      // Skip files that are type-only, config, or the logger itself
      if (
        ALLOWED_FILES.has(basename) ||
        basename.endsWith(".d.ts") ||
        basename === "trace.ts"
      ) {
        continue;
      }

      const content = readFileSync(filePath, "utf-8");

      // Only flag files that have executable code (not just type exports)
      const hasExecutableCode =
        content.includes("export function") ||
        content.includes("export async function") ||
        content.includes("export const") ||
        content.includes("export default");

      if (!hasExecutableCode) continue;

      // Check for logger import
      const hasLoggerImport =
        content.includes('from "./logger') ||
        content.includes('from "../logger') ||
        content.includes('from "../../logger') ||
        content.includes("from './logger") ||
        content.includes("from '../logger");

      if (!hasLoggerImport) {
        missingLogger.push(rel);
      }
    }

    // This is informational — not all files need logging.
    // But files with console calls that don't import logger are a problem.
    for (const file of missingLogger) {
      const content = readFileSync(join(SRC_DIR, file), "utf-8");
      const hasConsole = /\bconsole\.(log|warn|error)\b/.test(content);
      if (hasConsole) {
        throw new Error(
          `${file} uses console.* but does not import from logger.ts`
        );
      }
    }
  });
});
