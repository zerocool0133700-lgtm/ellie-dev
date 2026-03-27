/**
 * Formation Checkpoint & Resume — ELLIE-1081
 * Save state after each formation step, resume from last checkpoint on failure.
 */

import { log } from "./logger.ts";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

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

// In-memory checkpoint store (persist to disk for durability)
const states = new Map<string, FormationState>();

const CHECKPOINT_DIR = join(import.meta.dir, "..", ".checkpoints");

async function persistToDisk(formationId: string, state: FormationState): Promise<void> {
  try {
    await mkdir(CHECKPOINT_DIR, { recursive: true });
    await writeFile(
      join(CHECKPOINT_DIR, `${formationId}.json`),
      JSON.stringify(state, null, 2)
    );
  } catch {}
}

async function loadFromDisk(formationId: string): Promise<FormationState | null> {
  try {
    const data = await readFile(join(CHECKPOINT_DIR, `${formationId}.json`), "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

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

  // Persist to disk (non-blocking, non-fatal)
  persistToDisk(formationId, state).catch(() => {});
}

/**
 * Get the last successful checkpoint for resume.
 */
export async function getResumePoint(formationId: string): Promise<{
  lastCompletedStep: number;
  completedOutputs: Map<string, Record<string, unknown>>;
} | null> {
  let state = states.get(formationId);
  if (!state) {
    state = await loadFromDisk(formationId) ?? undefined;
    if (state) states.set(formationId, state); // Re-hydrate in memory
  }
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
export async function canResume(formationId: string): Promise<boolean> {
  const state = await getFormationState(formationId);
  if (!state) return false;
  return state.status === "failed" || state.status === "paused";
}

/**
 * Get formation state.
 */
export async function getFormationState(formationId: string): Promise<FormationState | null> {
  let state = states.get(formationId) ?? null;
  if (!state) {
    state = await loadFromDisk(formationId);
    if (state) states.set(formationId, state); // Re-hydrate in memory
  }
  return state;
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
