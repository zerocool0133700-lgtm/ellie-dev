/**
 * ELLIE-520 — Pre-validate agents before plan creation (fail fast).
 *
 * Verifies that all agents are checked BEFORE any state changes:
 *   - createExecutionPlan() (execution_plans DB row)
 *   - startRun() (orchestration tracker)
 *   - emitEvent() (ledger)
 *
 * If any agent doesn't exist, PipelineValidationError is thrown immediately
 * with no side effects — no orphaned plans, no Plane ticket movement.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  createMockDispatchResult,
  createMockOptions,
  createMockSupabase,
  createStep,
} from "./helpers.ts";

// ── Mock ellie-forest getAgent ────────────────────────────────

const mockGetAgent = mock();
const mockForestCompleteSession = mock();

mock.module("../../ellie-forest/src/index", () => ({
  getAgent: mockGetAgent,
  completeWorkSession: mockForestCompleteSession,
}));

// ── Mock agent-router (so dispatch doesn't hit real DB) ───────

const mockDispatchAgent = mock();
const mockSyncResponse = mock();

mock.module("../src/agent-router.ts", () => ({
  dispatchAgent: mockDispatchAgent,
  syncResponse: mockSyncResponse,
}));

// ── Mock memory / approval (pipeline uses these) ──────────────

mock.module("../src/memory.ts", () => ({
  processMemoryIntents: mock((_sb: any, text: string) => Promise.resolve(text)),
  insertMemoryWithDedup: mock(() => Promise.resolve({ id: "m", action: "inserted" })),
  checkMemoryConflict: mock(() => Promise.resolve({ available: true, match: null })),
  resolveMemoryConflict: mock(() => ({ resolution: "keep_both", existingMemory: null, reason: "" })),
  DEDUP_SIMILARITY_THRESHOLD: 0.85,
}));

mock.module("../src/approval.ts", () => ({
  extractApprovalTags: mock((text: string) => ({ cleanedText: text, approvals: [] })),
}));

// ── Imports after mocks ───────────────────────────────────────

import {
  executeOrchestrated,
  _resetCachesForTesting,
  PipelineValidationError,
} from "../src/orchestrator.ts";
import { _clearActiveCheckpoints } from "../src/pipeline-state.ts";

// ── Agent fixture ─────────────────────────────────────────────

const MOCK_AGENT = {
  name: "general",
  type: "generalist",
  system_prompt: "You are a helpful assistant.",
  model: null,
  tools_enabled: [],
  capabilities: ["general"],
};

// ── Setup ─────────────────────────────────────────────────────

beforeEach(() => {
  _resetCachesForTesting();
  _clearActiveCheckpoints();

  mockGetAgent.mockReset();
  mockDispatchAgent.mockReset();
  mockSyncResponse.mockReset();
  mockForestCompleteSession.mockReset();

  // Default: all agents exist
  mockGetAgent.mockImplementation(() => Promise.resolve(MOCK_AGENT));
  mockDispatchAgent.mockImplementation(() => Promise.resolve(createMockDispatchResult()));
  mockSyncResponse.mockImplementation(() => Promise.resolve(null));
  mockForestCompleteSession.mockImplementation(() => Promise.resolve());
});

// ── AC1 + AC2: Missing agent → PipelineValidationError, no plan created ──────

describe("AC1/AC2 — Missing agent detected, no state changes", () => {
  test("throws PipelineValidationError when first agent doesn't exist", async () => {
    mockGetAgent.mockImplementation(() => Promise.resolve(null));

    const options = createMockOptions();
    const steps = [createStep({ agent_name: "ghost-agent" })];

    await expect(
      executeOrchestrated("pipeline", steps, "Do something", options),
    ).rejects.toThrow(PipelineValidationError);
  });

  test("error message names the missing agent", async () => {
    mockGetAgent.mockImplementation(() => Promise.resolve(null));

    const options = createMockOptions();
    const steps = [createStep({ agent_name: "missing-agent-xyz" })];

    try {
      await executeOrchestrated("pipeline", steps, "Do something", options);
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineValidationError);
      expect((err as Error).message).toContain("missing-agent-xyz");
    }
  });

  test("no execution_plans row created when agent is missing", async () => {
    mockGetAgent.mockImplementation(() => Promise.resolve(null));

    const supabase = createMockSupabase();
    const options = createMockOptions({ supabase });
    const steps = [createStep({ agent_name: "ghost" })];

    await expect(
      executeOrchestrated("pipeline", steps, "Test", options),
    ).rejects.toThrow(PipelineValidationError);

    // execution_plans table must NOT have been touched
    const executionPlanCalls = supabase.from.mock.calls.filter(
      (call: any[]) => call[0] === "execution_plans",
    );
    expect(executionPlanCalls.length).toBe(0);
  });

  test("no dispatchAgent calls made when agent is missing", async () => {
    mockGetAgent.mockImplementation(() => Promise.resolve(null));

    const options = createMockOptions();
    const steps = [createStep({ agent_name: "ghost" })];

    await expect(
      executeOrchestrated("pipeline", steps, "Test", options),
    ).rejects.toThrow(PipelineValidationError);

    expect(mockDispatchAgent).not.toHaveBeenCalled();
  });

  test("getAgent called for each step before execution begins", async () => {
    mockGetAgent.mockImplementation(() => Promise.resolve(null));

    const options = createMockOptions();
    const steps = [
      createStep({ agent_name: "ghost-1" }),
      createStep({ agent_name: "ghost-2" }),
    ];

    await expect(
      executeOrchestrated("pipeline", steps, "Test", options),
    ).rejects.toThrow(PipelineValidationError);

    // Called once — fails fast on first missing agent
    expect(mockGetAgent).toHaveBeenCalledTimes(1);
    expect(mockGetAgent.mock.calls[0][0]).toBe("ghost-1");
  });
});

// ── AC3: Partial agent availability ───────────────────────────

describe("AC3 — Partial agent availability", () => {
  test("fails on first missing agent even if later agents exist", async () => {
    let callCount = 0;
    mockGetAgent.mockImplementation((name: string) => {
      callCount++;
      if (name === "ghost-step-2") return Promise.resolve(null);
      return Promise.resolve(MOCK_AGENT);
    });

    const options = createMockOptions();
    const steps = [
      createStep({ agent_name: "general" }),     // exists (step 1)
      createStep({ agent_name: "ghost-step-2" }), // missing (step 2)
      createStep({ agent_name: "content" }),      // exists (step 3, never reached)
    ];

    try {
      await executeOrchestrated("pipeline", steps, "Test", options);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineValidationError);
      expect((err as Error).message).toContain("ghost-step-2");
    }

    // Only 2 getAgent calls — stops at the missing one
    expect(mockGetAgent).toHaveBeenCalledTimes(2);
  });

  test("fails if last agent in pipeline is missing", async () => {
    mockGetAgent.mockImplementation((name: string) =>
      name === "missing-last"
        ? Promise.resolve(null)
        : Promise.resolve(MOCK_AGENT),
    );

    const options = createMockOptions();
    const steps = [
      createStep({ agent_name: "general" }),
      createStep({ agent_name: "content" }),
      createStep({ agent_name: "missing-last" }),
    ];

    await expect(
      executeOrchestrated("pipeline", steps, "Test", options),
    ).rejects.toThrow(PipelineValidationError);

    // All 3 agents checked (first two pass, third fails)
    expect(mockGetAgent).toHaveBeenCalledTimes(3);
  });

  test("no plan created when second of two agents is missing", async () => {
    mockGetAgent.mockImplementation((name: string) =>
      name === "ghost" ? Promise.resolve(null) : Promise.resolve(MOCK_AGENT),
    );

    const supabase = createMockSupabase();
    const options = createMockOptions({ supabase });
    const steps = [
      createStep({ agent_name: "general" }),
      createStep({ agent_name: "ghost" }),
    ];

    await expect(
      executeOrchestrated("pipeline", steps, "Test", options),
    ).rejects.toThrow(PipelineValidationError);

    const planCalls = supabase.from.mock.calls.filter(
      (call: any[]) => call[0] === "execution_plans",
    );
    expect(planCalls.length).toBe(0);
  });
});

// ── AC4: All-valid path — proceeds normally ───────────────────

describe("AC4 — All agents valid: execution proceeds", () => {
  test("execution_plans row IS created when all agents exist", async () => {
    // All agents return valid mock
    const supabase = createMockSupabase();
    const options = createMockOptions({ supabase });
    const steps = [
      createStep({ agent_name: "general" }),
      createStep({ agent_name: "content" }),
    ];

    await executeOrchestrated("pipeline", steps, "Test", options);

    const planCalls = supabase.from.mock.calls.filter(
      (call: any[]) => call[0] === "execution_plans",
    );
    expect(planCalls.length).toBeGreaterThan(0);
  });

  test("getAgent called once per step when all exist", async () => {
    const options = createMockOptions();
    const steps = [
      createStep({ agent_name: "general" }),
      createStep({ agent_name: "content" }),
    ];

    await executeOrchestrated("pipeline", steps, "Test", options);

    // 2 agents → 2 getAgent calls
    expect(mockGetAgent).toHaveBeenCalledTimes(2);
    expect(mockGetAgent.mock.calls[0][0]).toBe("general");
    expect(mockGetAgent.mock.calls[1][0]).toBe("content");
  });

  test("single-step pipeline with valid agent completes successfully", async () => {
    const options = createMockOptions();
    const steps = [createStep({ agent_name: "general" })];

    const result = await executeOrchestrated("pipeline", steps, "Test", options);

    expect(result.mode).toBe("pipeline");
    expect(result.stepResults.length).toBe(1);
  });

  test("fan-out mode: all agents validated before parallel execution", async () => {
    const options = createMockOptions();
    const steps = [
      createStep({ agent_name: "general", instruction: "A" }),
      createStep({ agent_name: "content", instruction: "B" }),
    ];

    const result = await executeOrchestrated("fan-out", steps, "Test", options);

    expect(result.mode).toBe("fan-out");
    // getAgent called once per step
    expect(mockGetAgent).toHaveBeenCalledTimes(2);
  });

  test("fan-out mode: missing agent aborts before any parallel step executes", async () => {
    mockGetAgent.mockImplementation((name: string) =>
      name === "ghost" ? Promise.resolve(null) : Promise.resolve(MOCK_AGENT),
    );

    const options = createMockOptions();
    const steps = [
      createStep({ agent_name: "general", instruction: "A" }),
      createStep({ agent_name: "ghost", instruction: "B" }),
    ];

    await expect(
      executeOrchestrated("fan-out", steps, "Test", options),
    ).rejects.toThrow(PipelineValidationError);

    // dispatchAgent never called — validation failed before execution
    expect(mockDispatchAgent).not.toHaveBeenCalled();
  });
});

// ── MAX_PIPELINE_DEPTH truncation ─────────────────────────────

describe("Validation respects MAX_PIPELINE_DEPTH truncation", () => {
  test("validates only up to MAX_PIPELINE_DEPTH steps", async () => {
    // Steps beyond depth 5 are truncated — ghost beyond limit should NOT fail
    const steps = [
      createStep({ agent_name: "general" }),
      createStep({ agent_name: "general" }),
      createStep({ agent_name: "general" }),
      createStep({ agent_name: "general" }),
      createStep({ agent_name: "general" }),
      createStep({ agent_name: "ghost-beyond-limit" }), // index 5, should be truncated
    ];

    mockGetAgent.mockImplementation((name: string) =>
      name === "ghost-beyond-limit" ? Promise.resolve(null) : Promise.resolve(MOCK_AGENT),
    );

    const options = createMockOptions();

    // Should NOT throw — the ghost step is beyond MAX_PIPELINE_DEPTH (5)
    const result = await executeOrchestrated("pipeline", steps, "Test", options);

    expect(result.mode).toBe("pipeline");
    expect(mockGetAgent).toHaveBeenCalledTimes(5); // only 5 steps validated
  });
});
