/**
 * API Route Tests: Memory — ELLIE-710
 *
 * Tests forest memory write/read/resolve/arcs validation.
 * Verifies request body validation and response shapes.
 */

import { describe, test, expect, mock } from "bun:test";

// ── Mocks ─────────────────────────────────────────────────────
const mockSql = mock(async () => []);
mock.module("../../../ellie-forest/src/index", () => ({
  writeMemory: mock(async () => ({ id: "mem-001" })),
  readMemories: mock(async () => []),
  getMemory: mock(async () => null),
  getAgentContext: mock(async () => []),
  findContradictions: mock(async () => []),
  resolveContradiction: mock(async () => ({})),
  markAsContradiction: mock(async () => ({})),
  boostConfidence: mock(async () => ({})),
  tryAutoResolve: mock(async () => null),
  dispatchCreature: mock(async () => ({})),
  writeCreatureMemory: mock(async () => ({ id: "cmem-001" })),
  createArc: mock(async () => ({ id: "arc-001" })),
  getArc: mock(async () => null),
  updateArc: mock(async () => ({})),
  addMemoryToArc: mock(async () => ({})),
  listArcs: mock(async () => []),
  getArcsForMemory: mock(async () => []),
  sql: mockSql,
}));
mock.module("../src/entailment-classifier.ts", () => ({
  classifyEntailment: mock(async () => ({ label: "neutral", confidence: 0.5 })),
}));
mock.module("../src/notification-policy.ts", () => ({
  notify: mock(async () => {}),
}));
mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

import {
  writeMemoryEndpoint,
  readMemoryEndpoint,
  resolveContradictionEndpoint,
  arcsEndpoint,
} from "../src/api/memory.ts";

function makeReq(body: Record<string, unknown> = {}): any {
  return { body };
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

const mockBot = {} as any;

describe("memory API", () => {
  describe("writeMemoryEndpoint", () => {
    test("rejects missing content", async () => {
      const res = makeRes();
      await writeMemoryEndpoint(makeReq({}), res, mockBot);
      expect(res.getStatus()).toBe(400);
      expect((res.getBody() as any).error).toContain("content");
    });

    test("rejects empty content", async () => {
      const res = makeRes();
      await writeMemoryEndpoint(makeReq({ content: "" }), res, mockBot);
      expect(res.getStatus()).toBe(400);
    });

    test("accepts valid write request", async () => {
      const res = makeRes();
      await writeMemoryEndpoint(makeReq({
        content: "Dave prefers dark mode",
        type: "fact",
        scope: "global",
      }), res, mockBot);
      expect(res.getStatus()).toBe(200);
      expect((res.getBody() as any).success).toBe(true);
    });

    test("rejects invalid duration 'working'", async () => {
      const res = makeRes();
      await writeMemoryEndpoint(makeReq({
        content: "test",
        duration: "working",
      }), res, mockBot);
      expect(res.getStatus()).toBe(400);
    });
  });

  describe("readMemoryEndpoint", () => {
    test("rejects missing query", async () => {
      const res = makeRes();
      await readMemoryEndpoint(makeReq({}), res, mockBot);
      expect(res.getStatus()).toBe(400);
      expect((res.getBody() as any).error).toContain("query");
    });

    test("accepts valid read request", async () => {
      const res = makeRes();
      await readMemoryEndpoint(makeReq({ query: "dark mode preference" }), res, mockBot);
      expect(res.getStatus()).toBe(200);
      expect((res.getBody() as any).success).toBe(true);
    });
  });

  describe("resolveContradictionEndpoint", () => {
    test("rejects missing memory_id", async () => {
      const res = makeRes();
      await resolveContradictionEndpoint(makeReq({ resolution: "keep_new" }), res, mockBot);
      expect(res.getStatus()).toBe(400);
    });

    test("rejects missing resolution", async () => {
      const res = makeRes();
      await resolveContradictionEndpoint(makeReq({ memory_id: "mem-1" }), res, mockBot);
      expect(res.getStatus()).toBe(400);
    });

    test("rejects invalid resolution type", async () => {
      const res = makeRes();
      await resolveContradictionEndpoint(makeReq({
        memory_id: "mem-1",
        resolution: "invalid",
      }), res, mockBot);
      expect(res.getStatus()).toBe(400);
    });

    test("rejects merge without merged_content", async () => {
      const res = makeRes();
      await resolveContradictionEndpoint(makeReq({
        memory_id: "mem-1",
        resolution: "merge",
      }), res, mockBot);
      expect(res.getStatus()).toBe(400);
    });
  });

  describe("arcsEndpoint", () => {
    test("rejects missing action", async () => {
      const res = makeRes();
      await arcsEndpoint(makeReq({}), res, mockBot);
      expect(res.getStatus()).toBe(400);
    });

    test("rejects invalid action", async () => {
      const res = makeRes();
      await arcsEndpoint(makeReq({ action: "invalid" }), res, mockBot);
      expect(res.getStatus()).toBe(400);
    });

    test("rejects create without name", async () => {
      const res = makeRes();
      await arcsEndpoint(makeReq({ action: "create" }), res, mockBot);
      expect(res.getStatus()).toBe(400);
    });

    test("rejects get without arc_id", async () => {
      const res = makeRes();
      await arcsEndpoint(makeReq({ action: "get" }), res, mockBot);
      expect(res.getStatus()).toBe(400);
    });

    test("accepts list action", async () => {
      const res = makeRes();
      await arcsEndpoint(makeReq({ action: "list" }), res, mockBot);
      expect(res.getStatus()).toBe(200);
      expect((res.getBody() as any).success).toBe(true);
    });
  });
});
