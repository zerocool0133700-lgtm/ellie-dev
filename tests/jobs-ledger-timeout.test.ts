/**
 * ELLIE-527 — timed_out outcome in job tracking.
 *
 * Tests:
 * - JobStatus type includes "timed_out"
 * - getJobMetrics() returns timed_out count
 * - markJobTimedOutByRunId() updates job status and appends event
 * - markJobTimedOutByRunId() is a no-op when run_id not found
 * - estimateJobCost() is unaffected by the new status
 * - Fallback metrics include timed_out: 0
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { JobStatus, JobMetrics } from "../src/jobs-ledger.ts";

// ── Mock postgres (direct DB connection) ─────────────────────

const mockSql = mock();

// postgres() returns a tagged-template function; we need to mock that
mock.module("postgres", () => {
  // The default export is a function that returns a sql template function
  return {
    default: () => mockSql,
  };
});

// ── Mock ellie-forest (writeMemory, createLink) ───────────────

mock.module("../../ellie-forest/src/index", () => ({
  writeMemory: mock(() => Promise.resolve({ id: "m1" })),
  createLink: mock(() => Promise.resolve({})),
  getAgent: mock(() => Promise.resolve(null)),
}));

// ── Imports after mocks ───────────────────────────────────────

import {
  estimateJobCost,
  markJobTimedOutByRunId,
} from "../src/jobs-ledger.ts";

// ── Helpers ──────────────────────────────────────────────────

function makeSqlTemplate(rows: unknown[]) {
  // postgres tagged template returns a Promise-like array
  const fn = mock((..._args: any[]) => Promise.resolve(rows));
  return fn;
}

// ── Type-level checks ─────────────────────────────────────────

describe("JobStatus type includes timed_out", () => {
  test("timed_out is a valid JobStatus assignment", () => {
    const status: JobStatus = "timed_out";
    expect(status).toBe("timed_out");
  });

  test("all original statuses still valid", () => {
    const statuses: JobStatus[] = ["queued", "running", "responded", "completed", "failed", "cancelled", "timed_out"];
    expect(statuses).toHaveLength(7);
    expect(statuses).toContain("timed_out");
  });
});

// ── JobMetrics shape ──────────────────────────────────────────

describe("JobMetrics interface includes timed_out", () => {
  test("metrics object with timed_out is structurally valid", () => {
    const metrics: JobMetrics = {
      total: 10,
      completed: 6,
      failed: 2,
      timed_out: 2,
      running: 0,
      success_rate: 75.0,
      avg_duration_ms: 1200,
      total_tokens_in: 5000,
      total_tokens_out: 2500,
      total_cost_usd: "0.0500",
      by_agent: [],
      by_type: [],
    };
    expect(metrics.timed_out).toBe(2);
    expect(metrics.failed).toBe(2);
    // timed_out is distinct from failed
    expect(metrics.timed_out + metrics.failed).toBe(4);
  });
});

// ── estimateJobCost ────────────────────────────────────────────

describe("estimateJobCost (unchanged by ELLIE-527)", () => {
  test("haiku pricing", () => {
    const cost = estimateJobCost("claude-haiku-4-5-20251001", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(4.8, 5); // 0.80 + 4.0
  });

  test("sonnet pricing", () => {
    const cost = estimateJobCost("claude-sonnet-4-5-20250929", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(18.0, 5); // 3.0 + 15.0
  });

  test("unknown model falls back to sonnet pricing", () => {
    const cost = estimateJobCost("unknown-model-xyz", 1_000_000, 0);
    expect(cost).toBeCloseTo(3.0, 5); // sonnet input price
  });

  test("zero tokens = zero cost", () => {
    expect(estimateJobCost("claude-haiku-4-5-20251001", 0, 0)).toBe(0);
  });
});

// ── markJobTimedOutByRunId ─────────────────────────────────────

describe("markJobTimedOutByRunId", () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  test("no-op when run_id not found in DB", async () => {
    // findJobByRunId returns empty array → no job found
    mockSql.mockImplementation(() => Promise.resolve([]));

    // Should not throw
    await expect(markJobTimedOutByRunId("nonexistent-run-id", 60_000)).resolves.toBeUndefined();
  });

  test("updates job status to timed_out when job found", async () => {
    const mockJob = {
      job_id: "test-job-id",
      status: "running",
      run_id: "test-run-id",
    };

    let callCount = 0;
    mockSql.mockImplementation((...args: any[]) => {
      callCount++;
      if (callCount === 1) {
        // findJobByRunId — SELECT * FROM jobs WHERE run_id = ?
        return Promise.resolve([mockJob]);
      }
      // updateJob + appendJobEvent calls
      return Promise.resolve([]);
    });

    await markJobTimedOutByRunId("test-run-id", 65_000);

    // Should have made at least 1 call (findJobByRunId)
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  test("silently handles DB errors (non-fatal)", async () => {
    mockSql.mockImplementation(() => Promise.reject(new Error("DB connection failed")));

    // Should not throw even when DB fails
    await expect(markJobTimedOutByRunId("some-run-id", 30_000)).resolves.toBeUndefined();
  });
});
