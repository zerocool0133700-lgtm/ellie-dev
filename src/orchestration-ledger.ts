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

const logger = log.child("orchestration-ledger");

// Lazy-load Forest DB
let _sql: ReturnType<typeof import("postgres").default> | null = null;

async function getSql() {
  if (!_sql) {
    const mod = await import("../../ellie-forest/src/db");
    _sql = mod.default;
  }
  return _sql;
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
  getSql()
    .then((sql) =>
      sql`
        INSERT INTO orchestration_events (run_id, event_type, agent_type, work_item_id, payload)
        VALUES (${runId}, ${eventType}, ${agentType || null}, ${workItemId || null}, ${JSON.stringify(payload || {})})
      `
    )
    .then(() => {
      if (eventType !== "heartbeat") {
        logger.info(`Event: ${eventType}`, { runId: runId.slice(0, 8), agentType, workItemId });
      }
    })
    .catch((err) => logger.error(`Failed to emit ${eventType}`, { runId: runId.slice(0, 8), error: err.message }));
}

// ── Queries ────────────────────────────────────────────────

/** Get all events for a specific run, ordered chronologically. */
export async function getRunEvents(runId: string): Promise<OrchestrationEvent[]> {
  const sql = await getSql();
  const rows = await sql`
    SELECT id, run_id, event_type, agent_type, work_item_id, payload, created_at
    FROM orchestration_events
    WHERE run_id = ${runId}
    ORDER BY created_at ASC
  `;
  return rows as unknown as OrchestrationEvent[];
}

/** Get recent events across all runs. */
export async function getRecentEvents(limit = 50): Promise<OrchestrationEvent[]> {
  const sql = await getSql();
  const rows = await sql`
    SELECT id, run_id, event_type, agent_type, work_item_id, payload, created_at
    FROM orchestration_events
    WHERE event_type != 'heartbeat'
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows as unknown as OrchestrationEvent[];
}

/** Get run_ids that have been dispatched but not yet terminated. */
export async function getUnterminated(): Promise<Array<{ run_id: string; agent_type: string | null; work_item_id: string | null; dispatched_at: string }>> {
  const sql = await getSql();
  const rows = await sql`
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
  `;
  return rows as unknown as Array<{ run_id: string; agent_type: string | null; work_item_id: string | null; dispatched_at: string }>;
}

export { TERMINAL_EVENTS };
