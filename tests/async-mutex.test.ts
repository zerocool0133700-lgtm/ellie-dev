/**
 * ELLIE-559 — async-mutex.ts tests
 *
 * Tests lock serialization, queueing, and timeout behavior.
 */

import { describe, test, expect } from "bun:test";
import { AsyncMutex } from "../src/async-mutex.ts";

// ── Basic locking ───────────────────────────────────────────

describe("AsyncMutex — basic", () => {
  test("starts unlocked", () => {
    const mutex = new AsyncMutex();
    expect(mutex.locked).toBe(false);
    expect(mutex.queueLength).toBe(0);
  });

  test("withLock executes the function", async () => {
    const mutex = new AsyncMutex();
    const result = await mutex.withLock(async () => 42);
    expect(result).toBe(42);
  });

  test("unlocked after withLock completes", async () => {
    const mutex = new AsyncMutex();
    await mutex.withLock(async () => {});
    expect(mutex.locked).toBe(false);
  });

  test("unlocked after withLock throws", async () => {
    const mutex = new AsyncMutex();
    try {
      await mutex.withLock(async () => { throw new Error("boom"); });
    } catch {}
    expect(mutex.locked).toBe(false);
  });
});

// ── Serialization ───────────────────────────────────────────

describe("AsyncMutex — serialization", () => {
  test("concurrent calls execute in order", async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];

    const p1 = mutex.withLock(async () => {
      await new Promise(r => setTimeout(r, 20));
      order.push(1);
    });
    const p2 = mutex.withLock(async () => {
      order.push(2);
    });
    const p3 = mutex.withLock(async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("queueLength reflects pending waiters", async () => {
    const mutex = new AsyncMutex();
    let resolve: () => void;
    const blocker = new Promise<void>(r => { resolve = r; });

    const p1 = mutex.withLock(async () => { await blocker; });
    // Wait for p1 to acquire the lock
    await new Promise(r => setTimeout(r, 5));

    const p2 = mutex.withLock(async () => {});
    const p3 = mutex.withLock(async () => {});

    expect(mutex.queueLength).toBe(2);
    resolve!();
    await Promise.all([p1, p2, p3]);
    expect(mutex.queueLength).toBe(0);
  });
});

// ── Timeout ─────────────────────────────────────────────────

describe("AsyncMutex — timeout", () => {
  test("throws on timeout", async () => {
    const mutex = new AsyncMutex();
    let resolve: () => void;
    const blocker = new Promise<void>(r => { resolve = r; });

    const p1 = mutex.withLock(async () => { await blocker; });
    await new Promise(r => setTimeout(r, 5));

    await expect(mutex.withLock(async () => {}, 50)).rejects.toThrow("timed out");

    resolve!();
    await p1;
  });

  test("timed out waiter removed from queue", async () => {
    const mutex = new AsyncMutex();
    let resolve: () => void;
    const blocker = new Promise<void>(r => { resolve = r; });

    const p1 = mutex.withLock(async () => { await blocker; });
    await new Promise(r => setTimeout(r, 5));

    try {
      await mutex.withLock(async () => {}, 50);
    } catch {}

    expect(mutex.queueLength).toBe(0);
    resolve!();
    await p1;
  });
});
