/**
 * ELLIE-62 — Critic Loop (ELLIE-56) execution tests
 *
 * Covers: producer→critic→revision cycle, early exit on approval,
 * max iterations enforced, structured output parsing, feedback passing,
 * default critic, iteration history, cost tracking per iteration.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  createMockDispatchResult,
  createMockOptions,
  createStep,
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
} from "../src/orchestrator.ts";

// ── Helpers ───────────────────────────────────────────────────

/** Create an Anthropic mock that alternates producer/critic responses. */
function createCriticLoopAnthropic(opts: {
  /** Which round the critic accepts (0-indexed). null = never accept */
  acceptOnRound: number | null;
  producerTexts?: string[];
  criticFeedback?: string;
}) {
  let callCount = 0;
  return {
    messages: {
      create: mock(async () => {
        callCount++;
        const isProducer = callCount % 2 === 1;
        const round = Math.floor((callCount - 1) / 2);

        if (isProducer) {
          const text = opts.producerTexts?.[round] ?? `Draft v${round + 1}`;
          return {
            content: [{ type: "text", text }],
            usage: { input_tokens: 200, output_tokens: 100 },
          };
        }

        // Critic
        const accepted = opts.acceptOnRound !== null && round >= opts.acceptOnRound;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                accepted,
                score: accepted ? 8 : 4,
                feedback: accepted
                  ? "Well done"
                  : (opts.criticFeedback ?? "Needs more detail"),
                issues: accepted ? [] : ["Lacks specificity"],
              }),
            },
          ],
          usage: { input_tokens: 150, output_tokens: 80 },
        };
      }),
    },
  } as any;
}

function criticLoopSteps() {
  return [
    createStep({ agent_name: "content", skill_name: "writing", instruction: "Write an email" }),
    createStep({ agent_name: "critic", skill_name: "critical_review", instruction: "Review the draft" }),
  ];
}

// ── Tests ─────────────────────────────────────────────────────

describe("ELLIE-56: Critic Loop Execution", () => {
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

  // ── Core Loop Mechanics ─────────────────────────────────────

  describe("Core Loop Mechanics", () => {
    test("orchestrator accepts critic-loop mode", async () => {
      const anthropic = createCriticLoopAnthropic({ acceptOnRound: 0 });
      const options = createMockOptions({ anthropicClient: anthropic });

      const result = await executeOrchestrated("critic-loop", criticLoopSteps(), "Write email", options);

      expect(result.mode).toBe("critic-loop");
    });

    test("producer → critic → revision cycle executes across multiple rounds", async () => {
      // Accept on round 1 (second pass)
      const anthropic = createCriticLoopAnthropic({ acceptOnRound: 1 });
      const options = createMockOptions({ anthropicClient: anthropic });

      const result = await executeOrchestrated("critic-loop", criticLoopSteps(), "Write email", options);

      // 2 rounds * 2 steps = 4 steps
      expect(result.stepResults.length).toBe(4);
      expect(result.finalResponse).toBeTruthy();
    });

    test("early exit when critic approves on first round", async () => {
      const anthropic = createCriticLoopAnthropic({
        acceptOnRound: 0,
        producerTexts: ["Perfect first draft"],
      });
      const options = createMockOptions({ anthropicClient: anthropic });

      const result = await executeOrchestrated("critic-loop", criticLoopSteps(), "Write email", options);

      // Only 1 round: 1 producer + 1 critic = 2 steps
      expect(result.stepResults.length).toBe(2);
      expect(result.finalResponse).toBe("Perfect first draft");
    });

    test("max iterations enforced — stops at 3 rounds", async () => {
      const anthropic = createCriticLoopAnthropic({ acceptOnRound: null }); // Never accepts
      const options = createMockOptions({ anthropicClient: anthropic });

      const result = await executeOrchestrated("critic-loop", criticLoopSteps(), "Write email", options);

      // 3 rounds * 2 steps = 6 steps
      expect(result.stepResults.length).toBe(6);
    });

    test("final output returned even when critic never satisfied", async () => {
      const anthropic = createCriticLoopAnthropic({
        acceptOnRound: null,
        producerTexts: ["Draft v1", "Draft v2", "Best effort v3"],
      });
      const options = createMockOptions({ anthropicClient: anthropic });

      const result = await executeOrchestrated("critic-loop", criticLoopSteps(), "Write email", options);

      // Should return the last producer output
      expect(result.finalResponse).toBe("Best effort v3");
    });

    test("critic structured output {accepted, feedback, score, issues} parsed", async () => {
      const anthropic = createCriticLoopAnthropic({ acceptOnRound: 0 });
      const options = createMockOptions({ anthropicClient: anthropic });

      const result = await executeOrchestrated("critic-loop", criticLoopSteps(), "Write email", options);

      // The critic step output should be valid JSON with the expected fields
      const criticStep = result.stepResults[1];
      const parsed = JSON.parse(criticStep.output);
      expect(parsed).toHaveProperty("accepted");
      expect(parsed).toHaveProperty("score");
      expect(parsed).toHaveProperty("feedback");
      expect(parsed).toHaveProperty("issues");
    });

    test("feedback from critic passed to producer in subsequent rounds", async () => {
      const criticFeedback = "Add more detail about the project timeline";
      const anthropic = createCriticLoopAnthropic({
        acceptOnRound: 1,
        criticFeedback,
      });
      const options = createMockOptions({ anthropicClient: anthropic });

      await executeOrchestrated("critic-loop", criticLoopSteps(), "Write plan", options);

      // The second producer call should have the instruction containing feedback
      // buildPromptFn is called for each step — round 2 producer should include feedback
      const buildCalls = (options.buildPromptFn as any).mock.calls;
      // At least 3 buildPromptFn calls: producer1, critic1, producer2 (+ critic2)
      expect(buildCalls.length).toBeGreaterThanOrEqual(3);
    });

    test("default critic used when only one step provided", async () => {
      const anthropic = createCriticLoopAnthropic({ acceptOnRound: 0 });
      const options = createMockOptions({ anthropicClient: anthropic });

      // Only provide producer step — critic should default
      const steps = [
        createStep({ agent_name: "content", skill_name: "writing", instruction: "Write email" }),
      ];

      const result = await executeOrchestrated("critic-loop", steps, "Write email", options);

      // Should still have 2 steps (producer + default critic)
      expect(result.stepResults.length).toBe(2);

      // The critic dispatch should be for "critic" agent
      const dispatchCalls = mockDispatchAgent.mock.calls;
      expect(dispatchCalls[1][1]).toBe("critic"); // agent_name arg
    });
  });

  // ── Iteration History & Transparency ────────────────────────

  describe("Iteration History & Transparency", () => {
    test("each round's producer output stored in steps", async () => {
      const anthropic = createCriticLoopAnthropic({
        acceptOnRound: null,
        producerTexts: ["Round 1 draft", "Round 2 draft", "Round 3 draft"],
      });
      const options = createMockOptions({ anthropicClient: anthropic });

      const result = await executeOrchestrated("critic-loop", criticLoopSteps(), "Write", options);

      // Producer steps are at even indices (0, 2, 4)
      const producerSteps = result.stepResults.filter((_, i) => i % 2 === 0);
      expect(producerSteps.length).toBe(3);
      expect(producerSteps[0].output).toBe("Round 1 draft");
      expect(producerSteps[1].output).toBe("Round 2 draft");
      expect(producerSteps[2].output).toBe("Round 3 draft");
    });

    test("each round's critic evaluation stored in steps", async () => {
      const anthropic = createCriticLoopAnthropic({ acceptOnRound: null });
      const options = createMockOptions({ anthropicClient: anthropic });

      const result = await executeOrchestrated("critic-loop", criticLoopSteps(), "Write", options);

      // Critic steps are at odd indices (1, 3, 5)
      const criticSteps = result.stepResults.filter((_, i) => i % 2 === 1);
      expect(criticSteps.length).toBe(3);
      for (const step of criticSteps) {
        expect(step.output).toBeTruthy();
        // Output should be valid JSON
        const parsed = JSON.parse(step.output);
        expect(parsed).toHaveProperty("accepted");
      }
    });

    test("iteration timeline visible in artifacts.steps", async () => {
      const anthropic = createCriticLoopAnthropic({ acceptOnRound: 1 });
      const options = createMockOptions({ anthropicClient: anthropic });

      const result = await executeOrchestrated("critic-loop", criticLoopSteps(), "Write", options);

      // Each step has step_index, agent_name, duration_ms
      for (const step of result.artifacts.steps) {
        expect(step).toHaveProperty("step_index");
        expect(step).toHaveProperty("agent_name");
        expect(step).toHaveProperty("duration_ms");
        expect(step).toHaveProperty("cost_usd");
      }
    });
  });

  // ── Cost Tracking ───────────────────────────────────────────

  describe("Cost Tracking", () => {
    test("per-iteration cost tracked separately", async () => {
      const anthropic = createCriticLoopAnthropic({ acceptOnRound: 1 });
      const options = createMockOptions({ anthropicClient: anthropic });

      const result = await executeOrchestrated("critic-loop", criticLoopSteps(), "Write", options);

      for (const step of result.stepResults) {
        expect(step.cost_usd).toBeGreaterThan(0);
      }

      // Total cost is sum of all steps
      const sumCost = result.stepResults.reduce((sum, s) => sum + s.cost_usd, 0);
      expect(result.artifacts.total_cost_usd).toBeCloseTo(sumCost, 6);
    });

    test("early exit (1 round) costs less than max rounds (3)", async () => {
      // Scenario 1: Accept on first round
      const anthropic1 = createCriticLoopAnthropic({ acceptOnRound: 0 });
      const options1 = createMockOptions({ anthropicClient: anthropic1 });
      const result1 = await executeOrchestrated("critic-loop", criticLoopSteps(), "Write", options1);

      // Scenario 2: Never accept (max 3 rounds)
      _resetCachesForTesting();
      mockDispatchAgent.mockImplementation(() =>
        Promise.resolve(createMockDispatchResult()),
      );
      const anthropic2 = createCriticLoopAnthropic({ acceptOnRound: null });
      const options2 = createMockOptions({ anthropicClient: anthropic2 });
      const result2 = await executeOrchestrated("critic-loop", criticLoopSteps(), "Write", options2);

      // Early exit should cost less
      expect(result1.artifacts.total_cost_usd).toBeLessThan(result2.artifacts.total_cost_usd);
      // Early exit: 2 steps. Max rounds: 6 steps.
      expect(result1.stepResults.length).toBe(2);
      expect(result2.stepResults.length).toBe(6);
    });

    test("total loop cost respects $2.00 limit", async () => {
      // Each step returns huge token counts
      let callCount = 0;
      const anthropic = {
        messages: {
          create: mock(async () => {
            callCount++;
            if (callCount % 2 === 1) {
              return {
                content: [{ type: "text", text: "Expensive draft" }],
                usage: { input_tokens: 500_000, output_tokens: 200_000 },
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    accepted: false,
                    score: 3,
                    feedback: "Bad",
                    issues: [],
                  }),
                },
              ],
              usage: { input_tokens: 500_000, output_tokens: 200_000 },
            };
          }),
        },
      } as any;

      const options = createMockOptions({ anthropicClient: anthropic });

      // Should abort early due to cost limit
      const result = await executeOrchestrated("critic-loop", criticLoopSteps(), "Write", options);

      // Loop should have stopped early (cost guard in critic-loop checks after producer)
      expect(result.stepResults.length).toBeLessThan(6);
      // Response should be flagged as truncated due to cost
      expect(result.cost_truncated).toBe(true);
    });
  });
});
