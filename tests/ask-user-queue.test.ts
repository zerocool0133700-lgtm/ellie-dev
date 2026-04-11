import { describe, test, expect, beforeEach } from "bun:test";
import {
  pushPendingAskUser,
  shiftPendingAskUser,
  getPendingAskUserCount,
  clearPendingAskUserQueue,
  ASK_USER_STALE_MS,
  type CoordinatorPausedState,
} from "../src/ellie-chat-handler";

/**
 * ELLIE-1159: ask_user responses must be routed to the coordinator that
 * asked the question, not whichever coordinator most recently wrote to
 * global state.
 *
 * Fix: replace global _pendingAskUser with a FIFO queue so concurrent
 * coordinators each get their own slot and responses are delivered in order.
 */

function makePausedState(overrides: Partial<CoordinatorPausedState> = {}): CoordinatorPausedState {
  return {
    messages: [],
    systemPrompt: "test prompt",
    toolUseId: overrides.toolUseId || `tool_${Math.random().toString(36).slice(2, 8)}`,
    question: overrides.question || "Test question?",
    foundation: "software-dev",
    model: "claude-sonnet-4-6",
    agentRoster: ["james"],
    envelopes: [],
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalCostUsd: 0,
    loopIterations: 1,
    orchestrationParentId: null,
    lastDispatchChildId: null,
    ...overrides,
  };
}

describe("ELLIE-1159: ask_user queue (replaces global _pendingAskUser)", () => {
  beforeEach(() => {
    clearPendingAskUserQueue();
  });

  test("single coordinator pause and resume works like before", () => {
    const stateA = makePausedState({ question: "Q from coordinator A", toolUseId: "tool_a" });

    pushPendingAskUser(stateA);
    expect(getPendingAskUserCount()).toBe(1);

    const resumed = shiftPendingAskUser();
    expect(resumed).not.toBeNull();
    expect(resumed!.toolUseId).toBe("tool_a");
    expect(resumed!.question).toBe("Q from coordinator A");
    expect(getPendingAskUserCount()).toBe(0);
  });

  test("shift returns null when queue is empty", () => {
    expect(shiftPendingAskUser()).toBeNull();
    expect(getPendingAskUserCount()).toBe(0);
  });

  test("two coordinators pause — responses route in FIFO order", () => {
    const stateA = makePausedState({ question: "Q from coordinator A", toolUseId: "tool_a" });
    const stateB = makePausedState({ question: "Q from coordinator B", toolUseId: "tool_b" });

    // Coordinator A pauses first, then B
    pushPendingAskUser(stateA);
    pushPendingAskUser(stateB);
    expect(getPendingAskUserCount()).toBe(2);

    // First user response should go to coordinator A (who asked first)
    const firstResume = shiftPendingAskUser();
    expect(firstResume!.toolUseId).toBe("tool_a");
    expect(firstResume!.question).toBe("Q from coordinator A");

    // Second user response should go to coordinator B
    const secondResume = shiftPendingAskUser();
    expect(secondResume!.toolUseId).toBe("tool_b");
    expect(secondResume!.question).toBe("Q from coordinator B");

    // Queue is now empty
    expect(getPendingAskUserCount()).toBe(0);
    expect(shiftPendingAskUser()).toBeNull();
  });

  test("clear empties the entire queue", () => {
    pushPendingAskUser(makePausedState({ toolUseId: "tool_1" }));
    pushPendingAskUser(makePausedState({ toolUseId: "tool_2" }));
    pushPendingAskUser(makePausedState({ toolUseId: "tool_3" }));
    expect(getPendingAskUserCount()).toBe(3);

    clearPendingAskUserQueue();
    expect(getPendingAskUserCount()).toBe(0);
    expect(shiftPendingAskUser()).toBeNull();
  });
});

describe("ELLIE-1158: stale ask_user entries are pruned on shift", () => {
  beforeEach(() => {
    clearPendingAskUserQueue();
  });

  test("fresh entries are returned normally", () => {
    pushPendingAskUser(makePausedState({ toolUseId: "fresh_1" }));
    const result = shiftPendingAskUser();
    expect(result).not.toBeNull();
    expect(result!.toolUseId).toBe("fresh_1");
  });

  test("stale entries are skipped and pruned", () => {
    // Push an entry with a backdated timestamp (older than ASK_USER_STALE_MS)
    pushPendingAskUser(makePausedState({ toolUseId: "stale_1" }), Date.now() - ASK_USER_STALE_MS - 1000);
    pushPendingAskUser(makePausedState({ toolUseId: "fresh_1" }));

    // The stale entry should be skipped, fresh one returned
    const result = shiftPendingAskUser();
    expect(result).not.toBeNull();
    expect(result!.toolUseId).toBe("fresh_1");

    // Queue should be empty — stale entry was pruned
    expect(getPendingAskUserCount()).toBe(0);
  });

  test("all-stale queue returns null", () => {
    const staleTime = Date.now() - ASK_USER_STALE_MS - 1000;
    pushPendingAskUser(makePausedState({ toolUseId: "stale_1" }), staleTime);
    pushPendingAskUser(makePausedState({ toolUseId: "stale_2" }), staleTime);

    const result = shiftPendingAskUser();
    expect(result).toBeNull();
    expect(getPendingAskUserCount()).toBe(0);
  });

  test("mixed stale and fresh — only fresh returned in FIFO order", () => {
    const staleTime = Date.now() - ASK_USER_STALE_MS - 1000;
    pushPendingAskUser(makePausedState({ toolUseId: "stale_1" }), staleTime);
    pushPendingAskUser(makePausedState({ toolUseId: "fresh_1" }));
    pushPendingAskUser(makePausedState({ toolUseId: "stale_2" }), staleTime);
    pushPendingAskUser(makePausedState({ toolUseId: "fresh_2" }));

    const first = shiftPendingAskUser();
    expect(first!.toolUseId).toBe("fresh_1");

    const second = shiftPendingAskUser();
    expect(second!.toolUseId).toBe("fresh_2");

    expect(shiftPendingAskUser()).toBeNull();
  });
});
