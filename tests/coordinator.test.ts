import { describe, test, expect } from "bun:test";
import { runCoordinatorLoop, type CoordinatorDeps, type CoordinatorOpts, type SpecialistResult } from "../src/coordinator";

/**
 * Helper: build a minimal CoordinatorDeps with stubs.
 * Override individual deps as needed per test.
 */
function stubDeps(overrides: Partial<CoordinatorDeps> = {}): CoordinatorDeps {
  return {
    callSpecialist: async (_agent, _task) => ({
      agent: _agent,
      status: "completed" as const,
      output: `Result from ${_agent}`,
      tokens_used: 100,
      duration_ms: 50,
    }),
    sendMessage: async () => {},
    readForest: async () => "forest data",
    readPlane: async () => "plane data",
    readMemory: async () => "memory data",
    readSessions: async () => "sessions data",
    getWorkingMemorySummary: async () => "working memory summary",
    updateWorkingMemory: async () => {},
    promoteToForest: async () => {},
    logEnvelope: async () => {},
    ...overrides,
  };
}

/** Helper: build a standard test response (assistant turn). */
function makeToolUseResponse(toolCalls: Array<{ name: string; id: string; input: Record<string, unknown> }>) {
  return {
    stop_reason: "tool_use",
    content: toolCalls.map((tc) => ({
      type: "tool_use",
      id: tc.id,
      name: tc.name,
      input: tc.input,
    })),
    usage: { input_tokens: 200, output_tokens: 100 },
  };
}

function makeCompleteResponse(response: string, promote = false) {
  return {
    stop_reason: "tool_use",
    content: [
      {
        type: "tool_use",
        id: "tool_complete_1",
        name: "complete",
        input: { response, promote_to_memory: promote },
      },
    ],
    usage: { input_tokens: 150, output_tokens: 80 },
  };
}

function makeEndTurnResponse(text: string) {
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

const BASE_OPTS: Omit<CoordinatorOpts, "deps" | "_testResponses"> = {
  message: "Hello, help me with something",
  channel: "telegram",
  userId: "user_1",
  foundation: "software-dev",
  systemPrompt: "You are Ellie, a coordinator.",
  model: "claude-sonnet-4-6",
  agentRoster: ["james", "kate", "jason"],
  maxIterations: 10,
};

describe("runCoordinatorLoop", () => {
  test("simple request — single dispatch and complete", async () => {
    const deps = stubDeps();

    const result = await runCoordinatorLoop({
      ...BASE_OPTS,
      deps,
      _testResponses: [
        // Iteration 1: dispatch jason
        makeToolUseResponse([
          { name: "dispatch_agent", id: "tool_1", input: { agent: "jason", task: "Check server status" } },
        ]),
        // Iteration 2: complete
        makeCompleteResponse("Server is running fine. Jason confirmed all services are healthy."),
      ],
    });

    expect(result.response).toBe("Server is running fine. Jason confirmed all services are healthy.");
    expect(result.loopIterations).toBe(2);
    expect(result.envelopes.length).toBeGreaterThanOrEqual(1);
    expect(result.hitSafetyRail).toBe(false);
    expect(result.totalTokensIn).toBeGreaterThan(0);
    expect(result.totalTokensOut).toBeGreaterThan(0);
    expect(result.totalCostUsd).toBeGreaterThan(0);
  });

  test("parallel dispatch — two agents at once", async () => {
    const dispatched: string[] = [];
    const deps = stubDeps({
      callSpecialist: async (agent, task) => {
        dispatched.push(agent);
        return {
          agent,
          status: "completed" as const,
          output: `${agent} completed: ${task}`,
          tokens_used: 100,
          duration_ms: 50,
        };
      },
    });

    const result = await runCoordinatorLoop({
      ...BASE_OPTS,
      deps,
      _testResponses: [
        // Iteration 1: dispatch two agents + update_user
        {
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tool_d1", name: "dispatch_agent", input: { agent: "james", task: "Review code" } },
            { type: "tool_use", id: "tool_d2", name: "dispatch_agent", input: { agent: "kate", task: "Research topic" } },
            { type: "tool_use", id: "tool_u1", name: "update_user", input: { message: "Working on it..." } },
          ],
          usage: { input_tokens: 300, output_tokens: 150 },
        },
        // Iteration 2: complete
        makeCompleteResponse("Both agents finished. Code reviewed and research done."),
      ],
    });

    expect(dispatched).toContain("james");
    expect(dispatched).toContain("kate");
    expect(dispatched.length).toBe(2);
    expect(result.response).toBe("Both agents finished. Code reviewed and research done.");
    expect(result.loopIterations).toBe(2);
    expect(result.hitSafetyRail).toBe(false);
  });

  test("max iterations safety rail", async () => {
    const deps = stubDeps();

    // Create 15 dispatch responses (more than maxIterations=3)
    const responses = Array.from({ length: 15 }, (_, i) =>
      makeToolUseResponse([
        { name: "dispatch_agent", id: `tool_loop_${i}`, input: { agent: "jason", task: `Task ${i}` } },
      ])
    );

    const result = await runCoordinatorLoop({
      ...BASE_OPTS,
      deps,
      maxIterations: 3,
      _testResponses: responses,
    });

    expect(result.loopIterations).toBe(3);
    expect(result.hitSafetyRail).toBe(true);
    expect(result.response).toBeTruthy();
  });

  test("specialist error flows back gracefully", async () => {
    const deps = stubDeps({
      callSpecialist: async (agent) => ({
        agent,
        status: "error" as const,
        output: "",
        error: "Agent crashed unexpectedly",
        tokens_used: 0,
        duration_ms: 10,
      }),
    });

    const result = await runCoordinatorLoop({
      ...BASE_OPTS,
      deps,
      _testResponses: [
        // Iteration 1: dispatch james (will error)
        makeToolUseResponse([
          { name: "dispatch_agent", id: "tool_err1", input: { agent: "james", task: "Do something" } },
        ]),
        // Iteration 2: complete gracefully after seeing the error
        makeCompleteResponse("I encountered an error with James but handled it."),
      ],
    });

    expect(result.response).toBe("I encountered an error with James but handled it.");
    expect(result.loopIterations).toBe(2);
    expect(result.hitSafetyRail).toBe(false);
  });
});
