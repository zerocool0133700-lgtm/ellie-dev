/**
 * Dispatch Queue — ELLIE-396
 *
 * Per-agent FIFO queue for sequential task execution.
 * When an agent is busy (dispatch lock blocks), the new dispatch
 * is enqueued instead of rejected. Queued items execute in order
 * when the current run completes.
 *
 * Queue lifecycle:
 *   1. Dispatch blocked by lock → enqueue()
 *   2. Current run ends → drainNext() fires
 *   3. Next queued item dispatches (or queue empties)
 *   4. User can inspect or cancel queued items
 */

import { log } from "./logger.ts";
import { emitEvent } from "./orchestration-ledger.ts";
import { notify, type NotifyContext } from "./notification-policy.ts";

const logger = log.child("dispatch-queue");

// ── Types ────────────────────────────────────────────────────

export interface QueuedDispatch {
  id: string;
  agentType: string;
  workItemId: string;
  channel: string;
  message?: string;
  enqueuedAt: number;
  /** Callback that actually fires the dispatch. */
  execute: () => void;
  /** Notification context for user alerts. */
  notifyCtx: NotifyContext;
}

export interface QueueStatus {
  /** Per-agent queue depths. */
  agents: Record<string, number>;
  /** Total queued items across all agents. */
  total: number;
  /** Full queue details. */
  items: Array<{
    id: string;
    agentType: string;
    workItemId: string;
    enqueuedAt: number;
    position: number;
  }>;
}

// ── In-memory queue state ────────────────────────────────────

/** Per work-item queues. Key = workItemId. */
const queues = new Map<string, QueuedDispatch[]>();

// ── Enqueue ──────────────────────────────────────────────────

/**
 * Add a dispatch to the queue for a work item.
 * Returns the queue ID and position.
 */
export function enqueue(item: QueuedDispatch): { queueId: string; position: number } {
  const { workItemId } = item;
  let q = queues.get(workItemId);
  if (!q) {
    q = [];
    queues.set(workItemId, q);
  }
  q.push(item);
  const position = q.length;

  logger.info("Dispatch queued", {
    queueId: item.id.slice(0, 8),
    agentType: item.agentType,
    workItemId,
    position,
  });

  return { queueId: item.id, position };
}

// ── Drain ────────────────────────────────────────────────────

/**
 * Called when a run ends for a work item.
 * Dequeues and executes the next pending dispatch, if any.
 */
export function drainNext(workItemId: string): void {
  const q = queues.get(workItemId);
  if (!q || q.length === 0) {
    queues.delete(workItemId);
    return;
  }

  const next = q.shift()!;
  if (q.length === 0) queues.delete(workItemId);

  logger.info("Draining queued dispatch", {
    queueId: next.id.slice(0, 8),
    agentType: next.agentType,
    workItemId,
    remaining: q.length,
  });

  // Fire the dispatch asynchronously
  try {
    next.execute();
  } catch (err) {
    logger.error("Queued dispatch execute failed", {
      queueId: next.id.slice(0, 8),
      workItemId,
    }, err);
  }
}

// ── Cancel ───────────────────────────────────────────────────

/**
 * Cancel a queued dispatch by its queue ID.
 * Returns true if found and removed.
 */
export function cancelQueued(queueId: string): boolean {
  for (const [workItemId, q] of queues) {
    const idx = q.findIndex(item => item.id === queueId);
    if (idx >= 0) {
      const removed = q.splice(idx, 1)[0];
      if (q.length === 0) queues.delete(workItemId);

      logger.info("Queued dispatch cancelled", {
        queueId: queueId.slice(0, 8),
        agentType: removed.agentType,
        workItemId: removed.workItemId,
      });

      emitEvent(queueId, "cancelled", removed.agentType, removed.workItemId, {
        reason: "user_cancel_queued",
      });

      return true;
    }
  }
  return false;
}

/**
 * Cancel all queued dispatches for a work item.
 * Returns the count of cancelled items.
 */
export function cancelAllForWorkItem(workItemId: string): number {
  const q = queues.get(workItemId);
  if (!q || q.length === 0) return 0;

  const count = q.length;
  for (const item of q) {
    emitEvent(item.id, "cancelled", item.agentType, item.workItemId, {
      reason: "user_cancel_all_queued",
    });
  }
  queues.delete(workItemId);

  logger.info("All queued dispatches cancelled for work item", {
    workItemId,
    count,
  });

  return count;
}

// ── Status ───────────────────────────────────────────────────

/** Get current queue status across all agents. */
export function getQueueStatus(): QueueStatus {
  const agents: Record<string, number> = {};
  const items: QueueStatus["items"] = [];

  for (const [, q] of queues) {
    for (let i = 0; i < q.length; i++) {
      const item = q[i];
      agents[item.agentType] = (agents[item.agentType] || 0) + 1;
      items.push({
        id: item.id,
        agentType: item.agentType,
        workItemId: item.workItemId,
        enqueuedAt: item.enqueuedAt,
        position: i + 1,
      });
    }
  }

  return {
    agents,
    total: items.length,
    items,
  };
}

/** Get queue depth for a specific work item. */
export function getQueueDepth(workItemId: string): number {
  return queues.get(workItemId)?.length || 0;
}
