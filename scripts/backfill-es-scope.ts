/**
 * One-time backfill: Add scope_path to all ellie-memory ES documents.
 * Reads scope_path from Forest shared_memories and updates ES.
 *
 * Usage: bun run scripts/backfill-es-scope.ts [--dry-run]
 */

import forestSql from "../../ellie-forest/src/db.ts";
import { indexMemory, classifyDomain } from "../src/elasticsearch.ts";

const dryRun = process.argv.includes("--dry-run");

async function backfill() {
  // Fetch all active memories with scope_path
  const memories = await forestSql`
    SELECT id, content, type, scope_path, created_at
    FROM shared_memories
    WHERE status = 'active'
      AND scope_path IS NOT NULL
    ORDER BY created_at DESC
  `;

  console.log(`Found ${memories.length} memories with scope_path to backfill`);

  if (dryRun) {
    // Show distribution
    const dist = new Map<string, number>();
    for (const m of memories) {
      const prefix = m.scope_path.split("/").slice(0, 2).join("/");
      dist.set(prefix, (dist.get(prefix) || 0) + 1);
    }
    console.log("Scope distribution:");
    for (const [scope, count] of [...dist.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${scope}: ${count}`);
    }
    return;
  }

  let updated = 0;
  let failed = 0;

  for (const mem of memories) {
    try {
      await indexMemory({
        id: mem.id,
        content: mem.content,
        type: mem.type,
        domain: classifyDomain(mem.content),
        created_at: mem.created_at,
        scope_path: mem.scope_path,
        metadata: { source: "shared_memories" },
      });
      updated++;
      if (updated % 100 === 0) {
        console.log(`  ... ${updated}/${memories.length} updated`);
      }
    } catch (err) {
      failed++;
      console.error(`  Failed: ${mem.id}`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`Backfill complete: ${updated} updated, ${failed} failed`);
  process.exit(0);
}

backfill().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
