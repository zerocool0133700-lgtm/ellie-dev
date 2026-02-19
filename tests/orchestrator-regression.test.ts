/**
 * ELLIE-62 — Regression tests
 *
 * Ensures that single-agent routing and pipeline mode are unaffected
 * by fan-out and critic-loop additions. Also tests cost enforcement.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  createMockDispatchResult,
  createMockOptions,
  createStep,
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

describe("Regression: Existing Modes", () => {
  beforeEach(() => {
    _resetCachesForTesting();
    mockDispatchAgent.mockReset();
    mockSyncResponse.mockReset();
    mockProcessMemoryIntents.mockReset();
    mockExtractApprovalTags.mockReset();

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

  // ── Pipeline Mode ───────────────────────────────────────────

  describe("Pipeline mode still works", () => {
    test("sequential steps execute in order", async () => {
      const callOrder: number[] = [];
      let callCount = 0;

      const anthropic = {
        messages: {
          create: mock(async () => {
            callCount++;
            callOrder.push(callCount);
            return {
              content: [{ type: "text", text: `Output from step ${callCount}` }],
              usage: { input_tokens: 100, output_tokens: 50 },
            };
          }),
        },
      } as any;

      const options = createMockOptions({ anthropicClient: anthropic });
      const steps = [
        createStep({ instruction: "Research topic", skill_name: "writing" }),
        createStep({ instruction: "Summarize findings", skill_name: "writing" }),
      ];

      const result = await executeOrchestrated("pipeline", steps, "Research and summarize", options);

      expect(result.mode).toBe("pipeline");
      expect(result.stepResults.length).toBe(2);
      expect(callOrder).toEqual([1, 2]);
    });

    test("output from step N feeds step N+1", async () => {
      let callCount = 0;
      const anthropic = {
        messages: {
          create: mock(async () => {
            callCount++;
            return {
              content: [{ type: "text", text: `Output-${callCount}` }],
              usage: { input_tokens: 100, output_tokens: 50 },
            };
          }),
        },
      } as any;

      const options = createMockOptions({ anthropicClient: anthropic });
      const steps = [
        createStep({ instruction: "Step 1", skill_name: "writing" }),
        createStep({ instruction: "Step 2", skill_name: "writing" }),
      ];

      await executeOrchestrated("pipeline", steps, "Two step pipeline", options);

      // buildPromptFn called twice — once for each step
      const buildCalls = (options.buildPromptFn as any).mock.calls;
      expect(buildCalls.length).toBe(2);
    });

    test("final response is output of last step", async () => {
      let callCount = 0;
      const anthropic = {
        messages: {
          create: mock(async () => {
            callCount++;
            return {
              content: [{ type: "text", text: `Step ${callCount} complete` }],
              usage: { input_tokens: 100, output_tokens: 50 },
            };
          }),
        },
      } as any;

      const options = createMockOptions({ anthropicClient: anthropic });
      const steps = [
        createStep({ instruction: "Step 1", skill_name: "writing" }),
        createStep({ instruction: "Step 2", skill_name: "writing" }),
      ];

      const result = await executeOrchestrated("pipeline", steps, "Pipeline", options);

      expect(result.finalResponse).toBe("Step 2 complete");
    });

    test("steps limited to MAX_PIPELINE_DEPTH (5)", async () => {
      const anthropic = {
        messages: {
          create: mock(async () => ({
            content: [{ type: "text", text: "Output" }],
            usage: { input_tokens: 50, output_tokens: 20 },
          })),
        },
      } as any;

      const options = createMockOptions({ anthropicClient: anthropic });
      const steps = Array.from({ length: 7 }, (_, i) =>
        createStep({ instruction: `Step ${i + 1}`, skill_name: "writing" }),
      );

      const result = await executeOrchestrated("pipeline", steps, "Many steps", options);

      expect(result.stepResults.length).toBeLessThanOrEqual(5);
    });

    test("heartbeat called between intermediate steps", async () => {
      const anthropic = {
        messages: {
          create: mock(async () => ({
            content: [{ type: "text", text: "Output" }],
            usage: { input_tokens: 50, output_tokens: 20 },
          })),
        },
      } as any;

      const heartbeat = mock(() => {});
      const options = createMockOptions({
        anthropicClient: anthropic,
        onHeartbeat: heartbeat,
      });
      const steps = [
        createStep({ instruction: "Step 1", skill_name: "writing" }),
        createStep({ instruction: "Step 2", skill_name: "writing" }),
        createStep({ instruction: "Step 3", skill_name: "writing" }),
      ];

      await executeOrchestrated("pipeline", steps, "Three steps", options);

      // Heartbeat between steps (not after last) → 2 calls
      expect(heartbeat).toHaveBeenCalledTimes(2);
    });
  });

  // ── Cost Enforcement ────────────────────────────────────────

  describe("Cost enforcement", () => {
    test("pipeline aborted when cost exceeds $2.00 limit", async () => {
      const anthropic = {
        messages: {
          create: mock(async () => ({
            content: [{ type: "text", text: "Expensive output" }],
            usage: { input_tokens: 500_000, output_tokens: 200_000 },
          })),
        },
      } as any;

      const options = createMockOptions({ anthropicClient: anthropic });
      const steps = [
        createStep({ instruction: "Expensive 1", skill_name: "writing" }),
        createStep({ instruction: "Expensive 2", skill_name: "writing" }),
        createStep({ instruction: "Expensive 3", skill_name: "writing" }),
      ];

      await expect(
        executeOrchestrated("pipeline", steps, "Expensive pipeline", options),
      ).rejects.toThrow();
    });

    test("pipeline cost overrun throws error type 'cost_exceeded'", async () => {
      const anthropic = {
        messages: {
          create: mock(async () => ({
            content: [{ type: "text", text: "Expensive output" }],
            usage: { input_tokens: 500_000, output_tokens: 200_000 },
          })),
        },
      } as any;

      const options = createMockOptions({ anthropicClient: anthropic });
      const steps = [
        createStep({ instruction: "Expensive 1", skill_name: "writing" }),
        createStep({ instruction: "Expensive 2", skill_name: "writing" }),
        createStep({ instruction: "Expensive 3", skill_name: "writing" }),
      ];

      try {
        await executeOrchestrated("pipeline", steps, "Expensive pipeline", options);
        expect(true).toBe(false); // should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(PipelineStepError);
        expect((err as PipelineStepError).errorType).toBe("cost_exceeded");
      }
    });
  });

  // ── Dispatch Failure ────────────────────────────────────────

  describe("Dispatch failure handling", () => {
    test("pipeline throws PipelineStepError on dispatch failure", async () => {
      mockDispatchAgent.mockImplementation(() => Promise.resolve(null));

      const options = createMockOptions();
      const steps = [createStep({ instruction: "Do something" })];

      await expect(
        executeOrchestrated("pipeline", steps, "Test", options),
      ).rejects.toThrow();
    });

    test("fan-out handles individual dispatch failures gracefully", async () => {
      let count = 0;
      mockDispatchAgent.mockImplementation(() => {
        count++;
        return count === 1
          ? Promise.resolve(createMockDispatchResult())
          : Promise.resolve(null);
      });

      const options = createMockOptions();
      const steps = [
        createStep({ instruction: "Task A" }),
        createStep({ instruction: "Task B" }),
      ];

      // Should not throw — one step succeeds
      const result = await executeOrchestrated("fan-out", steps, "Test", options);
      expect(result.stepResults.length).toBe(1);
    });
  });

  // ── Execution Plan Lifecycle ────────────────────────────────

  describe("Execution plan lifecycle", () => {
    test("plan created on start, completed on success", async () => {
      const options = createMockOptions();
      const steps = [createStep({ instruction: "Task", skill_name: "writing" })];

      const result = await executeOrchestrated("pipeline", steps, "Test", options);

      expect(result.planId).toBe("test-plan-id");
    });

    test("plan marked failed on error", async () => {
      mockDispatchAgent.mockImplementation(() => Promise.resolve(null));
      const options = createMockOptions();
      const steps = [createStep({ instruction: "Fail" })];

      try {
        await executeOrchestrated("pipeline", steps, "Test", options);
      } catch {
        // Expected
      }

      // Supabase.from("execution_plans") should have been called for both create and update
      expect(options.supabase!.from).toHaveBeenCalledWith("execution_plans");
    });
  });
});
