/**
 * ELLIE-507 — Orchestration reconciler tests
 *
 * Tests reconcileOnStartup(), startReconciler()/stopReconciler(), and
 * getReconcileStats(). The reconciler compares in-memory run state vs.
 * Forest ledger vs. Supabase sessions and resolves discrepancies.
 *
 * The orchestration-tracker module is NOT mocked — the real tracker is used so
 * its module registration is not polluted for other test files (bun 1.3.9 shares
 * the module registry across files in the same worker).
 * State is controlled via startRun() + _resetForTesting() before each test.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mocks ─────────────────────────────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock() }) },
}));

const mockGetUnterminated = mock(() => Promise.resolve([]));
const mockEmitEvent = mock(() => {});
mock.module("../src/orchestration-ledger.ts", () => ({
  getUnterminated: mockGetUnterminated,
  emitEvent: mockEmitEvent,
}));

// dispatch-queue is imported by orchestration-tracker (drainNext)
mock.module("../src/dispatch-queue.ts", () => ({
  drainNext: mock(() => {}),
  enqueue: mock(() => ({ position: 1 })),
  getQueueDepth: mock(() => 0),
}));

// notification-policy — type-only import in tracker, but mock to avoid side effects
mock.module("../src/notification-policy.ts", () => ({
  notify: mock(() => Promise.resolve()),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  reconcileOnStartup,
  startReconciler,
  stopReconciler,
  getReconcileStats,
} from "../src/orchestration-reconciler.ts";

import {
  startRun,
  _resetForTesting as resetTracker,
} from "../src/orchestration-tracker.ts";

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  stopReconciler(); // ensure clean timer state
  resetTracker();   // clear all active runs and watchdog
  mockGetUnterminated.mockClear();
  mockGetUnterminated.mockImplementation(() => Promise.resolve([]));
  mockEmitEvent.mockClear();
  mockEmitEvent.mockImplementation(() => {});
});

// ── getReconcileStats ─────────────────────────────────────────────────────────

describe("getReconcileStats", () => {
  test("returns stats with expected shape", () => {
    const stats = getReconcileStats();
    expect(typeof stats.totalRuns).toBe("number");
    expect(typeof stats.discrepanciesFound).toBe("number");
    expect(typeof stats.orphansReaped).toBe("number");
    expect("lastRunAt" in stats).toBe(true);
  });

  test("totalRuns increments after reconcileOnStartup", async () => {
    const before = getReconcileStats().totalRuns;
    await reconcileOnStartup(null);
    expect(getReconcileStats().totalRuns).toBe(before + 1);
  });

  test("lastRunAt is set after reconcileOnStartup", async () => {
    await reconcileOnStartup(null);
    expect(getReconcileStats().lastRunAt).not.toBeNull();
  });
});

// ── reconcileOnStartup — clean state ─────────────────────────────────────────

describe("reconcileOnStartup — clean state", () => {
  test("no discrepancies when both sources are empty", async () => {
    const before = getReconcileStats().discrepanciesFound;
    await reconcileOnStartup(null);
    // No new discrepancies when both sources empty
    expect(getReconcileStats().discrepanciesFound).toBe(before);
  });

  test("no emitEvent calls when no orphans", async () => {
    await reconcileOnStartup(null);
    expect(mockEmitEvent).not.toHaveBeenCalled();
  });

  test("reconcileOnStartup is non-fatal when ledger query fails", async () => {
    mockGetUnterminated.mockImplementation(() => Promise.reject(new Error("Forest DB down")));
    await expect(reconcileOnStartup(null)).resolves.toBeUndefined();
  });
});

// ── reconcileOnStartup — Forest orphan ───────────────────────────────────────

describe("reconcileOnStartup — Forest orphan (in ledger but not in memory)", () => {
  test("emits 'failed' event for orphaned Forest run at startup", async () => {
    // No in-memory runs (resetTracker() in beforeEach clears state)
    mockGetUnterminated.mockImplementation(() => Promise.resolve([
      {
        run_id: "orphan-run-1",
        agent_type: "dev",
        work_item_id: "ELLIE-600",
        dispatched_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
    ]));

    await reconcileOnStartup(null);

    expect(mockEmitEvent).toHaveBeenCalledWith(
      "orphan-run-1",
      "failed",
      "dev",
      "ELLIE-600",
      expect.objectContaining({ reason: "reconciler_orphan" }),
    );
  });

  test("increments discrepanciesFound for Forest orphan", async () => {
    const before = getReconcileStats().discrepanciesFound;
    mockGetUnterminated.mockImplementation(() => Promise.resolve([
      {
        run_id: "orphan-run-2",
        agent_type: "research",
        work_item_id: "ELLIE-601",
        dispatched_at: new Date(Date.now() - 3 * 60_000).toISOString(),
      },
    ]));

    await reconcileOnStartup(null);
    expect(getReconcileStats().discrepanciesFound).toBeGreaterThan(before);
  });

  test("increments orphansReaped for Forest orphan at startup", async () => {
    const before = getReconcileStats().orphansReaped;
    mockGetUnterminated.mockImplementation(() => Promise.resolve([
      {
        run_id: "orphan-run-3",
        agent_type: "ops",
        work_item_id: "ELLIE-602",
        dispatched_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      },
    ]));

    await reconcileOnStartup(null);
    expect(getReconcileStats().orphansReaped).toBeGreaterThan(before);
  });
});

// ── reconcileOnStartup — memory-only run ────────────────────────────────────

describe("reconcileOnStartup — in-memory run not in Forest ledger", () => {
  test("discrepancy found for memory-only run (no pid, no dead process check)", async () => {
    // Set up an in-memory run with no pid (no process liveness check)
    startRun("mem-only-run", "dev", "ELLIE-700", undefined /* no pid */);
    // Forest says nothing running
    mockGetUnterminated.mockImplementation(() => Promise.resolve([]));

    const before = getReconcileStats().discrepanciesFound;
    await reconcileOnStartup(null);
    expect(getReconcileStats().discrepanciesFound).toBeGreaterThan(before);
  });
});

// ── startReconciler / stopReconciler ─────────────────────────────────────────

describe("startReconciler / stopReconciler", () => {
  test("startReconciler runs without error", () => {
    expect(() => startReconciler(null)).not.toThrow();
    stopReconciler(); // clean up
  });

  test("startReconciler is idempotent (calling twice doesn't create two timers)", () => {
    startReconciler(null);
    startReconciler(null); // second call is a no-op
    stopReconciler();
  });

  test("stopReconciler is safe when not running", () => {
    expect(() => stopReconciler()).not.toThrow();
  });
});
