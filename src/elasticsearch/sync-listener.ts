/**
 * ES Forest — Real-time Sync Listener (ELLIE-110)
 *
 * Connects to Postgres via pg_notify and indexes forest changes
 * to Elasticsearch in real time. Uses the `postgres` library for
 * LISTEN and row fetches with denormalization JOINs.
 *
 * Can run standalone (`bun run src/elasticsearch/sync-listener.ts`)
 * or be imported and started by the relay.
 *
 * Graceful degradation: if ES is down, notifications are logged
 * and skipped. They'll be picked up by the backfill script later.
 */

import "dotenv/config";
import postgres from "postgres";
import {
  indexForestEvent,
  indexForestCommit,
  indexForestCreature,
  indexForestTree,
  cacheEntityName,
  type ForestEventRow,
  type ForestCommitRow,
  type ForestCreatureRow,
  type ForestTreeRow,
} from "./index-forest.ts";

const ES_URL = process.env.ELASTICSEARCH_URL || "";

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

let sql: ReturnType<typeof postgres> | null = null;
let running = false;

// Stats for monitoring
let stats = { indexed: 0, errors: 0, skipped: 0, started: Date.now() };

export function getSyncStats() {
  return { ...stats, uptime_ms: Date.now() - stats.started };
}

// ============================================================
// ROW FETCHERS (with denormalization JOINs)
// ============================================================

async function fetchEvent(id: string): Promise<ForestEventRow | null> {
  if (!sql) return null;
  const rows = await sql`
    SELECT
      fe.id, fe.kind, fe.tree_id, fe.entity_id, fe.branch_id,
      fe.trunk_id, fe.creature_id, fe.commit_id, fe.summary,
      fe.data, fe.created_at,
      t.title AS tree_title, t.type AS tree_type,
      e.name AS entity_name
    FROM forest_events fe
    LEFT JOIN trees t ON t.id = fe.tree_id
    LEFT JOIN tree_entities te ON te.tree_id = fe.tree_id AND te.entity_id = fe.entity_id
    LEFT JOIN entities e ON e.id = fe.entity_id
    WHERE fe.id = ${id}
    LIMIT 1
  `;
  return (rows[0] as ForestEventRow) || null;
}

async function fetchCommit(id: string): Promise<ForestCommitRow | null> {
  if (!sql) return null;
  const rows = await sql`
    SELECT
      c.id, c.tree_id, c.branch_id, c.trunk_id, c.entity_id,
      c.git_sha, c.message, c.content_summary, c.created_at,
      t.title AS tree_title, t.type AS tree_type,
      e.name AS entity_name
    FROM commits c
    LEFT JOIN trees t ON t.id = c.tree_id
    LEFT JOIN entities e ON e.id = c.entity_id
    WHERE c.id = ${id}
    LIMIT 1
  `;
  return (rows[0] as ForestCommitRow) || null;
}

async function fetchCreature(id: string): Promise<ForestCreatureRow | null> {
  if (!sql) return null;
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
    WHERE cr.id = ${id}
    LIMIT 1
  `;
  if (!rows[0]) return null;
  const row = rows[0] as any;
  // Ensure JSONB fields are objects (postgres may return strings for some drivers)
  if (typeof row.instructions === "string") {
    try { row.instructions = JSON.parse(row.instructions); } catch { /* keep as-is */ }
  }
  if (typeof row.result === "string") {
    try { row.result = JSON.parse(row.result); } catch { /* keep as-is */ }
  }
  return row as ForestCreatureRow;
}

async function fetchTree(id: string): Promise<ForestTreeRow | null> {
  if (!sql) return null;
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
    WHERE t.id = ${id}
    LIMIT 1
  `;
  if (!rows[0]) return null;
  const row = rows[0] as any;
  // Map tree_config → config for ForestTreeRow, ensuring it's an object
  let config = row.tree_config;
  if (typeof config === "string") {
    try { config = JSON.parse(config); } catch { config = undefined; }
  }
  return { ...row, config, tree_config: undefined } as ForestTreeRow;
}

// ============================================================
// NOTIFICATION HANDLER
// ============================================================

interface ForestNotification {
  type: "event" | "commit" | "creature" | "tree";
  id: string;
  op: string;
}

async function handleNotification(payload: string): Promise<void> {
  let notification: ForestNotification;
  try {
    notification = JSON.parse(payload);
  } catch {
    console.warn("[es-sync] Bad notification payload:", payload);
    stats.errors++;
    return;
  }

  const { type, id } = notification;

  try {
    switch (type) {
      case "event": {
        const row = await fetchEvent(id);
        if (!row) { stats.skipped++; return; }
        if (row.entity_id && row.entity_name) cacheEntityName(row.entity_id, row.entity_name);
        await indexForestEvent(row);
        break;
      }
      case "commit": {
        const row = await fetchCommit(id);
        if (!row) { stats.skipped++; return; }
        if (row.entity_id && row.entity_name) cacheEntityName(row.entity_id, row.entity_name);
        await indexForestCommit(row);
        break;
      }
      case "creature": {
        const row = await fetchCreature(id);
        if (!row) { stats.skipped++; return; }
        if (row.entity_id && row.entity_name) cacheEntityName(row.entity_id, row.entity_name);
        await indexForestCreature(row);
        break;
      }
      case "tree": {
        const row = await fetchTree(id);
        if (!row) { stats.skipped++; return; }
        await indexForestTree(row);
        break;
      }
      default:
        console.warn(`[es-sync] Unknown notification type: ${type}`);
        stats.skipped++;
    }
    stats.indexed++;
  } catch (err) {
    console.error(`[es-sync] Failed to index ${type} ${id}:`, err);
    stats.errors++;
  }
}

// ============================================================
// LIFECYCLE
// ============================================================

export async function startSyncListener(): Promise<void> {
  if (running) return;
  if (!ES_URL) {
    console.warn("[es-sync] ELASTICSEARCH_URL not set, sync listener disabled");
    return;
  }

  sql = postgres(pgConfig as any, {
    max: 2, // One for LISTEN, one for fetches
    idle_timeout: 0, // Keep alive forever
    connect_timeout: 10,
  });

  // Verify connection
  try {
    await sql`SELECT 1`;
    console.log("[es-sync] Connected to Postgres");
  } catch (err) {
    console.error("[es-sync] Failed to connect to Postgres:", err);
    sql = null;
    return;
  }

  running = true;
  stats = { indexed: 0, errors: 0, skipped: 0, started: Date.now() };

  // Start listening
  await sql.listen("forest_index_queue", (payload) => {
    handleNotification(payload).catch((err) => {
      console.error("[es-sync] Notification handler error:", err);
    });
  });

  console.log("[es-sync] Listening on forest_index_queue channel");
}

export async function stopSyncListener(): Promise<void> {
  if (!running || !sql) return;
  running = false;

  try {
    await sql.end({ timeout: 5 });
    console.log("[es-sync] Listener stopped");
  } catch (err) {
    console.error("[es-sync] Error stopping listener:", err);
  }
  sql = null;
}

// ============================================================
// STANDALONE MODE
// ============================================================

if (import.meta.main) {
  console.log("[es-sync] Starting standalone sync listener...");

  process.on("SIGINT", async () => {
    console.log("\n[es-sync] Shutting down...");
    await stopSyncListener();
    console.log(`[es-sync] Final stats: ${JSON.stringify(getSyncStats())}`);
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await stopSyncListener();
    process.exit(0);
  });

  await startSyncListener();
}
