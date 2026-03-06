/**
 * Workflow Conditional Router — ELLIE-596
 *
 * Adds conditional routing to workflow steps based on step outcome.
 * Parses agent output for success/failure signals, then routes to
 * the appropriate next step using on_success/on_failure targets.
 *
 * Supports loopback (e.g., critic → dev → critic) with a max iteration
 * guard to prevent infinite loops.
 *
 * Pure module — zero side effects, fully testable.
 */

import type { WorkflowDefinition, WorkflowStep, StepTarget } from "./workflow-schema.ts";

// ── Configuration ────────────────────────────────────────────────────────────

/** Default max iterations before the loopback guard fires. */
export const DEFAULT_MAX_ITERATIONS = 5;

// ── Types ────────────────────────────────────────────────────────────────────

export type StepOutcome = "success" | "failure";

export interface ConditionalRouteResult {
  outcome: StepOutcome;
  targetStep: number | "done";
  targetAgent?: string;
  targetLabel?: string;
  loopDetected: boolean;
  iterationCount: number;
}

// ── Pure: Outcome detection ──────────────────────────────────────────────────

/**
 * Success signal patterns — agent output indicates positive outcome.
 */
const SUCCESS_PATTERNS: RegExp[] = [
  /\bapproved\b/i,
  /\bship\s+it\b/i,
  /\blooks\s+good\b/i,
  /\bpassed\b/i,
  /\bsuccess(ful)?\b/i,
  /\bcomplete[d]?\b/i,
  /\bno\s+issues?\s+found\b/i,
  /\bready\s+(to|for)\b/i,
  /\bgreen\s+light\b/i,
  /\b(?:all\s+)?tests?\s+pass(?:ed|ing)?\b/i,
];

/**
 * Failure signal patterns — agent output indicates negative outcome.
 */
const FAILURE_PATTERNS: RegExp[] = [
  /\brejected\b/i,
  /\bneeds?\s+(?:more\s+)?work\b/i,
  /\bfailed\b/i,
  /\bfailure\b/i,
  /\bnot\s+ready\b/i,
  /\brework\b/i,
  /\bfix(?:es)?\s+(?:needed|required)\b/i,
  /\bblocked\b/i,
  /\bcritical\s+(?:issues?|bugs?|errors?)\b/i,
  /\bsend\s+(?:it\s+)?back\b/i,
  /\bdo\s+not\s+ship\b/i,
];

/**
 * Detect the outcome of a step from agent output text.
 *
 * Scans for failure signals first (conservative — if in doubt, it's a failure).
 * Falls back to success if success signals found.
 * Defaults to "success" if no signals detected (assume step completed normally).
 */
export function detectOutcome(agentOutput: string): StepOutcome {
  // Check failure first — failure is the more conservative default
  for (const pattern of FAILURE_PATTERNS) {
    if (pattern.test(agentOutput)) return "failure";
  }

  // Then check success
  for (const pattern of SUCCESS_PATTERNS) {
    if (pattern.test(agentOutput)) return "success";
  }

  // No signals — default to success (step completed without explicit judgment)
  return "success";
}

// ── Pure: Route resolution ───────────────────────────────────────────────────

/**
 * Resolve where a StepTarget points.
 *
 * @returns Step index or "done"
 */
export function resolveTarget(
  target: StepTarget | undefined,
  currentStep: number,
  totalSteps: number,
): number | "done" {
  if (target === undefined || target === "next") {
    const next = currentStep + 1;
    return next >= totalSteps ? "done" : next;
  }
  if (target === "done") return "done";
  // Numeric index
  if (target >= 0 && target < totalSteps) return target;
  // Out of bounds — treat as done
  return "done";
}

/**
 * Route to the next step based on outcome and step routing config.
 *
 * @param workflow - Current workflow definition
 * @param outcome - Success or failure of the current step
 * @param iterationCounts - Map of step index to iteration count (for loopback guard)
 * @param maxIterations - Max times a step can be visited before guard triggers
 * @returns Route result with target step and loop detection info
 */
export function resolveConditionalRoute(
  workflow: WorkflowDefinition,
  outcome: StepOutcome,
  iterationCounts: Map<number, number> = new Map(),
  maxIterations: number = DEFAULT_MAX_ITERATIONS,
): ConditionalRouteResult {
  const step = workflow.workflow_steps[workflow.current_step];
  const totalSteps = workflow.workflow_steps.length;

  // Determine routing target
  const target = outcome === "success" ? step.on_success : step.on_failure;
  const resolved = resolveTarget(target, workflow.current_step, totalSteps);

  if (resolved === "done") {
    return {
      outcome,
      targetStep: "done",
      loopDetected: false,
      iterationCount: 0,
    };
  }

  // Check loopback guard
  const currentCount = (iterationCounts.get(resolved) ?? 0) + 1;
  const loopDetected = currentCount >= maxIterations;

  const targetStepDef = workflow.workflow_steps[resolved];

  return {
    outcome,
    targetStep: resolved,
    targetAgent: targetStepDef?.agent,
    targetLabel: targetStepDef?.label,
    loopDetected,
    iterationCount: currentCount,
  };
}

// ── Pure: Apply route to workflow ────────────────────────────────────────────

/**
 * Apply a conditional route result to produce an updated workflow definition.
 * Returns null if the route leads to "done".
 *
 * @param workflow - Current workflow definition
 * @param route - Resolved route result
 * @param context - Context to carry forward (typically agent output summary)
 */
export function applyRoute(
  workflow: WorkflowDefinition,
  route: ConditionalRouteResult,
  context?: string,
): WorkflowDefinition | null {
  if (route.targetStep === "done") return null;

  return {
    ...workflow,
    current_step: route.targetStep,
    step_context: context ?? workflow.step_context,
  };
}

// ── Pure: Build iteration counts from workflow history ────────────────────────

/**
 * Create a fresh iteration count map.
 */
export function createIterationCounts(): Map<number, number> {
  return new Map();
}

/**
 * Increment the iteration count for a step.
 * Returns the updated map (mutates in place for efficiency).
 */
export function incrementIteration(counts: Map<number, number>, stepIndex: number): Map<number, number> {
  counts.set(stepIndex, (counts.get(stepIndex) ?? 0) + 1);
  return counts;
}
