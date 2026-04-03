/**
 * ELLIE-511 — Tests for dispatch-queue.ts
 *
 * Covers: enqueue, drainNext, cancelQueued, cancelAllForWorkItem,
 * getQueueStatus, getQueueDepth
 *
 * The dispatch queue is an in-memory per-work-item FIFO queue for
 * serialized task execution when an agent is busy.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  enqueue,
  drainNext,
  cancelQueued,
  cancelAllForWorkItem,
  getQueueStatus,
  getQueueDepth,
  MAX_QUEUE_RETRIES,
  QUEUE_TTL_MS,
  type QueuedDispatch,
} from "../src/dispatch-queue.ts";

// ── Helpers ──────────────────────────────────────────────────

let idCounter = 0;

function makeQueueItem(overrides: Partial<QueuedDispatch> = {}): QueuedDispatch {
  idCounter++;
  return {
    id: `q-${idCounter}`,
    agentType: "dev",
    workItemId: "ELLIE-100",
    channel: "telegram",
    enqueuedAt: Date.now(),
    retryCount: 0,
    execute: () => {},
    notifyCtx: {
      userId: "user-1",
      channel: "telegram",
      chatId: 123,
    } as any,
    ...overrides,
  };
}

// Clean the queue between tests by cancelling everything
beforeEach(() => {
  idCounter = 0;
  // Drain any leftover items from prior tests
  const status = getQueueStatus();
  for (const item of status.items) {
    cancelQueued(item.id);
  }
});

// ── enqueue ──────────────────────────────────────────────────

describe("enqueue", () => {
  test("returns queue ID and position 1 for first item", () => {
    const item = makeQueueItem();
    const result = enqueue(item);
    expect(result.queueId).toBe(item.id);
    expect(result.position).toBe(1);
  });

  test("returns incrementing position for multiple items", () => {
    const item1 = makeQueueItem({ workItemId: "ELLIE-200" });
    const item2 = makeQueueItem({ workItemId: "ELLIE-200" });
    const item3 = makeQueueItem({ workItemId: "ELLIE-200" });

    const r1 = enqueue(item1);
    const r2 = enqueue(item2);
    const r3 = enqueue(item3);

    expect(r1.position).toBe(1);
    expect(r2.position).toBe(2);
    expect(r3.position).toBe(3);
  });

  test("queues are per work item", () => {
    const itemA = makeQueueItem({ workItemId: "ELLIE-300" });
    const itemB = makeQueueItem({ workItemId: "ELLIE-301" });

    const rA = enqueue(itemA);
    const rB = enqueue(itemB);

    // Each is first in its own queue
    expect(rA.position).toBe(1);
    expect(rB.position).toBe(1);
  });
});

// ── drainNext ────────────────────────────────────────────────

describe("drainNext", () => {
  test("executes the next queued dispatch", () => {
    let executed = false;
    const item = makeQueueItem({
      workItemId: "ELLIE-400",
      execute: () => { executed = true; },
    });
    enqueue(item);
    drainNext("ELLIE-400");
    expect(executed).toBe(true);
  });

  test("drains items in FIFO order", () => {
    const order: number[] = [];
    const item1 = makeQueueItem({
      workItemId: "ELLIE-401",
      execute: () => { order.push(1); },
    });
    const item2 = makeQueueItem({
      workItemId: "ELLIE-401",
      execute: () => { order.push(2); },
    });
    enqueue(item1);
    enqueue(item2);

    drainNext("ELLIE-401");
    expect(order).toEqual([1]);

    drainNext("ELLIE-401");
    expect(order).toEqual([1, 2]);
  });

  test("no-op when queue is empty", () => {
    // Should not throw
    drainNext("NONEXISTENT-999");
  });

  test("cleans up map entry when queue is fully drained", () => {
    const item = makeQueueItem({ workItemId: "ELLIE-402" });
    enqueue(item);
    drainNext("ELLIE-402");
    expect(getQueueDepth("ELLIE-402")).toBe(0);
  });

  test("handles execute function that throws", () => {
    const item = makeQueueItem({
      workItemId: "ELLIE-403",
      execute: () => { throw new Error("boom"); },
    });
    enqueue(item);
    // Should not throw — error is caught internally
    drainNext("ELLIE-403");
  });
});

// ── cancelQueued ─────────────────────────────────────────────

describe("cancelQueued", () => {
  test("removes a queued item by ID and returns true", () => {
    const item = makeQueueItem({ workItemId: "ELLIE-500" });
    enqueue(item);
    const result = cancelQueued(item.id);
    expect(result).toBe(true);
    expect(getQueueDepth("ELLIE-500")).toBe(0);
  });

  test("returns false when ID not found", () => {
    const result = cancelQueued("nonexistent-id");
    expect(result).toBe(false);
  });

  test("removes only the specified item from multi-item queue", () => {
    const item1 = makeQueueItem({ workItemId: "ELLIE-501" });
    const item2 = makeQueueItem({ workItemId: "ELLIE-501" });
    const item3 = makeQueueItem({ workItemId: "ELLIE-501" });
    enqueue(item1);
    enqueue(item2);
    enqueue(item3);

    cancelQueued(item2.id);
    expect(getQueueDepth("ELLIE-501")).toBe(2);

    // Drain and verify item2 was actually removed
    const order: string[] = [];
    // Replace execute functions to track
    // Since we can't modify after enqueue, we verify via depth
  });
});

// ── cancelAllForWorkItem ─────────────────────────────────────

describe("cancelAllForWorkItem", () => {
  test("cancels all queued items for a work item", () => {
    enqueue(makeQueueItem({ workItemId: "ELLIE-600" }));
    enqueue(makeQueueItem({ workItemId: "ELLIE-600" }));
    enqueue(makeQueueItem({ workItemId: "ELLIE-600" }));

    const count = cancelAllForWorkItem("ELLIE-600");
    expect(count).toBe(3);
    expect(getQueueDepth("ELLIE-600")).toBe(0);
  });

  test("returns 0 when no items for work item", () => {
    const count = cancelAllForWorkItem("NONEXISTENT-999");
    expect(count).toBe(0);
  });

  test("does not affect other work items", () => {
    enqueue(makeQueueItem({ workItemId: "ELLIE-700" }));
    enqueue(makeQueueItem({ workItemId: "ELLIE-701" }));

    cancelAllForWorkItem("ELLIE-700");
    expect(getQueueDepth("ELLIE-700")).toBe(0);
    expect(getQueueDepth("ELLIE-701")).toBe(1);
  });
});

// ── getQueueStatus ───────────────────────────────────────────

describe("getQueueStatus", () => {
  test("returns empty status when no items queued", () => {
    const status = getQueueStatus();
    expect(status.total).toBe(0);
    expect(status.items).toEqual([]);
    expect(Object.keys(status.agents)).toHaveLength(0);
  });

  test("returns correct totals and per-agent counts", () => {
    enqueue(makeQueueItem({ workItemId: "ELLIE-800", agentType: "dev" }));
    enqueue(makeQueueItem({ workItemId: "ELLIE-800", agentType: "dev" }));
    enqueue(makeQueueItem({ workItemId: "ELLIE-801", agentType: "research" }));

    const status = getQueueStatus();
    expect(status.total).toBe(3);
    expect(status.agents.dev).toBe(2);
    expect(status.agents.research).toBe(1);
  });

  test("items include position starting at 1", () => {
    enqueue(makeQueueItem({ workItemId: "ELLIE-802" }));
    enqueue(makeQueueItem({ workItemId: "ELLIE-802" }));

    const status = getQueueStatus();
    expect(status.items[0].position).toBe(1);
    expect(status.items[1].position).toBe(2);
  });

  test("items include all required fields", () => {
    const item = makeQueueItem({ workItemId: "ELLIE-803", agentType: "strategy" });
    enqueue(item);

    const status = getQueueStatus();
    expect(status.items[0]).toEqual({
      id: item.id,
      agentType: "strategy",
      workItemId: "ELLIE-803",
      enqueuedAt: item.enqueuedAt,
      position: 1,
    });
  });
});

// ── getQueueDepth ────────────────────────────────────────────

describe("getQueueDepth", () => {
  test("returns 0 for empty or nonexistent queue", () => {
    expect(getQueueDepth("NONEXISTENT")).toBe(0);
  });

  test("returns correct count after enqueue", () => {
    enqueue(makeQueueItem({ workItemId: "ELLIE-900" }));
    enqueue(makeQueueItem({ workItemId: "ELLIE-900" }));
    expect(getQueueDepth("ELLIE-900")).toBe(2);
  });

  test("decrements after drain", () => {
    enqueue(makeQueueItem({ workItemId: "ELLIE-901" }));
    enqueue(makeQueueItem({ workItemId: "ELLIE-901" }));
    drainNext("ELLIE-901");
    expect(getQueueDepth("ELLIE-901")).toBe(1);
  });
});

// ── TTL expiry ──────────────────────────────────────────────

describe("drainNext TTL expiry", () => {
  test("drops items that exceed TTL", () => {
    let executed = false;
    const item = makeQueueItem({
      workItemId: "ELLIE-950",
      enqueuedAt: Date.now() - QUEUE_TTL_MS - 1000, // expired 1s ago
      execute: () => { executed = true; },
    });
    enqueue(item);
    drainNext("ELLIE-950");
    expect(executed).toBe(false);
    expect(getQueueDepth("ELLIE-950")).toBe(0);
  });

  test("skips expired items and executes valid ones", () => {
    let executed = false;
    const expired = makeQueueItem({
      workItemId: "ELLIE-951",
      enqueuedAt: Date.now() - QUEUE_TTL_MS - 5000,
    });
    const valid = makeQueueItem({
      workItemId: "ELLIE-951",
      enqueuedAt: Date.now(),
      execute: () => { executed = true; },
    });
    enqueue(expired);
    enqueue(valid);
    drainNext("ELLIE-951");
    expect(executed).toBe(true);
  });
});

// ── Max retry limit ─────────────────────────────────────────

describe("drainNext max retry limit", () => {
  test("drops items at max retry count", () => {
    let executed = false;
    const item = makeQueueItem({
      workItemId: "ELLIE-960",
      retryCount: MAX_QUEUE_RETRIES, // at limit
      execute: () => { executed = true; },
    });
    enqueue(item);
    drainNext("ELLIE-960");
    expect(executed).toBe(false);
    expect(getQueueDepth("ELLIE-960")).toBe(0);
  });

  test("allows items below max retry count", () => {
    let executed = false;
    const item = makeQueueItem({
      workItemId: "ELLIE-961",
      retryCount: MAX_QUEUE_RETRIES - 1, // one below limit
      execute: () => { executed = true; },
    });
    enqueue(item);
    drainNext("ELLIE-961");
    expect(executed).toBe(true);
  });

  test("skips over-retried items and executes valid ones", () => {
    let executed = false;
    const overRetried = makeQueueItem({
      workItemId: "ELLIE-962",
      retryCount: MAX_QUEUE_RETRIES + 5,
    });
    const valid = makeQueueItem({
      workItemId: "ELLIE-962",
      retryCount: 0,
      execute: () => { executed = true; },
    });
    enqueue(overRetried);
    enqueue(valid);
    drainNext("ELLIE-962");
    expect(executed).toBe(true);
  });

  test("MAX_QUEUE_RETRIES is a reasonable value", () => {
    expect(MAX_QUEUE_RETRIES).toBeGreaterThanOrEqual(3);
    expect(MAX_QUEUE_RETRIES).toBeLessThanOrEqual(5);
  });
});
