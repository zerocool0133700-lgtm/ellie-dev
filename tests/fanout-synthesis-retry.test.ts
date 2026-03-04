/**
 * ELLIE-522 — Fan-out synthesis retry logic.
 *
 * Tests that the synthesis LLM call in executeFanOut() is wrapped in
 * withRetry() with configurable retry count (default 2), so that
 * transient failures (rate limits, network errors) don't abort the
 * entire fan-out.
 *
 * Tests:
 * - Synthesis succeeds on first attempt — no retry
 * - Synthesis retried on rate-limit error, succeeds on second attempt
 * - All retries exhausted → throws PipelineStepError
 * - synthesisMaxRetries option controls retry count
 * - Permanent errors are not retried
 * - Artifacts are correct after a successful retry
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock dispatch-retry (zero-delay retries) ──────────────────────────────────
//
// Must be declared before any imports that depend on dispatch-retry.
// Classifies "rate" / "429" errors as retryable; everything else as permanent.

mock.module("../src/dispatch-retry.ts", () => ({
  withRetry: async <T>(fn: () => Promise<T>, opts: { maxRetries?: number } = {}) => {
    const maxRetries = opts.maxRetries ?? 3;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn();
        return { success: true, result, attempts: attempt + 1, retryHistory: [] };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const lower = lastError.message.toLowerCase();
        const isRetryable = lower.includes("rate") || lower.includes("429") || lower.includes("network");
        if (!isRetryable) {
          // Permanent — don't retry
          return { success: false, error: lastError, attempts: attempt + 1, retryHistory: [] };
        }
      }
    }
    // Exhausted retries
    return { success: false, error: lastError, attempts: maxRetries + 1, retryHistory: [] };
  },
  classifyError: (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    const isRetryable = lower.includes("rate") || lower.includes("429") || lower.includes("network");
    return { errorClass: isRetryable ? "retryable" : "permanent", reason: isRetryable ? "rate_limit" : "permanent" };
  },
  calculateDelay: () => 0,
}));

// ── Mock step-runner (executeStep always succeeds) ────────────────────────────

const mockExecuteStep = mock(async (_step: any, i: number) => ({
  stepResult: {
    step_index: i,
    agent_name: "general",
    skill_name: "research",
    output: `Output from step ${i}`,
    duration_ms: 50,
    input_tokens: 100,
    output_tokens: 50,
    cost_usd: 0.0005,
    execution_type: "light" as const,
    session_id: `session-${i}`,
  },
  dispatch: {
    session_id: `session-${i}`,
    agent: { name: "general", system_prompt: null, tools_enabled: [] },
  },
}));

mock.module("../src/step-runner.ts", () => ({
  executeStep: mockExecuteStep,
  callLightSkill: mock(async () => ({ text: "light synthesis", input_tokens: 10, output_tokens: 5 })),
  estimateTokens: mock((s: string) => Math.ceil(s.length / 4)),
}));

// ── Mock orchestrator-costs ───────────────────────────────────────────────────

mock.module("../src/orchestrator-costs.ts", () => ({
  calculateStepCost: mock(async () => 0.001),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { executeFanOut } from "../src/fanout-executor.ts";
import { PipelineStepError } from "../src/orchestrator-types.ts";
import type { PipelineStep, OrchestratorOptions, ArtifactStore } from "../src/orchestrator-types.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSteps(count = 2): PipelineStep[] {
  return Array.from({ length: count }, (_, i) => ({
    agent_name: "general",
    skill_name: "research",
    instruction: `Research task ${i + 1}`,
  }));
}

function makeArtifacts(): ArtifactStore {
  return {
    original_message: "test query",
    steps: [],
    total_duration_ms: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost_usd: 0,
  };
}

function makeOptions(callClaudeFn: (prompt: string, opts?: any) => Promise<string>, extra: Partial<OrchestratorOptions> = {}): OrchestratorOptions {
  return {
    supabase: null,
    channel: "test",
    userId: "user-1",
    anthropicClient: null, // use callClaudeFn path
    callClaudeFn,
    buildPromptFn: () => "prompt",
    ...extra,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("fan-out synthesis retry — success paths", () => {
  beforeEach(() => {
    mockExecuteStep.mockReset();
    mockExecuteStep.mockImplementation(async (_step: any, i: number) => ({
      stepResult: {
        step_index: i, agent_name: "general", skill_name: "research",
        output: `Output ${i}`, duration_ms: 50, input_tokens: 100,
        output_tokens: 50, cost_usd: 0.0005, execution_type: "light" as const,
        session_id: `s-${i}`,
      },
      dispatch: { session_id: `s-${i}`, agent: { name: "general", system_prompt: null, tools_enabled: [] } },
    }));
  });

  test("returns synthesized response on first attempt (no retry needed)", async () => {
    const callFn = mock(async () => "Synthesized answer");
    const result = await executeFanOut(
      makeSteps(2), "test query", makeOptions(callFn), makeArtifacts(),
    );
    expect(result.finalResponse).toBe("Synthesized answer");
    expect(callFn).toHaveBeenCalledTimes(1);
  });

  test("retries once on rate-limit and returns success on second attempt", async () => {
    let calls = 0;
    const callFn = mock(async () => {
      calls++;
      if (calls === 1) throw new Error("429 rate_limit exceeded");
      return "Synthesized after retry";
    });

    const result = await executeFanOut(
      makeSteps(2), "test query", makeOptions(callFn), makeArtifacts(),
    );
    expect(result.finalResponse).toBe("Synthesized after retry");
    expect(callFn).toHaveBeenCalledTimes(2);
  });

  test("mode is fan-out in the result", async () => {
    const callFn = mock(async () => "response");
    const result = await executeFanOut(
      makeSteps(2), "test query", makeOptions(callFn), makeArtifacts(),
    );
    expect(result.mode).toBe("fan-out");
  });

  test("artifacts accumulate step tokens before synthesis", async () => {
    const callFn = mock(async () => "synthesis result");
    const artifacts = makeArtifacts();
    const result = await executeFanOut(makeSteps(2), "test query", makeOptions(callFn), artifacts);
    // 2 steps × 100 input tokens each = at least 200
    expect(result.artifacts.total_input_tokens).toBeGreaterThanOrEqual(200);
  });

  test("finalDispatch is set from first successful step", async () => {
    const callFn = mock(async () => "ok");
    const result = await executeFanOut(makeSteps(2), "test query", makeOptions(callFn), makeArtifacts());
    expect(result.finalDispatch).not.toBeNull();
    expect(result.finalDispatch.session_id).toMatch(/^s-/);
  });
});

describe("fan-out synthesis retry — retry exhaustion", () => {
  beforeEach(() => {
    mockExecuteStep.mockReset();
    mockExecuteStep.mockImplementation(async (_step: any, i: number) => ({
      stepResult: {
        step_index: i, agent_name: "general", skill_name: "research",
        output: `Output ${i}`, duration_ms: 50, input_tokens: 100,
        output_tokens: 50, cost_usd: 0.0005, execution_type: "light" as const,
        session_id: `s-${i}`,
      },
      dispatch: { session_id: `s-${i}`, agent: { name: "general", system_prompt: null, tools_enabled: [] } },
    }));
  });

  test("throws PipelineStepError when all retries exhausted", async () => {
    const callFn = mock(async () => {
      throw new Error("429 rate_limit exceeded");
    });

    await expect(
      executeFanOut(makeSteps(2), "test query", makeOptions(callFn), makeArtifacts()),
    ).rejects.toThrow(PipelineStepError);
  });

  test("errorType is claude_error on exhaustion", async () => {
    const callFn = mock(async () => {
      throw new Error("rate limit");
    });

    try {
      await executeFanOut(makeSteps(2), "test query", makeOptions(callFn), makeArtifacts());
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineStepError);
      expect((err as PipelineStepError).errorType).toBe("claude_error");
    }
  });

  test("default retries 3 times total (initial + 2 retries)", async () => {
    let calls = 0;
    const callFn = mock(async () => {
      calls++;
      throw new Error("rate_limit");
    });

    await expect(
      executeFanOut(makeSteps(2), "test query", makeOptions(callFn), makeArtifacts()),
    ).rejects.toThrow(PipelineStepError);

    // default synthesisMaxRetries=2 → 3 total attempts
    expect(calls).toBe(3);
  });
});

describe("fan-out synthesis retry — synthesisMaxRetries option", () => {
  beforeEach(() => {
    mockExecuteStep.mockReset();
    mockExecuteStep.mockImplementation(async (_step: any, i: number) => ({
      stepResult: {
        step_index: i, agent_name: "general", skill_name: "research",
        output: `Output ${i}`, duration_ms: 50, input_tokens: 100,
        output_tokens: 50, cost_usd: 0.0005, execution_type: "light" as const,
        session_id: `s-${i}`,
      },
      dispatch: { session_id: `s-${i}`, agent: { name: "general", system_prompt: null, tools_enabled: [] } },
    }));
  });

  test("synthesisMaxRetries: 0 makes no retries — throws on first failure", async () => {
    let calls = 0;
    const callFn = mock(async () => {
      calls++;
      throw new Error("rate_limit");
    });

    await expect(
      executeFanOut(
        makeSteps(2), "test query",
        makeOptions(callFn, { synthesisMaxRetries: 0 }),
        makeArtifacts(),
      ),
    ).rejects.toThrow(PipelineStepError);

    expect(calls).toBe(1); // no retries
  });

  test("synthesisMaxRetries: 1 retries exactly once", async () => {
    let calls = 0;
    const callFn = mock(async () => {
      calls++;
      throw new Error("rate_limit");
    });

    await expect(
      executeFanOut(
        makeSteps(2), "test query",
        makeOptions(callFn, { synthesisMaxRetries: 1 }),
        makeArtifacts(),
      ),
    ).rejects.toThrow(PipelineStepError);

    expect(calls).toBe(2); // initial + 1 retry
  });

  test("synthesisMaxRetries: 2 (default) succeeds if third attempt works", async () => {
    let calls = 0;
    const callFn = mock(async () => {
      calls++;
      if (calls < 3) throw new Error("rate_limit");
      return "Third time lucky";
    });

    const result = await executeFanOut(
      makeSteps(2), "test query",
      makeOptions(callFn, { synthesisMaxRetries: 2 }),
      makeArtifacts(),
    );

    expect(result.finalResponse).toBe("Third time lucky");
    expect(calls).toBe(3);
  });
});

describe("fan-out synthesis retry — permanent errors", () => {
  beforeEach(() => {
    mockExecuteStep.mockReset();
    mockExecuteStep.mockImplementation(async (_step: any, i: number) => ({
      stepResult: {
        step_index: i, agent_name: "general", skill_name: "research",
        output: `Output ${i}`, duration_ms: 50, input_tokens: 100,
        output_tokens: 50, cost_usd: 0.0005, execution_type: "light" as const,
        session_id: `s-${i}`,
      },
      dispatch: { session_id: `s-${i}`, agent: { name: "general", system_prompt: null, tools_enabled: [] } },
    }));
  });

  test("permanent error is not retried — fails on first attempt", async () => {
    let calls = 0;
    const callFn = mock(async () => {
      calls++;
      throw new Error("invalid_api_key: authentication failed");
    });

    await expect(
      executeFanOut(makeSteps(2), "test query", makeOptions(callFn), makeArtifacts()),
    ).rejects.toThrow(PipelineStepError);

    // Permanent error — no retries, only 1 call
    expect(calls).toBe(1);
  });

  test("throws PipelineStepError even for permanent errors", async () => {
    const callFn = mock(async () => {
      throw new Error("authentication failed");
    });

    try {
      await executeFanOut(makeSteps(2), "test query", makeOptions(callFn), makeArtifacts());
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineStepError);
      expect((err as PipelineStepError).errorType).toBe("claude_error");
    }
  });
});

describe("fan-out synthesis retry — all parallel steps fail", () => {
  test("throws PipelineStepError when all parallel steps fail (pre-synthesis)", async () => {
    mockExecuteStep.mockReset();
    mockExecuteStep.mockImplementation(async () => {
      throw new Error("step failed");
    });

    const callFn = mock(async () => "should not be called");

    await expect(
      executeFanOut(makeSteps(2), "test query", makeOptions(callFn), makeArtifacts()),
    ).rejects.toThrow(PipelineStepError);

    // callFn should never be reached — parallel step failures short-circuit
    expect(callFn).not.toHaveBeenCalled();
  });
});
