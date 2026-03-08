/**
 * Backfill Forest shared_memories from Supabase memory table.
 *
 * Pulls all records from Supabase `memory` and inserts them into
 * Forest `shared_memories` with appropriate type mapping.
 *
 * Usage: bun run scripts/backfill-forest-memories.ts [--dry-run]
 */

import { createClient } from "@supabase/supabase-js";
import sql from "../../ellie-forest/src/db";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY!;
const DRY_RUN = process.argv.includes("--dry-run");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Map Supabase memory types to Forest memory_type enum
const TYPE_MAP: Record<string, string> = {
  fact: "fact",
  summary: "summary",
  goal: "fact",
  completed_goal: "fact",
  action_item: "finding",
  preference: "preference",
  decision: "decision",
};

async function main() {
  console.log(`Backfill Forest shared_memories from Supabase memory`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);

  // Get existing Forest memory content hashes to avoid duplicates
  const existing = await sql<{ content: string }[]>`
    SELECT content FROM shared_memories
    WHERE metadata->>'source' = 'supabase-backfill'
  `;
  const existingSet = new Set(existing.map((r) => r.content));
  console.log(`Existing backfilled memories: ${existingSet.size}`);

  // Fetch all Supabase memories in batches
  let offset = 0;
  const batchSize = 500;
  let total = 0;
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  while (true) {
    const { data, error } = await supabase
      .from("memory")
      .select("id, type, content, priority, created_at, metadata, source_agent, conversation_id")
      .order("created_at", { ascending: true })
      .range(offset, offset + batchSize - 1);

    if (error) {
      console.error("Supabase fetch error:", error.message);
      break;
    }
    if (!data || data.length === 0) break;

    total += data.length;

    for (const mem of data) {
      // Skip if already backfilled
      if (existingSet.has(mem.content)) {
        skipped++;
        continue;
      }

      const forestType = TYPE_MAP[mem.type] || "fact";
      const confidence = mem.type === "fact" ? 0.7
        : mem.type === "summary" ? 0.6
        : mem.type === "goal" || mem.type === "completed_goal" ? 0.5
        : 0.5;

      if (DRY_RUN) {
        inserted++;
        continue;
      }

      try {
        await sql`
          INSERT INTO shared_memories (
            content, type, scope, scope_path, confidence,
            tags, metadata, created_at, status
          ) VALUES (
            ${mem.content},
            ${forestType}::memory_type,
            'global'::memory_scope,
            '2',
            ${confidence},
            ${sql.array([
              "supabase-backfill",
              mem.type,
              ...(mem.source_agent ? [`agent:${mem.source_agent}`] : []),
            ])}::text[],
            ${JSON.stringify({
              source: "supabase-backfill",
              supabase_memory_id: mem.id,
              original_type: mem.type,
              ...(mem.conversation_id ? { conversation_id: mem.conversation_id } : {}),
              ...(mem.source_agent ? { source_agent: mem.source_agent } : {}),
            })}::jsonb,
            ${mem.created_at},
            'active'::memory_status
          )
        `;
        inserted++;
        existingSet.add(mem.content);
      } catch (err: unknown) {
        errors++;
        if (errors <= 5) {
          console.error(`  Error inserting memory ${mem.id}:`, (err as Error).message?.slice(0, 100));
        }
      }
    }

    console.log(`  Batch ${Math.floor(offset / batchSize) + 1}: ${data.length} fetched, ${inserted} inserted so far`);
    offset += batchSize;
  }

  console.log(`\nDone.`);
  console.log(`  Total in Supabase: ${total}`);
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Skipped (duplicate): ${skipped}`);
  console.log(`  Errors: ${errors}`);

  // Final count
  if (!DRY_RUN) {
    const [count] = await sql<{ total: number }[]>`SELECT count(*) as total FROM shared_memories`;
    console.log(`  Forest shared_memories total: ${count.total}`);
  }

  await sql.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
