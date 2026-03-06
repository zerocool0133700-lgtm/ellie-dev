/**
 * Workflow Chainer — ELLIE-594
 *
 * Pure logic for sequential workflow step chaining.
 * When a workflow step completes, determines the next action:
 *  - "notify": build a notification message for the coordinator
 *  - "auto": build an auto-dispatch payload for the next step
 *  - "done": workflow is complete, no further action
 *
 * Two layers:
 *  - Pure: action resolution + message building (zero deps, testable)
 *  - Integration: consumed by work-session complete handler
 */

import {
  advanceStep,
  getCurrentStep,
  isWorkflowComplete,
  type WorkflowDefinition,
  type WorkflowStep,
} from "./workflow-schema.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/** Action when a workflow step completes and there are more steps. */
export interface WorkflowNotifyAction {
  type: "notify";
  workflow: WorkflowDefinition;
  completedStep: WorkflowStep;
  nextStep: WorkflowStep;
  stepNumber: number;
  totalSteps: number;
  message: string;
}

/** Action when auto-dispatch should fire the next step. */
export interface WorkflowAutoDispatchAction {
  type: "auto";
  workflow: WorkflowDefinition;
  completedStep: WorkflowStep;
  nextStep: WorkflowStep;
  stepNumber: number;
  totalSteps: number;
  dispatchPayload: {
    agent: string;
    label: string;
    step_context: string;
    workflow_id: string;
    current_step: number;
  };
  message: string;
}

/** Action when the workflow is fully complete. */
export interface WorkflowDoneAction {
  type: "done";
  workflow: WorkflowDefinition;
  completedStep: WorkflowStep;
  totalSteps: number;
  message: string;
}

export type WorkflowChainAction =
  | WorkflowNotifyAction
  | WorkflowAutoDispatchAction
  | WorkflowDoneAction;

// ── Pure: Resolve next action ────────────────────────────────────────────────

/**
 * Determine what to do after a workflow step completes.
 *
 * @param workflow - The current workflow definition (before advancing)
 * @param completionSummary - Summary/output from the completed step
 * @param workItemId - Work item ID for message formatting
 * @returns The action to take, or null if no workflow is attached
 */
export function resolveChainAction(
  workflow: WorkflowDefinition | undefined,
  completionSummary: string,
  workItemId: string,
): WorkflowChainAction | null {
  if (!workflow) return null;

  const completedStep = getCurrentStep(workflow);
  if (!completedStep) return null;

  const totalSteps = workflow.workflow_steps.length;
  const stepNumber = workflow.current_step + 1; // 1-based for display

  // Check if this was the last step
  if (isWorkflowComplete(workflow)) {
    return {
      type: "done",
      workflow,
      completedStep,
      totalSteps,
      message: buildDoneMessage(workItemId, workflow.workflow_id, totalSteps),
    };
  }

  // Advance to next step
  const advanced = advanceStep(workflow, completionSummary);
  if (!advanced) {
    // Shouldn't happen since we checked isWorkflowComplete, but be safe
    return {
      type: "done",
      workflow,
      completedStep,
      totalSteps,
      message: buildDoneMessage(workItemId, workflow.workflow_id, totalSteps),
    };
  }

  const nextStep = getCurrentStep(advanced)!;

  if (workflow.on_complete === "auto") {
    return {
      type: "auto",
      workflow: advanced,
      completedStep,
      nextStep,
      stepNumber,
      totalSteps,
      dispatchPayload: {
        agent: nextStep.agent,
        label: nextStep.label,
        step_context: completionSummary,
        workflow_id: workflow.workflow_id,
        current_step: advanced.current_step,
      },
      message: buildAutoDispatchMessage(
        workItemId, completedStep, nextStep, stepNumber, totalSteps,
      ),
    };
  }

  // Default: notify
  return {
    type: "notify",
    workflow: advanced,
    completedStep,
    nextStep,
    stepNumber,
    totalSteps,
    message: buildNotifyMessage(
      workItemId, completedStep, nextStep, stepNumber, totalSteps,
    ),
  };
}

// ── Pure: Message builders ───────────────────────────────────────────────────

/**
 * Build the notification message for "notify" mode.
 */
export function buildNotifyMessage(
  workItemId: string,
  completedStep: WorkflowStep,
  nextStep: WorkflowStep,
  stepNumber: number,
  totalSteps: number,
): string {
  return [
    `Step ${stepNumber}/${totalSteps} done (${completedStep.agent}: ${completedStep.label}).`,
    `Next: ${nextStep.agent} — ${nextStep.label}.`,
    `[${workItemId}]`,
  ].join(" ");
}

/**
 * Build the notification message for "auto" mode.
 */
export function buildAutoDispatchMessage(
  workItemId: string,
  completedStep: WorkflowStep,
  nextStep: WorkflowStep,
  stepNumber: number,
  totalSteps: number,
): string {
  return [
    `Step ${stepNumber}/${totalSteps} done (${completedStep.agent}: ${completedStep.label}).`,
    `Auto-dispatching: ${nextStep.agent} — ${nextStep.label}.`,
    `[${workItemId}]`,
  ].join(" ");
}

/**
 * Build the completion message when all steps are done.
 */
export function buildDoneMessage(
  workItemId: string,
  workflowId: string,
  totalSteps: number,
): string {
  return `Workflow ${workflowId} complete — all ${totalSteps} steps done. [${workItemId}]`;
}

// ── Pure: Format for Telegram / Google Chat ──────────────────────────────────

/**
 * Format a chain action for Telegram (MarkdownV2-safe plain text).
 */
export function formatChainForTelegram(action: WorkflowChainAction): string {
  if (action.type === "done") {
    return `✅ ${action.message}`;
  }
  if (action.type === "auto") {
    return `⚡ ${action.message}`;
  }
  // notify
  return `🔗 ${action.message}`;
}

/**
 * Format a chain action for Google Chat (plain text).
 */
export function formatChainForGChat(action: WorkflowChainAction): string {
  if (action.type === "done") {
    return `✅ Workflow Complete\n\n${action.message}`;
  }
  if (action.type === "auto") {
    return `⚡ Auto-Dispatching Next Step\n\n${action.message}`;
  }
  // notify
  return `🔗 Workflow Step Complete\n\n${action.message}`;
}
