// tests/coordinator-cost-cap.test.ts
import { describe, test, expect } from "bun:test";
import { runCoordinatorLoop, type CoordinatorDeps } from "../src/coordinator";
import { parseClaudeJsonOutput } from "../src/claude-cli";

function createMockDeps(overrides?: Partial<CoordinatorDeps>): CoordinatorDeps {
  return {
    callSpecialist: overrides?.callSpecialist ?? (async (agent, task) => ({
      agent, status: "completed" as const, output: `${agent} done`, tokens_used: 500, cost_usd: 0.05, duration_ms: 1000,
    })),
    sendMessage: async () => {},
    sendEvent: async () => {},
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

  test("specialist costs are aggregated into totalCostUsd", async () => {
    const specialistCost = 0.25;
    const result = await runCoordinatorLoop({
      message: "Dispatch two specialists",
      channel: "test",
      userId: "test",
      foundation: "test",
      systemPrompt: "You are a test coordinator.",
      model: "claude-sonnet-4-6",
      agentRoster: ["james", "kate"],
      deps: createMockDeps({
        callSpecialist: async (agent) => ({
          agent, status: "completed" as const, output: `${agent} done`,
          tokens_used: 0, cost_usd: specialistCost, duration_ms: 500,
        }),
      }),
      _testResponses: [
        {
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_1", name: "dispatch_agent", input: { agent: "james", task: "task1" } },
            { type: "tool_use", id: "tu_2", name: "dispatch_agent", input: { agent: "kate", task: "task2" } },
          ],
          usage: { input_tokens: 1000, output_tokens: 100 },
        },
        {
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_3", name: "complete", input: { response: "Both done" } },
          ],
          usage: { input_tokens: 2000, output_tokens: 50 },
        },
      ],
    });

    // Total cost should include both specialist costs ($0.25 each = $0.50)
    // plus coordinator token costs
    const coordinatorOnlyCost = result.totalCostUsd - (specialistCost * 2);
    expect(result.totalCostUsd).toBeGreaterThan(specialistCost * 2);
    expect(coordinatorOnlyCost).toBeGreaterThan(0);
    expect(result.response).toBe("Both done");
  });

  test("specialist costs trigger cost cap", async () => {
    const result = await runCoordinatorLoop({
      message: "Dispatch expensive specialist",
      channel: "test",
      userId: "test",
      foundation: "test",
      systemPrompt: "You are a test coordinator.",
      model: "claude-sonnet-4-6",
      agentRoster: ["james"],
      costCapUsd: 0.10,
      deps: createMockDeps({
        callSpecialist: async (agent) => ({
          agent, status: "completed" as const, output: `${agent} done`,
          tokens_used: 0, cost_usd: 0.50, duration_ms: 500,
        }),
      }),
      _testResponses: [
        {
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_1", name: "dispatch_agent", input: { agent: "james", task: "expensive work" } },
          ],
          usage: { input_tokens: 100, output_tokens: 10 },
        },
        {
          // This iteration should not be reached — cost cap should trigger first
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_2", name: "dispatch_agent", input: { agent: "james", task: "more work" } },
          ],
          usage: { input_tokens: 100, output_tokens: 10 },
        },
        {
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_3", name: "complete", input: { response: "Should not reach here" } },
          ],
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      ],
    });

    // Specialist cost ($0.50) exceeds cap ($0.10) — should hit safety rail
    expect(result.hitSafetyRail).toBe(true);
    expect(result.response.toLowerCase()).toContain("cost");
    expect(result.loopIterations).toBeLessThanOrEqual(2);
  });
});

describe("parseClaudeJsonOutput", () => {
  test("parses valid JSON output with cost", () => {
    const raw = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Task completed successfully",
      cost_usd: 0.123,
      duration_ms: 5000,
      num_turns: 3,
      is_error: false,
      session_id: "abc-123",
    });

    const parsed = parseClaudeJsonOutput(raw);
    expect(parsed.result).toBe("Task completed successfully");
    expect(parsed.costUsd).toBe(0.123);
    expect(parsed.durationMs).toBe(5000);
    expect(parsed.numTurns).toBe(3);
    expect(parsed.isError).toBe(false);
    expect(parsed.sessionId).toBe("abc-123");
  });

  test("handles total_cost_usd fallback", () => {
    const raw = JSON.stringify({
      result: "Done",
      total_cost_usd: 0.456,
    });

    const parsed = parseClaudeJsonOutput(raw);
    expect(parsed.costUsd).toBe(0.456);
  });

  test("returns zero cost on invalid JSON", () => {
    const parsed = parseClaudeJsonOutput("not valid json {{{");
    expect(parsed.result).toBe("not valid json {{{");
    expect(parsed.costUsd).toBe(0);
  });

  test("handles error responses", () => {
    const raw = JSON.stringify({
      result: "Something went wrong",
      is_error: true,
      cost_usd: 0.01,
    });

    const parsed = parseClaudeJsonOutput(raw);
    expect(parsed.isError).toBe(true);
    expect(parsed.costUsd).toBe(0.01);
  });
});
