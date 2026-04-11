/**
 * Coverage Preload — imports all src/ files so Bun instruments them
 *
 * Problem: Bun's lcov reporter only covers files that were actually loaded
 * during the test run. Since most tests mock their dependencies, the real
 * source files never get imported and don't appear in coverage.
 *
 * Solution: This preload file eagerly imports every .ts file under src/
 * before tests run. Each import is wrapped in try/catch so modules with
 * side effects (DB connections, env var reads, server startup) don't crash
 * the test runner — they just fail silently and still get instrumented.
 *
 * Usage: passed via --preload flag in the coverage script (scripts/coverage.ts)
 *        NOT included in bunfig.toml (would slow down normal test runs)
 */

import { Glob } from "bun";
import { join } from "path";

const ROOT = join(import.meta.dir, "../..");
const glob = new Glob("src/**/*.ts");
const files = [...glob.scanSync({ cwd: ROOT })].sort();

// Files to skip — entry points that start servers or have heavy side effects
const SKIP_PATTERNS = [
  "src/relay.ts",           // Main entry point — starts Telegram bot + HTTP server
  "src/sync-es.ts",         // CLI script — runs Elasticsearch sync
  "src/summary-cli.ts",     // CLI script
  "src/consolidate-memory.ts", // CLI script
  "src/backfill-conversations.ts", // CLI script
  "src/summarize-backfill.ts",     // CLI script
];

function shouldSkip(file: string): boolean {
  return SKIP_PATTERNS.some(p => file === p || file.endsWith(`/${p}`));
}

let loaded = 0;
let skipped = 0;
let failed = 0;

for (const file of files) {
  if (shouldSkip(file)) {
    skipped++;
    continue;
  }

  try {
    await import(join(ROOT, file));
    loaded++;
  } catch {
    // Module failed to initialize (missing env vars, DB connections, etc.)
    // That's fine — Bun still instruments the file for coverage
    failed++;
  }
}

console.log(
  `[coverage-preload] ${loaded} loaded, ${failed} failed (still instrumented), ${skipped} skipped — ${files.length} total source files`
);
