/**
 * ELLIE-481 — Memory dedup search unavailability handling
 *
 * Verifies that:
 * - checkMemoryConflict returns { available: false } when search errors
 * - insertMemoryWithDedup queues the insert instead of silently skipping dedup
 * - getPendingMemoryQueue / clearPendingMemoryQueue manage the queue
 * - flushPendingMemoryInserts drains the queue when search is back
 * - isSearchAvailable / getMemorySearchHealth reflect circuit breaker + queue state
 */

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import {
  checkMemoryConflict,
  insertMemoryWithDedup,
  getPendingMemoryQueue,
  clearPendingMemoryQueue,
  flushPendingMemoryInserts,
  isSearchAvailable,
  getMemorySearchHealth,
  type MemoryInsertParams,
} from "../src/memory.ts";
import { breakers } from "../src/resilience.ts";

// ── Setup ────────────────────────────────────────────────────────

beforeEach(() => {
  breakers.edgeFn.reset();      // clean circuit breaker state
  clearPendingMemoryQueue();    // clean pending queue
});

afterAll(() => {
  breakers.edgeFn.reset();
  clearPendingMemoryQueue();
});

// ── Mock helpers ─────────────────────────────────────────────────

function makeSupabase(opts?: {
  searchError?: string;
  searchResults?: any[];
  insertId?: string;
  insertError?: any;
}) {
  const {
    searchError = null,
    searchResults = [],
    insertId = "new-id",
    insertError = null,
  } = opts ?? {};

  function insertChain() {
    const p = Promise.resolve({ data: insertError ? null : { id: insertId }, error: insertError });
    const c: any = { select: () => c, eq: () => c, single: () => p };
    c.then = (r: Function, rj?: Function) => p.then(r, rj);
    c.catch = (rj: Function) => p.catch(rj);
    return c;
  }

  function updateChain() {
    const p = Promise.resolve({ data: null, error: null });
    const c: any = { eq: () => c };
    c.then = (r: Function, rj?: Function) => p.then(r, rj);
    c.catch = (rj: Function) => p.catch(rj);
    return c;
  }

  return {
    from: mock(() => ({ insert: insertChain, update: updateChain, select: insertChain })),
    functions: {
      invoke: mock(() =>
        Promise.resolve({
          data: searchError ? null : searchResults,
          error: searchError ?? null,
        })
      ),
    },
    rpc: mock(() => Promise.resolve({ data: [], error: null })),
  } as any;
}

// ── isSearchAvailable ─────────────────────────────────────────────

describe("isSearchAvailable", () => {
  test("returns true when circuit breaker is closed (initial state)", () => {
    expect(isSearchAvailable()).toBe(true);
  });
});

// ── getMemorySearchHealth ─────────────────────────────────────────

describe("getMemorySearchHealth", () => {
  test("returns correct shape with empty pending queue", () => {
    const health = getMemorySearchHealth();
    expect(health).toHaveProperty("searchAvailable");
    expect(health).toHaveProperty("pendingQueueLength");
    expect(typeof health.searchAvailable).toBe("boolean");
    expect(typeof health.pendingQueueLength).toBe("number");
  });

  test("reports searchAvailable:true when breaker is closed", () => {
    const { searchAvailable } = getMemorySearchHealth();
    expect(searchAvailable).toBe(true);
  });

  test("pendingQueueLength reflects pending queue size", async () => {
    const supabase = makeSupabase({ searchError: "unavailable" });
    await insertMemoryWithDedup(supabase, {
      type: "fact", content: "test fact", source_agent: "test", visibility: "shared",
    });
    const { pendingQueueLength } = getMemorySearchHealth();
    expect(pendingQueueLength).toBe(1);
  });
});

// ── checkMemoryConflict — available:false path ────────────────────

describe("checkMemoryConflict — search unavailable", () => {
  test("returns { available: false } when Edge Function errors", async () => {
    const supabase = makeSupabase({ searchError: "service unavailable" });
    const result = await checkMemoryConflict(supabase, "test content", "fact");
    expect(result.available).toBe(false);
  });

  test("returns { available: true, match: null } when search succeeds with no results", async () => {
    const supabase = makeSupabase({ searchResults: [] });
    const result = await checkMemoryConflict(supabase, "unique content", "fact");
    expect(result.available).toBe(true);
    if (result.available) expect(result.match).toBeNull();
  });
});

// ── insertMemoryWithDedup — queuing behavior ──────────────────────

describe("insertMemoryWithDedup — pending queue", () => {
  test("queues insert when search unavailable and returns action:queued", async () => {
    const supabase = makeSupabase({ searchError: "Edge Function down" });

    const result = await insertMemoryWithDedup(supabase, {
      type: "fact",
      content: "deferred fact",
      source_agent: "general",
      visibility: "shared",
    });

    expect(result.action).toBe("queued");
    expect(result.id).toBeNull();
    expect(getPendingMemoryQueue()).toHaveLength(1);
  });

  test("queued insert preserves all params", async () => {
    const supabase = makeSupabase({ searchError: "down" });
    const params: MemoryInsertParams = {
      type: "goal",
      content: "finish ELLIE-481",
      source_agent: "research",
      visibility: "private",
      deadline: "2026-04-01",
      conversation_id: "conv-123",
    };

    await insertMemoryWithDedup(supabase, params);

    const queue = getPendingMemoryQueue();
    expect(queue[0]).toMatchObject(params);
  });

  test("multiple unavailable calls accumulate in queue", async () => {
    const supabase = makeSupabase({ searchError: "down" });
    await insertMemoryWithDedup(supabase, { type: "fact", content: "fact 1", source_agent: "g", visibility: "shared" });
    await insertMemoryWithDedup(supabase, { type: "fact", content: "fact 2", source_agent: "g", visibility: "shared" });
    expect(getPendingMemoryQueue()).toHaveLength(2);
  });

  test("inserts normally (not queued) when search is available", async () => {
    const supabase = makeSupabase({ searchResults: [], insertId: "ok-id" });
    const result = await insertMemoryWithDedup(supabase, {
      type: "fact", content: "normal fact", source_agent: "g", visibility: "shared",
    });
    expect(result.action).toBe("inserted");
    expect(result.id).toBe("ok-id");
    expect(getPendingMemoryQueue()).toHaveLength(0);
  });
});

// ── getPendingMemoryQueue / clearPendingMemoryQueue ───────────────

describe("getPendingMemoryQueue / clearPendingMemoryQueue", () => {
  test("getPendingMemoryQueue returns empty array initially", () => {
    expect(getPendingMemoryQueue()).toHaveLength(0);
  });

  test("getPendingMemoryQueue returns a copy (not the internal array)", async () => {
    const supabase = makeSupabase({ searchError: "down" });
    await insertMemoryWithDedup(supabase, { type: "fact", content: "test", source_agent: "g", visibility: "shared" });

    const queue = getPendingMemoryQueue();
    queue.push({ type: "fact", content: "injected", source_agent: "hack", visibility: "shared" });

    // Internal queue should be unaffected
    expect(getPendingMemoryQueue()).toHaveLength(1);
  });

  test("clearPendingMemoryQueue empties the queue", async () => {
    const supabase = makeSupabase({ searchError: "down" });
    await insertMemoryWithDedup(supabase, { type: "fact", content: "test", source_agent: "g", visibility: "shared" });
    expect(getPendingMemoryQueue()).toHaveLength(1);

    clearPendingMemoryQueue();
    expect(getPendingMemoryQueue()).toHaveLength(0);
  });
});

// ── flushPendingMemoryInserts ─────────────────────────────────────

describe("flushPendingMemoryInserts", () => {
  test("returns flushed:0 remaining:0 when queue is empty", async () => {
    const supabase = makeSupabase();
    const result = await flushPendingMemoryInserts(supabase);
    expect(result.flushed).toBe(0);
    expect(result.remaining).toBe(0);
  });

  test("returns remaining count when search is still unavailable during flush", async () => {
    const errorSupabase = makeSupabase({ searchError: "still down" });

    // Queue 1 item
    await insertMemoryWithDedup(errorSupabase, { type: "fact", content: "stuck item", source_agent: "g", visibility: "shared" });
    expect(getPendingMemoryQueue()).toHaveLength(1);

    // Try to flush while still down
    const result = await flushPendingMemoryInserts(errorSupabase);
    expect(result.flushed).toBe(0);
    expect(result.remaining).toBe(1);
    expect(getPendingMemoryQueue()).toHaveLength(1);
  });

  test("flushes queued items when search is available", async () => {
    const errorSupabase = makeSupabase({ searchError: "was down" });
    await insertMemoryWithDedup(errorSupabase, { type: "fact", content: "queued fact", source_agent: "g", visibility: "shared" });
    await insertMemoryWithDedup(errorSupabase, { type: "fact", content: "another queued fact", source_agent: "g", visibility: "shared" });
    expect(getPendingMemoryQueue()).toHaveLength(2);

    // Reset breaker so the probe succeeds, then flush with working supabase
    breakers.edgeFn.reset();
    const okSupabase = makeSupabase({ searchResults: [], insertId: "flushed-id" });
    const result = await flushPendingMemoryInserts(okSupabase);

    expect(result.flushed).toBe(2);
    expect(result.remaining).toBe(0);
    expect(getPendingMemoryQueue()).toHaveLength(0);
  });

  test("queue is empty after successful flush", async () => {
    const errorSupabase = makeSupabase({ searchError: "down" });
    await insertMemoryWithDedup(errorSupabase, { type: "fact", content: "item", source_agent: "g", visibility: "shared" });

    breakers.edgeFn.reset();
    const okSupabase = makeSupabase({ searchResults: [], insertId: "ok-id" });
    await flushPendingMemoryInserts(okSupabase);

    expect(getPendingMemoryQueue()).toHaveLength(0);
  });
});
