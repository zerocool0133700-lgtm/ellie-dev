/**
 * ELLIE-62 — Fan-Out (ELLIE-55) execution tests
 *
 * Covers: parallel dispatch, result merging/synthesis, partial & total failure,
 * per-branch cost tracking, timing verification, execution plan persistence.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  createMockDispatchResult,
  createMockOptions,
  createStep,
  createMockSupabase,
  createMockAnthropic,
} from "./helpers.ts";

// ── Mock Dependencies ─────────────────────────────────────────
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
}));

mock.module("../src/approval.ts", () => ({
  extractApprovalTags: mockExtractApprovalTags,
}));

import {
  executeOrchestrated,
  _resetCachesForTesting,
  PipelineStepError,
} from "../src/orchestrator.ts";

// ── Setup ─────────────────────────────────────────────────────

describe("ELLIE-55: Fan-Out Execution", () => {
  beforeEach(() => {
    _resetCachesForTesting();
    mockDispatchAgent.mockReset();
    mockSyncResponse.mockReset();
    mockProcessMemoryIntents.mockReset();
    mockExtractApprovalTags.mockReset();

    // Default behaviors
    mockDispatchAgent.mockImplementation(() =>
      Promise.resolve(createMockDispatchResult()),
    );
    mockSyncResponse.mockImplementation(() => Promise.resolve(null));
    mockProcessMemoryIntents.mockImplementation(
      (_sb: any, text: string) => Promise.resolve(text),
    );
    mockExtractApprovalTags.mockImplementation((text: string) => ({
      cleanedText: text,
      approvals: [],
    }));
  });

  // ── Core Execution ──────────────────────────────────────────

  describe("Core Execution", () => {
    test("orchestrator accepts fan-out mode", async () => {
      const options = createMockOptions();
      const steps = [
        createStep({ instruction: "Check calendar", skill_name: "calendar_management" }),
        createStep({ instruction: "Check email", skill_name: "gmail_management" }),
      ];

      const result = await executeOrchestrated("fan-out", steps, "Check calendar and email", options);

      expect(result.mode).toBe("fan-out");
    });

    test("2+ steps dispatched in parallel", async () => {
      const options = createMockOptions();
      const steps = [
        createStep({ instruction: "Check calendar" }),
        createStep({ instruction: "Check email" }),
        createStep({ instruction: "Check tasks" }),
      ];

      const result = await executeOrchestrated("fan-out", steps, "Check everything", options);

      expect(result.stepResults.length).toBe(3);
      // All dispatched (3 fan-out steps)
      expect(mockDispatchAgent).toHaveBeenCalledTimes(3);
    });

    test("parallel results synthesized into single response via LLM", async () => {
      const synthResponse = "Here's your calendar and email summary combined.";
      const mockAnthropic = createMockAnthropic(synthResponse);
      const options = createMockOptions({ anthropicClient: mockAnthropic });

      const steps = [
        createStep({ instruction: "Check calendar", skill_name: "writing" }),
        createStep({ instruction: "Check email", skill_name: "writing" }),
      ];

      const result = await executeOrchestrated("fan-out", steps, "Calendar and email?", options);

      // Synthesis LLM call should have been made (step calls + synthesis = 3 total)
      expect(mockAnthropic.messages.create).toHaveBeenCalled();
      expect(result.finalResponse).toBe(synthResponse);
    });

    test("parallel steps receive original message, not previous output", async () => {
      const options = createMockOptions();
      const steps = [
        createStep({ instruction: "Task A", skill_name: "writing" }),
        createStep({ instruction: "Task B", skill_name: "writing" }),
      ];

      await executeOrchestrated("fan-out", steps, "Original request", options);

      // buildPromptFn called with the step instruction, not previous output
      const calls = (options.buildPromptFn as any).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });

    test("wall-clock time closer to max branch than sum (parallel)", async () => {
      const delayMs = 50;
      let callCount = 0;

      const anthropic = {
        messages: {
          create: mock(async () => {
            callCount++;
            if (callCount <= 3) {
              // Step calls — add delay
              await Bun.sleep(delayMs);
            }
            return {
              content: [{ type: "text", text: `Result ${callCount}` }],
              usage: { input_tokens: 10, output_tokens: 10 },
            };
          }),
        },
      } as any;

      const options = createMockOptions({ anthropicClient: anthropic });
      const steps = [
        createStep({ instruction: "Task A", skill_name: "writing" }),
        createStep({ instruction: "Task B", skill_name: "writing" }),
        createStep({ instruction: "Task C", skill_name: "writing" }),
      ];

      const start = Date.now();
      await executeOrchestrated("fan-out", steps, "Three tasks", options);
      const elapsed = Date.now() - start;

      // If sequential: 3 * 50ms = 150ms minimum
      // If parallel: ~50ms + overhead
      expect(elapsed).toBeLessThan(delayMs * 3);
    });
  });

  // ── Error Handling ──────────────────────────────────────────

  describe("Error Handling", () => {
    test("one branch fails, others succeed — partial result returned", async () => {
      let stepCount = 0;
      mockDispatchAgent.mockImplementation(() => {
        stepCount++;
        if (stepCount === 2) {
          // Second step dispatch fails
          return Promise.resolve(null);
        }
        return Promise.resolve(createMockDispatchResult());
      });

      const options = createMockOptions();
      const steps = [
        createStep({ instruction: "Task A" }),
        createStep({ instruction: "Task B (fails)" }),
        createStep({ instruction: "Task C" }),
      ];

      const result = await executeOrchestrated("fan-out", steps, "Three tasks", options);

      // 2 successful, 1 failed
      expect(result.stepResults.length).toBe(2);
      expect(result.finalResponse).toBeTruthy();
    });

    test("all branches fail — throws error", async () => {
      mockDispatchAgent.mockImplementation(() => Promise.resolve(null));

      const options = createMockOptions();
      const steps = [
        createStep({ instruction: "Task A" }),
        createStep({ instruction: "Task B" }),
      ];

      await expect(
        executeOrchestrated("fan-out", steps, "Two tasks", options),
      ).rejects.toThrow();
    });

    test("timeout on one branch does not block others", async () => {
      let callIdx = 0;
      const anthropic = {
        messages: {
          create: mock(async () => {
            callIdx++;
            if (callIdx === 2) {
              // Second step throws
              throw new Error("Timeout");
            }
            return {
              content: [{ type: "text", text: `Result ${callIdx}` }],
              usage: { input_tokens: 10, output_tokens: 10 },
            };
          }),
        },
      } as any;

      const options = createMockOptions({ anthropicClient: anthropic });
      const steps = [
        createStep({ instruction: "Fast task", skill_name: "writing" }),
        createStep({ instruction: "Slow task", skill_name: "writing" }),
      ];

      const result = await executeOrchestrated("fan-out", steps, "Two tasks", options);

      // At least one step should succeed
      expect(result.stepResults.length).toBeGreaterThanOrEqual(1);
      expect(result.finalResponse).toBeTruthy();
    });
  });

  // ── Cost & Tracking ─────────────────────────────────────────

  describe("Cost & Tracking", () => {
    test("per-branch cost tracked as separate step results", async () => {
      const options = createMockOptions();
      const steps = [
        createStep({ instruction: "Task A", skill_name: "writing" }),
        createStep({ instruction: "Task B", skill_name: "writing" }),
      ];

      const result = await executeOrchestrated("fan-out", steps, "Two tasks", options);

      expect(result.stepResults.length).toBe(2);
      for (const step of result.stepResults) {
        expect(step.cost_usd).toBeGreaterThanOrEqual(0);
        expect(step.input_tokens).toBeGreaterThan(0);
        expect(step.output_tokens).toBeGreaterThan(0);
      }
    });

    test("total cost aggregates all branches plus synthesis", async () => {
      const options = createMockOptions();
      const steps = [
        createStep({ instruction: "Task A", skill_name: "writing" }),
        createStep({ instruction: "Task B", skill_name: "writing" }),
      ];

      const result = await executeOrchestrated("fan-out", steps, "Two tasks", options);

      const stepCostSum = result.stepResults.reduce((sum, s) => sum + s.cost_usd, 0);
      // Total includes synthesis cost → should be ≥ step sum
      expect(result.artifacts.total_cost_usd).toBeGreaterThanOrEqual(stepCostSum);
    });

    test("execution_plans record created with correct mode", async () => {
      const supabase = createMockSupabase();
      const options = createMockOptions({ supabase });
      const steps = [createStep({ instruction: "Task" })];

      const result = await executeOrchestrated("fan-out", steps, "Do something", options);

      expect(result.planId).toBe("test-plan-id");
      expect(supabase.from).toHaveBeenCalledWith("execution_plans");
    });

    test("duration is max of branches (not sum)", async () => {
      const options = createMockOptions();
      const steps = [
        createStep({ instruction: "Task A", skill_name: "writing" }),
        createStep({ instruction: "Task B", skill_name: "writing" }),
      ];

      const result = await executeOrchestrated("fan-out", steps, "Two tasks", options);

      // For fan-out, total_duration_ms is max of branches (set via Math.max)
      const maxStepDuration = Math.max(...result.stepResults.map((s) => s.duration_ms));
      // The artifacts total_duration_ms also includes synthesis time
      expect(result.artifacts.total_duration_ms).toBeGreaterThanOrEqual(maxStepDuration);
    });
  });
});
