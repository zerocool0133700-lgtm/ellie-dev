/**
 * ELLIE-511 — Tests for message-queue.ts
 *
 * Extends queue-primitives.test.ts coverage to include:
 * - ChannelQueue dead letter management (clearDeadLetterById, clearAllDeadLetters, restoreDeadLetter)
 * - enqueue/enqueueEllieChat module-level functions
 * - withQueue Telegram wrapper
 * - getQueueStatus combined status
 * - DLQ persistence (loadPersistedDeadLetters, clearAllDeadLetters, clearDeadLetterById)
 * - drainQueues timeout behavior
 *
 * queue-primitives.test.ts already covers: _withQueueTimeout, basic ChannelQueue, drainQueues idle case.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { writeFile, mkdir, unlink, readFile } from "node:fs/promises";

import {
  ChannelQueue,
  enqueue,
  enqueueEllieChat,
  getQueueStatus,
  loadPersistedDeadLetters,
  listDeadLetters,
  clearAllDeadLetters,
  clearDeadLetterById,
  drainQueues,
  setQueueBroadcast,
  type DeadLetterEntry,
} from "../src/message-queue.ts";

// ── Setup ────────────────────────────────────────────────────

// Suppress broadcast calls during tests
beforeEach(() => {
  setQueueBroadcast(() => {});
});

// ── ChannelQueue — dead letter management ────────────────────

describe("ChannelQueue — dead letter management", () => {
  test("restoreDeadLetter adds entry to dead letter list", () => {
    const q = new ChannelQueue("test-dlq");
    const entry: DeadLetterEntry = {
      id: "dl-1",
      channel: "telegram",
      preview: "test message",
      error: "timed out",
      ts: Date.now(),
      queue: "test-dlq",
    };
    q.restoreDeadLetter(entry);
    expect(q.getDeadLetters()).toHaveLength(1);
    expect(q.getDeadLetters()[0].id).toBe("dl-1");
  });

  test("clearDeadLetterById removes specific entry", () => {
    const q = new ChannelQueue("test-dlq");
    q.restoreDeadLetter({ id: "dl-1", channel: "ch", preview: "a", error: "err", ts: 1, queue: "test" });
    q.restoreDeadLetter({ id: "dl-2", channel: "ch", preview: "b", error: "err", ts: 2, queue: "test" });

    const found = q.clearDeadLetterById("dl-1");
    expect(found).toBe(true);
    expect(q.getDeadLetters()).toHaveLength(1);
    expect(q.getDeadLetters()[0].id).toBe("dl-2");
  });

  test("clearDeadLetterById returns false for unknown ID", () => {
    const q = new ChannelQueue("test-dlq");
    const found = q.clearDeadLetterById("nonexistent");
    expect(found).toBe(false);
  });

  test("clearAllDeadLetters empties the list", () => {
    const q = new ChannelQueue("test-dlq");
    q.restoreDeadLetter({ id: "dl-1", channel: "ch", preview: "a", error: "err", ts: 1, queue: "test" });
    q.restoreDeadLetter({ id: "dl-2", channel: "ch", preview: "b", error: "err", ts: 2, queue: "test" });

    q.clearAllDeadLetters();
    expect(q.getDeadLetters()).toHaveLength(0);
  });

  test("getDeadLetters returns a copy (not the internal array)", () => {
    const q = new ChannelQueue("test-dlq");
    q.restoreDeadLetter({ id: "dl-1", channel: "ch", preview: "a", error: "err", ts: 1, queue: "test" });

    const letters = q.getDeadLetters();
    letters.push({ id: "dl-fake", channel: "ch", preview: "b", error: "err", ts: 2, queue: "test" });
    expect(q.getDeadLetters()).toHaveLength(1); // original unaffected
  });
});

// ── ChannelQueue — getStatus ─────────────────────────────────

describe("ChannelQueue — getStatus details", () => {
  test("reports queued items with wait time", async () => {
    const q = new ChannelQueue("test-status");
    let resolve1: () => void;
    const p1 = new Promise<void>(r => { resolve1 = r; });

    // First task blocks the queue
    const enqueueP1 = q.enqueue(async () => { await p1; }, "ch", "first");

    // Second task gets queued
    const enqueueP2 = q.enqueue(async () => {}, "ch", "second");

    const status = q.getStatus();
    expect(status.busy).toBe(true);
    expect(status.current?.preview).toBe("first");
    expect(status.queueLength).toBe(1);
    expect(status.queued[0].preview).toBe("second");
    expect(status.queued[0].position).toBe(1);
    expect(status.queued[0].waitingMs).toBeGreaterThanOrEqual(0);

    // Unblock
    resolve1!();
    await Promise.all([enqueueP1, enqueueP2]);
  });

  test("reports current task duration", async () => {
    const q = new ChannelQueue("test-dur");
    let statusDuring: any = null;

    await q.enqueue(async () => {
      await new Promise(r => setTimeout(r, 10));
      statusDuring = q.getStatus();
    }, "ch", "timed");

    expect(statusDuring.current.durationMs).toBeGreaterThanOrEqual(5);
  });
});

// ── Module-level enqueue functions ───────────────────────────

describe("enqueue (main queue)", () => {
  test("processes a task on the main queue", async () => {
    let ran = false;
    await enqueue(async () => { ran = true; }, "google-chat", "test msg");
    expect(ran).toBe(true);
  });

  test("defaults channel to google-chat", async () => {
    let ran = false;
    await enqueue(async () => { ran = true; });
    expect(ran).toBe(true);
  });
});

describe("enqueueEllieChat", () => {
  test("processes a task on the ellie-chat queue", async () => {
    let ran = false;
    await enqueueEllieChat(async () => { ran = true; }, "test ellie msg");
    expect(ran).toBe(true);
  });
});

// ── getQueueStatus (combined) ────────────────────────────────

describe("getQueueStatus (combined)", () => {
  test("returns combined status from both queues", () => {
    const status = getQueueStatus();
    expect(status).toHaveProperty("busy");
    expect(status).toHaveProperty("queueLength");
    expect(status).toHaveProperty("current");
    expect(status).toHaveProperty("queued");
    expect(status).toHaveProperty("deadLetters");
    expect(Array.isArray(status.queued)).toBe(true);
    expect(Array.isArray(status.deadLetters)).toBe(true);
  });

  test("busy is false when both queues are idle", () => {
    const status = getQueueStatus();
    expect(status.busy).toBe(false);
  });
});

// ── DLQ persistence ──────────────────────────────────────────

describe("DLQ persistence", () => {
  const testDir = join(process.env.HOME ?? "/tmp", ".claude-relay-test-dlq");
  const testDlqPath = join(testDir, "dlq.jsonl");

  // We can't easily override RELAY_DIR/DLQ_PATH since they're module-level const.
  // Instead, test the module-level clearAllDeadLetters and listDeadLetters.

  test("listDeadLetters returns entries from both queues", () => {
    // After tests above, dead letters may exist. Just verify shape.
    const entries = listDeadLetters();
    expect(Array.isArray(entries)).toBe(true);
    for (const entry of entries) {
      expect(entry).toHaveProperty("id");
      expect(entry).toHaveProperty("channel");
      expect(entry).toHaveProperty("preview");
      expect(entry).toHaveProperty("error");
      expect(entry).toHaveProperty("ts");
      expect(entry).toHaveProperty("queue");
    }
  });

  test("clearAllDeadLetters empties both queues", async () => {
    await clearAllDeadLetters();
    const entries = listDeadLetters();
    expect(entries).toHaveLength(0);
  });
});

// ── drainQueues ──────────────────────────────────────────────

describe("drainQueues", () => {
  test("returns true immediately when all queues are idle", async () => {
    const result = await drainQueues(1000);
    expect(result).toBe(true);
  });

  test("returns false when timeout expires with busy queue", async () => {
    // Enqueue a slow task on the main queue
    let resolve: () => void;
    const blocker = new Promise<void>(r => { resolve = r; });

    const taskPromise = enqueue(async () => { await blocker; }, "test", "slow task");

    // Try to drain with very short timeout
    const result = await drainQueues(50);
    expect(result).toBe(false);

    // Unblock
    resolve!();
    await taskPromise;
  });
});

// ── ChannelQueue — error handling in process loop ────────────

describe("ChannelQueue — error handling", () => {
  test("failing task does not block the queue", async () => {
    const q = new ChannelQueue("test-err");
    const order: string[] = [];

    // First task fails
    try {
      await q.enqueue(async () => {
        order.push("fail");
        throw new Error("task error");
      }, "ch", "failing");
    } catch {
      // Expected
    }

    // Wait for queue to unblock
    await new Promise(r => setTimeout(r, 10));

    // Second task should still run
    await q.enqueue(async () => {
      order.push("success");
    }, "ch", "succeeding");

    expect(order).toContain("fail");
    expect(order).toContain("success");
  });

  test("queue becomes idle after all tasks complete or fail", async () => {
    const q = new ChannelQueue("test-idle");
    await q.enqueue(async () => {}, "ch", "task");
    await new Promise(r => setTimeout(r, 10));
    expect(q.isBusy).toBe(false);
    expect(q.length).toBe(0);
  });
});
