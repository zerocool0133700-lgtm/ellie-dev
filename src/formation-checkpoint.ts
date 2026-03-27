/**
 * Formation Checkpoint & Resume — ELLIE-1081
 * Save state after each formation step, resume from last checkpoint on failure.
 */

import { log } from "./logger.ts";

const logger = log.child("formation:checkpoint");

export interface FormationCheckpoint {
  formationId: string;
  stepIndex: number;
  stepId: string;
  status: "completed" | "failed" | "pending";
  outputs: Record<string, unknown>;
  timestamp: string;
}

export interface FormationState {
  formationId: string;
  workflowName: string;
  totalSteps: number;
  checkpoints: FormationCheckpoint[];
  status: "running" | "completed" | "failed" | "paused";
  startedAt: string;
  lastCheckpointAt: string;
}

// In-memory checkpoint store (persist to Forest for durability)
const states = new Map<string, FormationState>();

/**
 * Initialize formation state for a new run.
 */
export function initFormation(opts: {
  formationId: string;
  workflowName: string;
  totalSteps: number;
}): FormationState {
  const state: FormationState = {
    formationId: opts.formationId,
    workflowName: opts.workflowName,
    totalSteps: opts.totalSteps,
    checkpoints: [],
    status: "running",
    startedAt: new Date().toISOString(),
    lastCheckpointAt: new Date().toISOString(),
  };
  states.set(opts.formationId, state);
  logger.info("Formation initialized", { formationId: opts.formationId, totalSteps: opts.totalSteps });
  return state;
}

/**
 * Save a checkpoint after a step completes.
 */
export function saveCheckpoint(
  formationId: string,
  checkpoint: Omit<FormationCheckpoint, "formationId" | "timestamp">
): void {
  const state = states.get(formationId);
  if (!state) {
    logger.warn("No formation state found for checkpoint", { formationId });
    return;
  }

  const cp: FormationCheckpoint = {
    ...checkpoint,
    formationId,
    timestamp: new Date().toISOString(),
  };
  state.checkpoints.push(cp);
  state.lastCheckpointAt = cp.timestamp;

  if (checkpoint.status === "failed") {
    state.status = "failed";
  } else if (state.checkpoints.filter(c => c.status === "completed").length >= state.totalSteps) {
    state.status = "completed";
  }

  logger.info("Checkpoint saved", { formationId, stepId: checkpoint.stepId, status: checkpoint.status });
}

/**
 * Get the last successful checkpoint for resume.
 */
export function getResumePoint(formationId: string): {
  lastCompletedStep: number;
  completedOutputs: Map<string, Record<string, unknown>>;
} | null {
  const state = states.get(formationId);
  if (!state) return null;

  const completed = state.checkpoints.filter(c => c.status === "completed");
  if (completed.length === 0) return null;

  const outputs = new Map<string, Record<string, unknown>>();
  let lastStep = -1;
  for (const cp of completed) {
    outputs.set(cp.stepId, cp.outputs);
    if (cp.stepIndex > lastStep) lastStep = cp.stepIndex;
  }

  return { lastCompletedStep: lastStep, completedOutputs: outputs };
}

/**
 * Check if a formation can be resumed.
 */
export function canResume(formationId: string): boolean {
  const state = states.get(formationId);
  if (!state) return false;
  return state.status === "failed" || state.status === "paused";
}

/**
 * Get formation state.
 */
export function getFormationState(formationId: string): FormationState | null {
  return states.get(formationId) ?? null;
}

/**
 * List all formations with their status.
 */
export function listFormations(): FormationState[] {
  return Array.from(states.values());
}

/** Reset for testing */
export function _resetForTesting(): void {
  states.clear();
}
