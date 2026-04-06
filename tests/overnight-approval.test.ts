/**
 * Overnight Approval Workflow — Tests
 * ELLIE-1149: Interactive approval/rejection flow for morning review.
 */

import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test";
import type { ApiRequest, ApiResponse } from "../src/api/types.ts";

// ── Mock Supabase ───────────────────────────────────────────
function mockRes(): ApiResponse & { _status: number; _body: unknown } {
  const r: any = { _status: 200, _body: null };
  r.json = (data: unknown) => { r._status = 200; r._body = data; };
  r.status = (code: number) => ({
    json: (data: unknown) => { r._status = code; r._body = data; },
  });
  return r;
}

// ── Fixtures ────────────────────────────────────────────────
const TASK_COMPLETED = {
  id: "t1-uuid",
  session_id: "s1-uuid",
  gtd_task_id: "gtd-1",
  assigned_agent: "dev",
  task_title: "Fix login bug",
  task_content: "The login form crashes on empty email",
  status: "completed",
  branch_name: "overnight/ELLIE-100",
  pr_url: "https://github.com/evelife/ellie-dev/pull/42",
  pr_number: 42,
  summary: "Fixed validation in login form",
  error: null,
  container_id: "abc123",
  started_at: "2026-03-29T23:05:00Z",
  completed_at: "2026-03-29T23:45:00Z",
  duration_ms: 2400000,
};

const TASK_NO_PR = {
  ...TASK_COMPLETED,
  id: "t2-uuid",
  pr_url: null,
  pr_number: null,
};

const TASK_ALREADY_MERGED = {
  ...TASK_COMPLETED,
  id: "t3-uuid",
  status: "merged",
};

const TASK_ALREADY_REJECTED = {
  ...TASK_COMPLETED,
  id: "t4-uuid",
  status: "rejected",
};

// ── GitHub fetch mock ───────────────────────────────────────
const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mock>;

function mockGitHubFetch(status: number = 200, body: object = {}) {
  fetchMock = mock(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }))
  );
  globalThis.fetch = fetchMock as any;
}

// ── Supabase helpers ────────────────────────────────────────
/** Creates a mock supabase that returns `task` on select, and succeeds on update */
function createApprovalSupabase(task: any, updateError: any = null) {
  return {
    from: mock((table: string) => {
      const chain: any = {};
      chain.select = mock(() => chain);
      chain.eq = mock(() => chain);
      chain.single = mock(() => Promise.resolve({ data: task, error: null }));
      chain.update = mock(() => ({
        eq: mock(() => Promise.resolve({ data: task, error: updateError })),
      }));
      return chain;
    }),
  } as any;
}

// ── Tests ───────────────────────────────────────────────────

describe("overnight approval workflow", () => {
  let approveOvernightTask: Function;
  let rejectOvernightTask: Function;

  beforeEach(async () => {
    // Set env for GitHub token
    process.env.GH_TOKEN = "ghp_test_token_12345";
    const mod = await import("../src/api/overnight.ts");
    approveOvernightTask = mod.approveOvernightTask;
    rejectOvernightTask = mod.rejectOvernightTask;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.GH_TOKEN;
  });

  // ── POST /api/overnight/tasks/:id/approve ──

  describe("approveOvernightTask", () => {
    test("merges PR and updates task status to merged", async () => {
      mockGitHubFetch(200, { sha: "abc123", merged: true });
      const supabase = createApprovalSupabase(TASK_COMPLETED);
      const res = mockRes();

      await approveOvernightTask(
        { params: { id: "t1-uuid" } },
        res,
        supabase,
      );

      expect(res._status).toBe(200);
      const body = res._body as any;
      expect(body.status).toBe("merged");
      expect(body.pr_number).toBe(42);
      // Verify GitHub merge was called
      expect(fetchMock).toHaveBeenCalled();
      const [url, opts] = (fetchMock as any).mock.calls[0];
      expect(url).toContain("/pulls/42/merge");
      expect(opts.method).toBe("PUT");
    });

    test("returns 400 when task id is missing", async () => {
      const res = mockRes();
      await approveOvernightTask({ params: {} }, res, {} as any);

      expect(res._status).toBe(400);
      expect((res._body as any).error).toContain("task id");
    });

    test("returns 503 when database is unavailable", async () => {
      const res = mockRes();
      await approveOvernightTask({ params: { id: "t1-uuid" } }, res, null);

      expect(res._status).toBe(503);
    });

    test("returns 404 when task not found", async () => {
      const supabase = createApprovalSupabase(null);
      const res = mockRes();
      await approveOvernightTask({ params: { id: "nonexistent" } }, res, supabase);

      expect(res._status).toBe(404);
    });

    test("returns 400 when task has no PR", async () => {
      const supabase = createApprovalSupabase(TASK_NO_PR);
      const res = mockRes();
      await approveOvernightTask({ params: { id: "t2-uuid" } }, res, supabase);

      expect(res._status).toBe(400);
      expect((res._body as any).error).toContain("no PR");
    });

    test("returns 409 when task is already merged", async () => {
      const supabase = createApprovalSupabase(TASK_ALREADY_MERGED);
      const res = mockRes();
      await approveOvernightTask({ params: { id: "t3-uuid" } }, res, supabase);

      expect(res._status).toBe(409);
      expect((res._body as any).error).toContain("already");
    });

    test("returns 409 when task is already rejected", async () => {
      const supabase = createApprovalSupabase(TASK_ALREADY_REJECTED);
      const res = mockRes();
      await approveOvernightTask({ params: { id: "t4-uuid" } }, res, supabase);

      expect(res._status).toBe(409);
    });

    test("returns 502 when GitHub merge fails", async () => {
      mockGitHubFetch(422, { message: "Pull request is not mergeable" });
      const supabase = createApprovalSupabase(TASK_COMPLETED);
      const res = mockRes();
      await approveOvernightTask({ params: { id: "t1-uuid" } }, res, supabase);

      expect(res._status).toBe(502);
      expect((res._body as any).error).toContain("merge");
    });

    test("returns 500 when GH_TOKEN is not set", async () => {
      delete process.env.GH_TOKEN;
      delete process.env.OVERNIGHT_GH_TOKEN;
      const supabase = createApprovalSupabase(TASK_COMPLETED);
      const res = mockRes();
      await approveOvernightTask({ params: { id: "t1-uuid" } }, res, supabase);

      expect(res._status).toBe(500);
      expect((res._body as any).error).toContain("token");
    });
  });

  // ── POST /api/overnight/tasks/:id/reject ──

  describe("rejectOvernightTask", () => {
    test("closes PR and updates task status to rejected", async () => {
      mockGitHubFetch(200, { state: "closed" });
      const supabase = createApprovalSupabase(TASK_COMPLETED);
      const res = mockRes();

      await rejectOvernightTask(
        { params: { id: "t1-uuid" }, body: { reason: "Needs rework" } },
        res,
        supabase,
      );

      expect(res._status).toBe(200);
      const body = res._body as any;
      expect(body.status).toBe("rejected");
      // Verify GitHub close was called
      expect(fetchMock).toHaveBeenCalled();
      const [url, opts] = (fetchMock as any).mock.calls[0];
      expect(url).toContain("/pulls/42");
      expect(opts.method).toBe("PATCH");
      const reqBody = JSON.parse(opts.body);
      expect(reqBody.state).toBe("closed");
    });

    test("works without a rejection reason", async () => {
      mockGitHubFetch(200, { state: "closed" });
      const supabase = createApprovalSupabase(TASK_COMPLETED);
      const res = mockRes();

      await rejectOvernightTask(
        { params: { id: "t1-uuid" } },
        res,
        supabase,
      );

      expect(res._status).toBe(200);
      expect((res._body as any).status).toBe("rejected");
    });

    test("returns 400 when task id is missing", async () => {
      const res = mockRes();
      await rejectOvernightTask({ params: {} }, res, {} as any);

      expect(res._status).toBe(400);
    });

    test("returns 404 when task not found", async () => {
      const supabase = createApprovalSupabase(null);
      const res = mockRes();
      await rejectOvernightTask({ params: { id: "nonexistent" } }, res, supabase);

      expect(res._status).toBe(404);
    });

    test("returns 400 when task has no PR", async () => {
      const supabase = createApprovalSupabase(TASK_NO_PR);
      const res = mockRes();
      await rejectOvernightTask({ params: { id: "t2-uuid" } }, res, supabase);

      expect(res._status).toBe(400);
      expect((res._body as any).error).toContain("no PR");
    });

    test("returns 409 when task is already merged", async () => {
      const supabase = createApprovalSupabase(TASK_ALREADY_MERGED);
      const res = mockRes();
      await rejectOvernightTask({ params: { id: "t3-uuid" } }, res, supabase);

      expect(res._status).toBe(409);
    });

    test("returns 502 when GitHub close fails", async () => {
      mockGitHubFetch(500, { message: "Server error" });
      const supabase = createApprovalSupabase(TASK_COMPLETED);
      const res = mockRes();
      await rejectOvernightTask({ params: { id: "t1-uuid" } }, res, supabase);

      expect(res._status).toBe(502);
      expect((res._body as any).error).toContain("close");
    });
  });
});
