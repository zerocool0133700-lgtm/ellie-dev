/**
 * Overnight Dashboard API — Tests
 * ELLIE-1146: API endpoints for viewing overnight task status, history, and results.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { ApiRequest, ApiResponse } from "../src/api/types.ts";
import { _resetForTesting } from "../src/overnight/scheduler.ts";

// ── Mock Supabase ───────────────────────────────────────────
function createMockSupabase(data: unknown = null, error: unknown = null) {
  const chain: Record<string, Function> = {};
  chain.from = mock(() => chain);
  chain.select = mock(() => chain);
  chain.eq = mock(() => chain);
  chain.order = mock(() => chain);
  chain.limit = mock(() => chain);
  chain.single = mock(() => Promise.resolve({ data, error }));
  chain.neq = mock(() => chain);
  chain.then = (resolve: Function) => Promise.resolve({ data, error }).then(resolve as any);
  // Make the chain itself thenable for queries without .single()
  return chain as any;
}

function mockRes(): ApiResponse & { _status: number; _body: unknown } {
  const r: any = { _status: 200, _body: null };
  r.json = (data: unknown) => { r._status = 200; r._body = data; };
  r.status = (code: number) => ({
    json: (data: unknown) => { r._status = code; r._body = data; },
  });
  return r;
}

// ── Fixtures ────────────────────────────────────────────────
const SESSION_1 = {
  id: "s1-uuid",
  started_at: "2026-03-29T23:00:00Z",
  ends_at: "2026-03-30T06:00:00Z",
  stopped_at: "2026-03-30T06:00:00Z",
  status: "completed",
  concurrency_limit: 2,
  tasks_total: 3,
  tasks_completed: 2,
  tasks_failed: 1,
  stop_reason: "time_limit",
};

const SESSION_RUNNING = {
  id: "s2-uuid",
  started_at: "2026-03-30T23:00:00Z",
  ends_at: "2026-03-31T06:00:00Z",
  stopped_at: null,
  status: "running",
  concurrency_limit: 2,
  tasks_total: 1,
  tasks_completed: 0,
  tasks_failed: 0,
  stop_reason: null,
};

const TASK_1 = {
  id: "t1-uuid",
  session_id: "s1-uuid",
  gtd_task_id: "gtd-1",
  assigned_agent: "dev",
  task_title: "Fix login bug",
  task_content: "The login form crashes on empty email",
  status: "completed",
  branch_name: "fix/login-bug",
  pr_url: "https://github.com/org/repo/pull/42",
  pr_number: 42,
  summary: "Fixed validation in login form",
  error: null,
  container_id: "abc123",
  started_at: "2026-03-29T23:05:00Z",
  completed_at: "2026-03-29T23:45:00Z",
  duration_ms: 2400000,
};

const TASK_FAILED = {
  id: "t2-uuid",
  session_id: "s1-uuid",
  gtd_task_id: "gtd-2",
  assigned_agent: "dev",
  task_title: "Refactor auth module",
  task_content: null,
  status: "failed",
  branch_name: "refactor/auth",
  pr_url: null,
  pr_number: null,
  summary: null,
  error: "Container exited with code 1",
  container_id: "def456",
  started_at: "2026-03-29T23:10:00Z",
  completed_at: "2026-03-29T23:50:00Z",
  duration_ms: 2400000,
};

// ── Tests ───────────────────────────────────────────────────

describe("overnight API", () => {
  let getOvernightStatus: Function;
  let getOvernightSessions: Function;
  let getOvernightSessionDetail: Function;
  let getOvernightSessionTasks: Function;
  let getOvernightTaskDetail: Function;

  beforeEach(async () => {
    const mod = await import("../src/api/overnight.ts");
    getOvernightStatus = mod.getOvernightStatus;
    getOvernightSessions = mod.getOvernightSessions;
    getOvernightSessionDetail = mod.getOvernightSessionDetail;
    getOvernightSessionTasks = mod.getOvernightSessionTasks;
    getOvernightTaskDetail = mod.getOvernightTaskDetail;
  });

  // ── GET /api/overnight/status ──

  describe("getOvernightStatus", () => {
    beforeEach(() => _resetForTesting());
    afterEach(() => _resetForTesting({ running: false }));

    test("returns active session with running tasks when session is running", async () => {
      const supabase = createMockSupabase(SESSION_RUNNING);
      const taskChain = createMockSupabase([TASK_1]);
      // Override: first call returns session, we need to handle two .from() calls
      let callCount = 0;
      const multiSupabase: any = {
        from: mock((table: string) => {
          if (table === "overnight_sessions") return supabase;
          if (table === "overnight_task_results") return taskChain;
          return supabase;
        }),
      };

      const req: ApiRequest = {};
      const res = mockRes();
      await getOvernightStatus(req, res, multiSupabase);

      expect(res._status).toBe(200);
      expect(res._body).toHaveProperty("running", true);
      expect(res._body).toHaveProperty("session");
      expect((res._body as any).session.id).toBe("s2-uuid");
    });

    test("returns running: false when no active session", async () => {
      _resetForTesting({ running: false });
      const supabase: any = {
        from: mock(() => {
          const chain: any = {};
          chain.select = mock(() => chain);
          chain.eq = mock(() => chain);
          chain.order = mock(() => chain);
          chain.limit = mock(() => chain);
          chain.single = mock(() => Promise.resolve({ data: null, error: null }));
          return chain;
        }),
      };

      const req: ApiRequest = {};
      const res = mockRes();
      await getOvernightStatus(req, res, supabase);

      expect(res._status).toBe(200);
      expect((res._body as any).running).toBe(false);
      expect((res._body as any).session).toBeNull();
    });

    test("returns 500 when supabase is unavailable", async () => {
      const req: ApiRequest = {};
      const res = mockRes();
      await getOvernightStatus(req, res, null);

      expect(res._status).toBe(503);
      expect((res._body as any).error).toContain("Database");
    });
  });

  // ── GET /api/overnight/sessions ──

  describe("getOvernightSessions", () => {
    test("returns paginated session list", async () => {
      const sessions = [SESSION_1, SESSION_RUNNING];
      const supabase: any = {
        from: mock(() => {
          const chain: any = {};
          chain.select = mock(() => chain);
          chain.order = mock(() => chain);
          chain.limit = mock(() => chain);
          chain.range = mock(() => Promise.resolve({ data: sessions, error: null, count: 2 }));
          return chain;
        }),
      };

      const req: ApiRequest = { query: { limit: "10", offset: "0" } };
      const res = mockRes();
      await getOvernightSessions(req, res, supabase);

      expect(res._status).toBe(200);
      const body = res._body as any;
      expect(body.sessions).toHaveLength(2);
      expect(body.sessions[0].id).toBe("s1-uuid");
    });

    test("defaults to limit 20 when not specified", async () => {
      let capturedLimit: number | undefined;
      const supabase: any = {
        from: mock(() => {
          const chain: any = {};
          chain.select = mock(() => chain);
          chain.order = mock(() => chain);
          chain.limit = mock((n: number) => { capturedLimit = n; return chain; });
          chain.range = mock(() => Promise.resolve({ data: [], error: null, count: 0 }));
          return chain;
        }),
      };

      const req: ApiRequest = { query: {} };
      const res = mockRes();
      await getOvernightSessions(req, res, supabase);

      expect(capturedLimit).toBe(20);
    });
  });

  // ── GET /api/overnight/sessions/:id ──

  describe("getOvernightSessionDetail", () => {
    test("returns session with tasks", async () => {
      const supabase: any = {
        from: mock((table: string) => {
          if (table === "overnight_sessions") {
            const chain: any = {};
            chain.select = mock(() => chain);
            chain.eq = mock(() => chain);
            chain.single = mock(() => Promise.resolve({ data: SESSION_1, error: null }));
            return chain;
          }
          if (table === "overnight_task_results") {
            const chain: any = {};
            chain.select = mock(() => chain);
            chain.eq = mock(() => chain);
            chain.order = mock(() => Promise.resolve({ data: [TASK_1, TASK_FAILED], error: null }));
            return chain;
          }
        }),
      };

      const req: ApiRequest = { params: { id: "s1-uuid" } };
      const res = mockRes();
      await getOvernightSessionDetail(req, res, supabase);

      expect(res._status).toBe(200);
      const body = res._body as any;
      expect(body.session.id).toBe("s1-uuid");
      expect(body.tasks).toHaveLength(2);
    });

    test("returns 400 when session id is missing", async () => {
      const req: ApiRequest = { params: {} };
      const res = mockRes();
      await getOvernightSessionDetail(req, res, {} as any);

      expect(res._status).toBe(400);
      expect((res._body as any).error).toContain("session id");
    });

    test("returns 404 when session not found", async () => {
      const supabase: any = {
        from: mock(() => {
          const chain: any = {};
          chain.select = mock(() => chain);
          chain.eq = mock(() => chain);
          chain.single = mock(() => Promise.resolve({ data: null, error: null }));
          return chain;
        }),
      };

      const req: ApiRequest = { params: { id: "nonexistent" } };
      const res = mockRes();
      await getOvernightSessionDetail(req, res, supabase);

      expect(res._status).toBe(404);
    });
  });

  // ── GET /api/overnight/sessions/:id/tasks ──

  describe("getOvernightSessionTasks", () => {
    test("returns tasks for a session", async () => {
      const supabase: any = {
        from: mock(() => {
          const chain: any = {};
          chain.select = mock(() => chain);
          chain.eq = mock(() => chain);
          chain.order = mock(() => Promise.resolve({ data: [TASK_1, TASK_FAILED], error: null }));
          return chain;
        }),
      };

      const req: ApiRequest = { params: { id: "s1-uuid" } };
      const res = mockRes();
      await getOvernightSessionTasks(req, res, supabase);

      expect(res._status).toBe(200);
      const body = res._body as any;
      expect(body.tasks).toHaveLength(2);
      expect(body.tasks[0].id).toBe("t1-uuid");
    });

    test("supports filtering by status", async () => {
      let capturedStatus: string | undefined;
      const supabase: any = {
        from: mock(() => {
          const chain: any = {};
          chain.select = mock(() => chain);
          chain.eq = mock((_col: string, val: string) => {
            if (_col === "status") capturedStatus = val;
            return chain;
          });
          chain.order = mock(() => Promise.resolve({ data: [TASK_FAILED], error: null }));
          return chain;
        }),
      };

      const req: ApiRequest = { params: { id: "s1-uuid" }, query: { status: "failed" } };
      const res = mockRes();
      await getOvernightSessionTasks(req, res, supabase);

      expect(capturedStatus).toBe("failed");
      expect(res._status).toBe(200);
    });

    test("returns 400 when session id missing", async () => {
      const req: ApiRequest = { params: {} };
      const res = mockRes();
      await getOvernightSessionTasks(req, res, {} as any);

      expect(res._status).toBe(400);
    });
  });

  // ── GET /api/overnight/tasks/:id ──

  describe("getOvernightTaskDetail", () => {
    test("returns single task with full details", async () => {
      const supabase: any = {
        from: mock(() => {
          const chain: any = {};
          chain.select = mock(() => chain);
          chain.eq = mock(() => chain);
          chain.single = mock(() => Promise.resolve({ data: TASK_1, error: null }));
          return chain;
        }),
      };

      const req: ApiRequest = { params: { id: "t1-uuid" } };
      const res = mockRes();
      await getOvernightTaskDetail(req, res, supabase);

      expect(res._status).toBe(200);
      const body = res._body as any;
      expect(body.task.id).toBe("t1-uuid");
      expect(body.task.pr_url).toBe("https://github.com/org/repo/pull/42");
      expect(body.task.summary).toBe("Fixed validation in login form");
    });

    test("returns 404 when task not found", async () => {
      const supabase: any = {
        from: mock(() => {
          const chain: any = {};
          chain.select = mock(() => chain);
          chain.eq = mock(() => chain);
          chain.single = mock(() => Promise.resolve({ data: null, error: null }));
          return chain;
        }),
      };

      const req: ApiRequest = { params: { id: "nonexistent" } };
      const res = mockRes();
      await getOvernightTaskDetail(req, res, supabase);

      expect(res._status).toBe(404);
    });

    test("returns 400 when task id missing", async () => {
      const req: ApiRequest = { params: {} };
      const res = mockRes();
      await getOvernightTaskDetail(req, res, {} as any);

      expect(res._status).toBe(400);
    });
  });
});
