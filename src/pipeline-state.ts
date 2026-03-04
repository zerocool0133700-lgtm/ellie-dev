/**
 * Pipeline State Persistence — ELLIE-394 + ELLIE-519
 *
 * Saves intermediate pipeline results after each step so that
 * a partially-failed pipeline can be resumed from the last
 * successful step.
 *
 * ELLIE-519: DB primary (Supabase), disk fallback on DB error.
 * All errors are logged — no silent failures.
 *
 * Pipeline state lifecycle:
 *   1. Created when pipeline starts
 *   2. Updated after each successful step
 *   3. Deleted on pipeline completion or explicit abandon
 *   4. Loaded on resume attempt (checks DB first, then disk)
 */

import { writeFile, readFile, mkdir, unlink } from "fs/promises";
import { join } from "path";
import type { SupabaseClient } from "@supabase/supabase-js";
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

// ── Supabase Client ─────────────────────────────────────────

let _supabase: SupabaseClient | null = null;

/** Initialize the checkpoint store with a Supabase client. Call once at startup. */
export function initCheckpointStore(client: SupabaseClient | null): void {
  _supabase = client;
}

/** Get the current Supabase client (for testing). */
export function _getSupabaseClient(): SupabaseClient | null {
  return _supabase;
}

// ── Disk Paths ──────────────────────────────────────────────

const CACHE_DIR = join(process.cwd(), ".cache");

function diskPath(pipelineId: string): string {
  return join(CACHE_DIR, `pipeline-${pipelineId}.json`);
}

async function ensureCacheDir(): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
  } catch {}
}

// ── DB Table ────────────────────────────────────────────────

const TABLE = "pipeline_checkpoints";

// ── Save ────────────────────────────────────────────────────

/**
 * Save pipeline checkpoint — DB primary, disk fallback.
 * Errors are always logged. Never throws (checkpoint failure shouldn't kill the pipeline).
 */
export async function saveCheckpoint(checkpoint: PipelineCheckpoint): Promise<void> {
  checkpoint.updatedAt = Date.now();

  const logCtx = {
    pipelineId: checkpoint.pipelineId.slice(0, 8),
    nextStep: checkpoint.nextStepIndex,
    completedSteps: checkpoint.completedSteps.length,
    totalSteps: checkpoint.steps.length,
  };

  // DB primary
  if (_supabase) {
    try {
      const { error } = await _supabase
        .from(TABLE)
        .upsert({
          pipeline_id: checkpoint.pipelineId,
          checkpoint_data: checkpoint,
          updated_at: new Date().toISOString(),
        });

      if (error) throw error;

      logger.info("Checkpoint saved to DB", logCtx);
      return;
    } catch (err) {
      logger.warn("DB checkpoint save failed, falling back to disk", {
        ...logCtx,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Disk fallback
  try {
    await ensureCacheDir();
    await writeFile(diskPath(checkpoint.pipelineId), JSON.stringify(checkpoint), "utf-8");
    logger.info("Checkpoint saved to disk (fallback)", logCtx);
  } catch (diskErr) {
    logger.error("Checkpoint save failed — both DB and disk", {
      ...logCtx,
      error: diskErr instanceof Error ? diskErr.message : String(diskErr),
    });
  }
}

// ── Load ────────────────────────────────────────────────────

/** Max checkpoint age before it's considered stale. */
const MAX_CHECKPOINT_AGE_MS = 3_600_000; // 1 hour

/**
 * Load a pipeline checkpoint — checks DB first, then disk.
 * Returns null if not found or stale.
 */
export async function loadCheckpoint(pipelineId: string): Promise<PipelineCheckpoint | null> {
  // DB first
  if (_supabase) {
    try {
      const { data, error } = await _supabase
        .from(TABLE)
        .select("checkpoint_data")
        .eq("pipeline_id", pipelineId)
        .single();

      if (!error && data?.checkpoint_data) {
        const cp = data.checkpoint_data as PipelineCheckpoint;
        const ageMs = Date.now() - (cp.updatedAt || 0);

        if (ageMs > MAX_CHECKPOINT_AGE_MS) {
          logger.warn("DB checkpoint too old, discarding", {
            pipelineId: pipelineId.slice(0, 8),
            ageMin: Math.round(ageMs / 60_000),
          });
          // Clean up stale row
          await _supabase.from(TABLE).delete().eq("pipeline_id", pipelineId).catch(() => {});
          return null;
        }

        logger.info("Checkpoint loaded from DB", { pipelineId: pipelineId.slice(0, 8) });
        return cp;
      }
    } catch (err) {
      logger.warn("DB checkpoint load failed, trying disk", {
        pipelineId: pipelineId.slice(0, 8),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Disk fallback
  try {
    const raw = await readFile(diskPath(pipelineId), "utf-8");
    const data = JSON.parse(raw) as PipelineCheckpoint;

    if (!data) return null;

    const ageMs = Date.now() - (data.updatedAt || 0);
    if (ageMs > MAX_CHECKPOINT_AGE_MS) {
      logger.warn("Disk checkpoint too old, discarding", {
        pipelineId: pipelineId.slice(0, 8),
        ageMin: Math.round(ageMs / 60_000),
      });
      return null;
    }

    logger.info("Checkpoint loaded from disk (fallback)", { pipelineId: pipelineId.slice(0, 8) });
    return data;
  } catch {
    return null;
  }
}

// ── Delete ──────────────────────────────────────────────────

/**
 * Delete a pipeline checkpoint from both DB and disk.
 * Best-effort — errors are logged but don't propagate.
 */
export async function deleteCheckpoint(pipelineId: string): Promise<void> {
  // DB
  if (_supabase) {
    try {
      const { error } = await _supabase
        .from(TABLE)
        .delete()
        .eq("pipeline_id", pipelineId);

      if (error) {
        logger.warn("DB checkpoint delete failed", {
          pipelineId: pipelineId.slice(0, 8),
          error: error.message,
        });
      }
    } catch (err) {
      logger.warn("DB checkpoint delete error", {
        pipelineId: pipelineId.slice(0, 8),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Disk
  try {
    await unlink(diskPath(pipelineId));
  } catch {
    // File might not exist — that's fine
  }
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

/** Clear all active checkpoints (test-only). */
export function _clearActiveCheckpoints(): void {
  activeCheckpoints.clear();
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
