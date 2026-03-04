/**
 * ELLIE-523 — Orchestration integration tests
 *
 * Covers scenarios that require the full execution path through
 * executeOrchestrated, not just the individual mode functions:
 *
 * 1. Pipeline checkpoint resume — fail at step N, resume from checkpoint at step N
 * 2. Fan-out partial failure — synthesis receives only successful results + failure note
 * 3. Critic-loop malformed JSON on final round — graceful acceptance (no throw)
 * 4. Fan-out minimum success threshold — 0 successes throws, 1 success proceeds
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  createMockDispatchResult,
  createMockOptions,
  createStep,
} from "./helpers.ts";
import type { PipelineCheckpoint } from "../src/pipeline-state.ts";
import type { StepResult } from "../src/orchestrator-types.ts";

// ── Mock Dependencies ──────────────────────────────────────────────────────────

const mockDispatchAgent = mock();
const mockSyncResponse = mock();
const mockProcessMemoryIntents = mock();
const mockExtractApprovalTags = mock();

mock.module("../src/agent-router.ts", () => ({
  dispatchAgent: mockDispatchAgent,
  syncResponse: mockSyncResponse,
}));

mock.module("../src/memory.ts", () => ({
  processMemoryIntents: mockProcessMemoryIntents,
  insertMemoryWithDedup: mock(() => Promise.resolve({ id: "mock-id", action: "inserted" })),
  checkMemoryConflict: mock(() => Promise.resolve({ available: true, match: null })),
  resolveMemoryConflict: mock(() => ({ resolution: "keep_both", existingMemory: null, reason: "mock" })),
  DEDUP_SIMILARITY_THRESHOLD: 0.85,
}));

mock.module("../src/approval.ts", () => ({
  extractApprovalTags: mockExtractApprovalTags,
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { executeOrchestrated, _resetCachesForTesting, PipelineStepError } from "../src/orchestrator.ts";
import { _clearActiveCheckpoints } from "../src/pipeline-state.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal StepResult for checkpoint fixtures. */
function makeStepResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    step_index: 0,
    agent_name: "general",
    skill_name: "writing",
    output: "Completed step output",
    duration_ms: 100,
    input_tokens: 50,
    output_tokens: 30,
    cost_usd: 0.001,
    execution_type: "light",
    session_id: "test-session-id",
    ...overrides,
  };
}

/** Build a PipelineCheckpoint representing a pipeline that completed step 0, now ready to run step 1. */
function makeCheckpoint(
  steps: ReturnType<typeof createStep>[],
  overrides: Partial<PipelineCheckpoint> = {},
): PipelineCheckpoint {
  const completedStep = makeStepResult({ step_index: 0, output: "Step 0 result" });
  return {
    pipelineId: "test-pipeline-resume-" + Math.random().toString(36).slice(2, 8),
    originalMessage: "Original request",
    steps,
    nextStepIndex: 1,
    completedSteps: [completedStep],
    lastOutput: "Step 0 result",
    artifacts: {
      total_duration_ms: 100,
      total_input_tokens: 50,
      total_output_tokens: 30,
      total_cost_usd: 0.001,
    },
    channel: "telegram",
    updatedAt: Date.now(),
    runId: "test-run-resume",
    ...overrides,
  };
}

/** Anthropic mock that alternates producer/critic responses based on call index. */
function makeCriticAnthropic(opts: {
  producerText?: string;
  criticJson?: object | null; // null = return malformed text
}) {
  let callCount = 0;
  return {
    messages: {
      create: mock(async () => {
        callCount++;
        const isProducer = callCount % 2 === 1;
        if (isProducer) {
          return {
            content: [{ type: "text", text: opts.producerText ?? "Draft output" }],
            usage: { input_tokens: 100, output_tokens: 50 },
          };
        }
        // Critic
        const text = opts.criticJson === null
          ? "not valid json at all!"
          : JSON.stringify({ accepted: false, score: 3, feedback: "Needs work", issues: [], ...opts.criticJson });
        return {
          content: [{ type: "text", text }],
          usage: { input_tokens: 80, output_tokens: 40 },
        };
      }),
    },
  } as any;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetCachesForTesting();
  _clearActiveCheckpoints();

  mockDispatchAgent.mockReset();
  mockSyncResponse.mockReset();
  mockProcessMemoryIntents.mockReset();
  mockExtractApprovalTags.mockReset();

  mockDispatchAgent.mockImplementation(() => Promise.resolve(createMockDispatchResult()));
  mockSyncResponse.mockImplementation(() => Promise.resolve(null));
  mockProcessMemoryIntents.mockImplementation((_sb: any, text: string) => Promise.resolve(text));
  mockExtractApprovalTags.mockImplementation((text: string) => ({ cleanedText: text, approvals: [] }));
});

// ── AC 1: Pipeline checkpoint resume ─────────────────────────────────────────

describe("AC1 — Pipeline checkpoint resume", () => {
  test("resumes from step N: skips completed steps, dispatches only from nextStepIndex", async () => {
    const steps = [
      createStep({ agent_name: "research", instruction: "Step 0 research", skill_name: "writing" }),
      createStep({ agent_name: "dev", instruction: "Step 1 implementation", skill_name: "writing" }),
    ];

    const checkpoint = makeCheckpoint(steps);
    const options = createMockOptions({
      resumeCheckpoint: checkpoint,
      runId: checkpoint.pipelineId,
    });

    const anthropic = {
      messages: {
        create: mock(async () => ({
          content: [{ type: "text", text: "Step 1 complete" }],
          usage: { input_tokens: 100, output_tokens: 50 },
        })),
      },
    } as any;
    (options as any).anthropicClient = anthropic;

    const result = await executeOrchestrated("pipeline", steps, "Do the thing", options);

    // dispatchAgent should only be called ONCE (for step 1, step 0 was in checkpoint)
    expect(mockDispatchAgent).toHaveBeenCalledTimes(1);
    expect(mockDispatchAgent.mock.calls[0][1]).toBe("dev"); // step 1's agent

    // stepResults includes checkpoint's completed step + the new step
    expect(result.stepResults.length).toBe(2);
    expect(result.stepResults[0].step_index).toBe(0); // from checkpoint
    expect(result.stepResults[0].output).toBe("Step 0 result");
    expect(result.stepResults[1].output).toBe("Step 1 complete");
  });

  test("resumed pipeline carries forward accumulated artifact totals from checkpoint", async () => {
    const steps = [
      createStep({ instruction: "Step 0", skill_name: "writing" }),
      createStep({ instruction: "Step 1", skill_name: "writing" }),
    ];

    const checkpoint = makeCheckpoint(steps, {
      artifacts: {
        total_duration_ms: 500,
        total_input_tokens: 200,
        total_output_tokens: 100,
        total_cost_usd: 0.010,
      },
    });
    const options = createMockOptions({ resumeCheckpoint: checkpoint, runId: checkpoint.pipelineId });
    const anthropic = {
      messages: {
        create: mock(async () => ({
          content: [{ type: "text", text: "Resume step complete" }],
          usage: { input_tokens: 50, output_tokens: 25 },
        })),
      },
    } as any;
    (options as any).anthropicClient = anthropic;

    const result = await executeOrchestrated("pipeline", steps, "Test", options);

    // Total artifacts should include checkpoint totals + new step
    expect(result.artifacts.total_duration_ms).toBeGreaterThanOrEqual(500);
    expect(result.artifacts.total_input_tokens).toBeGreaterThan(200);
    expect(result.artifacts.total_cost_usd).toBeGreaterThan(0.010);
  });

  test("resumed pipeline returns final response from last step (not checkpoint output)", async () => {
    const steps = [
      createStep({ instruction: "Step 0", skill_name: "writing" }),
      createStep({ instruction: "Step 1 — final", skill_name: "writing" }),
    ];

    const checkpoint = makeCheckpoint(steps);
    const options = createMockOptions({ resumeCheckpoint: checkpoint, runId: checkpoint.pipelineId });
    const anthropic = {
      messages: {
        create: mock(async () => ({
          content: [{ type: "text", text: "Final step response" }],
          usage: { input_tokens: 50, output_tokens: 25 },
        })),
      },
    } as any;
    (options as any).anthropicClient = anthropic;

    const result = await executeOrchestrated("pipeline", steps, "Test", options);

    expect(result.finalResponse).toBe("Final step response");
  });

  test("resume with nextStepIndex=0 runs all steps (no skipping)", async () => {
    const steps = [
      createStep({ instruction: "Step 0", skill_name: "writing" }),
      createStep({ instruction: "Step 1", skill_name: "writing" }),
    ];

    const checkpoint = makeCheckpoint(steps, {
      nextStepIndex: 0,
      completedSteps: [],
      lastOutput: null,
      artifacts: { total_duration_ms: 0, total_input_tokens: 0, total_output_tokens: 0, total_cost_usd: 0 },
    });
    const options = createMockOptions({ resumeCheckpoint: checkpoint, runId: checkpoint.pipelineId });
    const anthropic = {
      messages: {
        create: mock(async () => ({
          content: [{ type: "text", text: "Output" }],
          usage: { input_tokens: 50, output_tokens: 25 },
        })),
      },
    } as any;
    (options as any).anthropicClient = anthropic;

    const result = await executeOrchestrated("pipeline", steps, "Test", options);

    // All 2 steps dispatched since nextStepIndex=0
    expect(mockDispatchAgent).toHaveBeenCalledTimes(2);
    expect(result.stepResults.length).toBe(2);
  });
});

// ── AC 2: Fan-out partial failure — synthesis receives only successful results ──

describe("AC2 — Fan-out partial failure: synthesis receives successful results + failure note", () => {
  test("synthesis prompt includes 'tasks failed' note when some steps fail", async () => {
    let stepCount = 0;
    mockDispatchAgent.mockImplementation(() => {
      stepCount++;
      // Step 2 fails (index 1)
      if (stepCount === 2) return Promise.resolve(null);
      return Promise.resolve(createMockDispatchResult());
    });

    const lastSynthesisPrompt = { value: "" };
    const anthropic = {
      messages: {
        create: mock(async (params: any) => {
          const content = params.messages[0].content as string;
          // The last call is the synthesis call
          lastSynthesisPrompt.value = content;
          return {
            content: [{ type: "text", text: "Synthesized result" }],
            usage: { input_tokens: 100, output_tokens: 50 },
          };
        }),
      },
    } as any;

    const options = createMockOptions({ anthropicClient: anthropic });
    const steps = [
      createStep({ instruction: "Task A", skill_name: "writing" }),
      createStep({ instruction: "Task B (will fail)", skill_name: "writing" }),
      createStep({ instruction: "Task C", skill_name: "writing" }),
    ];

    const result = await executeOrchestrated("fan-out", steps, "Do three tasks", options);

    // 2 of 3 succeed
    expect(result.stepResults.length).toBe(2);
    expect(result.finalResponse).toBe("Synthesized result");

    // Synthesis prompt must include failure note
    expect(lastSynthesisPrompt.value).toContain("1 of 3 tasks failed");
  });

  test("synthesis prompt contains outputs from all successful steps only", async () => {
    let stepCount = 0;
    mockDispatchAgent.mockImplementation(() => {
      stepCount++;
      if (stepCount === 1) return Promise.resolve(null); // first step fails
      return Promise.resolve(createMockDispatchResult());
    });

    const capturedSynthPrompts: string[] = [];
    const anthropic = {
      messages: {
        create: mock(async (params: any) => {
          capturedSynthPrompts.push(params.messages[0].content);
          return {
            content: [{ type: "text", text: "Combined" }],
            usage: { input_tokens: 50, output_tokens: 30 },
          };
        }),
      },
    } as any;

    const options = createMockOptions({ anthropicClient: anthropic });
    const steps = [
      createStep({ instruction: "Failing task", skill_name: "writing" }),
      createStep({ instruction: "Task B", skill_name: "writing" }),
    ];

    const result = await executeOrchestrated("fan-out", steps, "Two tasks", options);

    // Only one step succeeded → stepResults.length === 1
    expect(result.stepResults.length).toBe(1);

    // Synthesis prompt should be the last captured prompt
    const synthesisPrompt = capturedSynthPrompts[capturedSynthPrompts.length - 1];
    expect(synthesisPrompt).toContain("1 of 2 tasks failed");
    // The successful step's instruction should appear in the synthesis prompt
    expect(synthesisPrompt).toContain("Task B");
  });

  test("synthesis prompt has NO failure note when all steps succeed", async () => {
    const capturedSynthPrompts: string[] = [];
    const anthropic = {
      messages: {
        create: mock(async (params: any) => {
          capturedSynthPrompts.push(params.messages[0].content);
          return {
            content: [{ type: "text", text: "All good" }],
            usage: { input_tokens: 50, output_tokens: 30 },
          };
        }),
      },
    } as any;

    const options = createMockOptions({ anthropicClient: anthropic });
    const steps = [
      createStep({ instruction: "Task A", skill_name: "writing" }),
      createStep({ instruction: "Task B", skill_name: "writing" }),
    ];

    await executeOrchestrated("fan-out", steps, "Two tasks", options);

    const synthesisPrompt = capturedSynthPrompts[capturedSynthPrompts.length - 1];
    // No failure note when all succeed
    expect(synthesisPrompt).not.toContain("tasks failed");
  });

  test("fan-out returns correct stepResults count when 2 of 4 steps fail", async () => {
    let stepCount = 0;
    mockDispatchAgent.mockImplementation(() => {
      stepCount++;
      // Steps 1 and 3 fail (0-indexed)
      if (stepCount === 2 || stepCount === 4) return Promise.resolve(null);
      return Promise.resolve(createMockDispatchResult());
    });

    const options = createMockOptions();
    const steps = [
      createStep({ instruction: "A" }),
      createStep({ instruction: "B - fails" }),
      createStep({ instruction: "C" }),
      createStep({ instruction: "D - fails" }),
    ];

    const result = await executeOrchestrated("fan-out", steps, "Four tasks", options);

    // 2 succeed, 2 fail
    expect(result.stepResults.length).toBe(2);
  });
});

// ── AC 3: Critic-loop malformed JSON on final round ───────────────────────────

describe("AC3 — Critic-loop malformed JSON on final round: graceful completion", () => {
  test("critic always returns malformed JSON — completes without throwing", async () => {
    // All critic calls return invalid JSON → rounds 1 & 2 reject, round 3 (final) accepts with caveats
    const anthropic = makeCriticAnthropic({ producerText: "My draft", criticJson: null });
    const options = createMockOptions({ anthropicClient: anthropic });
    const steps = [
      createStep({ agent_name: "content", skill_name: "writing", instruction: "Write something" }),
      createStep({ agent_name: "critic", skill_name: "critical_review", instruction: "Review" }),
    ];

    // Should NOT throw — malformed JSON on final round is handled gracefully
    const result = await executeOrchestrated("critic-loop", steps, "Write for me", options);

    expect(result.mode).toBe("critic-loop");
    expect(result.finalResponse).toBeTruthy();
    // All 3 rounds ran (3 producers + 3 critics = 6 steps)
    expect(result.stepResults.length).toBe(6);
  });

  test("critic returns malformed JSON — final response is last producer output", async () => {
    const anthropic = makeCriticAnthropic({
      producerText: "Best effort draft",
      criticJson: null,
    });
    const options = createMockOptions({ anthropicClient: anthropic });
    const steps = [
      createStep({ agent_name: "content", skill_name: "writing", instruction: "Write it" }),
      createStep({ agent_name: "critic", skill_name: "critical_review", instruction: "Review" }),
    ];

    const result = await executeOrchestrated("critic-loop", steps, "Write something", options);

    expect(result.finalResponse).toBe("Best effort draft");
  });

  test("critic returns malformed JSON only on round 1/2, valid JSON on round 3 (accepts)", async () => {
    let callCount = 0;
    const anthropic = {
      messages: {
        create: mock(async () => {
          callCount++;
          const isProducer = callCount % 2 === 1;
          const round = Math.floor((callCount - 1) / 2);

          if (isProducer) {
            return {
              content: [{ type: "text", text: `Draft v${round + 1}` }],
              usage: { input_tokens: 100, output_tokens: 50 },
            };
          }

          // Critic: malformed on rounds 0 & 1, valid accept on round 2
          if (round < 2) {
            return {
              content: [{ type: "text", text: "this is not json!" }],
              usage: { input_tokens: 80, output_tokens: 20 },
            };
          }
          return {
            content: [{ type: "text", text: JSON.stringify({ accepted: true, score: 8, feedback: "Good", issues: [] }) }],
            usage: { input_tokens: 80, output_tokens: 30 },
          };
        }),
      },
    } as any;

    const options = createMockOptions({ anthropicClient: anthropic });
    const steps = [
      createStep({ agent_name: "content", skill_name: "writing", instruction: "Write" }),
      createStep({ agent_name: "critic", skill_name: "critical_review", instruction: "Review" }),
    ];

    const result = await executeOrchestrated("critic-loop", steps, "Write something", options);

    // 3 rounds to reach the valid acceptance
    expect(result.stepResults.length).toBe(6);
    expect(result.finalResponse).toBe("Draft v3");
  });

  test("malformed JSON on final round sets cost_truncated only if cost limit hit", async () => {
    // Verify cost_truncated is NOT set for normal runs (malformed JSON ≠ cost truncation)
    const anthropic = makeCriticAnthropic({ producerText: "Draft", criticJson: null });
    const options = createMockOptions({ anthropicClient: anthropic });
    const steps = [
      createStep({ agent_name: "content", skill_name: "writing", instruction: "Write" }),
      createStep({ agent_name: "critic", skill_name: "critical_review", instruction: "Review" }),
    ];

    const result = await executeOrchestrated("critic-loop", steps, "Write", options);

    // cost_truncated should be falsy (undefined) since cost is well under $2
    expect(result.cost_truncated).toBeFalsy();
  });
});

// ── AC 4: Fan-out minimum success threshold ───────────────────────────────────

describe("AC4 — Fan-out minimum success threshold", () => {
  test("0 of N steps succeed — throws PipelineStepError", async () => {
    mockDispatchAgent.mockImplementation(() => Promise.resolve(null)); // all dispatch fails

    const options = createMockOptions();
    const steps = [
      createStep({ instruction: "Task A" }),
      createStep({ instruction: "Task B" }),
      createStep({ instruction: "Task C" }),
    ];

    await expect(
      executeOrchestrated("fan-out", steps, "All fail", options),
    ).rejects.toThrow();
  });

  test("0 of N steps succeed — throws with errorType 'claude_error'", async () => {
    mockDispatchAgent.mockImplementation(() => Promise.resolve(null));

    const options = createMockOptions();
    const steps = [createStep({ instruction: "A" }), createStep({ instruction: "B" })];

    try {
      await executeOrchestrated("fan-out", steps, "All fail", options);
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineStepError);
      expect((err as PipelineStepError).errorType).toBe("claude_error");
    }
  });

  test("1 of N steps succeed — does NOT throw, returns partial result", async () => {
    let count = 0;
    mockDispatchAgent.mockImplementation(() => {
      count++;
      return count === 1
        ? Promise.resolve(createMockDispatchResult()) // only first step succeeds
        : Promise.resolve(null);
    });

    const options = createMockOptions();
    const steps = [
      createStep({ instruction: "Only success" }),
      createStep({ instruction: "Fail 1" }),
      createStep({ instruction: "Fail 2" }),
      createStep({ instruction: "Fail 3" }),
    ];

    const result = await executeOrchestrated("fan-out", steps, "Mostly fails", options);

    expect(result.stepResults.length).toBe(1);
    expect(result.finalResponse).toBeTruthy();
  });

  test("threshold enforcement: N-1 of N succeed — succeeds and synthesises correctly", async () => {
    const N = 4;
    let count = 0;
    mockDispatchAgent.mockImplementation(() => {
      count++;
      return count === N // last step fails
        ? Promise.resolve(null)
        : Promise.resolve(createMockDispatchResult());
    });

    const options = createMockOptions();
    const steps = Array.from({ length: N }, (_, i) =>
      createStep({ instruction: `Task ${i + 1}` }),
    );

    const result = await executeOrchestrated("fan-out", steps, "Mostly good", options);

    expect(result.stepResults.length).toBe(N - 1);
    expect(result.mode).toBe("fan-out");
  });

  test("all steps succeed — no threshold breach, full result returned", async () => {
    const options = createMockOptions();
    const steps = [
      createStep({ instruction: "A" }),
      createStep({ instruction: "B" }),
      createStep({ instruction: "C" }),
    ];

    const result = await executeOrchestrated("fan-out", steps, "All good", options);

    expect(result.stepResults.length).toBe(3);
    expect(result.mode).toBe("fan-out");
  });
});
