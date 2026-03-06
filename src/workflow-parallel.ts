/**
 * Workflow Parallel Fan-Out Dispatch — ELLIE-597
 *
 * Adds parallel step dispatch with join barrier for workflow orchestration.
 * A parallel step dispatches N agents simultaneously, and a join barrier
 * waits for all agents to complete before proceeding.
 *
 * Handles partial failures — if some agents complete but others fail or
 * time out, the barrier surfaces the issue for the coordinator to decide.
 *
 * Pure module — zero side effects, fully testable.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** An agent participating in a parallel fan-out. */
export interface ParallelAgent {
  agent: string;
  label: string;
}

/** Result status for an individual agent in a parallel group. */
export type AgentResultStatus = "pending" | "completed" | "failed" | "timed_out";

/** Result from a single agent in a parallel group. */
export interface AgentResult {
  agent: string;
  status: AgentResultStatus;
  output?: string;
  completedAt?: number;
}

/** A parallel dispatch — N agents to run simultaneously. */
export interface ParallelDispatch {
  agents: ParallelAgent[];
  stepIndex: number;
  dispatchedAt: number;
}

/** A join barrier tracking completion of parallel agents. */
export interface JoinBarrier {
  stepIndex: number;
  agents: ParallelAgent[];
  results: Map<string, AgentResult>;
  createdAt: number;
  timeoutMs: number;
}

/** Status of the join barrier. */
export type JoinStatus = "waiting" | "all_complete" | "partial_failure" | "all_failed";

/** Action the coordinator can take after evaluating a join barrier. */
export type JoinAction =
  | { type: "waiting"; pending: string[]; completed: string[] }
  | { type: "proceed"; aggregatedOutput: string }
  | { type: "partial_failure"; completed: AgentResult[]; failed: AgentResult[]; aggregatedOutput: string }
  | { type: "all_failed"; failed: AgentResult[] };

// ── Configuration ────────────────────────────────────────────────────────────

/** Default timeout for parallel agents (5 minutes). */
export const DEFAULT_PARALLEL_TIMEOUT_MS = 5 * 60 * 1000;

// ── Pure: Parallel dispatch ──────────────────────────────────────────────────

/**
 * Create a parallel dispatch for N agents at a given step index.
 * Returns the dispatch record with timestamp.
 */
export function createParallelDispatch(
  agents: ParallelAgent[],
  stepIndex: number,
  now: number = Date.now(),
): ParallelDispatch {
  return {
    agents: [...agents],
    stepIndex,
    dispatchedAt: now,
  };
}

/**
 * Build dispatch payloads for each agent in a parallel group.
 * Each payload can be sent to the agent dispatch system independently.
 */
export function buildDispatchPayloads(
  dispatch: ParallelDispatch,
  workflowId: string,
  stepContext?: string,
): Array<{ agent: string; label: string; step_context?: string; workflow_id: string; parallel_step: number }> {
  return dispatch.agents.map(a => ({
    agent: a.agent,
    label: a.label,
    step_context: stepContext,
    workflow_id: workflowId,
    parallel_step: dispatch.stepIndex,
  }));
}

// ── Pure: Join barrier ───────────────────────────────────────────────────────

/**
 * Create a join barrier for a parallel step.
 * Initializes all agents as "pending".
 */
export function createJoinBarrier(
  stepIndex: number,
  agents: ParallelAgent[],
  timeoutMs: number = DEFAULT_PARALLEL_TIMEOUT_MS,
  now: number = Date.now(),
): JoinBarrier {
  const results = new Map<string, AgentResult>();
  for (const a of agents) {
    results.set(a.agent, { agent: a.agent, status: "pending" });
  }
  return {
    stepIndex,
    agents: [...agents],
    results,
    createdAt: now,
    timeoutMs,
  };
}

/**
 * Record an agent's result in the join barrier.
 * Returns a new barrier (immutable — does not mutate original).
 */
export function recordAgentResult(
  barrier: JoinBarrier,
  agent: string,
  status: "completed" | "failed",
  output?: string,
  now: number = Date.now(),
): JoinBarrier {
  const newResults = new Map(barrier.results);
  newResults.set(agent, {
    agent,
    status,
    output,
    completedAt: now,
  });
  return { ...barrier, results: newResults };
}

/**
 * Apply timeout to any agents that haven't completed within the timeout window.
 * Returns a new barrier with timed-out agents marked.
 */
export function applyTimeouts(barrier: JoinBarrier, now: number = Date.now()): JoinBarrier {
  const elapsed = now - barrier.createdAt;
  if (elapsed < barrier.timeoutMs) return barrier;

  const newResults = new Map(barrier.results);
  for (const [agent, result] of newResults) {
    if (result.status === "pending") {
      newResults.set(agent, { ...result, status: "timed_out" });
    }
  }
  return { ...barrier, results: newResults };
}

// ── Pure: Join status ────────────────────────────────────────────────────────

/**
 * Get the current status of the join barrier.
 */
export function getJoinStatus(barrier: JoinBarrier): JoinStatus {
  const results = [...barrier.results.values()];
  const hasPending = results.some(r => r.status === "pending");
  if (hasPending) return "waiting";

  const completed = results.filter(r => r.status === "completed");
  const failed = results.filter(r => r.status === "failed" || r.status === "timed_out");

  if (failed.length === results.length) return "all_failed";
  if (failed.length > 0) return "partial_failure";
  return "all_complete";
}

/**
 * Check if the join barrier is still waiting for agents.
 */
export function isJoinWaiting(barrier: JoinBarrier): boolean {
  return getJoinStatus(barrier) === "waiting";
}

/**
 * Get completed agent results from the barrier.
 */
export function getCompletedResults(barrier: JoinBarrier): AgentResult[] {
  return [...barrier.results.values()].filter(r => r.status === "completed");
}

/**
 * Get failed/timed-out agent results from the barrier.
 */
export function getFailedResults(barrier: JoinBarrier): AgentResult[] {
  return [...barrier.results.values()].filter(
    r => r.status === "failed" || r.status === "timed_out",
  );
}

/**
 * Get pending agent names.
 */
export function getPendingAgents(barrier: JoinBarrier): string[] {
  return [...barrier.results.values()]
    .filter(r => r.status === "pending")
    .map(r => r.agent);
}

// ── Pure: Output aggregation ─────────────────────────────────────────────────

/**
 * Aggregate outputs from completed agents into a combined context string.
 * Each agent's output is labeled and separated.
 */
export function aggregateOutputs(barrier: JoinBarrier): string {
  const completed = getCompletedResults(barrier);
  if (completed.length === 0) return "";

  return completed
    .map(r => `[${r.agent}]: ${r.output ?? "(no output)"}`)
    .join("\n\n");
}

// ── Pure: Join action resolution ─────────────────────────────────────────────

/**
 * Resolve what action the coordinator should take based on join barrier state.
 *
 * - "waiting": still have pending agents
 * - "proceed": all agents completed successfully
 * - "partial_failure": some succeeded, some failed/timed out
 * - "all_failed": every agent failed or timed out
 */
export function resolveJoinAction(barrier: JoinBarrier): JoinAction {
  const status = getJoinStatus(barrier);

  if (status === "waiting") {
    return {
      type: "waiting",
      pending: getPendingAgents(barrier),
      completed: getCompletedResults(barrier).map(r => r.agent),
    };
  }

  if (status === "all_complete") {
    return {
      type: "proceed",
      aggregatedOutput: aggregateOutputs(barrier),
    };
  }

  if (status === "all_failed") {
    return {
      type: "all_failed",
      failed: getFailedResults(barrier),
    };
  }

  // partial_failure
  return {
    type: "partial_failure",
    completed: getCompletedResults(barrier),
    failed: getFailedResults(barrier),
    aggregatedOutput: aggregateOutputs(barrier),
  };
}

// ── Pure: Message formatting ─────────────────────────────────────────────────

/**
 * Build a human-readable summary of a parallel dispatch.
 */
export function formatParallelDispatch(dispatch: ParallelDispatch, workflowId: string): string {
  const agentList = dispatch.agents.map(a => `${a.agent} (${a.label})`).join(", ");
  return `Parallel dispatch [${workflowId}] step ${dispatch.stepIndex}: ${agentList}`;
}

/**
 * Build a human-readable summary of a join barrier.
 */
export function formatJoinStatus(barrier: JoinBarrier, workflowId: string): string {
  const status = getJoinStatus(barrier);
  const total = barrier.agents.length;
  const completed = getCompletedResults(barrier).length;
  const failed = getFailedResults(barrier).length;
  const pending = getPendingAgents(barrier).length;

  const parts: string[] = [`Join barrier [${workflowId}] step ${barrier.stepIndex}: ${completed}/${total} complete`];

  if (failed > 0) parts.push(`${failed} failed`);
  if (pending > 0) parts.push(`${pending} pending`);
  parts.push(`status: ${status}`);

  return parts.join(", ");
}

/**
 * Build a notification message for a join action.
 */
export function formatJoinActionMessage(action: JoinAction, workflowId: string): string {
  switch (action.type) {
    case "waiting":
      return `[${workflowId}] Waiting for ${action.pending.length} agent(s): ${action.pending.join(", ")}. ${action.completed.length} complete so far.`;

    case "proceed":
      return `[${workflowId}] All parallel agents complete. Proceeding with aggregated output.`;

    case "partial_failure": {
      const completedNames = action.completed.map(r => r.agent).join(", ");
      const failedNames = action.failed.map(r => `${r.agent} (${r.status})`).join(", ");
      return `[${workflowId}] Partial failure — completed: ${completedNames}; failed: ${failedNames}. Aggregated output from successful agents available.`;
    }

    case "all_failed": {
      const failedNames = action.failed.map(r => `${r.agent} (${r.status})`).join(", ");
      return `[${workflowId}] All parallel agents failed: ${failedNames}.`;
    }
  }
}
