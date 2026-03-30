/**
 * Overnight Scheduler — ELLIE-1136
 * Tests for pure functions: parseEndTime, shouldStop.
 */

import { describe, it, expect, mock } from "bun:test";

// ── Mocks (prevent import chain into ellie-forest) ──────────

// Prompt-builder is lazy-imported in scheduler, so no ellie-forest chain to worry about.

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock(), fatal: mock() }) },
}));

mock.module("../src/relay-state.ts", () => ({
  getRelayDeps: mock(() => ({ supabase: null, anthropic: null, bot: null })),
}));

mock.module("../src/trace.ts", () => ({
  getTraceId: mock(() => undefined),
}));

// ── Imports ─────────────────────────────────────────────────

import { parseEndTime, shouldStop, incrementSessionCounter, _onTaskCompleteForTesting, _setContainerStateForTesting, _resetForTesting } from "../src/overnight/scheduler.ts";

// ── parseEndTime ────────────────────────────────────────────

describe("parseEndTime", () => {
  // Fixed reference: 2026-03-29 at 11 PM
  const lateNight = new Date("2026-03-29T23:00:00");

  it("returns 6 AM next day by default", () => {
    const result = parseEndTime(undefined, lateNight);
    expect(result.getHours()).toBe(6);
    expect(result.getMinutes()).toBe(0);
    // Should be next day since 6 AM is before 11 PM
    expect(result.getDate()).toBe(30);
  });

  it("respects custom hour with 'am' suffix", () => {
    const result = parseEndTime("4am", lateNight);
    expect(result.getHours()).toBe(4);
    expect(result.getDate()).toBe(30);
  });

  it("handles '8am' format", () => {
    const result = parseEndTime("8am", lateNight);
    expect(result.getHours()).toBe(8);
    expect(result.getDate()).toBe(30);
  });

  it("handles space before am", () => {
    const result = parseEndTime("5 am", lateNight);
    expect(result.getHours()).toBe(5);
  });

  it("handles uppercase AM", () => {
    const result = parseEndTime("7AM", lateNight);
    expect(result.getHours()).toBe(7);
  });

  it("handles 24h format like '06:00'", () => {
    const result = parseEndTime("06:00", lateNight);
    expect(result.getHours()).toBe(6);
    expect(result.getDate()).toBe(30);
  });

  it("handles plain number input", () => {
    const result = parseEndTime("5", lateNight);
    expect(result.getHours()).toBe(5);
    expect(result.getDate()).toBe(30);
  });

  it("pushes to next day when time is before now", () => {
    const result = parseEndTime("3am", lateNight);
    expect(result.getTime()).toBeGreaterThan(lateNight.getTime());
    expect(result.getDate()).toBe(30);
  });

  it("does not push forward when time is after now", () => {
    const earlyMorning = new Date("2026-03-29T02:00:00");
    const result = parseEndTime("8am", earlyMorning);
    expect(result.getHours()).toBe(8);
    expect(result.getDate()).toBe(29); // same day
  });
});

// ── shouldStop ──────────────────────────────────────────────

describe("shouldStop", () => {
  it("returns 'time_limit' when past end time", () => {
    const pastEnd = new Date(Date.now() - 60_000);
    const result = shouldStop(pastEnd, false);
    expect(result).toBe("time_limit");
  });

  it("returns 'user_activity' when flag is set", () => {
    const futureEnd = new Date(Date.now() + 3_600_000);
    const result = shouldStop(futureEnd, true);
    expect(result).toBe("user_activity");
  });

  it("returns null when running normally", () => {
    const futureEnd = new Date(Date.now() + 3_600_000);
    const result = shouldStop(futureEnd, false);
    expect(result).toBeNull();
  });

  it("prioritizes user_activity over time_limit", () => {
    const pastEnd = new Date(Date.now() - 60_000);
    const result = shouldStop(pastEnd, true);
    expect(result).toBe("user_activity");
  });
});

// ── incrementSessionCounter (ELLIE-1141) ─────────────────

describe("incrementSessionCounter", () => {
  it("calls RPC and succeeds without fallback", async () => {
    let rpcCalled = false;
    let selectCalled = false;

    const mockSupabase = {
      rpc: (fn: string, params: any) => {
        rpcCalled = true;
        expect(fn).toBe("increment_session_counter");
        expect(params.p_session_id).toBe("session-1");
        expect(params.p_field).toBe("tasks_completed");
        return Promise.resolve({ data: null, error: null });
      },
      from: () => {
        selectCalled = true;
        const chain: any = { select: () => chain, eq: () => chain, single: () => Promise.resolve({ data: null, error: null }), update: () => chain };
        return chain;
      },
    };

    await incrementSessionCounter(mockSupabase, "session-1", "tasks_completed");
    expect(rpcCalled).toBe(true);
    expect(selectCalled).toBe(false); // no fallback needed
  });

  it("falls back to read-then-write when RPC fails", async () => {
    let updatePayload: any = null;
    let selectedField: string | null = null;

    const mockSupabase = {
      rpc: () => Promise.resolve({ data: null, error: { message: "function not found" } }),
      from: (table: string) => {
        const chain: any = {
          select: (field: string) => { selectedField = field; return chain; },
          eq: () => chain,
          single: () => Promise.resolve({ data: { tasks_failed: 3 }, error: null }),
          update: (data: any) => { updatePayload = data; return chain; },
        };
        return chain;
      },
    };

    await incrementSessionCounter(mockSupabase, "session-2", "tasks_failed");

    expect(selectedField).toBe("tasks_failed");
    expect(updatePayload).toEqual({ tasks_failed: 4 }); // 3 + 1
  });

  it("handles fallback when session not found", async () => {
    let updateCalled = false;

    const mockSupabase = {
      rpc: () => Promise.resolve({ data: null, error: { message: "function not found" } }),
      from: () => {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          single: () => Promise.resolve({ data: null, error: null }),
          update: () => { updateCalled = true; return chain; },
        };
        return chain;
      },
    };

    await incrementSessionCounter(mockSupabase, "missing-session", "tasks_total");
    expect(updateCalled).toBe(false); // should not attempt update if no session
  });
});

// ── duration_ms race condition (ELLIE-1139) ────────────────

describe("onTaskComplete duration_ms", () => {
  let updateArgs: Record<string, unknown> | null = null;

  const mockSupabase = {
    from: (table: string) => {
      const chain = {
        update: (data: Record<string, unknown>) => {
          if (table === "overnight_task_results") updateArgs = data;
          return chain;
        },
        eq: () => chain,
        select: () => chain,
        single: () => Promise.resolve({ data: null, error: null }),
      };
      return chain;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };

  it("records a positive duration_ms, not zero, for a task that ran for >1 second", async () => {
    const { getRelayDeps } = await import("../src/relay-state.ts");
    (getRelayDeps as any).mockImplementation(() => ({
      supabase: mockSupabase,
      anthropic: null,
      bot: null,
    }));

    _resetForTesting();
    updateArgs = null;

    const taskResultId = "task-duration-test";
    const gtdTaskId = "gtd-123";

    // Simulate a container that started 5 seconds ago
    _setContainerStateForTesting(taskResultId, {
      taskResultId,
      containerId: "c-abc",
      containerName: "ellie-overnight-test",
      volumeName: "ellie-overnight-vol-test",
      startedAt: Date.now() - 5_000,
      gtdTaskId,
    });

    await _onTaskCompleteForTesting(taskResultId, gtdTaskId, {
      exitCode: 0,
      logs: "All done",
    });

    expect(updateArgs).not.toBeNull();
    // duration_ms should be ~5000, definitely not 0
    expect(updateArgs!.duration_ms).toBeGreaterThan(4_000);
    expect(updateArgs!.duration_ms).toBeLessThan(10_000);
  });
});
