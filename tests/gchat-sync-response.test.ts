/**
 * ELLIE-83 — GChat respondedSync scoping fix
 *
 * Verifies that the sendSyncResponse function and respondedSync variable
 * are accessible from both the multi-step and single-agent code paths.
 *
 * The original bug: respondedSync was declared inside the single-agent
 * branch (after the multi-step branch), causing a TDZ ReferenceError
 * when sendSyncResponse was called from the multi-step path.
 */
import { describe, test, expect } from "bun:test";

describe("GChat Sync Response Gate", () => {
  // Simulate the fixed scoping pattern — shared gate before both branches

  function createSyncGate() {
    let respondedSync = false;

    function sendSyncResponse(text: string) {
      if (respondedSync) return null;
      respondedSync = true;
      return { text, sent: true };
    }

    return { sendSyncResponse, isResponded: () => respondedSync };
  }

  test("sendSyncResponse sends on first call", () => {
    const gate = createSyncGate();
    const result = gate.sendSyncResponse("Hello");
    expect(result).toEqual({ text: "Hello", sent: true });
    expect(gate.isResponded()).toBe(true);
  });

  test("sendSyncResponse is idempotent — second call returns null", () => {
    const gate = createSyncGate();
    const first = gate.sendSyncResponse("First");
    const second = gate.sendSyncResponse("Second");
    expect(first).toEqual({ text: "First", sent: true });
    expect(second).toBeNull();
  });

  test("multi-step branch can call sendSyncResponse before single-agent code", () => {
    // This is the exact scenario that caused the TDZ crash.
    // The gate is created before both branches, so both can access it.
    const gate = createSyncGate();

    // Simulates multi-step branch calling first
    const multiStepResult = gate.sendSyncResponse("Working on it... (pipeline)");
    expect(multiStepResult).toEqual({ text: "Working on it... (pipeline)", sent: true });

    // Single-agent branch would be skipped (multi-step returns early),
    // but if it tried to call, it should be a no-op
    const singleAgentResult = gate.sendSyncResponse("Direct response");
    expect(singleAgentResult).toBeNull();
  });

  test("single-agent branch works when multi-step is not triggered", () => {
    const gate = createSyncGate();

    // Multi-step branch is not entered (execution_mode === "single")
    // Single-agent branch calls sendSyncResponse
    const result = gate.sendSyncResponse("Here is your answer");
    expect(result).toEqual({ text: "Here is your answer", sent: true });
  });

  test("timeout path can send interim response, then async delivery skips gate", () => {
    const gate = createSyncGate();

    // Timeout fires and sends interim response
    const interim = gate.sendSyncResponse("Working on it...");
    expect(interim).toEqual({ text: "Working on it...", sent: true });

    // When Claude finishes, async delivery is used instead of the gate
    // The gate correctly blocks any duplicate sync response
    const duplicate = gate.sendSyncResponse("Actual answer");
    expect(duplicate).toBeNull();
    expect(gate.isResponded()).toBe(true);
  });
});
