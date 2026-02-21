/**
 * ES Forest — Backfill Script (ELLIE-112)
 *
 * Reads all forest data from Postgres and bulk-indexes it to
 * Elasticsearch. Idempotent — safe to run multiple times.
 *
 * Usage:
 *   bun run scripts/es-backfill-forest.ts                    # backfill all
 *   bun run scripts/es-backfill-forest.ts --index events     # backfill one index
 *   bun run scripts/es-backfill-forest.ts --since 2026-02-01 # incremental
 *   bun run scripts/es-backfill-forest.ts --dry-run          # show counts only
 *   bun run scripts/es-backfill-forest.ts --batch-size 500   # custom batch size
 */

import "dotenv/config";
import postgres from "postgres";
import { bulkIndexForest } from "../src/elasticsearch/index-forest.ts";

const ES_URL = process.env.ELASTICSEARCH_URL || "";

if (!ES_URL) { console.error("ELASTICSEARCH_URL not set"); process.exit(1); }

// Build connection config matching ellie-forest/src/db.ts defaults
const pgConfig = process.env.DATABASE_URL
  ? process.env.DATABASE_URL
  : {
      host: process.env.DB_HOST || "/var/run/postgresql",
      database: process.env.DB_NAME || "ellie-forest",
      username: process.env.DB_USER || "ellie",
      password: process.env.DB_PASS,
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
    };

// Parse CLI args
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const indexArg = args.includes("--index") ? args[args.indexOf("--index") + 1] : null;
const sinceArg = args.includes("--since") ? args[args.indexOf("--since") + 1] : null;
const batchSize = args.includes("--batch-size")
  ? parseInt(args[args.indexOf("--batch-size") + 1]) || 200
  : 200;

const sql = postgres(pgConfig as any, { max: 3, connect_timeout: 10 });

const sinceFilter = sinceArg ? new Date(sinceArg).toISOString() : null;

// ============================================================
// BACKFILL FUNCTIONS
// ============================================================

async function backfillEvents(): Promise<{ total: number; indexed: number; errors: number }> {
  const where = sinceFilter ? sql`WHERE fe.created_at >= ${sinceFilter}` : sql``;
  const rows = await sql`
    SELECT
      fe.id, fe.kind, fe.tree_id, fe.entity_id, fe.branch_id,
      fe.trunk_id, fe.creature_id, fe.commit_id, fe.summary,
      fe.data, fe.created_at,
      t.title AS tree_title, t.type AS tree_type,
      e.name AS entity_name
    FROM forest_events fe
    LEFT JOIN trees t ON t.id = fe.tree_id
    LEFT JOIN entities e ON e.id = fe.entity_id
    ${where}
    ORDER BY fe.created_at ASC
  `;

  if (dryRun) return { total: rows.length, indexed: 0, errors: 0 };

  let totalIndexed = 0, totalErrors = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const ops = batch.map((r: any) => ({
      index: "ellie-forest-events",
      id: r.id,
      doc: {
        event_id: r.id, kind: r.kind, tree_id: r.tree_id,
        entity_id: r.entity_id, branch_id: r.branch_id,
        trunk_id: r.trunk_id, creature_id: r.creature_id,
        commit_id: r.commit_id, summary: r.summary,
        data: r.data, tree_title: r.tree_title,
        tree_type: r.tree_type, entity_name: r.entity_name,
        created_at: r.created_at,
      },
    }));
    const { indexed, errors } = await bulkIndexForest(ops);
    totalIndexed += indexed;
    totalErrors += errors;
    process.stdout.write(`\r  events: ${totalIndexed}/${rows.length} indexed, ${totalErrors} errors`);
  }
  console.log();
  return { total: rows.length, indexed: totalIndexed, errors: totalErrors };
}

async function backfillCommits(): Promise<{ total: number; indexed: number; errors: number }> {
  const where = sinceFilter ? sql`WHERE c.created_at >= ${sinceFilter}` : sql``;
  const rows = await sql`
    SELECT
      c.id, c.tree_id, c.branch_id, c.trunk_id, c.entity_id,
      c.git_sha, c.message, c.content_summary, c.created_at,
      t.title AS tree_title, t.type AS tree_type,
      e.name AS entity_name
    FROM commits c
    LEFT JOIN trees t ON t.id = c.tree_id
    LEFT JOIN entities e ON e.id = c.entity_id
    ${where}
    ORDER BY c.created_at ASC
  `;

  if (dryRun) return { total: rows.length, indexed: 0, errors: 0 };

  let totalIndexed = 0, totalErrors = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const ops = batch.map((r: any) => ({
      index: "ellie-forest-commits",
      id: r.id,
      doc: {
        commit_id: r.id, tree_id: r.tree_id, branch_id: r.branch_id,
        trunk_id: r.trunk_id, entity_id: r.entity_id,
        git_sha: r.git_sha, message: r.message,
        content_summary: r.content_summary,
        tree_title: r.tree_title, tree_type: r.tree_type,
        entity_name: r.entity_name, created_at: r.created_at,
      },
    }));
    const { indexed, errors } = await bulkIndexForest(ops);
    totalIndexed += indexed;
    totalErrors += errors;
    process.stdout.write(`\r  commits: ${totalIndexed}/${rows.length} indexed, ${totalErrors} errors`);
  }
  console.log();
  return { total: rows.length, indexed: totalIndexed, errors: totalErrors };
}

async function backfillCreatures(): Promise<{ total: number; indexed: number; errors: number }> {
  const where = sinceFilter ? sql`WHERE cr.created_at >= ${sinceFilter}` : sql``;
  const rows = await sql`
    SELECT
      cr.id, cr.type, cr.tree_id, cr.entity_id, cr.branch_id,
      cr.parent_creature_id, cr.intent, cr.state,
      cr.instructions, cr.result, cr.error, cr.trigger_event,
      cr.timeout_seconds, cr.retry_count,
      cr.dispatched_at, cr.started_at, cr.completed_at, cr.created_at,
      t.title AS tree_title, t.type AS tree_type,
      e.name AS entity_name
    FROM creatures cr
    LEFT JOIN trees t ON t.id = cr.tree_id
    LEFT JOIN entities e ON e.id = cr.entity_id
    ${where}
    ORDER BY cr.created_at ASC
  `;

  if (dryRun) return { total: rows.length, indexed: 0, errors: 0 };

  let totalIndexed = 0, totalErrors = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const ops = batch.map((r: any) => {
      // Parse JSONB fields that may come as strings from Postgres
      let instructions = r.instructions;
      if (typeof instructions === "string") {
        try { instructions = JSON.parse(instructions); } catch { /* keep as-is */ }
      }
      let result = r.result;
      if (typeof result === "string") {
        try { result = JSON.parse(result); } catch { /* keep as-is */ }
      }
      return {
        index: "ellie-forest-creatures",
        id: r.id,
        doc: {
          creature_id: r.id, type: r.type, tree_id: r.tree_id,
          entity_id: r.entity_id, branch_id: r.branch_id,
          parent_creature_id: r.parent_creature_id, intent: r.intent,
          state: r.state, instructions, result,
          error: r.error, trigger_event: r.trigger_event,
          timeout_seconds: r.timeout_seconds, retry_count: r.retry_count,
          tree_title: r.tree_title, tree_type: r.tree_type,
          entity_name: r.entity_name,
          dispatched_at: r.dispatched_at, started_at: r.started_at,
          completed_at: r.completed_at, created_at: r.created_at,
        },
      };
    });
    const { indexed, errors } = await bulkIndexForest(ops);
    totalIndexed += indexed;
    totalErrors += errors;
    process.stdout.write(`\r  creatures: ${totalIndexed}/${rows.length} indexed, ${totalErrors} errors`);
  }
  console.log();
  return { total: rows.length, indexed: totalIndexed, errors: totalErrors };
}

async function backfillTrees(): Promise<{ total: number; indexed: number; errors: number }> {
  const where = sinceFilter ? sql`WHERE t.created_at >= ${sinceFilter}` : sql``;
  const rows = await sql`
    SELECT
      t.id, t.type, t.state, t.owner_id, t.title, t.description,
      t.work_item_id, t.external_ref, t.conversation_id, t.tags,
      t.tree_config,
      t.created_at, t.promoted_at, t.last_activity,
      t.closed_at, t.archived_at,
      (SELECT count(*) FROM tree_entities WHERE tree_id = t.id)::int AS entity_count,
      (SELECT count(*) FROM branches WHERE tree_id = t.id AND state = 'open')::int AS open_branches,
      (SELECT count(*) FROM trunks WHERE tree_id = t.id)::int AS trunk_count
    FROM trees t
    ${where}
    ORDER BY t.created_at ASC
  `;

  if (dryRun) return { total: rows.length, indexed: 0, errors: 0 };

  let totalIndexed = 0, totalErrors = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const ops = batch.map((r: any) => {
      const suggestInput: string[] = [];
      if (r.title) suggestInput.push(r.title);
      if (r.work_item_id) suggestInput.push(r.work_item_id);

      // Parse tree_config JSONB that may come as string from Postgres
      let config = r.tree_config;
      if (typeof config === "string") {
        try { config = JSON.parse(config); } catch { config = undefined; }
      }

      return {
        index: "ellie-forest-trees",
        id: r.id,
        doc: {
          tree_id: r.id, type: r.type, state: r.state,
          owner_id: r.owner_id, title: r.title,
          description: r.description, work_item_id: r.work_item_id,
          external_ref: r.external_ref, conversation_id: r.conversation_id,
          tags: r.tags || [],
          config: config || undefined,
          tree_name_suggest: suggestInput.length > 0 ? { input: suggestInput } : undefined,
          entity_count: r.entity_count ?? 0,
          open_branches: r.open_branches ?? 0,
          trunk_count: r.trunk_count ?? 0,
          created_at: r.created_at, promoted_at: r.promoted_at,
          last_activity: r.last_activity, closed_at: r.closed_at,
          archived_at: r.archived_at,
        },
      };
    });
    const { indexed, errors } = await bulkIndexForest(ops);
    totalIndexed += indexed;
    totalErrors += errors;
    process.stdout.write(`\r  trees: ${totalIndexed}/${rows.length} indexed, ${totalErrors} errors`);
  }
  console.log();
  return { total: rows.length, indexed: totalIndexed, errors: totalErrors };
}

// ============================================================
// MAIN
// ============================================================

async function run() {
  // Verify ES is reachable
  try {
    const res = await fetch(`${ES_URL}/_cluster/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const health = await res.json();
    console.log(`[backfill] ES cluster: ${health.cluster_name} (${health.status})`);
  } catch {
    console.error(`[backfill] Cannot reach Elasticsearch at ${ES_URL}`);
    process.exit(1);
  }

  // Verify Postgres
  try {
    await sql`SELECT 1`;
    console.log("[backfill] Postgres connected");
  } catch (err) {
    console.error("[backfill] Cannot connect to Postgres:", err);
    process.exit(1);
  }

  const targets = indexArg ? [indexArg] : ["events", "commits", "creatures", "trees"];
  console.log(`\n[backfill] ${dryRun ? "DRY RUN — " : ""}Backfilling: ${targets.join(", ")}`);
  if (sinceFilter) console.log(`[backfill] Since: ${sinceFilter}`);
  console.log();

  const results: Record<string, { total: number; indexed: number; errors: number }> = {};

  for (const target of targets) {
    switch (target) {
      case "events":
        results.events = await backfillEvents();
        break;
      case "commits":
        results.commits = await backfillCommits();
        break;
      case "creatures":
        results.creatures = await backfillCreatures();
        break;
      case "trees":
        results.trees = await backfillTrees();
        break;
      default:
        console.warn(`[backfill] Unknown index: ${target}`);
    }
  }

  // Summary
  console.log("\n[backfill] Summary:");
  let grandTotal = 0, grandIndexed = 0, grandErrors = 0;
  for (const [name, r] of Object.entries(results)) {
    console.log(`  ${name}: ${r.total} total, ${r.indexed} indexed, ${r.errors} errors`);
    grandTotal += r.total;
    grandIndexed += r.indexed;
    grandErrors += r.errors;
  }
  console.log(`  TOTAL: ${grandTotal} rows, ${grandIndexed} indexed, ${grandErrors} errors`);

  await sql.end();
}

run().catch((err) => {
  console.error("[backfill] Fatal:", err);
  process.exit(1);
});
