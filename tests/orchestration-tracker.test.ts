/**
 * ELLIE-507 — Orchestration tracker tests
 *
 * Tests the in-memory run lifecycle: startRun → heartbeat → endRun,
 * staleness recovery, watchdog start/stop, killRun edge cases, and
 * recoverActiveRuns orphan handling.
 *
 * External deps (orchestration-ledger, dispatch-queue) are mocked.
 * Uses the real tracker module with _resetForTesting() for isolation.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mocks — must precede imports ───────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock() }) },
}));

const mockEmitEvent = mock(() => {});
const mockGetUnterminated = mock(() => Promise.resolve([]));

mock.module("../src/orchestration-ledger.ts", () => ({
  emitEvent: mockEmitEvent,
  getUnterminated: mockGetUnterminated,
}));

const mockDrainNext = mock(() => {});

mock.module("../src/dispatch-queue.ts", () => ({
  drainNext: mockDrainNext,
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  startRun,
  heartbeat,
  endRun,
  getActiveRunCount,
  getActiveRunStates,
  getRunState,
  getActiveRunForWorkItem,
  setRunPid,
  killRun,
  startWatchdog,
  stopWatchdog,
  recoverActiveRuns,
  _resetForTesting,
} from "../src/orchestration-tracker.ts";

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetForTesting();
  mockEmitEvent.mockClear();
  mockEmitEvent.mockImplementation(() => {});
  mockGetUnterminated.mockClear();
  mockGetUnterminated.mockImplementation(() => Promise.resolve([]));
  mockDrainNext.mockClear();
  mockDrainNext.mockImplementation(() => {});
});

// ── startRun ──────────────────────────────────────────────────────────────────

describe("startRun", () => {
  test("adds run to active runs", () => {
    startRun("run-1", "dev", "ELLIE-100");
    expect(getActiveRunStates()).toHaveLength(1);
    expect(getActiveRunStates()[0].runId).toBe("run-1");
  });

  test("sets initial status to 'running'", () => {
    startRun("run-1", "dev", "ELLIE-100");
    expect(getRunState("run-1")!.status).toBe("running");
  });

  test("stores agentType and workItemId", () => {
    startRun("run-1", "research", "ELLIE-200", undefined, { channel: "telegram" });
    const run = getRunState("run-1")!;
    expect(run.agentType).toBe("research");
    expect(run.workItemId).toBe("ELLIE-200");
    expect(run.channel).toBe("telegram");
  });

  test("stores pid if provided", () => {
    startRun("run-1", "dev", "ELLIE-100", 12345);
    expect(getRunState("run-1")!.pid).toBe(12345);
  });

  test("multiple runs are tracked independently", () => {
    startRun("run-1", "dev", "ELLIE-101");
    startRun("run-2", "research", "ELLIE-102");
    expect(getActiveRunStates()).toHaveLength(2);
  });
});

// ── heartbeat ─────────────────────────────────────────────────────────────────

describe("heartbeat", () => {
  test("updates lastHeartbeat timestamp", async () => {
    startRun("run-1", "dev");
    const before = getRunState("run-1")!.lastHeartbeat;
    await new Promise(r => setTimeout(r, 5));
    heartbeat("run-1");
    const after = getRunState("run-1")!.lastHeartbeat;
    expect(after).toBeGreaterThan(before);
  });

  test("no-op on unknown runId", () => {
    expect(() => heartbeat("nonexistent")).not.toThrow();
  });

  test("restores 'stale' run to 'running' on heartbeat", () => {
    startRun("run-1", "dev");
    // Manually mark as stale to simulate watchdog action
    const run = getRunState("run-1")!;
    (run as any).status = "stale";
    heartbeat("run-1");
    expect(getRunState("run-1")!.status).toBe("running");
  });
});

// ── endRun ────────────────────────────────────────────────────────────────────

describe("endRun", () => {
  test("removes run from active tracking on completion", () => {
    startRun("run-1", "dev", "ELLIE-100");
    endRun("run-1", "completed");
    expect(getRunState("run-1")).toBeNull();
    expect(getActiveRunStates()).toHaveLength(0);
  });

  test("removes run from active tracking on failure", () => {
    startRun("run-1", "dev");
    endRun("run-1", "failed");
    expect(getRunState("run-1")).toBeNull();
  });

  test("calls drainNext when run has a workItemId", () => {
    startRun("run-1", "dev", "ELLIE-100");
    endRun("run-1", "completed");
    expect(mockDrainNext).toHaveBeenCalledWith("ELLIE-100");
  });

  test("does not call drainNext when run has no workItemId", () => {
    startRun("run-1", "dev");
    endRun("run-1", "completed");
    expect(mockDrainNext).not.toHaveBeenCalled();
  });

  test("no-op on unknown runId", () => {
    expect(() => endRun("nonexistent", "completed")).not.toThrow();
    expect(mockDrainNext).not.toHaveBeenCalled();
  });
});

// ── getActiveRunCount ─────────────────────────────────────────────────────────

describe("getActiveRunCount", () => {
  test("returns 0 when no runs", () => {
    expect(getActiveRunCount()).toBe(0);
  });

  test("counts only 'running' status runs", () => {
    startRun("run-1", "dev");
    startRun("run-2", "research");
    expect(getActiveRunCount()).toBe(2);
  });

  test("excludes stale runs from count", () => {
    startRun("run-1", "dev");
    startRun("run-2", "research");
    (getRunState("run-2") as any).status = "stale";
    expect(getActiveRunCount()).toBe(1);
  });

  test("decreases after endRun", () => {
    startRun("run-1", "dev");
    startRun("run-2", "research");
    endRun("run-1", "completed");
    expect(getActiveRunCount()).toBe(1);
  });
});

// ── getActiveRunForWorkItem ───────────────────────────────────────────────────

describe("getActiveRunForWorkItem", () => {
  test("returns running run for workItemId", () => {
    startRun("run-1", "dev", "ELLIE-300");
    const run = getActiveRunForWorkItem("ELLIE-300");
    expect(run).not.toBeNull();
    expect(run!.runId).toBe("run-1");
  });

  test("returns stale run for workItemId (still active)", () => {
    startRun("run-1", "dev", "ELLIE-300");
    (getRunState("run-1") as any).status = "stale";
    expect(getActiveRunForWorkItem("ELLIE-300")).not.toBeNull();
  });

  test("returns null after run ends", () => {
    startRun("run-1", "dev", "ELLIE-300");
    endRun("run-1", "completed");
    expect(getActiveRunForWorkItem("ELLIE-300")).toBeNull();
  });

  test("returns null for unknown workItemId", () => {
    expect(getActiveRunForWorkItem("ELLIE-NOTEXIST")).toBeNull();
  });
});

// ── setRunPid ─────────────────────────────────────────────────────────────────

describe("setRunPid", () => {
  test("updates pid for existing run", () => {
    startRun("run-1", "dev");
    setRunPid("run-1", 9999);
    expect(getRunState("run-1")!.pid).toBe(9999);
  });

  test("no-op on unknown runId", () => {
    expect(() => setRunPid("nonexistent", 9999)).not.toThrow();
  });
});

// ── killRun ───────────────────────────────────────────────────────────────────

describe("killRun", () => {
  test("returns false for unknown runId", async () => {
    expect(await killRun("nonexistent")).toBe(false);
  });

  test("returns true and ends run when no pid set", async () => {
    startRun("run-1", "dev", "ELLIE-100");
    const result = await killRun("run-1");
    expect(result).toBe(true);
    expect(getRunState("run-1")).toBeNull();
  });

  test("emits 'cancelled' event when no pid", async () => {
    startRun("run-1", "dev", "ELLIE-100");
    await killRun("run-1");
    expect(mockEmitEvent).toHaveBeenCalledWith(
      "run-1",
      "cancelled",
      "dev",
      "ELLIE-100",
      expect.objectContaining({ reason: "no_pid" }),
    );
  });

  test("returns true and ends run when process is already dead (invalid pid)", async () => {
    startRun("run-1", "dev", "ELLIE-100", 999999999);
    const result = await killRun("run-1");
    expect(result).toBe(true);
    expect(getRunState("run-1")).toBeNull();
  });
});

// ── startWatchdog / stopWatchdog ──────────────────────────────────────────────

describe("startWatchdog / stopWatchdog", () => {
  test("startWatchdog starts without error", () => {
    expect(() => startWatchdog()).not.toThrow();
    stopWatchdog(); // clean up
  });

  test("starting watchdog twice is a no-op (idempotent)", () => {
    startWatchdog();
    startWatchdog(); // should not throw or create second timer
    stopWatchdog();
  });

  test("stopWatchdog is safe to call when not running", () => {
    expect(() => stopWatchdog()).not.toThrow();
  });
});

// ── recoverActiveRuns ─────────────────────────────────────────────────────────

describe("recoverActiveRuns", () => {
  test("no orphans → emitEvent not called", async () => {
    mockGetUnterminated.mockImplementation(() => Promise.resolve([]));
    await recoverActiveRuns();
    expect(mockEmitEvent).not.toHaveBeenCalled();
  });

  test("two orphaned runs → emitEvent called twice with 'failed'", async () => {
    mockGetUnterminated.mockImplementation(() => Promise.resolve([
      { run_id: "orphan-1", agent_type: "dev", work_item_id: "ELLIE-400", dispatched_at: new Date(Date.now() - 60_000).toISOString() },
      { run_id: "orphan-2", agent_type: "research", work_item_id: "ELLIE-401", dispatched_at: new Date(Date.now() - 120_000).toISOString() },
    ]));
    await recoverActiveRuns();
    expect(mockEmitEvent).toHaveBeenCalledTimes(2);
    expect(mockEmitEvent).toHaveBeenCalledWith(
      "orphan-1",
      "failed",
      "dev",
      "ELLIE-400",
      expect.objectContaining({ reason: "relay_restart" }),
    );
  });

  test("recovery failure is non-fatal", async () => {
    mockGetUnterminated.mockImplementation(() => Promise.reject(new Error("DB down")));
    await expect(recoverActiveRuns()).resolves.toBeUndefined();
  });
});
