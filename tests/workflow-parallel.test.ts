/**
 * Workflow Parallel Fan-Out Dispatch Tests — ELLIE-597
 *
 * Validates:
 *  - createParallelDispatch() builds dispatch records
 *  - buildDispatchPayloads() generates per-agent payloads
 *  - createJoinBarrier() initializes all agents as pending
 *  - recordAgentResult() records completion/failure immutably
 *  - applyTimeouts() marks pending agents as timed_out
 *  - getJoinStatus() returns correct status
 *  - aggregateOutputs() combines completed agent outputs
 *  - resolveJoinAction() produces correct coordinator actions
 *  - formatParallelDispatch/formatJoinStatus/formatJoinActionMessage() formatting
 *  - Full scenario: fan-out → partial results → timeout → resolution
 */

import { describe, it, expect } from "bun:test";
import {
  createParallelDispatch,
  buildDispatchPayloads,
  createJoinBarrier,
  recordAgentResult,
  applyTimeouts,
  getJoinStatus,
  isJoinWaiting,
  getCompletedResults,
  getFailedResults,
  getPendingAgents,
  aggregateOutputs,
  resolveJoinAction,
  formatParallelDispatch,
  formatJoinStatus,
  formatJoinActionMessage,
  DEFAULT_PARALLEL_TIMEOUT_MS,
} from "../src/workflow-parallel.ts";
import type { ParallelAgent, JoinBarrier } from "../src/workflow-parallel.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

const agents: ParallelAgent[] = [
  { agent: "critic", label: "Code review" },
  { agent: "security", label: "Security audit" },
  { agent: "perf", label: "Performance review" },
];

const NOW = 1000000;

// ── createParallelDispatch ───────────────────────────────────────────────────

describe("createParallelDispatch", () => {
  it("creates dispatch with agents and step index", () => {
    const dispatch = createParallelDispatch(agents, 2, NOW);
    expect(dispatch.agents).toHaveLength(3);
    expect(dispatch.stepIndex).toBe(2);
    expect(dispatch.dispatchedAt).toBe(NOW);
  });

  it("copies agents array (no shared reference)", () => {
    const dispatch = createParallelDispatch(agents, 0, NOW);
    expect(dispatch.agents).not.toBe(agents);
    expect(dispatch.agents).toEqual(agents);
  });

  it("defaults to Date.now()", () => {
    const dispatch = createParallelDispatch(agents, 0);
    expect(dispatch.dispatchedAt).toBeGreaterThan(0);
  });
});

// ── buildDispatchPayloads ────────────────────────────────────────────────────

describe("buildDispatchPayloads", () => {
  it("builds one payload per agent", () => {
    const dispatch = createParallelDispatch(agents, 1, NOW);
    const payloads = buildDispatchPayloads(dispatch, "wf-1", "Review the code");
    expect(payloads).toHaveLength(3);
  });

  it("includes workflow_id and parallel_step in each payload", () => {
    const dispatch = createParallelDispatch(agents, 3, NOW);
    const payloads = buildDispatchPayloads(dispatch, "wf-42");
    for (const p of payloads) {
      expect(p.workflow_id).toBe("wf-42");
      expect(p.parallel_step).toBe(3);
    }
  });

  it("includes step_context when provided", () => {
    const dispatch = createParallelDispatch(agents, 0, NOW);
    const payloads = buildDispatchPayloads(dispatch, "wf-1", "Context here");
    for (const p of payloads) {
      expect(p.step_context).toBe("Context here");
    }
  });

  it("omits step_context when not provided", () => {
    const dispatch = createParallelDispatch(agents, 0, NOW);
    const payloads = buildDispatchPayloads(dispatch, "wf-1");
    for (const p of payloads) {
      expect(p.step_context).toBeUndefined();
    }
  });

  it("preserves agent and label per payload", () => {
    const dispatch = createParallelDispatch(agents, 0, NOW);
    const payloads = buildDispatchPayloads(dispatch, "wf-1");
    expect(payloads[0].agent).toBe("critic");
    expect(payloads[0].label).toBe("Code review");
    expect(payloads[1].agent).toBe("security");
    expect(payloads[2].agent).toBe("perf");
  });
});

// ── createJoinBarrier ────────────────────────────────────────────────────────

describe("createJoinBarrier", () => {
  it("creates barrier with all agents pending", () => {
    const barrier = createJoinBarrier(1, agents, DEFAULT_PARALLEL_TIMEOUT_MS, NOW);
    expect(barrier.stepIndex).toBe(1);
    expect(barrier.agents).toHaveLength(3);
    expect(barrier.results.size).toBe(3);
    for (const [, result] of barrier.results) {
      expect(result.status).toBe("pending");
    }
  });

  it("uses default timeout", () => {
    const barrier = createJoinBarrier(0, agents, undefined, NOW);
    expect(barrier.timeoutMs).toBe(DEFAULT_PARALLEL_TIMEOUT_MS);
  });

  it("accepts custom timeout", () => {
    const barrier = createJoinBarrier(0, agents, 30000, NOW);
    expect(barrier.timeoutMs).toBe(30000);
  });

  it("copies agents array", () => {
    const barrier = createJoinBarrier(0, agents, undefined, NOW);
    expect(barrier.agents).not.toBe(agents);
  });

  it("records creation timestamp", () => {
    const barrier = createJoinBarrier(0, agents, undefined, NOW);
    expect(barrier.createdAt).toBe(NOW);
  });
});

// ── recordAgentResult ────────────────────────────────────────────────────────

describe("recordAgentResult", () => {
  it("records a completed agent", () => {
    const barrier = createJoinBarrier(0, agents, undefined, NOW);
    const updated = recordAgentResult(barrier, "critic", "completed", "LGTM", NOW + 1000);
    const result = updated.results.get("critic")!;
    expect(result.status).toBe("completed");
    expect(result.output).toBe("LGTM");
    expect(result.completedAt).toBe(NOW + 1000);
  });

  it("records a failed agent", () => {
    const barrier = createJoinBarrier(0, agents, undefined, NOW);
    const updated = recordAgentResult(barrier, "security", "failed", "Crash", NOW + 500);
    const result = updated.results.get("security")!;
    expect(result.status).toBe("failed");
    expect(result.output).toBe("Crash");
  });

  it("does not mutate original barrier", () => {
    const barrier = createJoinBarrier(0, agents, undefined, NOW);
    const updated = recordAgentResult(barrier, "critic", "completed", "Done", NOW + 1000);
    expect(barrier.results.get("critic")!.status).toBe("pending");
    expect(updated.results.get("critic")!.status).toBe("completed");
  });

  it("preserves other agents' results", () => {
    let barrier = createJoinBarrier(0, agents, undefined, NOW);
    barrier = recordAgentResult(barrier, "critic", "completed", "OK");
    barrier = recordAgentResult(barrier, "security", "failed", "Error");
    expect(barrier.results.get("critic")!.status).toBe("completed");
    expect(barrier.results.get("security")!.status).toBe("failed");
    expect(barrier.results.get("perf")!.status).toBe("pending");
  });
});

// ── applyTimeouts ────────────────────────────────────────────────────────────

describe("applyTimeouts", () => {
  it("does not apply timeout before deadline", () => {
    const barrier = createJoinBarrier(0, agents, 5000, NOW);
    const updated = applyTimeouts(barrier, NOW + 4999);
    expect(getPendingAgents(updated)).toHaveLength(3);
  });

  it("marks pending agents as timed_out after deadline", () => {
    const barrier = createJoinBarrier(0, agents, 5000, NOW);
    const updated = applyTimeouts(barrier, NOW + 5000);
    for (const [, result] of updated.results) {
      expect(result.status).toBe("timed_out");
    }
  });

  it("does not change completed agents on timeout", () => {
    let barrier = createJoinBarrier(0, agents, 5000, NOW);
    barrier = recordAgentResult(barrier, "critic", "completed", "Done", NOW + 1000);
    const updated = applyTimeouts(barrier, NOW + 6000);
    expect(updated.results.get("critic")!.status).toBe("completed");
    expect(updated.results.get("security")!.status).toBe("timed_out");
    expect(updated.results.get("perf")!.status).toBe("timed_out");
  });

  it("does not change failed agents on timeout", () => {
    let barrier = createJoinBarrier(0, agents, 5000, NOW);
    barrier = recordAgentResult(barrier, "security", "failed", "Error", NOW + 500);
    const updated = applyTimeouts(barrier, NOW + 6000);
    expect(updated.results.get("security")!.status).toBe("failed");
  });
});

// ── getJoinStatus ────────────────────────────────────────────────────────────

describe("getJoinStatus", () => {
  it("returns 'waiting' when agents are pending", () => {
    const barrier = createJoinBarrier(0, agents, undefined, NOW);
    expect(getJoinStatus(barrier)).toBe("waiting");
  });

  it("returns 'all_complete' when all succeed", () => {
    let barrier = createJoinBarrier(0, agents, undefined, NOW);
    barrier = recordAgentResult(barrier, "critic", "completed", "OK");
    barrier = recordAgentResult(barrier, "security", "completed", "OK");
    barrier = recordAgentResult(barrier, "perf", "completed", "OK");
    expect(getJoinStatus(barrier)).toBe("all_complete");
  });

  it("returns 'partial_failure' when some fail", () => {
    let barrier = createJoinBarrier(0, agents, undefined, NOW);
    barrier = recordAgentResult(barrier, "critic", "completed", "OK");
    barrier = recordAgentResult(barrier, "security", "failed", "Error");
    barrier = recordAgentResult(barrier, "perf", "completed", "OK");
    expect(getJoinStatus(barrier)).toBe("partial_failure");
  });

  it("returns 'all_failed' when all fail", () => {
    let barrier = createJoinBarrier(0, agents, undefined, NOW);
    barrier = recordAgentResult(barrier, "critic", "failed", "Err");
    barrier = recordAgentResult(barrier, "security", "failed", "Err");
    barrier = recordAgentResult(barrier, "perf", "failed", "Err");
    expect(getJoinStatus(barrier)).toBe("all_failed");
  });

  it("returns 'partial_failure' with mix of timed_out and completed", () => {
    let barrier = createJoinBarrier(0, agents, 5000, NOW);
    barrier = recordAgentResult(barrier, "critic", "completed", "OK");
    barrier = applyTimeouts(barrier, NOW + 6000);
    expect(getJoinStatus(barrier)).toBe("partial_failure");
  });

  it("returns 'all_failed' when all timed out", () => {
    const barrier = createJoinBarrier(0, agents, 5000, NOW);
    const updated = applyTimeouts(barrier, NOW + 6000);
    expect(getJoinStatus(updated)).toBe("all_failed");
  });
});

// ── isJoinWaiting ────────────────────────────────────────────────────────────

describe("isJoinWaiting", () => {
  it("returns true when pending", () => {
    const barrier = createJoinBarrier(0, agents, undefined, NOW);
    expect(isJoinWaiting(barrier)).toBe(true);
  });

  it("returns false when all complete", () => {
    let barrier = createJoinBarrier(0, agents, undefined, NOW);
    barrier = recordAgentResult(barrier, "critic", "completed", "OK");
    barrier = recordAgentResult(barrier, "security", "completed", "OK");
    barrier = recordAgentResult(barrier, "perf", "completed", "OK");
    expect(isJoinWaiting(barrier)).toBe(false);
  });
});

// ── getCompletedResults / getFailedResults / getPendingAgents ─────────────────

describe("result accessors", () => {
  it("getCompletedResults returns only completed", () => {
    let barrier = createJoinBarrier(0, agents, undefined, NOW);
    barrier = recordAgentResult(barrier, "critic", "completed", "OK");
    barrier = recordAgentResult(barrier, "security", "failed", "Err");
    expect(getCompletedResults(barrier)).toHaveLength(1);
    expect(getCompletedResults(barrier)[0].agent).toBe("critic");
  });

  it("getFailedResults returns failed and timed_out", () => {
    let barrier = createJoinBarrier(0, agents, 5000, NOW);
    barrier = recordAgentResult(barrier, "critic", "completed", "OK");
    barrier = recordAgentResult(barrier, "security", "failed", "Err");
    barrier = applyTimeouts(barrier, NOW + 6000);
    const failed = getFailedResults(barrier);
    expect(failed).toHaveLength(2);
    expect(failed.map(r => r.agent).sort()).toEqual(["perf", "security"]);
  });

  it("getPendingAgents returns only pending", () => {
    let barrier = createJoinBarrier(0, agents, undefined, NOW);
    barrier = recordAgentResult(barrier, "critic", "completed", "OK");
    const pending = getPendingAgents(barrier);
    expect(pending).toHaveLength(2);
    expect(pending).toContain("security");
    expect(pending).toContain("perf");
  });
});

// ── aggregateOutputs ─────────────────────────────────────────────────────────

describe("aggregateOutputs", () => {
  it("returns empty string when no completed agents", () => {
    const barrier = createJoinBarrier(0, agents, undefined, NOW);
    expect(aggregateOutputs(barrier)).toBe("");
  });

  it("aggregates single agent output", () => {
    let barrier = createJoinBarrier(0, agents, undefined, NOW);
    barrier = recordAgentResult(barrier, "critic", "completed", "Code looks clean");
    const output = aggregateOutputs(barrier);
    expect(output).toContain("[critic]");
    expect(output).toContain("Code looks clean");
  });

  it("aggregates multiple agent outputs", () => {
    let barrier = createJoinBarrier(0, agents, undefined, NOW);
    barrier = recordAgentResult(barrier, "critic", "completed", "LGTM");
    barrier = recordAgentResult(barrier, "security", "completed", "No vulnerabilities");
    barrier = recordAgentResult(barrier, "perf", "completed", "Fast enough");
    const output = aggregateOutputs(barrier);
    expect(output).toContain("[critic]: LGTM");
    expect(output).toContain("[security]: No vulnerabilities");
    expect(output).toContain("[perf]: Fast enough");
  });

  it("handles agent with no output", () => {
    let barrier = createJoinBarrier(0, agents, undefined, NOW);
    barrier = recordAgentResult(barrier, "critic", "completed");
    const output = aggregateOutputs(barrier);
    expect(output).toContain("[critic]: (no output)");
  });

  it("excludes failed agents from aggregation", () => {
    let barrier = createJoinBarrier(0, agents, undefined, NOW);
    barrier = recordAgentResult(barrier, "critic", "completed", "OK");
    barrier = recordAgentResult(barrier, "security", "failed", "Error");
    barrier = recordAgentResult(barrier, "perf", "completed", "Fine");
    const output = aggregateOutputs(barrier);
    expect(output).toContain("[critic]: OK");
    expect(output).toContain("[perf]: Fine");
    expect(output).not.toContain("[security]");
  });
});

// ── resolveJoinAction ────────────────────────────────────────────────────────

describe("resolveJoinAction", () => {
  it("returns 'waiting' when agents are pending", () => {
    let barrier = createJoinBarrier(0, agents, undefined, NOW);
    barrier = recordAgentResult(barrier, "critic", "completed", "OK");
    const action = resolveJoinAction(barrier);
    expect(action.type).toBe("waiting");
    if (action.type === "waiting") {
      expect(action.pending).toHaveLength(2);
      expect(action.completed).toEqual(["critic"]);
    }
  });

  it("returns 'proceed' when all complete", () => {
    let barrier = createJoinBarrier(0, agents, undefined, NOW);
    barrier = recordAgentResult(barrier, "critic", "completed", "LGTM");
    barrier = recordAgentResult(barrier, "security", "completed", "Secure");
    barrier = recordAgentResult(barrier, "perf", "completed", "Fast");
    const action = resolveJoinAction(barrier);
    expect(action.type).toBe("proceed");
    if (action.type === "proceed") {
      expect(action.aggregatedOutput).toContain("[critic]: LGTM");
      expect(action.aggregatedOutput).toContain("[security]: Secure");
      expect(action.aggregatedOutput).toContain("[perf]: Fast");
    }
  });

  it("returns 'partial_failure' with completed and failed lists", () => {
    let barrier = createJoinBarrier(0, agents, undefined, NOW);
    barrier = recordAgentResult(barrier, "critic", "completed", "OK");
    barrier = recordAgentResult(barrier, "security", "failed", "Crash");
    barrier = recordAgentResult(barrier, "perf", "completed", "Fine");
    const action = resolveJoinAction(barrier);
    expect(action.type).toBe("partial_failure");
    if (action.type === "partial_failure") {
      expect(action.completed).toHaveLength(2);
      expect(action.failed).toHaveLength(1);
      expect(action.failed[0].agent).toBe("security");
      expect(action.aggregatedOutput).toContain("[critic]: OK");
      expect(action.aggregatedOutput).toContain("[perf]: Fine");
    }
  });

  it("returns 'all_failed' when everything fails", () => {
    let barrier = createJoinBarrier(0, agents, undefined, NOW);
    barrier = recordAgentResult(barrier, "critic", "failed", "Err1");
    barrier = recordAgentResult(barrier, "security", "failed", "Err2");
    barrier = recordAgentResult(barrier, "perf", "failed", "Err3");
    const action = resolveJoinAction(barrier);
    expect(action.type).toBe("all_failed");
    if (action.type === "all_failed") {
      expect(action.failed).toHaveLength(3);
    }
  });
});

// ── formatParallelDispatch ───────────────────────────────────────────────────

describe("formatParallelDispatch", () => {
  it("includes workflow ID and agents", () => {
    const dispatch = createParallelDispatch(agents, 2, NOW);
    const msg = formatParallelDispatch(dispatch, "wf-1");
    expect(msg).toContain("wf-1");
    expect(msg).toContain("step 2");
    expect(msg).toContain("critic");
    expect(msg).toContain("security");
    expect(msg).toContain("perf");
  });
});

// ── formatJoinStatus ─────────────────────────────────────────────────────────

describe("formatJoinStatus", () => {
  it("shows completed count and status", () => {
    let barrier = createJoinBarrier(0, agents, undefined, NOW);
    barrier = recordAgentResult(barrier, "critic", "completed", "OK");
    const msg = formatJoinStatus(barrier, "wf-1");
    expect(msg).toContain("wf-1");
    expect(msg).toContain("1/3 complete");
    expect(msg).toContain("2 pending");
    expect(msg).toContain("waiting");
  });

  it("shows failed count", () => {
    let barrier = createJoinBarrier(0, agents, undefined, NOW);
    barrier = recordAgentResult(barrier, "critic", "completed", "OK");
    barrier = recordAgentResult(barrier, "security", "failed", "Err");
    barrier = recordAgentResult(barrier, "perf", "completed", "OK");
    const msg = formatJoinStatus(barrier, "wf-1");
    expect(msg).toContain("2/3 complete");
    expect(msg).toContain("1 failed");
    expect(msg).toContain("partial_failure");
  });
});

// ── formatJoinActionMessage ──────────────────────────────────────────────────

describe("formatJoinActionMessage", () => {
  it("formats waiting message", () => {
    let barrier = createJoinBarrier(0, agents, undefined, NOW);
    barrier = recordAgentResult(barrier, "critic", "completed", "OK");
    const action = resolveJoinAction(barrier);
    const msg = formatJoinActionMessage(action, "wf-1");
    expect(msg).toContain("wf-1");
    expect(msg).toContain("Waiting for 2 agent(s)");
    expect(msg).toContain("1 complete so far");
  });

  it("formats proceed message", () => {
    let barrier = createJoinBarrier(0, agents, undefined, NOW);
    barrier = recordAgentResult(barrier, "critic", "completed", "OK");
    barrier = recordAgentResult(barrier, "security", "completed", "OK");
    barrier = recordAgentResult(barrier, "perf", "completed", "OK");
    const action = resolveJoinAction(barrier);
    const msg = formatJoinActionMessage(action, "wf-1");
    expect(msg).toContain("All parallel agents complete");
    expect(msg).toContain("Proceeding");
  });

  it("formats partial failure message", () => {
    let barrier = createJoinBarrier(0, agents, undefined, NOW);
    barrier = recordAgentResult(barrier, "critic", "completed", "OK");
    barrier = recordAgentResult(barrier, "security", "failed", "Err");
    barrier = recordAgentResult(barrier, "perf", "completed", "OK");
    const action = resolveJoinAction(barrier);
    const msg = formatJoinActionMessage(action, "wf-1");
    expect(msg).toContain("Partial failure");
    expect(msg).toContain("completed: critic, perf");
    expect(msg).toContain("security (failed)");
  });

  it("formats all failed message", () => {
    let barrier = createJoinBarrier(0, agents, undefined, NOW);
    barrier = recordAgentResult(barrier, "critic", "failed", "Err");
    barrier = recordAgentResult(barrier, "security", "failed", "Err");
    barrier = recordAgentResult(barrier, "perf", "failed", "Err");
    const action = resolveJoinAction(barrier);
    const msg = formatJoinActionMessage(action, "wf-1");
    expect(msg).toContain("All parallel agents failed");
  });
});

// ── Full scenario: fan-out → results → timeout → resolution ─────────────────

describe("full parallel workflow scenario", () => {
  it("dispatches, collects results, handles timeout, resolves", () => {
    // 1. Create parallel dispatch
    const dispatch = createParallelDispatch(agents, 1, NOW);
    expect(dispatch.agents).toHaveLength(3);
    const payloads = buildDispatchPayloads(dispatch, "wf-review", "Review the PR");
    expect(payloads).toHaveLength(3);

    // 2. Create join barrier
    let barrier = createJoinBarrier(1, agents, 10000, NOW);
    expect(getJoinStatus(barrier)).toBe("waiting");

    // 3. Critic completes quickly
    barrier = recordAgentResult(barrier, "critic", "completed", "Code LGTM — clean patterns.", NOW + 2000);
    expect(getJoinStatus(barrier)).toBe("waiting");
    expect(getPendingAgents(barrier)).toEqual(["security", "perf"]);

    // 4. Security completes
    barrier = recordAgentResult(barrier, "security", "completed", "No vulnerabilities found.", NOW + 5000);
    expect(getJoinStatus(barrier)).toBe("waiting");

    // 5. Perf times out
    barrier = applyTimeouts(barrier, NOW + 11000);
    expect(getJoinStatus(barrier)).toBe("partial_failure");

    // 6. Resolve action
    const action = resolveJoinAction(barrier);
    expect(action.type).toBe("partial_failure");
    if (action.type === "partial_failure") {
      expect(action.completed).toHaveLength(2);
      expect(action.failed).toHaveLength(1);
      expect(action.failed[0].agent).toBe("perf");
      expect(action.failed[0].status).toBe("timed_out");
      expect(action.aggregatedOutput).toContain("[critic]: Code LGTM");
      expect(action.aggregatedOutput).toContain("[security]: No vulnerabilities found.");
    }

    // 7. Format messages
    const dispatchMsg = formatParallelDispatch(dispatch, "wf-review");
    expect(dispatchMsg).toContain("critic");
    const statusMsg = formatJoinStatus(barrier, "wf-review");
    expect(statusMsg).toContain("2/3 complete");
    const actionMsg = formatJoinActionMessage(action, "wf-review");
    expect(actionMsg).toContain("Partial failure");
  });

  it("handles fully successful parallel execution", () => {
    let barrier = createJoinBarrier(0, agents, 10000, NOW);

    barrier = recordAgentResult(barrier, "critic", "completed", "Approved.", NOW + 1000);
    barrier = recordAgentResult(barrier, "security", "completed", "Secure.", NOW + 2000);
    barrier = recordAgentResult(barrier, "perf", "completed", "Fast.", NOW + 3000);

    const action = resolveJoinAction(barrier);
    expect(action.type).toBe("proceed");
    if (action.type === "proceed") {
      expect(action.aggregatedOutput).toContain("[critic]: Approved.");
      expect(action.aggregatedOutput).toContain("[security]: Secure.");
      expect(action.aggregatedOutput).toContain("[perf]: Fast.");
    }
  });

  it("handles all agents timing out", () => {
    const barrier = createJoinBarrier(0, agents, 5000, NOW);
    const timedOut = applyTimeouts(barrier, NOW + 6000);

    const action = resolveJoinAction(timedOut);
    expect(action.type).toBe("all_failed");
    if (action.type === "all_failed") {
      expect(action.failed).toHaveLength(3);
      for (const f of action.failed) {
        expect(f.status).toBe("timed_out");
      }
    }
  });

  it("handles 2-agent parallel (minimum)", () => {
    const twoAgents: ParallelAgent[] = [
      { agent: "dev", label: "Implement" },
      { agent: "test", label: "Write tests" },
    ];
    const dispatch = createParallelDispatch(twoAgents, 0, NOW);
    expect(dispatch.agents).toHaveLength(2);

    let barrier = createJoinBarrier(0, twoAgents, undefined, NOW);
    barrier = recordAgentResult(barrier, "dev", "completed", "Code done");
    barrier = recordAgentResult(barrier, "test", "completed", "Tests pass");

    expect(getJoinStatus(barrier)).toBe("all_complete");
    const output = aggregateOutputs(barrier);
    expect(output).toContain("[dev]: Code done");
    expect(output).toContain("[test]: Tests pass");
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("single agent parallel dispatch", () => {
    const single: ParallelAgent[] = [{ agent: "solo", label: "Do it all" }];
    let barrier = createJoinBarrier(0, single, undefined, NOW);
    barrier = recordAgentResult(barrier, "solo", "completed", "All done");
    expect(getJoinStatus(barrier)).toBe("all_complete");
    expect(aggregateOutputs(barrier)).toContain("[solo]: All done");
  });

  it("recording result for unknown agent adds it", () => {
    const barrier = createJoinBarrier(0, agents, undefined, NOW);
    const updated = recordAgentResult(barrier, "unknown", "completed", "Surprise");
    expect(updated.results.get("unknown")!.status).toBe("completed");
  });

  it("timeout at exact boundary triggers", () => {
    const barrier = createJoinBarrier(0, agents, 5000, NOW);
    const updated = applyTimeouts(barrier, NOW + 5000);
    expect(getPendingAgents(updated)).toHaveLength(0);
  });

  it("timeout before boundary does not trigger", () => {
    const barrier = createJoinBarrier(0, agents, 5000, NOW);
    const updated = applyTimeouts(barrier, NOW + 4999);
    expect(getPendingAgents(updated)).toHaveLength(3);
  });
});
