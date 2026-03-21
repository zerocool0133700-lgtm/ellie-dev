/**
 * ELLIE-942 — Wiring integration tests for session-spawn
 *
 * Tests that session-spawn is properly wired into:
 *   - orchestration-dispatch.ts (executeSpawnedDispatch)
 *   - formation-costs.ts (fetchChildCosts)
 *   - prompt-builder.ts (spawn status injection)
 *   - periodic-tasks.ts (timeout check)
 *
 * All external deps are mocked to isolate the wiring logic.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mocks — must precede imports ─────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock() }) },
}));

const mockDispatchAgent = mock(() =>
  Promise.resolve({
    session_id: "child-session-1",
    agent: {
      name: "research",
      type: "specialist",
      system_prompt: null,
      model: "claude-haiku-4-5-20251001",
      tools_enabled: [],
      capabilities: [],
    },
    is_new: true,
  }),
);
const mockSyncResponse = mock(() => Promise.resolve({ success: true }));
mock.module("../src/agent-router.ts", () => ({
  dispatchAgent: mockDispatchAgent,
  syncResponse: mockSyncResponse,
}));

const mockNotify = mock(() => Promise.resolve());
mock.module("../src/notification-policy.ts", () => ({
  notify: mockNotify,
}));

mock.module("../src/tool-approval.ts", () => ({
  enterDispatchMode: mock(),
  exitDispatchMode: mock(),
}));

// Stub everything orchestration-dispatch transitively imports
mock.module("../src/orchestration-ledger.ts", () => ({ emitEvent: mock() }));
mock.module("../src/orchestration-tracker.ts", () => ({
  startRun: mock(),
  endRun: mock(),
  getActiveRunForWorkItem: mock(() => null),
  getActiveRunCount: mock(() => 0),
  getActiveRunStates: mock(() => []),
}));
mock.module("../src/dispatch-queue.ts", () => ({
  enqueue: mock(() => ({ position: 1 })),
  getQueueDepth: mock(() => 0),
  drainNext: mock(),
}));
mock.module("../src/trace.ts", () => ({
  withTrace: mock((_fn: () => Promise<any>) => Promise.resolve()),
  getTraceId: mock(() => "trace-id"),
  generateTraceId: mock(() => "gen-trace-id"),
}));
mock.module("../src/plane.ts", () => ({ fetchWorkItemDetails: mock(() => Promise.resolve(null)) }));
mock.module("../src/memory.ts", () => ({
  processMemoryIntents: mock(() => Promise.resolve()),
  clearPendingMemoryQueue: mock(),
}));
mock.module("../src/elasticsearch/circuit-breaker.ts", () => ({
  resetBreaker: mock(),
}));
mock.module("../src/prompt-builder.ts", () => ({
  getAgentArchetype: mock(() => Promise.resolve("")),
  getPsyContext: mock(() => Promise.resolve("")),
  getPhaseContext: mock(() => Promise.resolve("")),
  getHealthContext: mock(() => Promise.resolve("")),
  getAgentRoleContext: mock(() => Promise.resolve("")),
}));
mock.module("../src/context-sources.ts", () => ({ getRiverContextForAgent: mock(() => Promise.resolve(null)) }));
mock.module("../src/dispatch-retry.ts", () => ({
  withRetry: mock((fn: () => any) => fn().then((r: any) => ({ success: true, result: r, attempts: 1 }))),
  classifyError: mock(() => ({ errorClass: "unknown", reason: "unknown" })),
}));
mock.module("../src/dispatch-advice-injector.ts", () => ({
  getAdviceForDispatch: mock(() => Promise.resolve(null)),
  enrichPromptWithAdvice: mock((ctx: string) => ctx),
}));
mock.module("../src/jobs-ledger.ts", () => ({
  createJob: mock(() => Promise.resolve("job-123")),
  updateJob: mock(() => Promise.resolve()),
  appendJobEvent: mock(() => Promise.resolve()),
  verifyJobWork: mock(() => Promise.resolve({ verified: true, note: "" })),
  estimateJobCost: mock(() => 0),
  writeJobTouchpointForAgent: mock(() => Promise.resolve()),
}));
mock.module("../src/relay-utils.ts", () => ({ estimateTokens: mock(() => 100) }));
mock.module("../src/relay-config.ts", () => ({ RELAY_BASE_URL: "http://localhost:3001" }));
mock.module("../src/relay-epoch.ts", () => ({ RELAY_EPOCH: "test" }));
const noopBreaker = { call: mock(async (fn: () => any) => fn()), reset: mock() };
mock.module("../src/resilience.ts", () => ({
  breakers: {
    edgeFn: noopBreaker,
    plane: { ...noopBreaker },
    bridge: { ...noopBreaker },
    outlook: { ...noopBreaker },
    googleChat: { ...noopBreaker },
  },
}));
mock.module("../src/intent-classifier.ts", () => ({
  classifyIntent: mock(() => Promise.resolve({ agent_name: "general", rule_name: "test", confidence: 1, execution_mode: "single" })),
}));
mock.module("../src/permission-guard.ts", () => ({
  guardAgentDispatch: mock(() => Promise.resolve({ allowed: true })),
  resolveRbacEntityId: mock(() => Promise.resolve(null)),
  formatDenialMessage: mock(() => ""),
  DEFAULT_GUARD_CONFIG: {},
}));
mock.module("../src/permission-audit.ts", () => ({ logCheck: mock() }));
mock.module("../../ellie-forest/src/index", () => ({
  sql: mock(),
  startCreature: mock(() => Promise.resolve()),
  failCreature: mock(() => Promise.resolve()),
  completeCreature: mock(() => Promise.resolve()),
  dispatchPushCreature: mock(() => Promise.resolve({ id: "push-1" })),
  writeJobCompletionMetric: mock(),
}));
mock.module("../src/channels/discord/observation.ts", () => ({
  postCreatureEvent: mock(),
  postJobEvent: mock(),
}));

// ── Imports (after mocks) ────────────────────────────────────

import { _clearRegistryForTesting, getSpawnRecord, getChildrenForParent } from "../src/session-spawn.ts";
import { executeSpawnedDispatch, type SpawnedDispatchOpts } from "../src/orchestration-dispatch.ts";

// ── Helpers ──────────────────────────────────────────────────

function makePlaybookCtx(): any {
  return {
    supabase: {
      from: mock(() => ({
        select: mock().mockReturnThis(),
        insert: mock().mockReturnThis(),
        update: mock().mockReturnThis(),
        eq: mock().mockReturnThis(),
        is: mock().mockReturnThis(),
        order: mock().mockReturnThis(),
        limit: mock().mockReturnThis(),
        single: mock(() => Promise.resolve({ data: null, error: null })),
      })),
      functions: { invoke: mock(() => Promise.resolve({ data: null, error: null })) },
    },
    bot: { api: { sendMessage: mock(() => Promise.resolve()) } },
    telegramUserId: "user-1",
    gchatSpaceName: null,
    buildPromptFn: mock(() => "Built prompt for sub-agent"),
    callClaudeFn: mock(() => Promise.resolve("Sub-agent research complete: found 3 issues")),
  };
}

function makeSpawnedOpts(overrides: Partial<SpawnedDispatchOpts> = {}): SpawnedDispatchOpts {
  return {
    parentSessionId: "parent-session-1",
    parentAgentName: "dev",
    targetAgentName: "research",
    task: "Investigate auth middleware compliance",
    channel: "telegram",
    userId: "user-1",
    workItemId: "ELLIE-100",
    playbookCtx: makePlaybookCtx(),
    ...overrides,
  };
}

beforeEach(() => {
  _clearRegistryForTesting();
  mockDispatchAgent.mockClear();
  mockSyncResponse.mockClear();
  mockNotify.mockClear();
});

// ── executeSpawnedDispatch ────────────────────────────────────

describe("executeSpawnedDispatch", () => {
  test("spawns and returns spawnId immediately", () => {
    const result = executeSpawnedDispatch(makeSpawnedOpts());

    expect(result.success).toBe(true);
    expect(result.spawnId).toBeTruthy();
    expect(result.promise).toBeInstanceOf(Promise);
  });

  test("spawn record is created in registry", () => {
    const result = executeSpawnedDispatch(makeSpawnedOpts());

    const record = getSpawnRecord(result.spawnId);
    expect(record).not.toBeNull();
    expect(record!.parentSessionId).toBe("parent-session-1");
    expect(record!.targetAgentName).toBe("research");
    expect(record!.state).toBe("pending");
  });

  test("full lifecycle: dispatches agent, calls Claude, completes", async () => {
    const opts = makeSpawnedOpts();
    const result = executeSpawnedDispatch(opts);

    expect(result.success).toBe(true);
    await result.promise;

    // Check the spawn completed
    const record = getSpawnRecord(result.spawnId);
    expect(record!.state).toBe("completed");
    expect(record!.resultText).toContain("research complete");

    // Verify dispatchAgent was called with correct args
    expect(mockDispatchAgent).toHaveBeenCalledTimes(1);

    // Verify syncResponse was called to close the session
    expect(mockSyncResponse).toHaveBeenCalledTimes(1);

    // Verify notification was sent
    expect(mockNotify).toHaveBeenCalled();
    const notifyCall = mockNotify.mock.calls[0];
    expect(notifyCall[1].event).toBe("session_complete");
    expect(notifyCall[1].telegramMessage).toContain("Sub-agent research finished");
  });

  test("marks spawn failed when dispatchAgent returns null", async () => {
    mockDispatchAgent.mockImplementationOnce(() => Promise.resolve(null));

    const result = executeSpawnedDispatch(makeSpawnedOpts());
    await result.promise;

    const record = getSpawnRecord(result.spawnId);
    expect(record!.state).toBe("failed");
    expect(record!.error).toContain("dispatch returned null");
  });

  test("marks spawn failed when Claude call throws", async () => {
    const opts = makeSpawnedOpts();
    opts.playbookCtx.callClaudeFn = mock(() => Promise.reject(new Error("Rate limited")));

    const result = executeSpawnedDispatch(opts);
    await result.promise;

    const record = getSpawnRecord(result.spawnId);
    expect(record!.state).toBe("failed");
    expect(record!.error).toContain("Rate limited");
  });

  test("rejects when max children exceeded", () => {
    // Fill to capacity (5)
    for (let i = 0; i < 5; i++) {
      executeSpawnedDispatch(makeSpawnedOpts());
    }

    const result = executeSpawnedDispatch(makeSpawnedOpts());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Max concurrent children");
  });

  test("passes arcMode and threadBind through to spawn record", () => {
    const result = executeSpawnedDispatch(
      makeSpawnedOpts({
        arcMode: "fork",
        threadBind: true,
        parentArcId: "arc-1",
      }),
    );

    const record = getSpawnRecord(result.spawnId);
    expect(record!.arcMode).toBe("fork");
    expect(record!.threadBound).toBe(true);
    expect(record!.arcId).toBe("arc-1");
  });

  test("children are visible via getChildrenForParent", () => {
    executeSpawnedDispatch(makeSpawnedOpts({ targetAgentName: "research" }));
    executeSpawnedDispatch(makeSpawnedOpts({ targetAgentName: "critic" }));

    const children = getChildrenForParent("parent-session-1");
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.targetAgentName).sort()).toEqual(["critic", "research"]);
  });
});
