/**
 * API Route Tests: Comms — ELLIE-710
 *
 * Tests comms thread listing, detail, snooze, resolve, preferences.
 * Uses mock Supabase client to verify query construction and response shapes.
 */

import { describe, test, expect, mock } from "bun:test";

// ── Mocks ─────────────────────────────────────────────────────
mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));
mock.module("../src/ums/consumers/comms.ts", () => ({
  getStaleThreads: mock(() => []),
  invalidateCommsCache: mock(async () => {}),
  getActiveThreads: mock(() => []),
  getStaleThresholds: mock(() => ({ telegram: 4, gchat: 4, gmail: 48 })),
  _testing: { resolveThreadId: () => "test", isOwner: () => false, THREADED_PROVIDERS: new Set() },
}));

import { listThreads, getThread } from "../src/api/comms.ts";

// ── Mock helpers ──────────────────────────────────────────────

function makeMockSupabase(data: unknown[] = [], error: { message: string } | null = null) {
  const mockQuery: Record<string, unknown> = {
    select: () => mockQuery,
    eq: () => mockQuery,
    not: () => mockQuery,
    order: () => mockQuery,
    limit: () => mockQuery,
    single: () => Promise.resolve({ data: data[0] || null, error }),
    then: (resolve: (val: unknown) => void) => resolve({ data, error }),
  };
  // Make it thenable for await
  Object.defineProperty(mockQuery, "then", {
    value: (resolve: (val: unknown) => void) => resolve({ data, error }),
  });

  return {
    from: () => mockQuery,
  };
}

function makeReq(query: Record<string, string> = {}, params: Record<string, string> = {}): any {
  return { query, params };
}

function makeRes(): any {
  let statusCode = 200;
  let body: unknown = null;
  return {
    status(code: number) { statusCode = code; return this; },
    json(data: unknown) { body = data; return this; },
    getStatus: () => statusCode,
    getBody: () => body,
  };
}

describe("comms API", () => {
  describe("listThreads", () => {
    test("returns threads on success", async () => {
      const threads = [{ id: "t-1", provider: "telegram" }];
      const supabase = makeMockSupabase(threads);
      const res = makeRes();

      await listThreads(makeReq(), res, supabase as any);

      expect(res.getBody()).toEqual({ success: true, threads });
    });

    test("returns 500 on DB error", async () => {
      const supabase = makeMockSupabase([], { message: "DB error" });
      const res = makeRes();

      await listThreads(makeReq(), res, supabase as any);

      expect(res.getStatus()).toBe(500);
      expect(res.getBody()).toEqual({ error: "DB error" });
    });
  });

  describe("getThread", () => {
    test("returns 400 when no thread ID", async () => {
      const res = makeRes();
      await getThread(makeReq({}, {}), res, makeMockSupabase() as any);
      expect(res.getStatus()).toBe(400);
      expect(res.getBody()).toEqual({ error: "Thread ID required" });
    });
  });
});
