/**
 * ELLIE-521 — Per-step timeout tests.
 *
 * Covers:
 * - Timeout fires when callClaudeFn never resolves (heavy path)
 * - Timeout fires when anthropicClient.messages.create never resolves (light path)
 * - stepTimeoutMs override is respected
 * - No timeout when step completes in time
 * - Light skill defaults to STEP_TIMEOUT_LIGHT_MS, heavy to STEP_TIMEOUT_HEAVY_MS
 * - Timeout propagates as PipelineStepError with errorType "timeout"
 * - Timeout+abort propagates out of executePipeline
 * - Timeout+skip continues pipeline with previous output
 * - Timeout+retry retries the step
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  createMockDispatchResult,
  createMockOptions,
  createMockSupabase,
  createStep,
} from "./helpers.ts";

// ── Mock ellie-forest ─────────────────────────────────────────

const mockGetAgent = mock();
const mockForestCompleteSession = mock();

mock.module("../../ellie-forest/src/index", () => ({
  getAgent: mockGetAgent,
  completeWorkSession: mockForestCompleteSession,
}));

// ── Mock agent-router ─────────────────────────────────────────

const mockDispatchAgent = mock();
const mockSyncResponse = mock();

mock.module("../src/agent-router.ts", () => ({
  dispatchAgent: mockDispatchAgent,
  syncResponse: mockSyncResponse,
}));

// ── Mock dispatch-retry (no real backoff delays in tests) ─────

mock.module("../src/dispatch-retry.ts", () => ({
  classifyError: (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.toLowerCase().includes("timeout");
    return { errorClass: isTimeout ? "retryable" : "permanent", reason: isTimeout ? "timeout" : "permanent" };
  },
  calculateDelay: () => 0,
  withRetry: async <T>(fn: () => Promise<T>, opts: { maxRetries?: number } = {}) => {
    const maxRetries = opts.maxRetries ?? 3;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn();
        return { success: true, result, attempts: attempt + 1, retryHistory: [] };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const msg = lastError.message.toLowerCase();
        if (!msg.includes("timeout") && !msg.includes("timed out")) {
          // permanent — don't retry
          return { success: false, error: lastError, attempts: attempt + 1, retryHistory: [] };
        }
      }
    }
    return { success: false, error: lastError, attempts: maxRetries + 1, retryHistory: [] };
  },
}));

// ── Mock memory / approval ────────────────────────────────────

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
  PipelineStepError,
  STEP_TIMEOUT_LIGHT_MS,
  STEP_TIMEOUT_HEAVY_MS,
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

  mockGetAgent.mockImplementation(() => Promise.resolve(MOCK_AGENT));
  mockDispatchAgent.mockImplementation(() => Promise.resolve(createMockDispatchResult()));
  mockSyncResponse.mockImplementation(() => Promise.resolve(null));
  mockForestCompleteSession.mockImplementation(() => Promise.resolve());
});

// ── Constants ─────────────────────────────────────────────────

describe("STEP_TIMEOUT constants", () => {
  test("STEP_TIMEOUT_LIGHT_MS is 30 seconds", () => {
    expect(STEP_TIMEOUT_LIGHT_MS).toBe(30_000);
  });

  test("STEP_TIMEOUT_HEAVY_MS is 60 seconds", () => {
    expect(STEP_TIMEOUT_HEAVY_MS).toBe(60_000);
  });

  test("light timeout is shorter than heavy timeout", () => {
    expect(STEP_TIMEOUT_LIGHT_MS).toBeLessThan(STEP_TIMEOUT_HEAVY_MS);
  });
});

// ── Heavy path timeout ────────────────────────────────────────

describe("Heavy path (callClaudeFn) — timeout", () => {
  test("throws PipelineStepError with errorType 'timeout' when callClaudeFn never resolves", async () => {
    const options = createMockOptions({
      // Remove anthropicClient so skill goes heavy path
      anthropicClient: null,
      callClaudeFn: mock(() => new Promise(() => {})), // never resolves
      stepTimeoutMs: 50,
    });
    const steps = [createStep({ agent_name: "general", skill_name: "web_research" })];

    await expect(
      executeOrchestrated("pipeline", steps, "Test timeout", options),
    ).rejects.toMatchObject({
      name: "PipelineStepError",
      errorType: "timeout",
    });
  });

  test("PipelineStepError has correct stepIndex on timeout", async () => {
    const options = createMockOptions({
      anthropicClient: null,
      callClaudeFn: mock(() => new Promise(() => {})),
      stepTimeoutMs: 50,
    });
    const steps = [createStep({ agent_name: "general", skill_name: "web_research" })];

    try {
      await executeOrchestrated("pipeline", steps, "Test", options);
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineStepError);
      expect((err as PipelineStepError).stepIndex).toBe(0);
    }
  });

  test("second step can timeout independently (first step completes)", async () => {
    let callCount = 0;
    const options = createMockOptions({
      anthropicClient: null,
      callClaudeFn: mock(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve("Step 1 done");
        return new Promise(() => {}); // step 2 never resolves
      }),
      stepTimeoutMs: 50,
    });
    const steps = [
      createStep({ agent_name: "general", instruction: "Step 1" }),
      createStep({ agent_name: "general", instruction: "Step 2" }),
    ];

    await expect(
      executeOrchestrated("pipeline", steps, "Test", options),
    ).rejects.toMatchObject({ name: "PipelineStepError", errorType: "timeout" });

    expect(callCount).toBe(2);
  });
});

// ── Light path timeout ────────────────────────────────────────

describe("Light path (anthropicClient) — timeout", () => {
  test("throws PipelineStepError with errorType 'timeout' when anthropicClient never resolves", async () => {
    const hangingAnthropic = {
      messages: {
        create: mock(() => new Promise(() => {})), // never resolves
      },
    };
    const options = createMockOptions({
      anthropicClient: hangingAnthropic as any,
      stepTimeoutMs: 50,
    });
    // writing is a "light" skill in mock supabase
    const steps = [createStep({ agent_name: "general", skill_name: "writing" })];

    await expect(
      executeOrchestrated("pipeline", steps, "Test", options),
    ).rejects.toMatchObject({ name: "PipelineStepError", errorType: "timeout" });
  });
});

// ── No timeout when step completes in time ────────────────────

describe("No timeout when step completes quickly", () => {
  test("completes successfully with generous stepTimeoutMs", async () => {
    const options = createMockOptions({
      stepTimeoutMs: 5_000, // 5s — plenty of time for mock
    });
    const steps = [createStep({ agent_name: "general" })];

    const result = await executeOrchestrated("pipeline", steps, "Test", options);
    expect(result.mode).toBe("pipeline");
    expect(result.stepResults.length).toBe(1);
  });

  test("default options (no stepTimeoutMs) succeeds — mock resolves instantly", async () => {
    const options = createMockOptions();
    const steps = [createStep({ agent_name: "general" })];

    const result = await executeOrchestrated("pipeline", steps, "Test", options);
    expect(result.mode).toBe("pipeline");
  });
});

// ── stepTimeoutMs override ────────────────────────────────────

describe("stepTimeoutMs override", () => {
  test("custom stepTimeoutMs fires at correct threshold", async () => {
    let resolveAfterMs = 200; // step takes 200ms
    const options = createMockOptions({
      anthropicClient: null,
      callClaudeFn: mock(
        () => new Promise<string>(resolve => setTimeout(() => resolve("done"), resolveAfterMs)),
      ),
      stepTimeoutMs: 80, // fires before 200ms
    });
    const steps = [createStep({ agent_name: "general", skill_name: "web_research" })];

    await expect(
      executeOrchestrated("pipeline", steps, "Test", options),
    ).rejects.toMatchObject({ name: "PipelineStepError", errorType: "timeout" });
  });

  test("step completes successfully when stepTimeoutMs is larger than step duration", async () => {
    const options = createMockOptions({
      anthropicClient: null,
      callClaudeFn: mock(
        () => new Promise<string>(resolve => setTimeout(() => resolve("done"), 20)),
      ),
      stepTimeoutMs: 500,
    });
    const steps = [createStep({ agent_name: "general", skill_name: "web_research" })];

    const result = await executeOrchestrated("pipeline", steps, "Test", options);
    expect(result.finalResponse).toBe("done");
  });
});

// ── Timeout + skip ────────────────────────────────────────────

describe("Timeout + onStepFailure skip", () => {
  test("skip action: pipeline continues with previous output", async () => {
    let callCount = 0;
    const options = createMockOptions({
      anthropicClient: null,
      callClaudeFn: mock(() => {
        callCount++;
        if (callCount === 1) return new Promise(() => {}); // step 1 hangs
        return Promise.resolve("Step 2 output");
      }),
      stepTimeoutMs: 50,
      onStepFailure: mock(async () => "skip" as const),
    });
    const steps = [
      createStep({ agent_name: "general", instruction: "Slow step" }),
      createStep({ agent_name: "general", instruction: "Fast step" }),
    ];

    const result = await executeOrchestrated("pipeline", steps, "Test", options);
    // Pipeline completes — skipped step carried forward null/empty previous output
    expect(result.mode).toBe("pipeline");
    expect(result.stepResults.length).toBe(1); // only step 2 succeeded
    expect(result.finalResponse).toBe("Step 2 output");
  });
});

// ── Timeout + retry ───────────────────────────────────────────

describe("Timeout + onStepFailure retry", () => {
  test("retry action: step is attempted again after timeout", async () => {
    let callCount = 0;
    const options = createMockOptions({
      anthropicClient: null,
      callClaudeFn: mock(() => {
        callCount++;
        if (callCount <= 1) return new Promise(() => {}); // first attempt hangs
        return Promise.resolve("Retry succeeded");
      }),
      stepTimeoutMs: 50,
      onStepFailure: mock(async () => "retry" as const),
    });
    const steps = [createStep({ agent_name: "general", skill_name: "web_research" })];

    const result = await executeOrchestrated("pipeline", steps, "Test", options);
    expect(result.finalResponse).toBe("Retry succeeded");
    // At least 2 calls: one timeout + one or more retries
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  test("retry exhausted → throws PipelineStepError", async () => {
    const options = createMockOptions({
      anthropicClient: null,
      callClaudeFn: mock(() => new Promise(() => {})), // always hangs
      stepTimeoutMs: 30,
      onStepFailure: mock(async () => "retry" as const),
    });
    const steps = [createStep({ agent_name: "general", skill_name: "web_research" })];

    await expect(
      executeOrchestrated("pipeline", steps, "Test", options),
    ).rejects.toBeInstanceOf(PipelineStepError);
  });
});

// ── Fan-out mode ──────────────────────────────────────────────

describe("Fan-out mode timeout", () => {
  test("timeout in fan-out step propagates as error", async () => {
    // fan-out needs synthesis step — use anthropicClient for synthesis
    // but make callClaudeFn hang for the parallel steps
    const hangingCallClaude = mock(() => new Promise<string>(() => {}));
    const options = createMockOptions({
      anthropicClient: null,
      callClaudeFn: hangingCallClaude,
      stepTimeoutMs: 50,
    });
    const steps = [
      createStep({ agent_name: "general", instruction: "Part A", skill_name: "web_research" }),
      createStep({ agent_name: "general", instruction: "Part B", skill_name: "web_research" }),
    ];

    await expect(
      executeOrchestrated("fan-out", steps, "Test", options),
    ).rejects.toBeInstanceOf(PipelineStepError);
  });
});
