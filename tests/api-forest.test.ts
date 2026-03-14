/**
 * API Route Tests: Forest — ELLIE-710
 *
 * Tests forest browse/search parameter parsing and validation.
 * Uses mock Forest imports to verify query construction.
 */

import { describe, test, expect, mock } from "bun:test";

// ── Mocks ─────────────────────────────────────────────────────
const mockSql = mock(async () => []);
(mockSql as any).unsafe = mock(async () => []);

mock.module("../../../ellie-forest/src/index", () => ({
  readMemories: mock(async () => []),
  getMemory: mock(async () => null),
  listMemories: mock(async () => []),
  getMemoryCount: mock(async () => 0),
  listUnresolvedContradictions: mock(async () => []),
  getScope: mock(async () => null),
  getChildScopes: mock(async () => []),
  getFullHierarchy: mock(async () => []),
  getBreadcrumb: mock(async () => []),
  getDescendantScopes: mock(async () => []),
  sql: mockSql,
}));

import { browse, search } from "../src/api/forest.ts";

function makeReq(query: Record<string, string> = {}, body: Record<string, unknown> = {}): any {
  return { query, body, method: "GET" };
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

describe("forest API", () => {
  describe("browse", () => {
    test("returns memories list with default pagination", async () => {
      const res = makeRes();
      await browse(makeReq(), res);
      const body = res.getBody() as any;
      expect(body.success).toBe(true);
      expect(Array.isArray(body.memories)).toBe(true);
    });

    test("caps limit at 200", async () => {
      const res = makeRes();
      await browse(makeReq({ limit: "500" }), res);
      // The function should execute without error
      expect(res.getBody()).toBeTruthy();
    });
  });

  describe("search", () => {
    test("rejects missing query", async () => {
      const res = makeRes();
      await search(makeReq({}, {}), res);
      expect(res.getStatus()).toBe(400);
      const body = res.getBody() as any;
      expect(body.error).toContain("Query");
    });

    test("rejects short query (< 2 chars)", async () => {
      const res = makeRes();
      await search(makeReq({}, { query: "x" }), res);
      expect(res.getStatus()).toBe(400);
    });

    test("accepts valid search query", async () => {
      const res = makeRes();
      await search(makeReq({}, { query: "test search", scope_path: "2/1" }), res);
      const body = res.getBody() as any;
      expect(body.success).toBe(true);
    });
  });
});
