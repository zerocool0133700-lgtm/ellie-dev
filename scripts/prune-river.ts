#!/usr/bin/env bun
/**
 * River Document Pruner CLI — ELLIE-581
 *
 * Usage:
 *   bun run prune:river              # Prune expired documents
 *   bun run prune:river --dry-run    # Preview what would be pruned
 */

import { pruneRiver, DEFAULT_TTL_POLICY } from "../src/river-pruner.ts";

const dryRun = process.argv.includes("--dry-run");

console.log("River Document Pruner");
console.log("=====================");
console.log("");
console.log("TTL Policy:");
for (const [type, ttl] of Object.entries(DEFAULT_TTL_POLICY)) {
  console.log(`  ${type}: ${ttl === null ? "indefinite" : `${ttl} days`}`);
}
console.log("");

if (dryRun) {
  console.log("DRY RUN — no files will be moved\n");
}

const result = await pruneRiver({ dryRun });

console.log(`\nResults:`);
console.log(`  Scanned:  ${result.scanned}`);
console.log(`  Archived: ${result.archived}`);
console.log(`  Skipped:  ${result.skipped}`);
console.log(`  Errors:   ${result.errors}`);

if (result.archivedFiles.length > 0) {
  console.log(`\n${dryRun ? "Would archive" : "Archived"}:`);
  for (const f of result.archivedFiles) {
    console.log(`  → ${f}`);
  }
}

if (result.archived === 0) {
  console.log("\nNothing to prune — all documents are within TTL.");
}

process.exit(result.errors > 0 ? 1 : 0);
