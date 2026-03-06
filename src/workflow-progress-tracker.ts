/**
 * Workflow Progress Tracker — ELLIE-595
 *
 * Tracks active workflow state and builds a prompt section for the
 * coordinator agent showing which steps are done, active, and pending.
 *
 * Uses the same cache pattern as pending-commitments-prompt:
 *  - Module-level cache set before buildPrompt
 *  - Pure builder produces the prompt section
 *  - Test injection bypasses the store
 *
 * Integrates with the commitment ledger conceptually — workflows are
 * multi-step commitments tracked at the workflow level rather than
 * individual commitment level.
 */

import {
  getCurrentStep,
  getCompletedSteps,
  getRemainingSteps,
  isWorkflowComplete,
  type WorkflowDefinition,
  type WorkflowStep,
} from "./workflow-schema.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type StepStatus = "done" | "active" | "pending" | "failed";

export interface TrackedWorkflow {
  workItemId: string;
  workflow: WorkflowDefinition;
  stepStatuses: StepStatus[];
}

// ── In-memory store ──────────────────────────────────────────────────────────

const _activeWorkflows = new Map<string, TrackedWorkflow>();

/**
 * Register or update a workflow for tracking.
 * Called when a work session starts with a workflow definition.
 */
export function trackWorkflow(workItemId: string, workflow: WorkflowDefinition): TrackedWorkflow {
  const stepStatuses: StepStatus[] = workflow.workflow_steps.map((_, i) => {
    if (i < workflow.current_step) return "done";
    if (i === workflow.current_step) return "active";
    return "pending";
  });

  const tracked: TrackedWorkflow = { workItemId, workflow, stepStatuses };
  _activeWorkflows.set(workItemId, tracked);
  return tracked;
}

/**
 * Mark a step as done and advance the active step.
 * Returns the updated tracked workflow, or null if not found.
 */
export function markStepDone(workItemId: string): TrackedWorkflow | null {
  const tracked = _activeWorkflows.get(workItemId);
  if (!tracked) return null;

  const { workflow } = tracked;
  const newStatuses = [...tracked.stepStatuses];
  newStatuses[workflow.current_step] = "done";

  const nextStep = workflow.current_step + 1;
  if (nextStep < workflow.workflow_steps.length) {
    newStatuses[nextStep] = "active";
  }

  const updated: TrackedWorkflow = {
    ...tracked,
    workflow: { ...workflow, current_step: nextStep },
    stepStatuses: newStatuses,
  };
  _activeWorkflows.set(workItemId, updated);
  return updated;
}

/**
 * Mark the current step as failed.
 * Returns the updated tracked workflow, or null if not found.
 */
export function markStepFailed(workItemId: string): TrackedWorkflow | null {
  const tracked = _activeWorkflows.get(workItemId);
  if (!tracked) return null;

  const newStatuses = [...tracked.stepStatuses];
  newStatuses[tracked.workflow.current_step] = "failed";

  const updated: TrackedWorkflow = { ...tracked, stepStatuses: newStatuses };
  _activeWorkflows.set(workItemId, updated);
  return updated;
}

/**
 * Remove a workflow from tracking (e.g., workflow complete or cancelled).
 */
export function untrackWorkflow(workItemId: string): boolean {
  return _activeWorkflows.delete(workItemId);
}

/**
 * Get a tracked workflow by work item ID.
 */
export function getTrackedWorkflow(workItemId: string): TrackedWorkflow | null {
  return _activeWorkflows.get(workItemId) ?? null;
}

/**
 * List all active tracked workflows.
 */
export function listTrackedWorkflows(): TrackedWorkflow[] {
  return [..._activeWorkflows.values()];
}

/** Reset store — for testing only. */
export function _resetTrackerForTesting(): void {
  _activeWorkflows.clear();
}

// ── Cache for prompt injection ───────────────────────────────────────────────

let _testWorkflows: TrackedWorkflow[] | null = null;

/** Inject workflows for testing — bypasses the store. */
export function _injectWorkflowsForTesting(workflows: TrackedWorkflow[] | null): void {
  _testWorkflows = workflows;
}

// ── Pure: Prompt section builder ─────────────────────────────────────────────

const STATUS_ICONS: Record<StepStatus, string> = {
  done: "[done]",
  active: "[active]",
  pending: "[pending]",
  failed: "[FAILED]",
};

/**
 * Format a single step line for the prompt.
 */
export function formatStepLine(step: WorkflowStep, index: number, status: StepStatus): string {
  const num = index + 1;
  const icon = STATUS_ICONS[status];
  if (status === "failed") {
    return `  ${num}. **${icon}** ${step.agent}: ${step.label}`;
  }
  if (status === "active") {
    return `  ${num}. **${icon}** ${step.agent}: ${step.label}`;
  }
  return `  ${num}. ${icon} ${step.agent}: ${step.label}`;
}

/**
 * Build a summary line for a tracked workflow.
 * e.g., "Workflow wf-1 (ELLIE-583): step 2/3 (dev) in progress. Completed: critic. Next: ops."
 */
export function buildWorkflowSummary(tracked: TrackedWorkflow): string {
  const { workflow, workItemId, stepStatuses } = tracked;
  const total = workflow.workflow_steps.length;

  const activeIdx = stepStatuses.indexOf("active");
  const activeStep = activeIdx >= 0 ? workflow.workflow_steps[activeIdx] : null;
  const stepNum = activeIdx >= 0 ? activeIdx + 1 : total;

  const completedSteps = workflow.workflow_steps
    .filter((_, i) => stepStatuses[i] === "done")
    .map(s => s.agent);

  const failedSteps = workflow.workflow_steps
    .filter((_, i) => stepStatuses[i] === "failed")
    .map(s => s.agent);

  const pendingSteps = workflow.workflow_steps
    .filter((_, i) => stepStatuses[i] === "pending")
    .map(s => s.agent);

  const parts: string[] = [];

  if (activeStep) {
    parts.push(`step ${stepNum}/${total} (${activeStep.agent}) in progress`);
  } else if (failedSteps.length > 0) {
    parts.push(`step ${stepNum}/${total} failed`);
  } else {
    parts.push(`all ${total} steps complete`);
  }

  if (completedSteps.length > 0) {
    parts.push(`Completed: ${completedSteps.join(", ")}`);
  }
  if (failedSteps.length > 0) {
    parts.push(`Failed: ${failedSteps.join(", ")}`);
  }
  if (pendingSteps.length > 0) {
    parts.push(`Next: ${pendingSteps.join(", ")}`);
  }

  return `Workflow ${workflow.workflow_id} [${workItemId}]: ${parts.join(". ")}.`;
}

/**
 * Build the full prompt section for active workflows.
 * Returns null if no active workflows exist.
 */
export function buildWorkflowProgressSection(workflows: TrackedWorkflow[]): string | null {
  if (workflows.length === 0) return null;

  const lines: string[] = [];
  lines.push(`\nACTIVE WORKFLOWS (${workflows.length}):`);

  for (const tracked of workflows) {
    lines.push(buildWorkflowSummary(tracked));
    for (let i = 0; i < tracked.workflow.workflow_steps.length; i++) {
      lines.push(formatStepLine(
        tracked.workflow.workflow_steps[i],
        i,
        tracked.stepStatuses[i],
      ));
    }
  }

  lines.push("Track workflow progress. Dispatch next steps when ready.");

  return lines.join("\n");
}

/**
 * Get the workflow progress section for the current prompt.
 * Called by buildPrompt — returns null if no active workflows.
 */
export function getWorkflowProgressForPrompt(): string | null {
  const workflows = _testWorkflows !== null ? _testWorkflows : listTrackedWorkflows();
  return buildWorkflowProgressSection(workflows);
}
