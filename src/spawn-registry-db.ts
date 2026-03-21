/**
 * Spawn Registry DB — ELLIE-954
 *
 * Persistence layer for agent_spawn_records. Writes through to Postgres
 * on every state change so spawn records survive relay restarts.
 *
 * The in-memory registry (session-spawn.ts) remains the primary read path
 * for performance. This module syncs writes and provides recovery on startup.
 */

import { sql } from "../../ellie-forest/src/index.ts";
import { log } from "./logger.ts";
import type { SpawnRecord, SpawnState } from "./types/session-spawn.ts";

const logger = log.child("spawn-db");

// ── DB Row Type ─────────────────────────────────────────────

interface SpawnRow {
  id: string;
  parent_session_id: string;
  parent_agent_name: string;
  child_session_id: string;
  child_session_key: string;
  target_agent_name: string;
  task: string;
  state: SpawnState;
  arc_mode: string;
  arc_id: string | null;
  delivery_context: Record<string, unknown> | null;
  thread_bound: boolean;
  work_item_id: string | null;
  depth: number;
  timeout_seconds: number;
  result_text: string | null;
  error: string | null;
  created_at: Date;
  ended_at: Date | null;
}

// ── Write Operations ────────────────────────────────────────

/**
 * Persist a new spawn record to the database.
 * Called after addToRegistry() in spawnSession().
 */
export async function persistSpawnRecord(record: SpawnRecord): Promise<void> {
  try {
    await sql`
      INSERT INTO agent_spawn_records (
        id, parent_session_id, parent_agent_name, child_session_id,
        child_session_key, target_agent_name, task, state, arc_mode,
        arc_id, delivery_context, thread_bound, work_item_id, depth,
        timeout_seconds, result_text, error, created_at, ended_at
      ) VALUES (
        ${record.id}::uuid,
        ${record.parentSessionId},
        ${record.parentAgentName},
        ${record.childSessionId},
        ${record.childSessionKey},
        ${record.targetAgentName},
        ${record.task},
        ${record.state}::spawn_state,
        ${record.arcMode},
        ${record.arcId ? record.arcId : null}::uuid,
        ${record.deliveryContext ? sql.json(record.deliveryContext) : null},
        ${record.threadBound},
        ${record.workItemId},
        ${record.depth},
        ${record.timeoutSeconds},
        ${record.resultText},
        ${record.error},
        ${new Date(record.createdAt).toISOString()}::timestamptz,
        ${record.endedAt ? new Date(record.endedAt).toISOString() : null}::timestamptz
      )
      ON CONFLICT (child_session_key) DO NOTHING
    `;
  } catch (err) {
    logger.error("Failed to persist spawn record", { id: record.id, err: (err as Error).message });
  }
}

/**
 * Update a spawn record's state in the database.
 * Called after markRunning/markCompleted/markFailed/markTimedOut.
 */
export async function updateSpawnState(
  id: string,
  state: SpawnState,
  updates?: {
    childSessionId?: string;
    resultText?: string | null;
    error?: string | null;
    endedAt?: number | null;
  },
): Promise<void> {
  try {
    await sql`
      UPDATE agent_spawn_records SET
        state = ${state}::spawn_state,
        child_session_id = COALESCE(${updates?.childSessionId ?? null}, child_session_id),
        result_text = ${updates?.resultText ?? null},
        error = ${updates?.error ?? null},
        ended_at = ${updates?.endedAt ? new Date(updates.endedAt).toISOString() : null}::timestamptz
      WHERE id = ${id}::uuid
    `;
  } catch (err) {
    logger.error("Failed to update spawn state", { id, state, err: (err as Error).message });
  }
}

/**
 * Delete old completed/failed spawn records from the database.
 * Mirrors pruneCompletedSpawns() in session-spawn.ts.
 */
export async function pruneDbSpawnRecords(maxAgeMs: number): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const rows = await sql<{ id: string }[]>`
      DELETE FROM agent_spawn_records
      WHERE state NOT IN ('pending', 'running')
        AND ended_at < ${cutoff}::timestamptz
      RETURNING id
    `;
    return rows.length;
  } catch (err) {
    logger.error("Failed to prune DB spawn records", { err: (err as Error).message });
    return 0;
  }
}

// ── Recovery (Startup) ──────────────────────────────────────

/**
 * Load active (pending/running) spawn records from the database.
 * Called once on relay startup to rebuild the in-memory registry.
 * Returns the records that should be re-added to the registry.
 */
export async function loadActiveSpawnRecords(): Promise<SpawnRecord[]> {
  try {
    const rows = await sql<SpawnRow[]>`
      SELECT * FROM agent_spawn_records
      WHERE state IN ('pending', 'running')
      ORDER BY created_at ASC
    `;

    return rows.map(rowToRecord);
  } catch (err) {
    logger.error("Failed to load active spawn records", { err: (err as Error).message });
    return [];
  }
}

/**
 * Mark stale spawns as failed on startup.
 * Any spawn still 'pending' or 'running' beyond its timeout is dead
 * (the relay that owned it has restarted).
 */
export async function recoverStaleSpawns(): Promise<number> {
  try {
    const rows = await sql<{ id: string }[]>`
      UPDATE agent_spawn_records SET
        state = 'failed'::spawn_state,
        error = 'Relay restarted — spawn orphaned',
        ended_at = NOW()
      WHERE state IN ('pending', 'running')
        AND created_at + (timeout_seconds || ' seconds')::interval < NOW()
      RETURNING id
    `;
    if (rows.length > 0) {
      logger.info("Recovery: marked stale spawns as failed", { count: rows.length });
    }
    return rows.length;
  } catch (err) {
    logger.error("Failed to recover stale spawns", { err: (err as Error).message });
    return 0;
  }
}

// ── Helpers ─────────────────────────────────────────────────

function rowToRecord(row: SpawnRow): SpawnRecord {
  return {
    id: row.id,
    parentSessionId: row.parent_session_id,
    parentAgentName: row.parent_agent_name,
    childSessionId: row.child_session_id,
    childSessionKey: row.child_session_key,
    targetAgentName: row.target_agent_name,
    task: row.task,
    state: row.state,
    arcMode: row.arc_mode as "inherit" | "fork",
    arcId: row.arc_id,
    deliveryContext: row.delivery_context as SpawnRecord["deliveryContext"],
    threadBound: row.thread_bound,
    workItemId: row.work_item_id,
    createdAt: new Date(row.created_at).getTime(),
    endedAt: row.ended_at ? new Date(row.ended_at).getTime() : null,
    resultText: row.result_text,
    error: row.error,
    timeoutSeconds: row.timeout_seconds,
    depth: row.depth,
  };
}
