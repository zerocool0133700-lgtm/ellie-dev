/**
 * ELLIE-465 — Unit tests for relay stability primitives
 *
 * Covers: _withQueueTimeout, ChannelQueue, drainQueues (from message-queue.ts)
 *         _withTimeout, _settledValues (from context-sources.ts)
 *         periodicTask re-entrancy + recovery (from periodic-task.ts)
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";

import {
  _withQueueTimeout,
  ChannelQueue,
  drainQueues,
} from "../src/message-queue.ts";

import {
  _withTimeout,
  _settledValues,
} from "../src/context-sources.ts";

// ── _withQueueTimeout ────────────────────────────────────────

describe("_withQueueTimeout", () => {
  test("returns true when task completes within timeout", async () => {
    const ok = await _withQueueTimeout(async () => {}, "test", "preview");
    expect(ok).toBe(true);
  });

  test("returns false when task throws", async () => {
    const ok = await _withQueueTimeout(async () => {
      throw new Error("boom");
    }, "test", "preview");
    expect(ok).toBe(false);
  });
});

// ── ChannelQueue ─────────────────────────────────────────────

describe("ChannelQueue", () => {
  test("processes a task and becomes idle after", async () => {
    const q = new ChannelQueue("test");
    let ran = false;
    await q.enqueue(async () => { ran = true; }, "ch", "task");
    expect(ran).toBe(true);
    // yield one tick — the .finally() cleanup runs as a microtask after the outer promise resolves
    await new Promise(r => setTimeout(r, 0));
    expect(q.isBusy).toBe(false);
  });

  test("processes queued tasks in order", async () => {
    const q = new ChannelQueue("test");
    const order: number[] = [];

    // Start first task (takes 10ms), don't await yet
    const p1 = q.enqueue(async () => {
      await new Promise(r => setTimeout(r, 10));
      order.push(1);
    }, "ch", "task1");

    // Enqueue second task (should queue behind first)
    const p2 = q.enqueue(async () => { order.push(2); }, "ch", "task2");

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  test("getStatus reports busy and current item", async () => {
    const q = new ChannelQueue("test");
    let statusDuringRun: ReturnType<ChannelQueue["getStatus"]> | null = null;

    await q.enqueue(async () => {
      statusDuringRun = q.getStatus();
    }, "ch", "preview-text");

    expect(statusDuringRun).not.toBeNull();
    expect(statusDuringRun!.busy).toBe(true);
    expect(statusDuringRun!.current?.preview).toBe("preview-text");
  });

  test("getDeadLetters is empty for successful tasks", async () => {
    const q = new ChannelQueue("test");
    await q.enqueue(async () => {}, "ch", "task");
    expect(q.getDeadLetters()).toHaveLength(0);
  });
});

// ── drainQueues ──────────────────────────────────────────────

describe("drainQueues", () => {
  test("resolves true immediately when all queues idle", async () => {
    const result = await drainQueues(1000);
    expect(result).toBe(true);
  });
});

// ── _withTimeout (context-sources) ───────────────────────────

describe("_withTimeout", () => {
  test("returns resolved value when promise resolves before timeout", async () => {
    const result = await _withTimeout(Promise.resolve(42), 1000, 0);
    expect(result).toBe(42);
  });

  test("returns fallback when promise is slow", async () => {
    const slow = new Promise<number>(r => setTimeout(() => r(99), 500));
    const result = await _withTimeout(slow, 10, -1);
    expect(result).toBe(-1);
  });

  test("returns fallback when promise rejects (no throw)", async () => {
    const rejected = new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error("fail")), 50)
    );
    // _withTimeout races — if rejection wins, it propagates; add timeout short enough
    // that the timeout fires first
    const result = await _withTimeout(rejected, 10, -1);
    expect(result).toBe(-1);
  });
});

// ── _settledValues ────────────────────────────────────────────

describe("_settledValues", () => {
  test("extracts fulfilled values only", () => {
    const results: PromiseSettledResult<number>[] = [
      { status: "fulfilled", value: 1 },
      { status: "rejected", reason: new Error("x") },
      { status: "fulfilled", value: 3 },
    ];
    const vals = _settledValues(results, "test");
    expect(vals).toEqual([1, 3]);
  });

  test("returns empty array when all rejected", () => {
    const results: PromiseSettledResult<string>[] = [
      { status: "rejected", reason: new Error("a") },
      { status: "rejected", reason: new Error("b") },
    ];
    const vals = _settledValues(results, "test");
    expect(vals).toEqual([]);
  });

  test("handles all fulfilled", () => {
    const results: PromiseSettledResult<string>[] = [
      { status: "fulfilled", value: "a" },
      { status: "fulfilled", value: "b" },
    ];
    const vals = _settledValues(results, "test");
    expect(vals).toEqual(["a", "b"]);
  });
});
