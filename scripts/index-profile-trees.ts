/**
 * Index Agent Profiles + Orchestrator trees into knowledge_scopes + shared_memories.
 *
 * Creates scope entries under 2/1/2 (agents topic) for each tree,
 * then writes each branch's content as a searchable shared_memory.
 *
 * Run: bun scripts/index-profile-trees.ts
 */

import { listBranches, getLatestCommit } from "../../ellie-forest/src/index.ts";
import sql from "../../ellie-forest/src/db.ts";

// ── Config ───────────────────────────────────────────────────

const AGENTS_TOPIC_ID = "dd73d681-33cc-40b1-9656-4dcb5f0c9f57"; // 2/1/2

const TREES = [
  {
    treeId:    "77ea2414-f992-4ba1-8eab-4609209318a1",
    scopePath: "2/1/2/1",
    scopeName: "agent-profiles",
    scopeDesc: "Composable agent profile layers — soul, creatures (DNA), roles (capabilities), agent wiring files, relationship sections",
    level:     "topic",
  },
  {
    treeId:    "d6596078-2714-49ca-8647-bfc9f599fcff",
    scopePath: "2/1/2/2",
    scopeName: "orchestrator",
    scopeDesc: "Orchestrator coordination tree — identity, agent registry, routing rules, coordination state",
    level:     "topic",
  },
];

// ── Helpers ──────────────────────────────────────────────────

async function upsertScope(tree: typeof TREES[0]): Promise<string> {
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM knowledge_scopes WHERE path = ${tree.scopePath}
  `;
  if (existing.length > 0) {
    console.log(`  Scope ${tree.scopePath} already exists (${existing[0].id.slice(0, 8)})`);
    return existing[0].id;
  }
  const [scope] = await sql<{ id: string }[]>`
    INSERT INTO knowledge_scopes (path, name, level, parent_id, tree_id, description)
    VALUES (
      ${tree.scopePath},
      ${tree.scopeName},
      ${tree.level},
      ${AGENTS_TOPIC_ID},
      ${tree.treeId},
      ${tree.scopeDesc}
    )
    RETURNING id
  `;
  console.log(`  Created scope ${tree.scopePath} → ${scope.id.slice(0, 8)}`);
  return scope.id;
}

async function indexBranches(treeConfig: typeof TREES[0]): Promise<void> {
  console.log(`\nIndexing tree ${treeConfig.treeId.slice(0, 8)} (${treeConfig.scopeName})...`);

  const scopeId = await upsertScope(treeConfig);
  const branches = await listBranches(treeConfig.treeId);
  console.log(`  ${branches.length} branches found`);

  let written = 0;
  let skipped = 0;

  for (const branch of branches) {
    const commit = await getLatestCommit(branch.id);
    if (!commit?.content_summary) {
      console.log(`  SKIP ${branch.name} — no commit content`);
      skipped++;
      continue;
    }

    // Check if already indexed (by branch_id)
    const existing = await sql<{ id: string }[]>`
      SELECT id FROM shared_memories
      WHERE source_tree_id = ${treeConfig.treeId}
        AND metadata->>'branch_path' = ${branch.name}
        AND archived_at IS NULL
      LIMIT 1
    `;
    if (existing.length > 0) {
      console.log(`  SKIP ${branch.name} — already indexed`);
      skipped++;
      continue;
    }

    // Determine memory type based on path
    const memType = branch.name.startsWith("soul") ? "fact"
      : branch.name.startsWith("routing/intent-rules") ? "fact"
      : branch.name.startsWith("agents/") || branch.name.startsWith("registry/agents/") ? "fact"
      : "fact";

    await sql`
      INSERT INTO shared_memories (
        content, type, scope, scope_path, scope_id, source_tree_id,
        confidence, metadata, weight
      ) VALUES (
        ${commit.content_summary},
        ${memType}::"memory_type",
        'forest'::"memory_scope",
        ${treeConfig.scopePath},
        ${scopeId},
        ${treeConfig.treeId},
        0.95,
        ${sql.json({ branch_path: branch.name, branch_id: branch.id, tree_name: treeConfig.scopeName })},
        0.5
      )
    `;
    console.log(`  + ${branch.name} (${commit.content_summary.length}c)`);
    written++;
  }

  console.log(`  Done: ${written} written, ${skipped} skipped`);
}

// ── Main ─────────────────────────────────────────────────────

for (const tree of TREES) {
  await indexBranches(tree);
}

console.log("\nAll trees indexed.");
process.exit(0);
