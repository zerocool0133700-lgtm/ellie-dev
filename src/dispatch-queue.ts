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

/** Max times a queued dispatch can be re-enqueued before being dropped. */
export const MAX_QUEUE_RETRIES = 3;

/** Max age (ms) for a queued dispatch before it expires (10 minutes). */
export const QUEUE_TTL_MS = 10 * 60 * 1000;

export interface QueuedDispatch {
  id: string;
  agentType: string;
  workItemId: string;
  channel: string;
  message?: string;
  enqueuedAt: number;
  /** How many times this dispatch has been re-queued after failing to acquire a slot. */
  retryCount: number;
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
    retryCount: item.retryCount,
  });

  return { queueId: item.id, position };
}

// ── Drain ────────────────────────────────────────────────────

/**
 * Called when a run ends for a work item.
 * Dequeues and executes the next pending dispatch, if any.
 * Drops items that have exceeded max retries or TTL.
 */
export function drainNext(workItemId: string): void {
  const q = queues.get(workItemId);
  if (!q || q.length === 0) {
    queues.delete(workItemId);
    return;
  }

  const next = q.shift()!;
  if (q.length === 0) queues.delete(workItemId);

  // Check TTL — drop if item has been waiting too long
  const age = Date.now() - next.enqueuedAt;
  if (age > QUEUE_TTL_MS) {
    logger.warn("Queued dispatch expired (TTL exceeded)", {
      queueId: next.id.slice(0, 8),
      agentType: next.agentType,
      workItemId,
      ageMs: age,
      ttlMs: QUEUE_TTL_MS,
    });

    emitEvent(next.id, "cancelled", next.agentType, next.workItemId, {
      reason: "queue_ttl_expired",
      age_ms: age,
    });

    notify(next.notifyCtx, {
      event: "dispatch_confirm",
      workItemId: next.workItemId,
      telegramMessage: `⚠️ ${next.workItemId} dispatch expired after ${Math.round(age / 1000)}s in queue — dropping`,
    }).catch(() => {});

    // Continue draining — next item in queue may still be valid
    drainNext(workItemId);
    return;
  }

  // Check retry count — drop if re-queued too many times
  if (next.retryCount >= MAX_QUEUE_RETRIES) {
    logger.warn("Queued dispatch dropped (max retries exceeded)", {
      queueId: next.id.slice(0, 8),
      agentType: next.agentType,
      workItemId,
      retryCount: next.retryCount,
      maxRetries: MAX_QUEUE_RETRIES,
    });

    emitEvent(next.id, "cancelled", next.agentType, next.workItemId, {
      reason: "queue_max_retries",
      retry_count: next.retryCount,
    });

    notify(next.notifyCtx, {
      event: "dispatch_confirm",
      workItemId: next.workItemId,
      telegramMessage: `⚠️ ${next.workItemId} dispatch failed after ${next.retryCount} retries — work item may be permanently blocked`,
    }).catch(() => {});

    // Continue draining
    drainNext(workItemId);
    return;
  }

  logger.info("Draining queued dispatch", {
    queueId: next.id.slice(0, 8),
    agentType: next.agentType,
    workItemId,
    retryCount: next.retryCount,
    remaining: q?.length ?? 0,
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
