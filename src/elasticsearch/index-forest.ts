/**
 * ES Forest — Indexing Functions
 *
 * Indexes forest data (events, commits, creatures, trees) into
 * Elasticsearch with denormalized fields for efficient search.
 *
 * Uses the same raw fetch() pattern as src/elasticsearch.ts.
 * All functions are fire-and-forget — ES failures never block
 * Postgres operations.
 */

import "dotenv/config";

const ES_URL = process.env.ELASTICSEARCH_URL || "";

// ============================================================
// HEALTH CHECK (shared circuit breaker)
// ============================================================

let esAvailable = true;
let disabledUntil = 0;

async function checkHealth(): Promise<boolean> {
  if (!ES_URL) return false;
  if (!esAvailable && Date.now() < disabledUntil) return false;
  if (!esAvailable) esAvailable = true; // retry window

  try {
    const res = await fetch(`${ES_URL}/_cluster/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch {
    console.warn("[es-forest] Elasticsearch unreachable, disabling for 60s");
    esAvailable = false;
    disabledUntil = Date.now() + 60_000;
    return false;
  }
}

async function esRequest(
  method: string,
  path: string,
  body?: object
): Promise<any> {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${ES_URL}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ES ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

// ============================================================
// JSONB FLATTENING
// ============================================================

/**
 * Flatten a JSONB object to a single searchable text string.
 * Extracts all leaf values (strings, numbers, booleans), skipping nulls.
 * Useful for building text representations of flattened JSONB fields.
 */
export function flattenJsonb(obj: unknown): string {
  if (obj == null) return "";
  if (typeof obj === "string") return obj;
  if (typeof obj === "number" || typeof obj === "boolean") return String(obj);
  if (Array.isArray(obj)) return obj.map(flattenJsonb).filter(Boolean).join(" ");
  if (typeof obj === "object") {
    return Object.values(obj as Record<string, unknown>)
      .map(flattenJsonb)
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

// ============================================================
// ENTITY NAME CACHE
// ============================================================

// Cache entity names per entity_id to avoid repeated lookups.
// The caller provides entity_name when available (from JOINs),
// but we also accept raw entity_id for fire-and-forget calls.
const entityNameCache = new Map<string, string>();

export function cacheEntityName(entityId: string, name: string): void {
  entityNameCache.set(entityId, name);
}

export function getCachedEntityName(entityId: string | null | undefined): string | undefined {
  if (!entityId) return undefined;
  return entityNameCache.get(entityId);
}

// ============================================================
// TYPES — Match Postgres forest schema
// ============================================================

export interface ForestEventRow {
  id: string;
  kind: string;
  tree_id?: string | null;
  entity_id?: string | null;
  branch_id?: string | null;
  trunk_id?: string | null;
  creature_id?: string | null;
  commit_id?: string | null;
  summary?: string | null;
  data?: Record<string, unknown>;
  created_at: string;
  // Denormalized (caller may provide from JOIN)
  tree_title?: string | null;
  tree_type?: string | null;
  entity_name?: string | null;
}

export interface ForestCommitRow {
  id: string;
  tree_id: string;
  branch_id?: string | null;
  trunk_id?: string | null;
  entity_id?: string | null;
  git_sha?: string | null;
  message: string;
  content_summary?: string | null;
  created_at: string;
  // Denormalized
  tree_title?: string | null;
  tree_type?: string | null;
  entity_name?: string | null;
}

export interface ForestCreatureRow {
  id: string;
  type: string;
  tree_id: string;
  entity_id: string;
  branch_id?: string | null;
  parent_creature_id?: string | null;
  intent: string;
  state: string;
  instructions?: Record<string, unknown> | null;
  result?: unknown;
  error?: string | null;
  trigger_event?: string | null;
  dispatched_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at: string;
  timeout_seconds?: number;
  retry_count?: number;
  // Denormalized
  tree_title?: string | null;
  tree_type?: string | null;
  entity_name?: string | null;
}

export interface ForestTreeRow {
  id: string;
  type: string;
  state: string;
  owner_id?: string | null;
  title?: string | null;
  description?: string | null;
  work_item_id?: string | null;
  external_ref?: string | null;
  conversation_id?: string | null;
  tags?: string[];
  config?: Record<string, unknown> | null;
  created_at: string;
  promoted_at?: string | null;
  last_activity?: string | null;
  closed_at?: string | null;
  archived_at?: string | null;
  // Denormalized counts (from forest view)
  entity_count?: number;
  open_branches?: number;
  trunk_count?: number;
}

// ============================================================
// INDEXING FUNCTIONS
// ============================================================

/**
 * Index a forest event. Fire-and-forget.
 */
export async function indexForestEvent(event: ForestEventRow): Promise<void> {
  if (!(await checkHealth())) return;

  try {
    const entityName = event.entity_name
      || getCachedEntityName(event.entity_id)
      || undefined;

    await esRequest("PUT", `/ellie-forest-events/_doc/${event.id}`, {
      event_id: event.id,
      kind: event.kind,
      tree_id: event.tree_id || undefined,
      entity_id: event.entity_id || undefined,
      branch_id: event.branch_id || undefined,
      trunk_id: event.trunk_id || undefined,
      creature_id: event.creature_id || undefined,
      commit_id: event.commit_id || undefined,
      summary: event.summary || undefined,
      data: event.data || undefined,
      tree_title: event.tree_title || undefined,
      tree_type: event.tree_type || undefined,
      entity_name: entityName,
      created_at: event.created_at,
    });
  } catch (err) {
    console.error("[es-forest] Failed to index event:", err);
  }
}

/**
 * Index a forest commit. Fire-and-forget.
 */
export async function indexForestCommit(commit: ForestCommitRow): Promise<void> {
  if (!(await checkHealth())) return;

  try {
    const entityName = commit.entity_name
      || getCachedEntityName(commit.entity_id)
      || undefined;

    await esRequest("PUT", `/ellie-forest-commits/_doc/${commit.id}`, {
      commit_id: commit.id,
      tree_id: commit.tree_id,
      branch_id: commit.branch_id || undefined,
      trunk_id: commit.trunk_id || undefined,
      entity_id: commit.entity_id || undefined,
      git_sha: commit.git_sha || undefined,
      message: commit.message,
      content_summary: commit.content_summary || undefined,
      tree_title: commit.tree_title || undefined,
      tree_type: commit.tree_type || undefined,
      entity_name: entityName,
      created_at: commit.created_at,
    });
  } catch (err) {
    console.error("[es-forest] Failed to index commit:", err);
  }
}

/**
 * Index a forest creature. Fire-and-forget.
 */
export async function indexForestCreature(creature: ForestCreatureRow): Promise<void> {
  if (!(await checkHealth())) return;

  try {
    const entityName = creature.entity_name
      || getCachedEntityName(creature.entity_id)
      || undefined;

    await esRequest("PUT", `/ellie-forest-creatures/_doc/${creature.id}`, {
      creature_id: creature.id,
      type: creature.type,
      tree_id: creature.tree_id,
      entity_id: creature.entity_id,
      branch_id: creature.branch_id || undefined,
      parent_creature_id: creature.parent_creature_id || undefined,
      intent: creature.intent,
      state: creature.state,
      instructions: creature.instructions || undefined,
      result: creature.result || undefined,
      error: creature.error || undefined,
      trigger_event: creature.trigger_event || undefined,
      tree_title: creature.tree_title || undefined,
      tree_type: creature.tree_type || undefined,
      entity_name: entityName,
      dispatched_at: creature.dispatched_at || undefined,
      started_at: creature.started_at || undefined,
      completed_at: creature.completed_at || undefined,
      created_at: creature.created_at,
      timeout_seconds: creature.timeout_seconds,
      retry_count: creature.retry_count,
    });
  } catch (err) {
    console.error("[es-forest] Failed to index creature:", err);
  }
}

/**
 * Index a forest tree. Fire-and-forget.
 * Includes completion suggester for autocomplete.
 */
export async function indexForestTree(tree: ForestTreeRow): Promise<void> {
  if (!(await checkHealth())) return;

  try {
    // Build suggest input from title + work_item_id
    const suggestInput: string[] = [];
    if (tree.title) suggestInput.push(tree.title);
    if (tree.work_item_id) suggestInput.push(tree.work_item_id);

    await esRequest("PUT", `/ellie-forest-trees/_doc/${tree.id}`, {
      tree_id: tree.id,
      type: tree.type,
      state: tree.state,
      owner_id: tree.owner_id || undefined,
      title: tree.title || undefined,
      description: tree.description || undefined,
      work_item_id: tree.work_item_id || undefined,
      external_ref: tree.external_ref || undefined,
      conversation_id: tree.conversation_id || undefined,
      tags: tree.tags || [],
      config: tree.config || undefined,
      tree_name_suggest: suggestInput.length > 0
        ? { input: suggestInput }
        : undefined,
      entity_count: tree.entity_count ?? 0,
      open_branches: tree.open_branches ?? 0,
      trunk_count: tree.trunk_count ?? 0,
      created_at: tree.created_at,
      promoted_at: tree.promoted_at || undefined,
      last_activity: tree.last_activity || undefined,
      closed_at: tree.closed_at || undefined,
      archived_at: tree.archived_at || undefined,
    });
  } catch (err) {
    console.error("[es-forest] Failed to index tree:", err);
  }
}

// ============================================================
// BULK INDEXING (for backfill — ELLIE-112)
// ============================================================

export async function bulkIndexForest(
  operations: Array<{ index: string; id: string; doc: object }>
): Promise<{ errors: number; indexed: number }> {
  if (!ES_URL) return { errors: 0, indexed: 0 };

  const lines: string[] = [];
  for (const op of operations) {
    lines.push(JSON.stringify({ index: { _index: op.index, _id: op.id } }));
    lines.push(JSON.stringify(op.doc));
  }
  const ndjson = lines.join("\n") + "\n";

  const res = await fetch(`${ES_URL}/_bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/x-ndjson" },
    body: ndjson,
    signal: AbortSignal.timeout(30_000),
  });

  const result = await res.json();
  const errorCount = result.items?.filter((i: any) => i.index?.error).length || 0;

  return { errors: errorCount, indexed: operations.length - errorCount };
}
