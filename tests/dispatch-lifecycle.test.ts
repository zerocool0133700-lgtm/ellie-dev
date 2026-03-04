/**
 * ELLIE-494 — Dispatch lifecycle tests
 *
 * Covers executeTrackedDispatch:
 * - Returns { runId, promise } synchronously (non-blocking)
 * - Registers run via startRun (agentType, workItemId tracked)
 * - Emits "dispatched" event immediately
 * - Queues when duplicate work item is active
 * - Queues when concurrency cap (3) is reached
 * - On ticket not found → endRun("failed"), notify error
 * - On agent dispatch failure → endRun("failed"), failCreature called
 * - On happy path → endRun("completed"), no error
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Control knobs ─────────────────────────────────────────────

// In-memory active runs: workItemId → run state
let _activeRunsByWorkItem = new Map<string, { runId: string; agentType: string }>();
let _activeRunCount = 0;

// Captured calls
const _startRunCalls: any[] = [];
const _endRunCalls: any[] = [];
const _emitEventCalls: any[] = [];
const _enqueuedItems: any[] = [];
const _notifyCalls: any[] = [];

// Configurable mocks for fetch deps
let _workItemResult: any = { name: "Test Ticket", description: "ticket description", priority: "medium" };
let _dispatchAgentResult: any = {
  session_id: "session-1",
  is_new: true,
  agent: {
    name: "dev",
    type: "specialist",
    model: "claude-opus-4-6",
    tools_enabled: ["code_editor"],
    system_prompt: "You are a dev agent.",
    capabilities: ["coding"],
  },
};
let _claudeResponse = "Claude completed the task.";

// ── Module mocks ──────────────────────────────────────────────
// Must be registered before any imports that trigger module evaluation.

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

mock.module("../src/orchestration-tracker.ts", () => ({
  startRun: mock((runId: string, agentType: string, workItemId: string) => {
    _startRunCalls.push({ runId, agentType, workItemId });
    _activeRunsByWorkItem.set(workItemId, { runId, agentType });
  }),
  endRun: mock((runId: string, status: string) => {
    _endRunCalls.push({ runId, status });
  }),
  getActiveRunForWorkItem: mock((workItemId: string) =>
    _activeRunsByWorkItem.get(workItemId) ?? null
  ),
  getActiveRunCount: mock(() => _activeRunCount),
  setWatchdogNotify: mock(() => {}),
  heartbeat: mock(() => {}),
}));

mock.module("../src/orchestration-ledger.ts", () => ({
  emitEvent: mock((runId: string, type: string, agentType: string, workItemId: string, data?: any) => {
    _emitEventCalls.push({ runId, type, agentType, workItemId, data });
  }),
  getUnterminated: mock(() => Promise.resolve([])),
}));

mock.module("../src/dispatch-queue.ts", () => ({
  enqueue: mock((item: any) => {
    _enqueuedItems.push(item);
    return { position: 1 };
  }),
  getQueueDepth: mock(() => 0),
  drainNext: mock(() => {}),
}));

mock.module("../src/dispatch-retry.ts", () => ({
  withRetry: mock(async (fn: () => Promise<any>) => {
    try {
      const result = await fn();
      return { success: true, result, attempts: 1 };
    } catch (err: any) {
      return { success: false, result: null, error: err, attempts: 1 };
    }
  }),
  classifyError: mock(() => "transient"),
}));

mock.module("../src/plane.ts", () => ({
  fetchWorkItemDetails: mock(async () => _workItemResult),
  isPlaneConfigured: mock(() => true),
  createPlaneIssue: mock(() => Promise.resolve(null)),
  updateWorkItemOnFailure: mock(() => Promise.resolve()),
  updateWorkItemOnSessionStart: mock(() => Promise.resolve()),
  updateWorkItemOnSessionComplete: mock(() => Promise.resolve()),
}));

mock.module("../src/agent-router.ts", () => ({
  dispatchAgent: mock(async () => _dispatchAgentResult),
  syncResponse: mock(() => Promise.resolve()),
}));

mock.module("../src/memory.ts", () => ({
  processMemoryIntents: mock(() => Promise.resolve()),
  getRelevantContext: mock(() => Promise.resolve("")),
}));

mock.module("../src/notification-policy.ts", () => ({
  notify: mock(async (ctx: any, opts: any) => {
    _notifyCalls.push({ ctx, opts });
  }),
}));

mock.module("../src/prompt-builder.ts", () => ({
  getAgentArchetype: mock(async () => null),
  getPsyContext: mock(async () => null),
  getPhaseContext: mock(async () => null),
  getHealthContext: mock(async () => null),
}));

mock.module("../src/context-sources.ts", () => ({
  getRiverContextForAgent: mock(async () => null),
}));

mock.module("../src/jobs-ledger.ts", () => ({
  createJob: mock(async () => "job-test-id"),
  updateJob: mock(async () => {}),
  appendJobEvent: mock(async () => {}),
  verifyJobWork: mock(async () => ({ verified: true, note: "" })),
  estimateJobCost: mock(() => 0.001),
  writeJobTouchpointForAgent: mock(async () => {}),
}));

mock.module("../src/relay-utils.ts", () => ({
  estimateTokens: mock(() => 100),
}));

mock.module("../../ellie-forest/src/index", () => ({
  startCreature: mock(async () => ({ id: "c-1", state: "working" })),
  completeCreature: mock(async () => ({ id: "c-1", state: "completed" })),
  failCreature: mock(async () => ({ id: "c-1", state: "failed" })),
  dispatchPushCreature: mock(async () => ({ id: "c-push-1", state: "dispatched" })),
  writeJobCompletionMetric: mock(async () => {}),
}));

mock.module("../src/channels/discord/observation.ts", () => ({
  postCreatureEvent: mock(() => {}),
  postJobEvent: mock(() => {}),
}));

mock.module("../src/tool-approval.ts", () => ({
  enterDispatchMode: mock(() => {}),
  exitDispatchMode: mock(() => {}),
}));

mock.module("../src/trace.ts", () => ({
  withTrace: mock(async (fn: () => Promise<any>) => fn()),
  getTraceId: mock(() => "trace-test-id"),
  generateTraceId: mock(() => "generated-trace-id"),
}));

// ── Import after mocks ────────────────────────────────────────

import { executeTrackedDispatch, type TrackedDispatchOpts } from "../src/orchestration-dispatch.ts";

// ── Helpers ───────────────────────────────────────────────────

const makeMockPlaybookCtx = (overrides: Partial<any> = {}): any => ({
  supabase: null,
  bot: null,
  telegramUserId: "user-123",
  gchatSpaceName: undefined,
  channel: "telegram",
  callClaudeFn: mock(async () => _claudeResponse),
  buildPromptFn: mock((..._args: any[]) => "built-prompt"),
  ...overrides,
});

function makeOpts(overrides: Partial<TrackedDispatchOpts> = {}): TrackedDispatchOpts {
  return {
    agentType: "dev",
    workItemId: "ELLIE-494",
    channel: "telegram",
    message: "Work on this ticket",
    playbookCtx: makeMockPlaybookCtx(),
    ...overrides,
  };
}

// Override global fetch for the work-session HTTP call
const _mockFetch = mock(async () => ({
  json: async () => ({
    success: true,
    tree_id: "tree-1",
    creatures: [{ id: "c-1", branch_id: "branch-1", entity_id: "entity-dev" }],
  }),
}));

beforeEach(() => {
  _activeRunsByWorkItem.clear();
  _activeRunCount = 0;
  _startRunCalls.length = 0;
  _endRunCalls.length = 0;
  _emitEventCalls.length = 0;
  _enqueuedItems.length = 0;
  _notifyCalls.length = 0;
  _workItemResult = { name: "Test Ticket", description: "ticket description", priority: "medium" };
  _dispatchAgentResult = {
    session_id: "session-1",
    is_new: true,
    agent: {
      name: "dev",
      type: "specialist",
      model: "claude-opus-4-6",
      tools_enabled: [],
      system_prompt: "",
      capabilities: [],
    },
  };
  _claudeResponse = "Claude completed the task.";
  _mockFetch.mockClear();
  global.fetch = _mockFetch as any;
});

// ── Synchronous return behavior ───────────────────────────────

describe("executeTrackedDispatch — synchronous return", () => {
  test("returns { runId, promise } without awaiting", () => {
    const result = executeTrackedDispatch(makeOpts());

    expect(result).toBeDefined();
    expect(typeof result.runId).toBe("string");
    expect(result.promise instanceof Promise).toBe(true);
  });

  test("runId is a UUID-format string", () => {
    const { runId } = executeTrackedDispatch(makeOpts());
    // Rough UUID check: 36 chars with hyphens
    expect(runId.length).toBeGreaterThanOrEqual(32);
  });

  test("calls startRun immediately with agentType and workItemId", () => {
    const opts = makeOpts({ agentType: "research", workItemId: "ELLIE-100" });
    executeTrackedDispatch(opts);

    expect(_startRunCalls).toHaveLength(1);
    expect(_startRunCalls[0].agentType).toBe("research");
    expect(_startRunCalls[0].workItemId).toBe("ELLIE-100");
  });

  test("emits 'dispatched' event synchronously", () => {
    executeTrackedDispatch(makeOpts({ workItemId: "ELLIE-200" }));

    const dispatchedEvt = _emitEventCalls.find(e => e.type === "dispatched");
    expect(dispatchedEvt).toBeDefined();
    expect(dispatchedEvt.workItemId).toBe("ELLIE-200");
    expect(dispatchedEvt.agentType).toBe("dev");
  });

  test("returned runId matches the runId passed to startRun", () => {
    const { runId } = executeTrackedDispatch(makeOpts());
    expect(_startRunCalls[0].runId).toBe(runId);
  });
});

// ── Dispatch queuing — duplicate work item ────────────────────

describe("executeTrackedDispatch — duplicate work item queuing", () => {
  test("queues when active run already exists for same work item", () => {
    // First dispatch
    executeTrackedDispatch(makeOpts({ workItemId: "ELLIE-300" }));

    // Second dispatch for same work item (activeRunsByWorkItem now has it)
    const result2 = executeTrackedDispatch(makeOpts({ workItemId: "ELLIE-300" }));

    expect(_enqueuedItems).toHaveLength(1);
    expect(_enqueuedItems[0].workItemId).toBe("ELLIE-300");
    // Queue ID is returned, not a real run ID (startRun not called a second time)
    expect(_startRunCalls).toHaveLength(1);
  });

  test("queued dispatch returns a promise that resolves immediately", async () => {
    executeTrackedDispatch(makeOpts({ workItemId: "ELLIE-301" }));
    const { promise } = executeTrackedDispatch(makeOpts({ workItemId: "ELLIE-301" }));

    // Should resolve without error
    await expect(promise).resolves.toBeUndefined();
  });

  test("different work items are NOT queued (independent dispatches)", () => {
    executeTrackedDispatch(makeOpts({ workItemId: "ELLIE-400" }));
    executeTrackedDispatch(makeOpts({ workItemId: "ELLIE-401" }));

    expect(_enqueuedItems).toHaveLength(0);
    expect(_startRunCalls).toHaveLength(2);
  });
});

// ── Dispatch queuing — concurrency cap ───────────────────────

describe("executeTrackedDispatch — concurrency cap (MAX=3)", () => {
  test("queues when 3 dispatches already active", () => {
    _activeRunCount = 3;
    // No active run for this work item, but at cap
    const { runId } = executeTrackedDispatch(makeOpts({ workItemId: "ELLIE-500" }));

    expect(_enqueuedItems).toHaveLength(1);
    expect(_enqueuedItems[0].workItemId).toBe("ELLIE-500");
    // startRun NOT called for a queued dispatch
    expect(_startRunCalls).toHaveLength(0);
  });

  test("queued-for-cap dispatch also returns promise that resolves immediately", async () => {
    _activeRunCount = 3;
    const { promise } = executeTrackedDispatch(makeOpts());
    await expect(promise).resolves.toBeUndefined();
  });

  test("dispatches normally when count is exactly 2 (below cap)", () => {
    _activeRunCount = 2;
    executeTrackedDispatch(makeOpts({ workItemId: "ELLIE-502" }));

    expect(_enqueuedItems).toHaveLength(0);
    expect(_startRunCalls).toHaveLength(1);
  });
});

// ── Async lifecycle: ticket not found ────────────────────────

describe("executeTrackedDispatch — async: ticket not found", () => {
  test("calls endRun('failed') when ticket not found", async () => {
    _workItemResult = null; // fetchWorkItemDetails returns null
    const { runId, promise } = executeTrackedDispatch(makeOpts({ workItemId: "MISSING-1" }));

    await promise;

    const failedEnd = _endRunCalls.find(c => c.runId === runId && c.status === "failed");
    expect(failedEnd).toBeDefined();
  });

  test("notifies error when ticket not found", async () => {
    _workItemResult = null;
    const { promise } = executeTrackedDispatch(makeOpts({ workItemId: "MISSING-2" }));
    await promise;

    const errorNotify = _notifyCalls.find(c => c.opts.event === "error");
    expect(errorNotify).toBeDefined();
    expect(errorNotify.opts.workItemId).toBe("MISSING-2");
  });

  test("emits 'failed' event when ticket not found", async () => {
    _workItemResult = null;
    const { runId, promise } = executeTrackedDispatch(makeOpts({ workItemId: "MISSING-3" }));
    await promise;

    const failedEvt = _emitEventCalls.find(e => e.type === "failed" && e.runId === runId);
    expect(failedEvt).toBeDefined();
  });
});

// ── Async lifecycle: agent dispatch failure ───────────────────

describe("executeTrackedDispatch — async: agent dispatch failure", () => {
  test("calls endRun('failed') when dispatchAgent returns null", async () => {
    _dispatchAgentResult = null; // dispatchAgent returns null
    const { runId, promise } = executeTrackedDispatch(makeOpts({ workItemId: "FAIL-AGENT-1" }));

    await promise;

    const failedEnd = _endRunCalls.find(c => c.runId === runId && c.status === "failed");
    expect(failedEnd).toBeDefined();
  });
});

// ── Async lifecycle: happy path ───────────────────────────────

describe("executeTrackedDispatch — async: happy path", () => {
  test("calls endRun('completed') on success", async () => {
    const { runId, promise } = executeTrackedDispatch(makeOpts({ workItemId: "ELLIE-OK-1" }));

    await promise;

    const completedEnd = _endRunCalls.find(c => c.runId === runId && c.status === "completed");
    expect(completedEnd).toBeDefined();
  });

  test("emits 'completed' event on success", async () => {
    const { runId, promise } = executeTrackedDispatch(makeOpts({ workItemId: "ELLIE-OK-2" }));

    await promise;

    const completedEvt = _emitEventCalls.find(e => e.type === "completed" && e.runId === runId);
    expect(completedEvt).toBeDefined();
  });

  test("notifies session_complete on success", async () => {
    const { promise } = executeTrackedDispatch(makeOpts({ workItemId: "ELLIE-OK-3" }));

    await promise;

    const completeNotify = _notifyCalls.find(c => c.opts.event === "session_complete");
    expect(completeNotify).toBeDefined();
    expect(completeNotify.opts.workItemId).toBe("ELLIE-OK-3");
  });

  test("callClaudeFn is invoked with the built prompt", async () => {
    const callClaudeFn = mock(async () => "Claude says done");
    const playbookCtx = makeMockPlaybookCtx({ callClaudeFn });

    const { promise } = executeTrackedDispatch(makeOpts({
      workItemId: "ELLIE-OK-4",
      playbookCtx,
    }));

    await promise;

    expect(callClaudeFn).toHaveBeenCalledTimes(1);
    // First arg is the prompt string
    expect(typeof callClaudeFn.mock.calls[0][0]).toBe("string");
  });

  test("dispatch_confirm notification sent before calling Claude", async () => {
    const { promise } = executeTrackedDispatch(makeOpts({ workItemId: "ELLIE-OK-5" }));

    await promise;

    const confirmNotify = _notifyCalls.find(c => c.opts.event === "dispatch_confirm");
    expect(confirmNotify).toBeDefined();
    expect(confirmNotify.opts.workItemId).toBe("ELLIE-OK-5");
  });
});
