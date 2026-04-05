/**
 * One-time reclassification of shared_memories using the new scope router.
 * Only reclassifies memories at scope_path='2' (the generic bucket).
 * Memories with explicit scope assignments are left alone.
 *
 * Usage: bun run scripts/reclassify-memories.ts [--dry-run]
 */

import "dotenv/config"
import sql from "../../ellie-forest/src/db"
import { routeToScope } from "../../ellie-forest/src/scope-router"

const dryRun = process.argv.includes("--dry-run")

async function main() {
  const memories = await sql<{
    id: string; content: string; type: string; category: string;
    source_tree_id: string | null; source_entity_id: string | null;
    source_creature_id: string | null; metadata: Record<string, unknown>;
  }[]>`
    SELECT id, content, type, category, source_tree_id, source_entity_id,
           source_creature_id, metadata
    FROM shared_memories
    WHERE status = 'active' AND scope_path = '2'
    ORDER BY created_at DESC
  `

  console.log(`Found ${memories.length} memories at scope '2' to reclassify`)
  if (dryRun) console.log("(DRY RUN — no changes will be made)")

  const moves: Record<string, number> = {}
  let unchanged = 0

  for (const m of memories) {
    const newScope = await routeToScope({
      source_tree_id: m.source_tree_id,
      source_entity_id: m.source_entity_id,
      source_creature_id: m.source_creature_id,
      content: m.content,
      category: m.category,
      type: m.type,
      metadata: m.metadata,
    })

    if (newScope === '2') {
      unchanged++
      continue
    }

    moves[newScope] = (moves[newScope] || 0) + 1

    if (!dryRun) {
      await sql`UPDATE shared_memories SET scope_path = ${newScope} WHERE id = ${m.id}`
    }
  }

  console.log("\nReclassification results:")
  const sorted = Object.entries(moves).sort((a, b) => b[1] - a[1])
  for (const [scope, count] of sorted) {
    console.log(`  ${scope}: ${count} memories`)
  }
  console.log(`  2 (unchanged): ${unchanged}`)
  console.log(`\nTotal moved: ${memories.length - unchanged}`)

  await sql.end()
}

main().catch(console.error)
