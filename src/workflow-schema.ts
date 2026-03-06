/**
 * Workflow Step Schema — ELLIE-593
 *
 * Defines the schema for multi-step workflow definitions that can be
 * attached to work-session records. All fields are optional — existing
 * single-dispatch sessions are unaffected.
 *
 * Two layers:
 *  - Pure: types, validation, step navigation (zero deps, testable)
 *  - Integration: consumed by work-session API handlers
 */

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Routing target for conditional branching (ELLIE-596).
 * - number: jump to step at that index
 * - "next": advance to next sequential step (default)
 * - "done": workflow is complete
 */
export type StepTarget = number | "next" | "done";

/** A single step in a workflow. */
export interface WorkflowStep {
  agent: string;
  label: string;
  /** Where to go on success (default: "next") — ELLIE-596 */
  on_success?: StepTarget;
  /** Where to go on failure (default: "next") — ELLIE-596 */
  on_failure?: StepTarget;
}

/** What happens when a step completes. */
export type OnComplete = "auto" | "notify";

/** Full workflow definition attached to a work session. */
export interface WorkflowDefinition {
  workflow_id: string;
  workflow_steps: WorkflowStep[];
  current_step: number;
  on_complete: OnComplete;
  step_context?: string;
}

/** The workflow fields as they arrive in the API request (all optional). */
export interface WorkflowInput {
  workflow_id?: string;
  workflow_steps?: unknown[];
  current_step?: number;
  on_complete?: string;
  step_context?: string;
}

// ── Validation ───────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  definition?: WorkflowDefinition;
}

/**
 * Validate a single workflow step.
 * Returns an error message or null if valid.
 */
export function validateStep(step: unknown, index: number): string | null {
  if (typeof step !== "object" || step === null) {
    return `workflow_steps[${index}]: must be an object`;
  }
  const s = step as Record<string, unknown>;
  if (typeof s.agent !== "string" || s.agent.trim() === "") {
    return `workflow_steps[${index}].agent: must be a non-empty string`;
  }
  if (typeof s.label !== "string" || s.label.trim() === "") {
    return `workflow_steps[${index}].label: must be a non-empty string`;
  }
  return null;
}

/**
 * Validate workflow input from an API request.
 *
 * Returns { valid: true, definition } on success, or { valid: false, errors } on failure.
 * Returns { valid: true } with no definition if no workflow fields are present (no-op).
 */
export function validateWorkflowInput(input: WorkflowInput): ValidationResult {
  // If no workflow fields are present at all, that's fine — single dispatch
  const hasAnyField =
    input.workflow_id !== undefined ||
    input.workflow_steps !== undefined ||
    input.current_step !== undefined ||
    input.on_complete !== undefined ||
    input.step_context !== undefined;

  if (!hasAnyField) {
    return { valid: true, errors: [] };
  }

  const errors: string[] = [];

  // workflow_id is required when any workflow field is present
  if (typeof input.workflow_id !== "string" || input.workflow_id.trim() === "") {
    errors.push("workflow_id: required when workflow fields are present");
  }

  // workflow_steps is required and must be a non-empty array
  if (!Array.isArray(input.workflow_steps)) {
    errors.push("workflow_steps: must be an array");
  } else if (input.workflow_steps.length === 0) {
    errors.push("workflow_steps: must have at least one step");
  } else {
    for (let i = 0; i < input.workflow_steps.length; i++) {
      const err = validateStep(input.workflow_steps[i], i);
      if (err) errors.push(err);
    }
  }

  // current_step defaults to 0
  const currentStep = input.current_step ?? 0;
  if (typeof currentStep !== "number" || !Number.isInteger(currentStep) || currentStep < 0) {
    errors.push("current_step: must be a non-negative integer");
  } else if (Array.isArray(input.workflow_steps) && input.workflow_steps.length > 0 && currentStep >= input.workflow_steps.length) {
    errors.push(`current_step: ${currentStep} is out of bounds (${input.workflow_steps.length} steps)`);
  }

  // on_complete defaults to "notify"
  const onComplete = input.on_complete ?? "notify";
  if (onComplete !== "auto" && onComplete !== "notify") {
    errors.push(`on_complete: must be "auto" or "notify", got "${onComplete}"`);
  }

  // step_context is optional, but must be a string if present
  if (input.step_context !== undefined && typeof input.step_context !== "string") {
    errors.push("step_context: must be a string");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    definition: {
      workflow_id: input.workflow_id as string,
      workflow_steps: (input.workflow_steps as Record<string, unknown>[]).map(s => ({
        agent: (s.agent as string).trim(),
        label: (s.label as string).trim(),
      })),
      current_step: currentStep,
      on_complete: onComplete as OnComplete,
      step_context: input.step_context,
    },
  };
}

// ── Step navigation helpers ──────────────────────────────────────────────────

/**
 * Get the current step from a workflow definition.
 * Returns null if the workflow is complete (current_step past end).
 */
export function getCurrentStep(def: WorkflowDefinition): WorkflowStep | null {
  if (def.current_step >= def.workflow_steps.length) return null;
  return def.workflow_steps[def.current_step];
}

/**
 * Advance to the next step, optionally carrying context forward.
 * Returns a new WorkflowDefinition (immutable) or null if already at the end.
 */
export function advanceStep(def: WorkflowDefinition, context?: string): WorkflowDefinition | null {
  const nextStep = def.current_step + 1;
  if (nextStep >= def.workflow_steps.length) return null;

  return {
    ...def,
    current_step: nextStep,
    step_context: context ?? def.step_context,
  };
}

/**
 * Check if the workflow is complete (all steps done).
 */
export function isWorkflowComplete(def: WorkflowDefinition): boolean {
  return def.current_step >= def.workflow_steps.length - 1;
}

/**
 * Get remaining steps (excluding current).
 */
export function getRemainingSteps(def: WorkflowDefinition): WorkflowStep[] {
  return def.workflow_steps.slice(def.current_step + 1);
}

/**
 * Get completed steps (before current).
 */
export function getCompletedSteps(def: WorkflowDefinition): WorkflowStep[] {
  return def.workflow_steps.slice(0, def.current_step);
}
