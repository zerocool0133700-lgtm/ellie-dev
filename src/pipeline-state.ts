/**
 * Pipeline State Persistence — ELLIE-394
 *
 * Saves intermediate pipeline results after each step so that
 * a partially-failed pipeline can be resumed from the last
 * successful step. State is persisted to disk via config-cache.
 *
 * Pipeline state lifecycle:
 *   1. Created when pipeline starts
 *   2. Updated after each successful step
 *   3. Deleted on pipeline completion or explicit abandon
 *   4. Loaded on resume attempt
 */

import { writeToDisk, readFromDisk } from "./config-cache.ts";
import { log } from "./logger.ts";
import type { PipelineStep, StepResult, ArtifactStore } from "./orchestrator.ts";

const logger = log.child("pipeline-state");

// ── Types ───────────────────────────────────────────────────

export interface PipelineCheckpoint {
  /** Unique pipeline execution ID. */
  pipelineId: string;
  /** Original user message that triggered the pipeline. */
  originalMessage: string;
  /** All planned steps. */
  steps: PipelineStep[];
  /** Index of the step that failed (or next step to execute). */
  nextStepIndex: number;
  /** Results from successfully completed steps. */
  completedSteps: StepResult[];
  /** Output from the last successful step (used as input to next step). */
  lastOutput: string | null;
  /** Running artifact totals. */
  artifacts: Pick<ArtifactStore, "total_duration_ms" | "total_input_tokens" | "total_output_tokens" | "total_cost_usd">;
  /** Channel this pipeline was initiated on. */
  channel: string;
  /** Error that caused the failure (if any). */
  failureError?: string;
  /** Step index where the failure occurred. */
  failedStepIndex?: number;
  /** Timestamp when the checkpoint was created/updated. */
  updatedAt: number;
  /** Run ID for tracking. */
  runId?: string;
}

export type FailureAction = "retry" | "skip" | "abort";

// ── Disk Key ────────────────────────────────────────────────

function cacheKey(pipelineId: string): string {
  return `pipeline-${pipelineId}`;
}

// ── Save / Load / Delete ────────────────────────────────────

/** Save pipeline checkpoint to disk (fire-and-forget). */
export function saveCheckpoint(checkpoint: PipelineCheckpoint): void {
  checkpoint.updatedAt = Date.now();
  writeToDisk(cacheKey(checkpoint.pipelineId), checkpoint);
  logger.info("Checkpoint saved", {
    pipelineId: checkpoint.pipelineId.slice(0, 8),
    nextStep: checkpoint.nextStepIndex,
    completedSteps: checkpoint.completedSteps.length,
    totalSteps: checkpoint.steps.length,
  });
}

/** Load a pipeline checkpoint from disk. Returns null if not found. */
export async function loadCheckpoint(pipelineId: string): Promise<PipelineCheckpoint | null> {
  const data = await readFromDisk<PipelineCheckpoint>(cacheKey(pipelineId));
  if (!data) return null;

  // Validate checkpoint isn't stale (>1 hour old)
  const ageMs = Date.now() - (data.updatedAt || 0);
  if (ageMs > 3_600_000) {
    logger.warn("Checkpoint too old, discarding", {
      pipelineId: pipelineId.slice(0, 8),
      ageMin: Math.round(ageMs / 60_000),
    });
    return null;
  }

  return data;
}

/** Delete a pipeline checkpoint (on completion or abandon). */
export function deleteCheckpoint(pipelineId: string): void {
  // Write empty data to effectively clear it
  writeToDisk(cacheKey(pipelineId), null);
}

// ── In-Memory Registry ──────────────────────────────────────

/** Active pipeline checkpoints — keyed by pipelineId. */
const activeCheckpoints = new Map<string, PipelineCheckpoint>();

export function getActiveCheckpoint(pipelineId: string): PipelineCheckpoint | null {
  return activeCheckpoints.get(pipelineId) || null;
}

export function setActiveCheckpoint(checkpoint: PipelineCheckpoint): void {
  activeCheckpoints.set(checkpoint.pipelineId, checkpoint);
}

export function removeActiveCheckpoint(pipelineId: string): void {
  activeCheckpoints.delete(pipelineId);
}

/** Get all active pipeline checkpoints. */
export function getAllActiveCheckpoints(): PipelineCheckpoint[] {
  return Array.from(activeCheckpoints.values());
}

// ── Resumability Check ──────────────────────────────────────

/**
 * Check if a pipeline can be resumed from a checkpoint.
 * Returns the checkpoint and number of steps remaining.
 */
export async function canResume(pipelineId: string): Promise<{
  resumable: boolean;
  checkpoint: PipelineCheckpoint | null;
  stepsRemaining: number;
  stepsCompleted: number;
}> {
  const checkpoint = getActiveCheckpoint(pipelineId) || await loadCheckpoint(pipelineId);
  if (!checkpoint) {
    return { resumable: false, checkpoint: null, stepsRemaining: 0, stepsCompleted: 0 };
  }

  const stepsRemaining = checkpoint.steps.length - checkpoint.nextStepIndex;
  return {
    resumable: stepsRemaining > 0,
    checkpoint,
    stepsRemaining,
    stepsCompleted: checkpoint.completedSteps.length,
  };
}
