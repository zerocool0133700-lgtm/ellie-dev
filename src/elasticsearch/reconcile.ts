/**
 * ES Reconciliation — ELLIE-496
 *
 * Detects asymmetry between source databases (Supabase + Forest/Postgres)
 * and Elasticsearch indices. Finds records that exist in the source of
 * truth but are missing from ES, and backfills them with rate limiting.
 *
 * Indexed types:
 *   Supabase: messages, memory, conversations
 *   Forest:   forest_events, commits, creatures, trees
 *
 * Designed to run as a periodic task. Results are cached for the
 * health endpoint.
 */

import { log } from "../logger.ts";

const logger = log.child("es-reconcile");

const ES_URL = process.env.ELASTICSEARCH_URL || "";

// ============================================================
// CONFIGURATION
// ============================================================

export interface ReconcileConfig {
  /** Max records to backfill per reconciliation run. Default: 100 */
  backfillBatchSize: number;
  /** How many recent records to sample for missing-ID detection. Default: 500 */
  sampleSize: number;
  /** Delay between individual backfill index operations (ms). Default: 50 */
  backfillDelayMs: number;
  /** Asymmetry threshold (fraction) before alerting. Default: 0.05 (5%) */
  alertThreshold: number;
}

const DEFAULT_CONFIG: ReconcileConfig = {
  backfillBatchSize: 100,
  sampleSize: 500,
  backfillDelayMs: 50,
  alertThreshold: 0.05,
};

// ============================================================
// TYPES
// ============================================================

export interface IndexReconcileResult {
  index: string;
  sourceCount: number;
  esCount: number;
  missingIds: string[];
  backfilledCount: number;
  errors: number;
}

export interface ReconcileStatus {
  lastRunAt: number | null;
  lastRunDurationMs: number | null;
  results: IndexReconcileResult[];
  totalMissing: number;
  totalBackfilled: number;
  healthy: boolean;
}

// ============================================================
// STATUS CACHE (exposed to health endpoint)
// ============================================================

let _status: ReconcileStatus = {
  lastRunAt: null,
  lastRunDurationMs: null,
  results: [],
  totalMissing: 0,
  totalBackfilled: 0,
  healthy: true,
};

export function getReconcileStatus(): ReconcileStatus {
  return { ..._status, results: _status.results.map(r => ({ ...r })) };
}

// ============================================================
// ES HELPERS
// ============================================================

async function esRequest(
  method: string,
  path: string,
  body?: object,
): Promise<unknown> {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${ES_URL}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ES ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

/** Get document count for an ES index. Returns 0 if index doesn't exist. */
export async function getEsCount(index: string): Promise<number> {
  try {
    const result = (await esRequest("GET", `/${index}/_count`)) as {
      count: number;
    };
    return result.count;
  } catch {
    return 0;
  }
}

/**
 * Check which IDs exist in an ES index.
 * Returns a Set of IDs that were found.
 */
export async function checkEsIds(
  index: string,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();

  try {
    const result = (await esRequest("POST", `/${index}/_search`, {
      query: { ids: { values: ids } },
      size: ids.length,
      _source: false,
    })) as { hits?: { hits?: Array<{ _id: string }> } };

    const found = new Set<string>();
    for (const hit of result.hits?.hits || []) {
      found.add(hit._id);
    }
    return found;
  } catch {
    return new Set();
  }
}

// ============================================================
// SOURCE ADAPTERS
// ============================================================

export interface SourceAdapter {
  /** Human-readable name for this index */
  name: string;
  /** ES index name */
  index: string;
  /** Get total count from source DB */
  getSourceCount: () => Promise<number>;
  /** Get recent IDs from source DB (most recent first) */
  getRecentIds: (limit: number) => Promise<string[]>;
  /** Backfill a single record by ID into ES */
  backfillRecord: (id: string) => Promise<void>;
}

// ── Supabase adapters ────────────────────────────────────────

function supabaseAdapter(
  supabase: SupabaseClientLike,
  table: string,
  index: string,
  backfillFn: (id: string, supabase: SupabaseClientLike) => Promise<void>,
): SourceAdapter {
  return {
    name: table,
    index,
    getSourceCount: async () => {
      const { count, error } = await supabase
        .from(table)
        .select("*", { count: "exact", head: true });
      if (error) throw new Error(`Supabase count ${table}: ${error.message}`);
      return count ?? 0;
    },
    getRecentIds: async (limit: number) => {
      const { data, error } = await supabase
        .from(table)
        .select("id")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error)
        throw new Error(`Supabase recent IDs ${table}: ${error.message}`);
      return (data || []).map((r: { id: string }) => r.id);
    },
    backfillRecord: (id: string) => backfillFn(id, supabase),
  };
}

// ── Forest adapters ──────────────────────────────────────────

function forestAdapter(
  forestSql: ForestSqlLike,
  table: string,
  index: string,
  backfillFn: (id: string, sql: ForestSqlLike) => Promise<void>,
): SourceAdapter {
  return {
    name: table,
    index,
    getSourceCount: async () => {
      const rows = await forestSql`SELECT count(*)::int AS cnt FROM ${forestSql(table)}`;
      return rows[0]?.cnt ?? 0;
    },
    getRecentIds: async (limit: number) => {
      const rows = await forestSql`
        SELECT id FROM ${forestSql(table)}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      return rows.map((r: { id: string }) => r.id);
    },
    backfillRecord: (id: string) => backfillFn(id, forestSql),
  };
}

// ============================================================
// BACKFILL FUNCTIONS
// ============================================================

async function backfillMessage(
  id: string,
  supabase: SupabaseClientLike,
): Promise<void> {
  const { data, error } = await supabase
    .from("messages")
    .select("id, role, content, channel, created_at, conversation_id, summarized")
    .eq("id", id)
    .single();
  if (error || !data) return;
  const { indexMessage } = await import("../elasticsearch.ts");
  await indexMessage(data as { id: string; content: string; role: string; channel: string; created_at: string; conversation_id?: string; summarized?: boolean });
}

async function backfillMemory(
  id: string,
  supabase: SupabaseClientLike,
): Promise<void> {
  const { data, error } = await supabase
    .from("memory")
    .select("id, type, content, created_at, conversation_id, metadata")
    .eq("id", id)
    .single();
  if (error || !data) return;
  const { indexMemory } = await import("../elasticsearch.ts");
  await indexMemory(data as { id: string; content: string; type: string; created_at: string; conversation_id?: string; metadata?: Record<string, unknown> });
}

async function backfillConversation(
  id: string,
  supabase: SupabaseClientLike,
): Promise<void> {
  const { data, error } = await supabase
    .from("conversations")
    .select("id, channel, summary, started_at, ended_at, message_count")
    .eq("id", id)
    .single();
  if (error || !data) return;
  const d = data as Record<string, string | number>;
  const { indexConversation } = await import("../elasticsearch.ts");
  await indexConversation({
    id: d.id as string,
    summary: (d.summary as string) || "",
    channel: d.channel as string,
    started_at: d.started_at as string,
    ended_at: (d.ended_at as string) || (d.started_at as string),
    message_count: d.message_count as number,
  });
}

async function backfillForestEvent(
  id: string,
  sql: ForestSqlLike,
): Promise<void> {
  const rows = await sql`
    SELECT fe.id, fe.kind, fe.tree_id, fe.entity_id, fe.branch_id,
           fe.trunk_id, fe.creature_id, fe.commit_id, fe.summary,
           fe.data, fe.created_at,
           t.title AS tree_title, t.type AS tree_type,
           e.name AS entity_name
    FROM forest_events fe
    LEFT JOIN trees t ON t.id = fe.tree_id
    LEFT JOIN entities e ON e.id = fe.entity_id
    WHERE fe.id = ${id} LIMIT 1
  `;
  if (!rows[0]) return;
  const { indexForestEvent } = await import("./index-forest.ts");
  await indexForestEvent(rows[0] as import("./index-forest.ts").ForestEventRow);
}

async function backfillForestCommit(
  id: string,
  sql: ForestSqlLike,
): Promise<void> {
  const rows = await sql`
    SELECT c.id, c.tree_id, c.branch_id, c.trunk_id, c.entity_id,
           c.git_sha, c.message, c.content_summary, c.created_at,
           t.title AS tree_title, t.type AS tree_type,
           e.name AS entity_name
    FROM commits c
    LEFT JOIN trees t ON t.id = c.tree_id
    LEFT JOIN entities e ON e.id = c.entity_id
    WHERE c.id = ${id} LIMIT 1
  `;
  if (!rows[0]) return;
  const { indexForestCommit } = await import("./index-forest.ts");
  await indexForestCommit(rows[0] as import("./index-forest.ts").ForestCommitRow);
}

async function backfillForestCreature(
  id: string,
  sql: ForestSqlLike,
): Promise<void> {
  const rows = await sql`
    SELECT cr.id, cr.type, cr.tree_id, cr.entity_id, cr.branch_id,
           cr.parent_creature_id, cr.intent, cr.state,
           cr.instructions, cr.result, cr.error, cr.trigger_event,
           cr.timeout_seconds, cr.retry_count,
           cr.dispatched_at, cr.started_at, cr.completed_at, cr.created_at,
           t.title AS tree_title, t.type AS tree_type,
           e.name AS entity_name
    FROM creatures cr
    LEFT JOIN trees t ON t.id = cr.tree_id
    LEFT JOIN entities e ON e.id = cr.entity_id
    WHERE cr.id = ${id} LIMIT 1
  `;
  if (!rows[0]) return;
  const { indexForestCreature } = await import("./index-forest.ts");
  await indexForestCreature(rows[0] as import("./index-forest.ts").ForestCreatureRow);
}

async function backfillForestTree(
  id: string,
  sql: ForestSqlLike,
): Promise<void> {
  const rows = await sql`
    SELECT t.id, t.type, t.state, t.owner_id, t.title, t.description,
           t.work_item_id, t.external_ref, t.conversation_id, t.tags,
           t.tree_config,
           t.created_at, t.promoted_at, t.last_activity,
           t.closed_at, t.archived_at,
           (SELECT count(*) FROM tree_entities WHERE tree_id = t.id)::int AS entity_count,
           (SELECT count(*) FROM branches WHERE tree_id = t.id AND state = 'open')::int AS open_branches,
           (SELECT count(*) FROM trunks WHERE tree_id = t.id)::int AS trunk_count
    FROM trees t
    WHERE t.id = ${id} LIMIT 1
  `;
  if (!rows[0]) return;
  const row = rows[0] as Record<string, unknown>;
  let config = row.tree_config;
  if (typeof config === "string") {
    try { config = JSON.parse(config); } catch { config = undefined; }
  }
  const { indexForestTree } = await import("./index-forest.ts");
  await indexForestTree({ ...row, config, tree_config: undefined } as unknown as import("./index-forest.ts").ForestTreeRow);
}

// ============================================================
// MINIMAL TYPE INTERFACES (avoid hard Supabase/postgres imports)
// ============================================================

export interface SupabaseClientLike {
  from(table: string): {
    select(columns: string, opts?: { count?: string; head?: boolean }): {
      order(col: string, opts: { ascending: boolean }): {
        limit(n: number): Promise<{ data: Array<{ id: string }> | null; error: { message: string } | null }>;
      };
      eq(col: string, val: string): {
        single(): Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
      };
    } & Promise<{ count: number | null; error: { message: string } | null }>;
  };
}

// Minimal SQL tagged template interface matching postgres.js
export interface ForestSqlLike {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Array<Record<string, unknown>>>;
  (identifier: string): { toString(): string };
}

// ============================================================
// RECONCILE ENGINE
// ============================================================

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reconcile a single index: compare source vs ES, detect missing, backfill.
 */
export async function reconcileIndex(
  adapter: SourceAdapter,
  config: ReconcileConfig,
): Promise<IndexReconcileResult> {
  const result: IndexReconcileResult = {
    index: adapter.index,
    sourceCount: 0,
    esCount: 0,
    missingIds: [],
    backfilledCount: 0,
    errors: 0,
  };

  // 1. Get counts
  try {
    [result.sourceCount, result.esCount] = await Promise.all([
      adapter.getSourceCount(),
      getEsCount(adapter.index),
    ]);
  } catch (err) {
    logger.error(`[reconcile] Count failed for ${adapter.name}`, err);
    result.errors++;
    return result;
  }

  // 2. Sample recent IDs and find missing
  try {
    const recentIds = await adapter.getRecentIds(config.sampleSize);
    if (recentIds.length === 0) return result;

    // Check in batches of 100 (ES ids query limit)
    const BATCH = 100;
    for (let i = 0; i < recentIds.length; i += BATCH) {
      const batch = recentIds.slice(i, i + BATCH);
      const found = await checkEsIds(adapter.index, batch);
      for (const id of batch) {
        if (!found.has(id)) {
          result.missingIds.push(id);
        }
      }
    }
  } catch (err) {
    logger.error(`[reconcile] ID check failed for ${adapter.name}`, err);
    result.errors++;
    return result;
  }

  // 3. Backfill missing records (with rate limiting)
  const toBackfill = result.missingIds.slice(0, config.backfillBatchSize);
  for (const id of toBackfill) {
    try {
      await adapter.backfillRecord(id);
      result.backfilledCount++;
    } catch (err) {
      logger.error(`[reconcile] Backfill failed for ${adapter.name}/${id}`, err);
      result.errors++;
    }
    if (config.backfillDelayMs > 0) {
      await sleep(config.backfillDelayMs);
    }
  }

  if (result.missingIds.length > 0) {
    logger.info(
      `[reconcile] ${adapter.name}: ${result.missingIds.length} missing, ${result.backfilledCount} backfilled`,
    );
  }

  return result;
}

// ============================================================
// BUILD ADAPTERS
// ============================================================

export function buildAdapters(
  supabase: SupabaseClientLike | null,
  forestSql: ForestSqlLike | null,
): SourceAdapter[] {
  const adapters: SourceAdapter[] = [];

  if (supabase) {
    adapters.push(
      supabaseAdapter(supabase, "messages", "ellie-messages", backfillMessage),
      supabaseAdapter(supabase, "memory", "ellie-memory", backfillMemory),
      supabaseAdapter(supabase, "conversations", "ellie-conversations", backfillConversation),
    );
  }

  if (forestSql) {
    adapters.push(
      forestAdapter(forestSql, "forest_events", "ellie-forest-events", backfillForestEvent),
      forestAdapter(forestSql, "commits", "ellie-forest-commits", backfillForestCommit),
      forestAdapter(forestSql, "creatures", "ellie-forest-creatures", backfillForestCreature),
      forestAdapter(forestSql, "trees", "ellie-forest-trees", backfillForestTree),
    );
  }

  return adapters;
}

// ============================================================
// MAIN RECONCILE RUNNER
// ============================================================

export interface ReconcileDeps {
  supabase: SupabaseClientLike | null;
  forestSql: ForestSqlLike | null;
  /** Called when asymmetry exceeds threshold */
  onAlert?: (message: string, results: IndexReconcileResult[]) => void | Promise<void>;
}

/**
 * Run full reconciliation across all indices.
 * Returns the overall status.
 */
export async function runReconciliation(
  deps: ReconcileDeps,
  config: Partial<ReconcileConfig> = {},
): Promise<ReconcileStatus> {
  if (!ES_URL) {
    logger.info("[reconcile] ES not configured, skipping");
    return _status;
  }

  const cfg = { ...DEFAULT_CONFIG, ...config };
  const startTime = Date.now();

  const adapters = buildAdapters(deps.supabase, deps.forestSql);
  const results: IndexReconcileResult[] = [];

  for (const adapter of adapters) {
    try {
      const result = await reconcileIndex(adapter, cfg);
      results.push(result);
    } catch (err) {
      logger.error(`[reconcile] Failed for ${adapter.name}`, err);
      results.push({
        index: adapter.index,
        sourceCount: 0,
        esCount: 0,
        missingIds: [],
        backfilledCount: 0,
        errors: 1,
      });
    }
  }

  const totalMissing = results.reduce((sum, r) => sum + r.missingIds.length, 0);
  const totalBackfilled = results.reduce((sum, r) => sum + r.backfilledCount, 0);
  const totalSourceCount = results.reduce((sum, r) => sum + r.sourceCount, 0);

  // Check if asymmetry exceeds threshold
  const asymmetryFraction =
    totalSourceCount > 0 ? totalMissing / totalSourceCount : 0;
  const healthy = asymmetryFraction < cfg.alertThreshold;

  const status: ReconcileStatus = {
    lastRunAt: Date.now(),
    lastRunDurationMs: Date.now() - startTime,
    results,
    totalMissing,
    totalBackfilled,
    healthy,
  };

  _status = status;

  // Fire alert if asymmetry exceeded
  if (!healthy && deps.onAlert) {
    const alertLines = results
      .filter((r) => r.missingIds.length > 0)
      .map(
        (r) =>
          `  ${r.index}: ${r.missingIds.length} missing (source: ${r.sourceCount}, ES: ${r.esCount})`,
      );
    const message = `ES reconciliation found ${totalMissing} missing records (${(asymmetryFraction * 100).toFixed(1)}% asymmetry):\n${alertLines.join("\n")}`;

    try {
      await deps.onAlert(message, results);
    } catch (err) {
      logger.error("[reconcile] Alert callback failed", err);
    }
  }

  logger.info(
    `[reconcile] Complete in ${status.lastRunDurationMs}ms: ${totalMissing} missing, ${totalBackfilled} backfilled, healthy=${healthy}`,
  );

  return status;
}
