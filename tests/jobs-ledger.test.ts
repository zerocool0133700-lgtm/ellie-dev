/**
 * ELLIE-513 — Jobs ledger tests.
 *
 * Covers createJob, updateJob, appendJobEvent, findJobByRunId/TreeId,
 * getJob, listJobs, getJobMetrics, cleanupOrphanedJobs,
 * writeJobTouchpoint, writeJobTouchpointForAgent, verifyJobWork,
 * and estimateJobCost (opus + null/undefined model cases not in ELLIE-527 tests).
 *
 * DB calls are mocked via postgres module mock.
 * Forest calls are mocked via ellie-forest module mock.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock logger ────────────────────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

// ── Mock postgres (direct DB connection) ──────────────────────────────────

const mockSql = mock((..._args: any[]) => Promise.resolve([]));

mock.module("postgres", () => ({
  default: () => mockSql,
}));

// ── Mock ellie-forest ─────────────────────────────────────────────────────

const mockWriteMemory = mock(() => Promise.resolve({ id: "m-test" }));
const mockCreateLink  = mock(() => Promise.resolve({}));

mock.module("../../ellie-forest/src/index", () => ({
  writeMemory: mockWriteMemory,
  createLink:  mockCreateLink,
  getAgent:    mock(() => Promise.resolve(null)),
}));

// ── Imports after mocks ───────────────────────────────────────────────────

import {
  estimateJobCost,
  createJob,
  updateJob,
  appendJobEvent,
  findJobByRunId,
  findJobByTreeId,
  getJob,
  listJobs,
  getJobMetrics,
  cleanupOrphanedJobs,
  writeJobTouchpoint,
  writeJobTouchpointForAgent,
  verifyJobWork,
  _resetDbForTesting,
} from "../src/jobs-ledger.ts";

// Reset the DB singleton before every test so mock.module("postgres") is
// always picked up fresh, regardless of which other test files have run.
beforeEach(() => _resetDbForTesting());

// ── estimateJobCost — opus + null/undefined (haiku/sonnet/unknown/zero in ELLIE-527) ─

describe("estimateJobCost — opus pricing", () => {
  test("opus input: 15.0 per million tokens", () => {
    expect(estimateJobCost("claude-opus-4-6", 1_000_000, 0)).toBeCloseTo(15.0, 5);
  });

  test("opus output: 75.0 per million tokens", () => {
    expect(estimateJobCost("claude-opus-4-6", 0, 1_000_000)).toBeCloseTo(75.0, 5);
  });

  test("opus combined cost", () => {
    const expected = (500_000 * 15.0 + 100_000 * 75.0) / 1_000_000;
    expect(estimateJobCost("claude-opus-4-6", 500_000, 100_000)).toBeCloseTo(expected, 5);
  });
});

describe("estimateJobCost — null/undefined model fallback", () => {
  test("null model uses sonnet pricing (3.0 input)", () => {
    expect(estimateJobCost(null, 1_000_000, 0)).toBeCloseTo(3.0, 5);
  });

  test("undefined model uses sonnet pricing (15.0 output)", () => {
    expect(estimateJobCost(undefined, 0, 1_000_000)).toBeCloseTo(15.0, 5);
  });

  test("mixed tokens with sonnet-4-6", () => {
    const expected = (200_000 * 3.0 + 100_000 * 15.0) / 1_000_000;
    expect(estimateJobCost("claude-sonnet-4-6", 200_000, 100_000)).toBeCloseTo(expected, 5);
  });
});

// ── findJobByRunId ─────────────────────────────────────────────────────────

describe("findJobByRunId", () => {
  beforeEach(() => mockSql.mockReset());

  test("returns null when no rows", async () => {
    mockSql.mockImplementation(() => Promise.resolve([]));
    expect(await findJobByRunId("nonexistent")).toBeNull();
  });

  test("returns the job object when found", async () => {
    const job = { job_id: "j1", run_id: "r1", status: "running" };
    mockSql.mockImplementation(() => Promise.resolve([job]));
    expect(await findJobByRunId("r1")).toEqual(job);
  });

  test("returns null on DB error", async () => {
    mockSql.mockImplementation(() => Promise.reject(new Error("DB down")));
    expect(await findJobByRunId("r1")).toBeNull();
  });
});

// ── findJobByTreeId ───────────────────────────────────────────────────────

describe("findJobByTreeId", () => {
  beforeEach(() => mockSql.mockReset());

  test("returns null when no rows", async () => {
    mockSql.mockImplementation(() => Promise.resolve([]));
    expect(await findJobByTreeId("tree-xyz")).toBeNull();
  });

  test("returns the job when found", async () => {
    const job = { job_id: "j2", tree_id: "t1", status: "completed" };
    mockSql.mockImplementation(() => Promise.resolve([job]));
    expect(await findJobByTreeId("t1")).toEqual(job);
  });

  test("returns null on DB error", async () => {
    mockSql.mockImplementation(() => Promise.reject(new Error("select failed")));
    expect(await findJobByTreeId("t1")).toBeNull();
  });
});

// ── appendJobEvent ────────────────────────────────────────────────────────

describe("appendJobEvent", () => {
  beforeEach(() => mockSql.mockReset());

  test("resolves without error", async () => {
    mockSql.mockImplementation(() => Promise.resolve([]));
    await expect(appendJobEvent("j1", "started", { note: "hello" })).resolves.toBeUndefined();
  });

  test("silently handles DB error", async () => {
    mockSql.mockImplementation(() => Promise.reject(new Error("insert failed")));
    await expect(appendJobEvent("j1", "started")).resolves.toBeUndefined();
  });

  test("accepts optional step_name and duration_ms", async () => {
    mockSql.mockImplementation(() => Promise.resolve([]));
    await expect(
      appendJobEvent("j1", "step", {}, { step_name: "validate", duration_ms: 100 }),
    ).resolves.toBeUndefined();
  });
});

// ── createJob ─────────────────────────────────────────────────────────────

describe("createJob", () => {
  beforeEach(() => mockSql.mockReset());

  test("returns the job_id from DB", async () => {
    let calls = 0;
    mockSql.mockImplementation((..._args: any[]) => {
      calls++;
      if (calls === 1) return Promise.resolve([{ job_id: "created-job-id" }]);
      return Promise.resolve([]); // appendJobEvent INSERT
    });
    const id = await createJob({ source: "test", agent_type: "dev" });
    expect(id).toBe("created-job-id");
  });

  test("throws on DB error (createJob is not fire-and-forget)", async () => {
    mockSql.mockImplementation(() => Promise.reject(new Error("insert error")));
    await expect(createJob({ source: "test" })).rejects.toThrow("insert error");
  });
});

// ── updateJob ─────────────────────────────────────────────────────────────

describe("updateJob", () => {
  beforeEach(() => mockSql.mockReset());

  test("resolves without error on status update", async () => {
    mockSql.mockImplementation(() => Promise.resolve([]));
    await expect(updateJob("j1", { status: "completed" })).resolves.toBeUndefined();
  });

  test("no-op (no sql template call) when no fields provided", async () => {
    // sets.length === 0 → early return before any sql call
    await expect(updateJob("j1", {})).resolves.toBeUndefined();
    expect(mockSql).not.toHaveBeenCalled();
  });

  test("silently handles DB error", async () => {
    // Use a sync throw so the try/catch in updateJob catches it before any
    // fragment Promises can become unhandled rejections.
    mockSql.mockImplementation(() => { throw new Error("update fail"); });
    await expect(updateJob("j1", { status: "failed" })).resolves.toBeUndefined();
  });
});

// ── getJob ────────────────────────────────────────────────────────────────

describe("getJob", () => {
  beforeEach(() => mockSql.mockReset());

  test("returns null when job not found", async () => {
    mockSql.mockImplementation(() => Promise.resolve([]));
    expect(await getJob("missing")).toBeNull();
  });

  test("returns job with events and sub_jobs when found", async () => {
    const job    = { job_id: "j1", status: "completed" };
    const event  = { event_id: "e1", job_id: "j1", event: "created" };
    const subJob = { job_id: "j2", parent_job_id: "j1" };
    let calls = 0;
    mockSql.mockImplementation((..._args: any[]) => {
      calls++;
      if (calls === 1) return Promise.resolve([job]);
      if (calls === 2) return Promise.resolve([event]);
      return Promise.resolve([subJob]);
    });
    const result = await getJob("j1");
    expect(result?.job).toEqual(job);
    expect(result?.events).toEqual([event]);
    expect(result?.sub_jobs).toEqual([subJob]);
  });

  test("returns null on DB error", async () => {
    mockSql.mockImplementation(() => Promise.reject(new Error("select failed")));
    expect(await getJob("j1")).toBeNull();
  });
});

// ── listJobs ──────────────────────────────────────────────────────────────

describe("listJobs", () => {
  beforeEach(() => mockSql.mockReset());

  test("returns empty array when no rows", async () => {
    mockSql.mockImplementation(() => Promise.resolve([]));
    expect(await listJobs()).toEqual([]);
  });

  test("returns rows from DB", async () => {
    const jobs = [{ job_id: "j1" }, { job_id: "j2" }];
    // listJobs calls sql multiple times (conditional fragments + main query);
    // last call is the main SELECT — all mocked to return same value here
    mockSql.mockImplementation(() => Promise.resolve(jobs));
    const result = await listJobs();
    expect(result).toEqual(jobs);
  });

  test("returns empty array on DB error", async () => {
    // Sync throw avoids unhandled rejections from inline fragment calls.
    mockSql.mockImplementation(() => { throw new Error("query failed"); });
    expect(await listJobs()).toEqual([]);
  });
});

// ── getJobMetrics ─────────────────────────────────────────────────────────

describe("getJobMetrics", () => {
  beforeEach(() => mockSql.mockReset());

  test("returns zero-struct fallback on DB error", async () => {
    // Sync throw — getJobMetrics calls db()`` for sinceClause before the main
    // SELECT, so a rejected Promise there becomes an unhandled rejection.
    mockSql.mockImplementation(() => { throw new Error("metrics fail"); });
    const m = await getJobMetrics();
    expect(m.total).toBe(0);
    expect(m.completed).toBe(0);
    expect(m.failed).toBe(0);
    expect(m.timed_out).toBe(0);
    expect(m.running).toBe(0);
    expect(m.by_agent).toEqual([]);
    expect(m.by_type).toEqual([]);
    expect(m.total_cost_usd).toBe("0");
  });

  test("maps totals DB row to JobMetrics shape", async () => {
    const totalsRow = {
      total: 10, completed: 7, failed: 2, timed_out: 1, running: 0,
      success_rate: "77.8", avg_duration_ms: 1500,
      total_tokens_in: 5000, total_tokens_out: 2500, total_cost_usd: "0.0500",
    };
    let calls = 0;
    mockSql.mockImplementation((..._args: any[]) => {
      calls++;
      // call #1: sinceClause = db()`` (empty fragment, no `since` passed)
      // call #2: main SELECT totals
      // call #3: by_agent SELECT
      // call #4: by_type SELECT
      if (calls === 1) return Promise.resolve([]);           // sinceClause fragment
      if (calls === 2) return Promise.resolve([totalsRow]);  // totals SELECT
      return Promise.resolve([]);                            // by_agent / by_type
    });
    const m = await getJobMetrics();
    expect(m.total).toBe(10);
    expect(m.completed).toBe(7);
    expect(m.failed).toBe(2);
    expect(m.timed_out).toBe(1);
    expect(m.total_cost_usd).toBe("0.0500");
    expect(m.avg_duration_ms).toBe(1500);
    expect(m.total_tokens_in).toBe(5000);
  });

  test("avg_duration_ms is null when DB returns null", async () => {
    const totalsRow = {
      total: 0, completed: 0, failed: 0, timed_out: 0, running: 0,
      success_rate: null, avg_duration_ms: null,
      total_tokens_in: 0, total_tokens_out: 0, total_cost_usd: "0",
    };
    let calls = 0;
    mockSql.mockImplementation((..._args: any[]) => {
      calls++;
      if (calls === 1) return Promise.resolve([]);          // sinceClause fragment
      if (calls === 2) return Promise.resolve([totalsRow]); // totals SELECT
      return Promise.resolve([]);
    });
    const m = await getJobMetrics();
    expect(m.avg_duration_ms).toBeNull();
  });
});

// ── cleanupOrphanedJobs ───────────────────────────────────────────────────

describe("cleanupOrphanedJobs", () => {
  beforeEach(() => mockSql.mockReset());

  test("returns 0 when no orphaned jobs exist", async () => {
    mockSql.mockImplementation(() => Promise.resolve([]));
    expect(await cleanupOrphanedJobs()).toBe(0);
  });

  test("returns count of jobs cleaned up", async () => {
    let calls = 0;
    mockSql.mockImplementation((..._args: any[]) => {
      calls++;
      if (calls === 1) return Promise.resolve([{ job_id: "j1" }, { job_id: "j2" }]);
      return Promise.resolve([]); // appendJobEvent for each
    });
    expect(await cleanupOrphanedJobs()).toBe(2);
  });

  test("returns 0 on DB error (non-fatal)", async () => {
    mockSql.mockImplementation(() => Promise.reject(new Error("cleanup fail")));
    expect(await cleanupOrphanedJobs()).toBe(0);
  });
});

// ── writeJobTouchpoint ────────────────────────────────────────────────────

describe("writeJobTouchpoint — scope routing", () => {
  beforeEach(() => {
    mockWriteMemory.mockReset();
    mockSql.mockReset();
  });

  test("dev entity uses scope J/3/1", async () => {
    await writeJobTouchpoint({ jobId: "j1", entityType: "dev", touchpointType: "started", content: "Dev start" });
    expect((mockWriteMemory.mock.calls[0][0] as any).scope_path).toBe("J/3/1");
  });

  test("strategy entity uses scope J/3/2", async () => {
    await writeJobTouchpoint({ jobId: "j1", entityType: "strategy", touchpointType: "decision", content: "Plan" });
    expect((mockWriteMemory.mock.calls[0][0] as any).scope_path).toBe("J/3/2");
  });

  test("research entity uses scope J/3/3", async () => {
    await writeJobTouchpoint({ jobId: "j1", entityType: "research", touchpointType: "blocker", content: "Blocked" });
    expect((mockWriteMemory.mock.calls[0][0] as any).scope_path).toBe("J/3/3");
  });

  test("content entity uses scope J/3/4", async () => {
    await writeJobTouchpoint({ jobId: "j1", entityType: "content", touchpointType: "started", content: "Writing" });
    expect((mockWriteMemory.mock.calls[0][0] as any).scope_path).toBe("J/3/4");
  });

  test("finance entity uses scope J/3/5", async () => {
    await writeJobTouchpoint({ jobId: "j1", entityType: "finance", touchpointType: "started", content: "Budget" });
    expect((mockWriteMemory.mock.calls[0][0] as any).scope_path).toBe("J/3/5");
  });

  test("critic entity uses scope J/3/6", async () => {
    await writeJobTouchpoint({ jobId: "j1", entityType: "critic", touchpointType: "decision", content: "Review" });
    expect((mockWriteMemory.mock.calls[0][0] as any).scope_path).toBe("J/3/6");
  });

  test("general entity uses scope J/3/7", async () => {
    await writeJobTouchpoint({ jobId: "j1", entityType: "general", touchpointType: "started", content: "General" });
    expect((mockWriteMemory.mock.calls[0][0] as any).scope_path).toBe("J/3/7");
  });
});

describe("writeJobTouchpoint — content and metadata", () => {
  beforeEach(() => {
    mockWriteMemory.mockReset();
    mockSql.mockReset();
  });

  test("capitalises touchpoint type in content prefix", async () => {
    await writeJobTouchpoint({ jobId: "j1", entityType: "dev", touchpointType: "started", content: "Work begun" });
    expect((mockWriteMemory.mock.calls[0][0] as any).content).toContain("[Started]");
  });

  test("content text appears after the type prefix", async () => {
    await writeJobTouchpoint({ jobId: "j1", entityType: "dev", touchpointType: "blocker", content: "Waiting on PR review" });
    expect((mockWriteMemory.mock.calls[0][0] as any).content).toContain("Waiting on PR review");
  });

  test("includes job_id in metadata", async () => {
    await writeJobTouchpoint({ jobId: "job-abc123", entityType: "dev", touchpointType: "started", content: "X" });
    expect((mockWriteMemory.mock.calls[0][0] as any).metadata.job_id).toBe("job-abc123");
  });

  test("includes workItemId in metadata when provided", async () => {
    await writeJobTouchpoint({
      jobId: "j1", entityType: "dev", touchpointType: "started", content: "X",
      metadata: { workItemId: "ELLIE-100", tokens: 500 },
    });
    const meta = (mockWriteMemory.mock.calls[0][0] as any).metadata;
    expect(meta.work_item_id).toBe("ELLIE-100");
    expect(meta.tokens).toBe(500);
  });

  test("includes job-touchpoint, touchpointType, and entityType in tags", async () => {
    await writeJobTouchpoint({ jobId: "j1", entityType: "research", touchpointType: "failed", content: "X" });
    const tags = (mockWriteMemory.mock.calls[0][0] as any).tags as string[];
    expect(tags).toContain("job-touchpoint");
    expect(tags).toContain("failed");
    expect(tags).toContain("research");
  });

  test("type is 'finding'", async () => {
    await writeJobTouchpoint({ jobId: "j1", entityType: "dev", touchpointType: "decision", content: "X" });
    expect((mockWriteMemory.mock.calls[0][0] as any).type).toBe("finding");
  });
});

// ── writeJobTouchpointForAgent — resolveEntityType ────────────────────────

describe("writeJobTouchpointForAgent — entity type resolution", () => {
  beforeEach(() => {
    mockWriteMemory.mockReset();
    mockSql.mockReset();
  });

  test("'dev' → J/3/1", async () => {
    await writeJobTouchpointForAgent("j1", "dev", null, "started", "Dev work");
    expect((mockWriteMemory.mock.calls[0][0] as any).scope_path).toBe("J/3/1");
  });

  test("'dev-ant' → J/3/1 (normalised to dev)", async () => {
    await writeJobTouchpointForAgent("j1", "dev-ant", null, "started", "Dev-ant work");
    expect((mockWriteMemory.mock.calls[0][0] as any).scope_path).toBe("J/3/1");
  });

  test("'ant' → J/3/1 (normalised to dev)", async () => {
    await writeJobTouchpointForAgent("j1", "ant", null, "started", "Ant work");
    expect((mockWriteMemory.mock.calls[0][0] as any).scope_path).toBe("J/3/1");
  });

  test("'strategy' → J/3/2", async () => {
    await writeJobTouchpointForAgent("j1", "strategy", null, "decision", "Strategy");
    expect((mockWriteMemory.mock.calls[0][0] as any).scope_path).toBe("J/3/2");
  });

  test("'research' → J/3/3", async () => {
    await writeJobTouchpointForAgent("j1", "research", null, "blocker", "Research");
    expect((mockWriteMemory.mock.calls[0][0] as any).scope_path).toBe("J/3/3");
  });

  test("'content' → J/3/4", async () => {
    await writeJobTouchpointForAgent("j1", "content", null, "started", "Content");
    expect((mockWriteMemory.mock.calls[0][0] as any).scope_path).toBe("J/3/4");
  });

  test("'finance' → J/3/5", async () => {
    await writeJobTouchpointForAgent("j1", "finance", null, "started", "Finance");
    expect((mockWriteMemory.mock.calls[0][0] as any).scope_path).toBe("J/3/5");
  });

  test("'critic' → J/3/6", async () => {
    await writeJobTouchpointForAgent("j1", "critic", null, "decision", "Critic");
    expect((mockWriteMemory.mock.calls[0][0] as any).scope_path).toBe("J/3/6");
  });

  test("null agent_type → J/3/7 (general)", async () => {
    await writeJobTouchpointForAgent("j1", null, null, "started", "Unknown agent");
    expect((mockWriteMemory.mock.calls[0][0] as any).scope_path).toBe("J/3/7");
  });

  test("undefined agent_type → J/3/7 (general)", async () => {
    await writeJobTouchpointForAgent("j1", undefined, null, "started", "Unknown agent");
    expect((mockWriteMemory.mock.calls[0][0] as any).scope_path).toBe("J/3/7");
  });

  test("unknown agent_type → J/3/7 (general)", async () => {
    await writeJobTouchpointForAgent("j1", "some-random-type", null, "started", "Random");
    expect((mockWriteMemory.mock.calls[0][0] as any).scope_path).toBe("J/3/7");
  });

  test("agent type is case-insensitive (DEV → dev → J/3/1)", async () => {
    await writeJobTouchpointForAgent("j1", "DEV", null, "started", "Upper-case dev");
    expect((mockWriteMemory.mock.calls[0][0] as any).scope_path).toBe("J/3/1");
  });
});

// ── verifyJobWork ─────────────────────────────────────────────────────────

describe("verifyJobWork — non-dev agents skip git check", () => {
  test("strategy returns verified=true immediately", async () => {
    const r = await verifyJobWork("strategy", Date.now());
    expect(r.verified).toBe(true);
    expect(r.note).toContain("non-dev");
  });

  test("research returns verified=true immediately", async () => {
    expect((await verifyJobWork("research", Date.now())).verified).toBe(true);
  });

  test("finance returns verified=true immediately", async () => {
    expect((await verifyJobWork("finance", Date.now())).verified).toBe(true);
  });

  test("critic returns verified=true immediately", async () => {
    expect((await verifyJobWork("critic", Date.now())).verified).toBe(true);
  });

  test("content returns verified=true immediately", async () => {
    expect((await verifyJobWork("content", Date.now())).verified).toBe(true);
  });

  test("general returns verified=true immediately", async () => {
    expect((await verifyJobWork("general", Date.now())).verified).toBe(true);
  });
});
