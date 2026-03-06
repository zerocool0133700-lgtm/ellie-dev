/**
 * ELLIE-507 — Orchestration dispatch tests
 *
 * Tests executeTrackedDispatch() focusing on observable synchronous behavior:
 *   - Dispatch locking: duplicate dispatch for same workItemId → queued
 *   - Concurrency cap: active count >= MAX_CONCURRENT_DISPATCHES → queued
 *   - Normal dispatch: startRun called, emitEvent "dispatched" emitted, runId returned
 *
 * All heavy external deps (plane, agent-router, memory, etc.) are mocked.
 * The orchestration-tracker module is NOT mocked — the real tracker is used so
 * its module registration is not polluted for other test files (bun 1.3.9 shares
 * the module registry across files in the same worker).
 * withTrace is mocked to a no-op to prevent runDispatch from executing.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mocks — must precede imports ───────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock() }) },
}));

const mockEmitEvent = mock(() => {});
mock.module("../src/orchestration-ledger.ts", () => ({
  emitEvent: mockEmitEvent,
}));

const mockEnqueue = mock(() => ({ position: 1 }));
const mockGetQueueDepth = mock(() => 0);
const mockDrainNext = mock(() => {});
mock.module("../src/dispatch-queue.ts", () => ({
  enqueue: mockEnqueue,
  getQueueDepth: mockGetQueueDepth,
  drainNext: mockDrainNext,
}));

const mockNotify = mock(() => Promise.resolve());
mock.module("../src/notification-policy.ts", () => ({
  notify: mockNotify,
}));

// withTrace: call fn immediately but return resolved promise (prevents runDispatch running)
const mockWithTrace = mock((_fn: () => Promise<any>) => Promise.resolve());
const mockGetTraceId = mock(() => "trace-test-id");
const mockGenerateTraceId = mock(() => "generated-trace-id");
mock.module("../src/trace.ts", () => ({
  withTrace: mockWithTrace,
  getTraceId: mockGetTraceId,
  generateTraceId: mockGenerateTraceId,
}));

// Stub all other heavy imports
mock.module("../src/plane.ts", () => ({ fetchWorkItemDetails: mock(() => Promise.resolve(null)) }));
mock.module("../src/agent-router.ts", () => ({ dispatchAgent: mock(), syncResponse: mock() }));
mock.module("../src/memory.ts", () => ({ processMemoryIntents: mock(() => Promise.resolve()) }));
mock.module("../src/prompt-builder.ts", () => ({
  getAgentArchetype: mock(() => Promise.resolve("")),
  getPsyContext: mock(() => Promise.resolve("")),
  getPhaseContext: mock(() => Promise.resolve("")),
  getHealthContext: mock(() => Promise.resolve("")),
}));
mock.module("../src/context-sources.ts", () => ({ getRiverContextForAgent: mock(() => Promise.resolve(null)) }));
mock.module("../src/dispatch-retry.ts", () => ({
  withRetry: mock((fn: () => any) => fn().then((r: any) => ({ success: true, result: r, attempts: 1 }))),
  classifyError: mock(() => ({ errorClass: "unknown", reason: "unknown" })),
}));
mock.module("../src/tool-approval.ts", () => ({ enterDispatchMode: mock(), exitDispatchMode: mock() }));
mock.module("../src/jobs-ledger.ts", () => ({
  createJob: mock(() => Promise.resolve("job-123")),
  updateJob: mock(() => Promise.resolve()),
  appendJobEvent: mock(() => Promise.resolve()),
  verifyJobWork: mock(() => Promise.resolve({ verified: true, note: "" })),
  estimateJobCost: mock(() => 0),
  writeJobTouchpointForAgent: mock(() => Promise.resolve()),
}));
mock.module("../src/relay-utils.ts", () => ({ estimateTokens: mock(() => 100) }));
mock.module("../../ellie-forest/src/index", () => ({
  startCreature: mock(() => Promise.resolve()),
  failCreature: mock(() => Promise.resolve()),
  completeCreature: mock(() => Promise.resolve()),
  dispatchPushCreature: mock(() => Promise.resolve({ id: "push-creature-id" })),
  writeJobCompletionMetric: mock(() => {}),
}));
mock.module("../src/channels/discord/observation.ts", () => ({
  postCreatureEvent: mock(() => {}),
  postJobEvent: mock(() => {}),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { executeTrackedDispatch } from "../src/orchestration-dispatch.ts";
import {
  startRun,
  getActiveRunStates,
  _resetForTesting as resetTracker,
} from "../src/orchestration-tracker.ts";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeOpts(overrides = {}) {
  return {
    agentType: "dev",
    workItemId: "ELLIE-500",
    channel: "telegram",
    message: "Work on ELLIE-500",
    playbookCtx: {
      bot: null,
      telegramUserId: "123",
      gchatSpaceName: null,
      supabase: null,
      buildPromptFn: mock(() => "prompt"),
      callClaudeFn: mock(() => Promise.resolve({ success: true, result: "response", attempts: 1 })),
    },
    ...overrides,
  };
}

beforeEach(() => {
  // Reset real tracker state
  resetTracker();
  // Reset mocks
  mockEmitEvent.mockClear();
  mockEmitEvent.mockImplementation(() => {});
  mockEnqueue.mockClear();
  mockEnqueue.mockImplementation(() => ({ position: 1 }));
  mockNotify.mockClear();
  mockNotify.mockImplementation(() => Promise.resolve());
  mockWithTrace.mockClear();
  mockWithTrace.mockImplementation((_fn: () => Promise<any>) => Promise.resolve());
});

// ── Dispatch locking (duplicate workItem) ─────────────────────────────────────

describe("executeTrackedDispatch — dispatch locking", () => {
  test("queues when existing run found for same workItemId", () => {
    // Set up an existing run for ELLIE-500 using the real tracker
    startRun("existing-run", "dev", "ELLIE-500");

    executeTrackedDispatch(makeOpts());
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    // Only the pre-existing run should be in activeRuns (no new run started)
    expect(getActiveRunStates()).toHaveLength(1);
    expect(getActiveRunStates()[0].runId).toBe("existing-run");
  });

  test("queued dispatch resolves immediately", async () => {
    startRun("existing-run", "dev", "ELLIE-500");

    const result = executeTrackedDispatch(makeOpts());
    await expect(result.promise).resolves.toBeUndefined();
  });
});

// ── Concurrency cap ───────────────────────────────────────────────────────────

describe("executeTrackedDispatch — concurrency limit", () => {
  test("queues when active count is at MAX_CONCURRENT_DISPATCHES (3)", () => {
    // Fill up concurrency slots with 3 different work items
    startRun("r1", "dev", "ELLIE-100");
    startRun("r2", "dev", "ELLIE-101");
    startRun("r3", "dev", "ELLIE-102");

    // Dispatch a NEW work item (ELLIE-200, not already active)
    executeTrackedDispatch(makeOpts({ workItemId: "ELLIE-200" }));
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    // Still only 3 runs — no new run added
    expect(getActiveRunStates()).toHaveLength(3);
  });

  test("dispatches normally when active count is below limit (2)", () => {
    startRun("r1", "dev", "ELLIE-100");
    startRun("r2", "dev", "ELLIE-101");

    executeTrackedDispatch(makeOpts({ workItemId: "ELLIE-200" }));
    expect(mockEnqueue).not.toHaveBeenCalled();
    // A new run was added for ELLIE-200
    expect(getActiveRunStates()).toHaveLength(3);
  });
});

// ── Normal dispatch path ──────────────────────────────────────────────────────

describe("executeTrackedDispatch — normal dispatch", () => {
  test("returns a runId (UUID format)", () => {
    const result = executeTrackedDispatch(makeOpts());
    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("startRun was called — run appears in tracker with correct agentType and workItemId", () => {
    executeTrackedDispatch(makeOpts());
    const runs = getActiveRunStates();
    expect(runs).toHaveLength(1);
    expect(runs[0].agentType).toBe("dev");
    expect(runs[0].workItemId).toBe("ELLIE-500");
  });

  test("emits 'dispatched' event", () => {
    const result = executeTrackedDispatch(makeOpts());
    expect(mockEmitEvent).toHaveBeenCalledWith(
      result.runId,
      "dispatched",
      "dev",
      "ELLIE-500",
      expect.objectContaining({ source: "formal_dispatch" }),
    );
  });

  test("returns a promise", () => {
    const result = executeTrackedDispatch(makeOpts());
    expect(result.promise).toBeInstanceOf(Promise);
  });
});
