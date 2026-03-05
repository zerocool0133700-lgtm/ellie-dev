/**
 * Tests for ELLIE-563: Mark orchestration startup as critical
 *
 * initOrchestration() runs the full startup sequence and throws on failure.
 * Tests verify:
 *   - Success path: all steps run in order, returns orphan count
 *   - recoverActiveRuns failure: rejects with the error
 *   - cleanupOrphanedJobs failure: rejects with the error
 *   - reconcileOnStartup failure: rejects with the error
 *   - startWatchdog/startReconciler only called after all async steps succeed
 *   - On failure, startWatchdog/startReconciler are NOT called
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockRecoverActiveRuns = mock(() => Promise.resolve());
const mockCleanupOrphanedJobs = mock(() => Promise.resolve(0));
const mockReconcileOnStartup = mock(() => Promise.resolve());
const mockStartWatchdog = mock(() => {});
const mockStartReconciler = mock((_sb: unknown) => {});

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock() }) },
}));

mock.module("../src/orchestration-tracker.ts", () => ({
  recoverActiveRuns: mockRecoverActiveRuns,
  startWatchdog: mockStartWatchdog,
  setWatchdogNotify: mock(),
  stopWatchdog: mock(),
}));

mock.module("../src/orchestration-reconciler.ts", () => ({
  reconcileOnStartup: mockReconcileOnStartup,
  startReconciler: mockStartReconciler,
  stopReconciler: mock(),
}));

mock.module("../src/jobs-ledger.ts", () => ({
  cleanupOrphanedJobs: mockCleanupOrphanedJobs,
  registerJobVines: mock(() => Promise.resolve()),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { initOrchestration } from "../src/orchestration-init.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockRecoverActiveRuns.mockReset();
  mockCleanupOrphanedJobs.mockReset();
  mockReconcileOnStartup.mockReset();
  mockStartWatchdog.mockReset();
  mockStartReconciler.mockReset();

  // Default: all succeed
  mockRecoverActiveRuns.mockImplementation(() => Promise.resolve());
  mockCleanupOrphanedJobs.mockImplementation(() => Promise.resolve(0));
  mockReconcileOnStartup.mockImplementation(() => Promise.resolve());
});

// ── Success path ──────────────────────────────────────────────────────────────

describe("initOrchestration — success path", () => {
  it("resolves when all steps succeed", async () => {
    await expect(initOrchestration(null)).resolves.toBeDefined();
  });

  it("returns orphanedJobs count", async () => {
    mockCleanupOrphanedJobs.mockImplementation(() => Promise.resolve(5));
    const result = await initOrchestration(null);
    expect(result.orphanedJobs).toBe(5);
  });

  it("calls recoverActiveRuns", async () => {
    await initOrchestration(null);
    expect(mockRecoverActiveRuns).toHaveBeenCalledTimes(1);
  });

  it("calls cleanupOrphanedJobs", async () => {
    await initOrchestration(null);
    expect(mockCleanupOrphanedJobs).toHaveBeenCalledTimes(1);
  });

  it("calls reconcileOnStartup", async () => {
    await initOrchestration(null);
    expect(mockReconcileOnStartup).toHaveBeenCalledTimes(1);
  });

  it("calls startWatchdog after async steps complete", async () => {
    await initOrchestration(null);
    expect(mockStartWatchdog).toHaveBeenCalledTimes(1);
  });

  it("calls startReconciler with supabase after async steps complete", async () => {
    const fakeSb = { from: mock() } as unknown;
    await initOrchestration(fakeSb as any);
    expect(mockStartReconciler).toHaveBeenCalledTimes(1);
    expect(mockStartReconciler).toHaveBeenCalledWith(fakeSb);
  });

  it("calls steps in order: recover → cleanup → reconcile → watchdog + reconciler", async () => {
    const order: string[] = [];
    mockRecoverActiveRuns.mockImplementation(async () => { order.push("recover"); });
    mockCleanupOrphanedJobs.mockImplementation(async () => { order.push("cleanup"); return 0; });
    mockReconcileOnStartup.mockImplementation(async () => { order.push("reconcile"); });
    mockStartWatchdog.mockImplementation(() => { order.push("watchdog"); });
    mockStartReconciler.mockImplementation(() => { order.push("reconciler"); });

    await initOrchestration(null);
    expect(order).toEqual(["recover", "cleanup", "reconcile", "watchdog", "reconciler"]);
  });
});

// ── Failure: recoverActiveRuns ─────────────────────────────────────────────────

describe("initOrchestration — recoverActiveRuns failure", () => {
  it("rejects when recoverActiveRuns throws", async () => {
    mockRecoverActiveRuns.mockImplementation(() => Promise.reject(new Error("DB connection lost")));
    await expect(initOrchestration(null)).rejects.toThrow("DB connection lost");
  });

  it("does NOT call startWatchdog on failure", async () => {
    mockRecoverActiveRuns.mockImplementation(() => Promise.reject(new Error("fail")));
    try { await initOrchestration(null); } catch {}
    expect(mockStartWatchdog).not.toHaveBeenCalled();
  });

  it("does NOT call startReconciler on failure", async () => {
    mockRecoverActiveRuns.mockImplementation(() => Promise.reject(new Error("fail")));
    try { await initOrchestration(null); } catch {}
    expect(mockStartReconciler).not.toHaveBeenCalled();
  });
});

// ── Failure: cleanupOrphanedJobs ──────────────────────────────────────────────

describe("initOrchestration — cleanupOrphanedJobs failure", () => {
  it("rejects when cleanupOrphanedJobs throws", async () => {
    mockCleanupOrphanedJobs.mockImplementation(() => Promise.reject(new Error("cleanup failed")));
    await expect(initOrchestration(null)).rejects.toThrow("cleanup failed");
  });

  it("does NOT start background monitors", async () => {
    mockCleanupOrphanedJobs.mockImplementation(() => Promise.reject(new Error("fail")));
    try { await initOrchestration(null); } catch {}
    expect(mockStartWatchdog).not.toHaveBeenCalled();
    expect(mockStartReconciler).not.toHaveBeenCalled();
  });
});

// ── Failure: reconcileOnStartup ───────────────────────────────────────────────

describe("initOrchestration — reconcileOnStartup failure", () => {
  it("rejects when reconcileOnStartup throws", async () => {
    mockReconcileOnStartup.mockImplementation(() => Promise.reject(new Error("supabase down")));
    await expect(initOrchestration(null)).rejects.toThrow("supabase down");
  });

  it("does NOT start background monitors", async () => {
    mockReconcileOnStartup.mockImplementation(() => Promise.reject(new Error("fail")));
    try { await initOrchestration(null); } catch {}
    expect(mockStartWatchdog).not.toHaveBeenCalled();
    expect(mockStartReconciler).not.toHaveBeenCalled();
  });
});
