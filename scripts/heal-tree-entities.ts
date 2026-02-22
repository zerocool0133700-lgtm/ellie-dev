#!/usr/bin/env bun
/**
 * Heal Forest Tree Entities — ELLIE-135
 *
 * Fixes misattributed tree_entities caused by the hardcoded "agent: dev"
 * in the work session start protocol. Uses Supabase agent_sessions
 * (which have the correct agent from the classifier) to re-attribute
 * forest trees to the right entity.
 *
 * Strategy:
 *   For each forest tree, find the Supabase agent_session that was
 *   active at the tree's creation time. If the session's agent differs
 *   from the tree's current entity, update tree_entities and creatures.
 *
 * Usage:
 *   bun scripts/heal-tree-entities.ts          # dry run (default)
 *   bun scripts/heal-tree-entities.ts --apply  # apply changes
 */

import { config } from "dotenv";
import { resolve } from "path";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

config({ path: resolve(import.meta.dir, "../.env") });

const DRY_RUN = !process.argv.includes("--apply");

const forestDb = postgres({
  host: "/var/run/postgresql",
  database: "ellie-forest",
  username: "ellie",
});

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
);

// Entity name lookup cache
const entityIdCache = new Map<string, string>();

async function getEntityId(name: string): Promise<string | null> {
  if (entityIdCache.has(name)) return entityIdCache.get(name)!;
  const [row] = await forestDb`SELECT id FROM entities WHERE name = ${name} LIMIT 1`;
  if (row) {
    entityIdCache.set(name, row.id);
    return row.id;
  }
  return null;
}

// Map Supabase agent short names to forest entity names
const AGENT_ENTITY_MAP: Record<string, string> = {
  dev: "dev_agent",
  research: "research_agent",
  critic: "critic_agent",
  content: "content_agent",
  finance: "finance_agent",
  strategy: "strategy_agent",
  general: "general_agent",
  router: "agent_router",
};

async function main() {
  console.log(`\n  Forest Tree Entity Healer${DRY_RUN ? " (DRY RUN)" : " (APPLYING CHANGES)"}\n`);

  // 1. Get all forest trees with their current entity assignment
  const trees = await forestDb`
    SELECT t.id, t.work_item_id, t.title, t.state, t.created_at,
           te.entity_id as current_entity_id,
           e.name as current_entity_name
    FROM trees t
    LEFT JOIN tree_entities te ON te.tree_id = t.id
    LEFT JOIN entities e ON e.id = te.entity_id
    ORDER BY t.created_at DESC
  `;

  console.log(`  Found ${trees.length} trees\n`);

  // 2. Get all agent sessions from Supabase (with agent names)
  const { data: sessions, error } = await supabase
    .from("agent_sessions")
    .select("id, created_at, last_activity, state, channel, agents(name)")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("  Failed to fetch agent_sessions:", error);
    process.exit(1);
  }

  console.log(`  Found ${sessions?.length || 0} agent sessions\n`);

  // 3. For each tree, find the best matching agent session
  let healedCount = 0;
  let skippedCount = 0;
  let noMatchCount = 0;

  for (const tree of trees) {
    const treeCreated = new Date(tree.created_at).getTime();

    // Find agent session that was active when this tree was created
    // (created_at <= tree.created_at AND last_activity >= tree.created_at)
    const match = sessions?.find((s) => {
      const sCreated = new Date(s.created_at).getTime();
      const sLastActivity = new Date(s.last_activity).getTime();
      // Session was active at tree creation time (with 5 minute buffer)
      return sCreated <= treeCreated + 300_000 && sLastActivity >= treeCreated - 300_000;
    });

    if (!match) {
      noMatchCount++;
      continue;
    }

    const sessionAgent = (match as any).agents?.name;
    if (!sessionAgent) {
      noMatchCount++;
      continue;
    }

    const correctEntityName = AGENT_ENTITY_MAP[sessionAgent] || sessionAgent;

    // Already correct?
    if (tree.current_entity_name === correctEntityName) {
      skippedCount++;
      continue;
    }

    const correctEntityId = await getEntityId(correctEntityName);
    if (!correctEntityId) {
      console.log(`  SKIP ${tree.work_item_id}: entity "${correctEntityName}" not found in forest`);
      skippedCount++;
      continue;
    }

    console.log(
      `  ${DRY_RUN ? "WOULD HEAL" : "HEALING"} ${tree.work_item_id} (${tree.state}): ` +
      `${tree.current_entity_name || "none"} → ${correctEntityName}`
    );

    if (!DRY_RUN) {
      // Update tree_entities
      if (tree.current_entity_id) {
        await forestDb`
          UPDATE tree_entities
          SET entity_id = ${correctEntityId}
          WHERE tree_id = ${tree.id} AND entity_id = ${tree.current_entity_id}
        `;
      } else {
        await forestDb`
          INSERT INTO tree_entities (tree_id, entity_id, role)
          VALUES (${tree.id}, ${correctEntityId}, 'contributor')
          ON CONFLICT (tree_id, entity_id) DO NOTHING
        `;
      }

      // Update creatures on this tree
      await forestDb`
        UPDATE creatures
        SET entity_id = ${correctEntityId}
        WHERE tree_id = ${tree.id}
          AND entity_id = ${tree.current_entity_id}
      `;
    }

    healedCount++;
  }

  console.log(`\n  Results:`);
  console.log(`    ${DRY_RUN ? "Would heal" : "Healed"}: ${healedCount}`);
  console.log(`    Already correct: ${skippedCount}`);
  console.log(`    No session match: ${noMatchCount}`);
  console.log(`    Total trees: ${trees.length}`);

  if (DRY_RUN && healedCount > 0) {
    console.log(`\n  Run with --apply to make changes.\n`);
  } else if (!DRY_RUN && healedCount > 0) {
    console.log(`\n  Done. Check entity_workload view for updated distribution.\n`);
  } else {
    console.log(`\n  No changes needed.\n`);
  }

  await forestDb.end();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
