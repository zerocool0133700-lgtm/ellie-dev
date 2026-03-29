// tests/coordinator-cost-cap.test.ts
import { describe, test, expect } from "bun:test";
import { runCoordinatorLoop, type CoordinatorDeps } from "../src/coordinator";

function createMockDeps(overrides?: Partial<CoordinatorDeps>): CoordinatorDeps {
  return {
    callSpecialist: overrides?.callSpecialist ?? (async (agent, task) => ({
      agent, status: "completed" as const, output: `${agent} done`, tokens_used: 500, duration_ms: 1000,
    })),
    sendMessage: async () => {},
    readForest: async () => "",
    readPlane: async () => "",
    readMemory: async () => "",
    readSessions: async () => "",
    getWorkingMemorySummary: async () => "",
    updateWorkingMemory: async () => {},
    promoteToForest: async () => {},
    logEnvelope: async () => {},
  };
}

describe("Coordinator cost cap enforcement", () => {
  test("session cost cap triggers safety rail", async () => {
    const result = await runCoordinatorLoop({
      message: "Do lots of work",
      channel: "test",
      userId: "test",
      foundation: "test",
      systemPrompt: "You are a test coordinator.",
      model: "claude-sonnet-4-6",
      agentRoster: ["james"],
      deps: createMockDeps(),
      costCapUsd: 0.001, // Very low — even one API call should exceed it
      _testResponses: [
        {
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_1", name: "dispatch_agent", input: { agent: "james", task: "work" } },
          ],
          usage: { input_tokens: 50000, output_tokens: 5000 }, // ~$0.225 at sonnet rates
        },
        {
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_2", name: "complete", input: { response: "Done" } },
          ],
          usage: { input_tokens: 5000, output_tokens: 100 },
        },
      ],
    });

    expect(result.hitSafetyRail).toBe(true);
    expect(result.response.toLowerCase()).toContain("cost");
    expect(result.loopIterations).toBeLessThanOrEqual(2);
  });

  test("totalCostUsd is computed correctly in result", async () => {
    const result = await runCoordinatorLoop({
      message: "Quick task",
      channel: "test",
      userId: "test",
      foundation: "test",
      systemPrompt: "You are a test coordinator.",
      model: "claude-sonnet-4-6",
      agentRoster: ["james"],
      deps: createMockDeps(),
      _testResponses: [
        {
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_1", name: "complete", input: { response: "Done" } },
          ],
          usage: { input_tokens: 1000, output_tokens: 100 },
        },
      ],
    });

    expect(result.totalCostUsd).toBeGreaterThan(0);
    expect(result.totalCostUsd).toBeLessThan(0.01);
  });

  test("cost includes specialist dispatch envelopes", async () => {
    const result = await runCoordinatorLoop({
      message: "Dispatch and complete",
      channel: "test",
      userId: "test",
      foundation: "test",
      systemPrompt: "You are a test coordinator.",
      model: "claude-sonnet-4-6",
      agentRoster: ["james"],
      deps: createMockDeps(),
      _testResponses: [
        {
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_1", name: "dispatch_agent", input: { agent: "james", task: "work" } },
          ],
          usage: { input_tokens: 5000, output_tokens: 200 },
        },
        {
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_2", name: "complete", input: { response: "All done" } },
          ],
          usage: { input_tokens: 6000, output_tokens: 100 },
        },
      ],
    });

    expect(result.envelopes.length).toBeGreaterThanOrEqual(2);
    expect(result.response).toBe("All done");
  });
});
