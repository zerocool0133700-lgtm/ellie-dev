/**
 * Unified Dispatch Events — ELLIE-1308
 *
 * Single entry point for emitting dispatch lifecycle events.
 * Writes to the Forest DB orchestration ledger AND broadcasts
 * to Ellie Chat WebSocket clients as `dispatch_event` messages.
 */

import { log } from "./logger.ts";
import { emitEvent, type OrchestrationEventType } from "./orchestration-ledger.ts";
import { broadcastDispatchEvent } from "./relay-state.ts";

const logger = log.child("dispatch-events");

export interface DispatchEventPayload {
  agent: string;
  title: string;
  work_item_id?: string | null;
  progress_line?: string | null;
  dispatch_type: "single" | "formation" | "round_table" | "delegation";
  duration_ms?: number;
  cost_usd?: number;
}

export type DispatchStatus =
  | "dispatched"
  | "in_progress"
  | "done"
  | "failed"
  | "stalled"
  | "cancelled";

const EVENT_TO_STATUS: Record<string, DispatchStatus> = {
  dispatched: "dispatched",
  heartbeat: "in_progress",
  progress: "in_progress",
  completed: "done",
  failed: "failed",
  cancelled: "cancelled",
  retried: "in_progress",
  timeout: "failed",
  stalled: "stalled",
};

export function buildDispatchWebSocketPayload(
  runId: string,
  eventType: OrchestrationEventType,
  payload: DispatchEventPayload,
): Record<string, unknown> {
  return {
    type: "dispatch_event",
    run_id: runId,
    event_type: eventType,
    agent: payload.agent,
    title: payload.title,
    work_item_id: payload.work_item_id ?? null,
    progress_line: payload.progress_line ?? null,
    dispatch_type: payload.dispatch_type,
    status: EVENT_TO_STATUS[eventType] ?? "in_progress",
    timestamp: Date.now(),
    ...(payload.duration_ms != null ? { duration_ms: payload.duration_ms } : {}),
    ...(payload.cost_usd != null ? { cost_usd: payload.cost_usd } : {}),
  };
}

export function emitDispatchEvent(
  runId: string,
  eventType: OrchestrationEventType,
  payload: DispatchEventPayload,
): void {
  emitEvent(
    runId,
    eventType,
    payload.agent,
    payload.work_item_id ?? null,
    {
      agent: payload.agent,
      title: payload.title,
      work_item_id: payload.work_item_id ?? null,
      progress_line: payload.progress_line ?? null,
      dispatch_type: payload.dispatch_type,
      ...(payload.duration_ms != null ? { duration_ms: payload.duration_ms } : {}),
      ...(payload.cost_usd != null ? { cost_usd: payload.cost_usd } : {}),
    },
  );

  try {
    const wsPayload = buildDispatchWebSocketPayload(runId, eventType, payload);
    broadcastDispatchEvent(wsPayload);
  } catch (err) {
    logger.warn("WebSocket broadcast failed", { runId, eventType, error: err instanceof Error ? err.message : String(err) });
  }
}
