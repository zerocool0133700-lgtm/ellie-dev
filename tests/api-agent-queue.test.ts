/**
 * API Route Tests: Agent Queue — ELLIE-710
 *
 * Tests queue item creation validation and status update validation.
 * Uses mock Forest SQL to verify query construction.
 */

import { describe, test, expect, mock } from "bun:test";

// ── Mocks ─────────────────────────────────────────────────────
const mockSqlFn = Object.assign(
  mock(async (..._args: unknown[]) => []),
  { json: (v: unknown) => v },
);

mock.module("../../../ellie-forest/src/index", () => ({
  sql: mockSqlFn,
  writeMemory: mock(async () => ({ id: "mem-1" })),
}));
mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

import { createQueueItem, updateQueueStatus } from "../src/api/agent-queue.ts";

function makeReq(body: Record<string, unknown> = {}): any {
  return { body, url: "/api/queue/create" };
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

describe("agent-queue API", () => {
  describe("createQueueItem", () => {
    test("rejects missing required fields", async () => {
      const res = makeRes();
      await createQueueItem(makeReq({}), res);
      expect(res.getStatus()).toBe(400);
      expect((res.getBody() as any).error).toContain("Required");
    });

    test("rejects missing source", async () => {
      const res = makeRes();
      await createQueueItem(makeReq({
        target: "dev", category: "alert", title: "Test", content: "Test content",
      }), res);
      expect(res.getStatus()).toBe(400);
    });

    test("rejects missing target", async () => {
      const res = makeRes();
      await createQueueItem(makeReq({
        source: "gateway", category: "alert", title: "Test", content: "Test content",
      }), res);
      expect(res.getStatus()).toBe(400);
    });

    test("rejects missing category", async () => {
      const res = makeRes();
      await createQueueItem(makeReq({
        source: "gateway", target: "dev", title: "Test", content: "Test content",
      }), res);
      expect(res.getStatus()).toBe(400);
    });

    test("rejects missing title", async () => {
      const res = makeRes();
      await createQueueItem(makeReq({
        source: "gateway", target: "dev", category: "alert", content: "Test content",
      }), res);
      expect(res.getStatus()).toBe(400);
    });

    test("rejects missing content", async () => {
      const res = makeRes();
      await createQueueItem(makeReq({
        source: "gateway", target: "dev", category: "alert", title: "Test",
      }), res);
      expect(res.getStatus()).toBe(400);
    });
  });

  describe("updateQueueStatus", () => {
    test("rejects missing status", async () => {
      const res = makeRes();
      await updateQueueStatus(makeReq({}), res, "some-id");
      expect(res.getStatus()).toBe(400);
      expect((res.getBody() as any).error).toContain("status");
    });

    test("rejects invalid status value", async () => {
      const res = makeRes();
      await updateQueueStatus(makeReq({ status: "invalid" }), res, "some-id");
      expect(res.getStatus()).toBe(400);
    });

    test("rejects 'new' as status update", async () => {
      const res = makeRes();
      await updateQueueStatus(makeReq({ status: "new" }), res, "some-id");
      expect(res.getStatus()).toBe(400);
    });

    test("accepts 'acknowledged' status", async () => {
      // Will get 404 since mock SQL returns [] but validation passes
      const res = makeRes();
      await updateQueueStatus(makeReq({ status: "acknowledged" }), res, "some-id");
      // Either 200 (if mock returns item) or 404 (mock returns []) — validation passed
      expect(res.getStatus()).not.toBe(400);
    });

    test("accepts 'completed' status", async () => {
      const res = makeRes();
      await updateQueueStatus(makeReq({ status: "completed" }), res, "some-id");
      expect(res.getStatus()).not.toBe(400);
    });
  });
});
