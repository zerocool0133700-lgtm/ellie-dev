/**
 * Orchestration Ledger — ELLIE-348
 *
 * Append-only event log for agent dispatch lifecycle.
 * All orchestration events (dispatch, heartbeat, progress, completion,
 * failure, cancellation, retry, timeout) are recorded here.
 *
 * Lazy-loads Forest DB to avoid circular deps at import time
 * (same pattern as plane-queue.ts).
 */

import { log } from "./logger.ts";
import { resilientTask } from "./resilient-task.ts";

const logger = log.child("orchestration-ledger");

// ── Lazy Forest DB with timeout + failure backoff (ELLIE-486) ──

const CONNECT_TIMEOUT_MS = 5_000;
const FAILURE_BACKOFF_MS = 30_000; // don't retry for 30s after a failed import

let _sql: ReturnType<typeof import("postgres").default> | null = null;
let _sqlFailedAt = 0; // 0 = never failed
let _sqlPending: Promise<ReturnType<typeof import("postgres").default>> | null = null;

async function getSql(): Promise<ReturnType<typeof import("postgres").default>> {
  if (_sql) return _sql;

  // If an import is already in progress, wait for it instead of starting a new one
  if (_sqlPending) return _sqlPending;

  // Cache failure state — don't hammer the import every call during an outage
  if (_sqlFailedAt > 0 && Date.now() - _sqlFailedAt < FAILURE_BACKOFF_MS) {
    throw new Error(`Forest DB unavailable (retry in ${Math.round((FAILURE_BACKOFF_MS - (Date.now() - _sqlFailedAt)) / 1000)}s)`);
  }

  // Start the import and cache the promise so concurrent callers wait for the same import
  _sqlPending = (async () => {
    try {
      const mod = await Promise.race([
        import("../../ellie-forest/src/db"),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Forest DB import timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)),
            CONNECT_TIMEOUT_MS,
          )
        ),
      ]);
      _sql = mod.default;
      _sqlFailedAt = 0; // clear any prior failure
      return _sql;
    } catch (err) {
      _sqlFailedAt = Date.now();
      logger.error("Forest DB import failed — entering backoff", {
        error: err instanceof Error ? err.message : String(err),
        backoffMs: FAILURE_BACKOFF_MS,
      });
      throw err;
    } finally {
      _sqlPending = null; // clear pending state so future calls can retry
    }
  })();

  return _sqlPending;
}

/**
 * Run a DB operation with a hard timeout (ELLIE-486).
 * Prevents query hangs from blocking callers indefinitely.
 */
const QUERY_TIMEOUT_MS = 8_000;

async function withDbTimeout<T>(op: () => Promise<T>, label: string): Promise<T> {
  return Promise.race([
    op(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Forest DB query timed out: ${label}`)), QUERY_TIMEOUT_MS)
    ),
  ]);
}

// ── Types ──────────────────────────────────────────────────

export type OrchestrationEventType =
  | "dispatched"
  | "heartbeat"
  | "progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "retried"
  | "timeout";

export interface OrchestrationEvent {
  id: string;
  run_id: string;
  event_type: OrchestrationEventType;
  agent_type: string | null;
  work_item_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

const TERMINAL_EVENTS: OrchestrationEventType[] = [
  "completed",
  "failed",
  "cancelled",
  "timeout",
];

// ── Emit (fire-and-forget) ──────────────────────────────────

/**
 * Record an orchestration event. Non-blocking — errors are logged, not thrown.
 */
export function emitEvent(
  runId: string,
  eventType: OrchestrationEventType,
  agentType?: string | null,
  workItemId?: string | null,
  payload?: Record<string, unknown>,
): void {
  const doEmit = async () => {
    const sql = await getSql();
    await withDbTimeout(
      () => sql`
        INSERT INTO orchestration_events (run_id, event_type, agent_type, work_item_id, payload)
        VALUES (${runId}, ${eventType}, ${agentType || null}, ${workItemId || null}, ${JSON.stringify(payload || {})})
      `,
      `emitEvent:${eventType}`,
    );
    if (eventType !== "heartbeat") {
      logger.info(`Event: ${eventType}`, { runId: runId.slice(0, 8), agentType, workItemId });
    }
  };

  // Terminal events (completed, failed, cancelled, timeout) use resilient retry
  // to prevent data loss. Heartbeats and progress stay best-effort.
  const isTerminal = TERMINAL_EVENTS.includes(eventType);
  resilientTask(
    `emitEvent:${eventType}`,
    isTerminal ? "critical" : "best-effort",
    doEmit,
  );
}

// ── Queries ────────────────────────────────────────────────

/** Get all events for a specific run, ordered chronologically. */
export async function getRunEvents(runId: string): Promise<OrchestrationEvent[]> {
  const sql = await getSql();
  const rows = await withDbTimeout(
    () => sql`
      SELECT id, run_id, event_type, agent_type, work_item_id, payload, created_at
      FROM orchestration_events
      WHERE run_id = ${runId}
      ORDER BY created_at ASC
    `,
    "getRunEvents",
  );
  return rows as unknown as OrchestrationEvent[];
}

/** Get recent events across all runs. */
export async function getRecentEvents(limit = 50): Promise<OrchestrationEvent[]> {
  const sql = await getSql();
  const rows = await withDbTimeout(
    () => sql`
      SELECT id, run_id, event_type, agent_type, work_item_id, payload, created_at
      FROM orchestration_events
      WHERE event_type != 'heartbeat'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `,
    "getRecentEvents",
  );
  return rows as unknown as OrchestrationEvent[];
}

/** Get run_ids that have been dispatched but not yet terminated. */
export async function getUnterminated(): Promise<Array<{ run_id: string; agent_type: string | null; work_item_id: string | null; dispatched_at: string }>> {
  const sql = await getSql();
  const rows = await withDbTimeout(
    () => sql`
      SELECT DISTINCT ON (e.run_id)
        e.run_id,
        e.agent_type,
        e.work_item_id,
        e.created_at AS dispatched_at
      FROM orchestration_events e
      WHERE e.event_type = 'dispatched'
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_events t
          WHERE t.run_id = e.run_id
            AND t.event_type IN ('completed', 'failed', 'cancelled', 'timeout')
        )
      ORDER BY e.run_id, e.created_at ASC
    `,
    "getUnterminated",
  );
  return rows as unknown as Array<{ run_id: string; agent_type: string | null; work_item_id: string | null; dispatched_at: string }>;
}

export { TERMINAL_EVENTS };
