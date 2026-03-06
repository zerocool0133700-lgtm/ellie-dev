/**
 * Orchestrator — ELLIE-54 + ELLIE-58
 *
 * Executes multi-agent plans in four modes:
 *   - pipeline:    Sequential steps, output N feeds step N+1
 *   - fan-out:     Independent steps in parallel, merged via synthesis LLM call
 *   - critic-loop: Iterative producer + critic refinement (max 3 rounds)
 *   - single:      Passthrough (handled by relay, not here)
 *
 * ELLIE-524: Execution logic split into focused modules:
 *   - orchestrator-types.ts   — shared types, constants, error classes
 *   - orchestrator-costs.ts   — model cost cache and cost calculation
 *   - step-runner.ts          — unified step executor, prompt builder, skill cache
 *   - pipeline-executor.ts    — sequential pipeline mode
 *   - fanout-executor.ts      — parallel fan-out mode
 *   - critic-executor.ts      — critic-loop mode and verdict parsing
 *
 * This file is the public entry point — it re-exports the full API surface
 * so all existing importers (relay.ts, ellie-chat-handler.ts, tests, etc.)
 * continue to work without modification.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./logger.ts";
import { startRun, endRun } from "./orchestration-tracker.ts";
import { emitEvent } from "./orchestration-ledger.ts";
import { updateWorkItemOnFailure } from "./plane.ts";
import { completeWorkSession as forestCompleteSession, getAgent } from "../../ellie-forest/src/index";
import { executePipeline } from "./pipeline-executor.ts";
import { executeFanOut } from "./fanout-executor.ts";
import { executeCriticLoop } from "./critic-executor.ts";
import { _resetSkillCacheForTesting } from "./step-runner.ts";
import { _resetModelCostCacheForTesting } from "./orchestrator-costs.ts";
import type { ExecutionMode } from "./intent-classifier.ts";
import {
  type PipelineStep,
  type ArtifactStore,
  type ExecutionResult,
  type OrchestratorOptions,
  PipelineValidationError,
  MAX_PIPELINE_DEPTH,
  COST_WARN_THRESHOLD,
  MAX_COST_PER_EXECUTION,
} from "./orchestrator-types.ts";

// ── Public re-exports — all existing importers continue to work ──

export type {
  PipelineStep,
  StepResult,
  ArtifactStore,
  ExecutionResult,
  OrchestratorOptions,
} from "./orchestrator-types.ts";

export {
  PipelineStepError,
  PipelineValidationError,
  MAX_PIPELINE_DEPTH,
  MAX_PIPELINE_TIMEOUT_MS,
  MAX_PREVIOUS_OUTPUT_CHARS,
  MAX_INSTRUCTION_CHARS,
  MAX_CRITIC_ROUNDS,
  COST_WARN_THRESHOLD,
  MAX_COST_PER_EXECUTION,
  FALLBACK_MODEL_COSTS,
  STEP_TIMEOUT_LIGHT_MS,
  STEP_TIMEOUT_HEAVY_MS,
} from "./orchestrator-types.ts";

export {
  preloadModelCosts,
  estimateExecutionCost,
  getModelCosts,
  calculateStepCost,
} from "./orchestrator-costs.ts";

export { parseCriticVerdict } from "./critic-executor.ts";
export { sanitizeInstruction } from "./step-runner.ts";

// Backward compat — relay.ts currently imports executePipeline directly
export { executePipeline };

const logger = log.child("orchestrator");

// ────────────────────────────────────────────────────────────────
// Cache reset (test-only)
// ────────────────────────────────────────────────────────────────

/** Reset internal caches — test-only. */
export function _resetCachesForTesting(): void {
  _resetSkillCacheForTesting();
  _resetModelCostCacheForTesting();
}

// ────────────────────────────────────────────────────────────────
// Main Entry Point
// ────────────────────────────────────────────────────────────────

/**
 * Execute an orchestrated multi-step plan.
 * Dispatches to pipeline, fan-out, or critic-loop based on mode.
 */
export async function executeOrchestrated(
  mode: ExecutionMode,
  steps: PipelineStep[],
  originalMessage: string,
  options: OrchestratorOptions,
): Promise<ExecutionResult> {
  const effectiveSteps = steps.slice(0, MAX_PIPELINE_DEPTH);
  const orchestrationRunId = options.runId || crypto.randomUUID();
  // ELLIE-390: Ensure runId is available for heartbeat threading through steps
  if (!options.runId) options.runId = orchestrationRunId;

  if (effectiveSteps.length === 0) {
    throw new Error(`Orchestrator received empty steps array for mode "${mode}"`);
  }

  // ELLIE-520: Validate ALL agents BEFORE any state changes (tracker, events, plan creation).
  // If any agent doesn't exist, fail immediately — no orphaned plans, no Plane ticket movement.
  for (const step of effectiveSteps) {
    const agent = await getAgent(step.agent_name);
    if (!agent) {
      throw new PipelineValidationError(`Agent "${step.agent_name}" in pipeline does not exist`);
    }
  }

  // ELLIE-390: Register with tracker so watchdog monitors this run
  startRun(orchestrationRunId, effectiveSteps[0]?.agent_name || "orchestrator", undefined, undefined, {
    channel: options.channel,
    message: `${mode}: ${effectiveSteps.length} steps`,
  });

  emitEvent(orchestrationRunId, "dispatched", effectiveSteps[0]?.agent_name, null, {
    mode,
    step_count: effectiveSteps.length,
    source: "orchestrator",
  });

  // Create execution plan record
  const planId = await createExecutionPlan(options.supabase, {
    conversation_id: options.conversationId,
    mode,
    original_message: originalMessage,
    steps: effectiveSteps,
  });

  const artifacts: ArtifactStore = {
    original_message: originalMessage,
    steps: [],
    total_duration_ms: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost_usd: 0,
  };

  try {
    let result: ExecutionResult;

    switch (mode) {
      case "fan-out":
        result = await executeFanOut(effectiveSteps, originalMessage, options, artifacts);
        break;
      case "critic-loop":
        result = await executeCriticLoop(effectiveSteps, originalMessage, options, artifacts);
        break;
      case "pipeline":
      default:
        result = await executePipeline(effectiveSteps, originalMessage, options, artifacts);
        break;
    }

    result.mode = mode;
    result.planId = planId || undefined;

    // Complete execution plan
    await completeExecutionPlan(options.supabase, planId, artifacts, "completed");
    endRun(orchestrationRunId, "completed");
    emitEvent(orchestrationRunId, "completed", effectiveSteps[0]?.agent_name, null, {
      mode,
      duration_ms: artifacts.total_duration_ms,
      cost_usd: artifacts.total_cost_usd,
    });

    // Cost enforcement
    if (artifacts.total_cost_usd > MAX_COST_PER_EXECUTION) {
      logger.error("Cost limit exceeded", { cost: artifacts.total_cost_usd, limit: MAX_COST_PER_EXECUTION });
    } else if (artifacts.total_cost_usd > COST_WARN_THRESHOLD) {
      logger.warn("High cost", { cost: artifacts.total_cost_usd, mode, steps: effectiveSteps.length });
    }

    logger.info(
      `Completed ${mode} in ${artifacts.total_duration_ms}ms, ` +
      `${artifacts.total_input_tokens + artifacts.total_output_tokens} tokens, ` +
      `$${artifacts.total_cost_usd.toFixed(4)}`,
    );

    return result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    await completeExecutionPlan(options.supabase, planId, artifacts, "failed", errMsg);
    endRun(orchestrationRunId, "failed");
    emitEvent(orchestrationRunId, "failed", effectiveSteps[0]?.agent_name, null, {
      mode,
      error: errMsg,
    });

    // Roll back Plane ticket and close Forest session so they don't get stuck "In Progress"
    if (options.workItemId) {
      await updateWorkItemOnFailure(options.workItemId, errMsg).catch(() => {});
    }
    if (options.forestSessionId) {
      await forestCompleteSession(options.forestSessionId, `Pipeline failed: ${errMsg}`).catch(() => {});
    }

    throw err;
  }
}

// ────────────────────────────────────────────────────────────────
// Execution Plan Persistence
// ────────────────────────────────────────────────────────────────

async function createExecutionPlan(
  supabase: SupabaseClient | null,
  plan: {
    conversation_id?: string;
    mode: string;
    original_message: string;
    steps: PipelineStep[];
  },
): Promise<string | null> {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from("execution_plans")
      .insert({
        conversation_id: plan.conversation_id || null,
        mode: plan.mode,
        original_message: plan.original_message,
        steps: plan.steps,
        status: "running",
      })
      .select("id")
      .single();

    if (error) {
      logger.error("Failed to create execution plan", error);
      return null;
    }

    return data.id;
  } catch {
    return null;
  }
}

async function completeExecutionPlan(
  supabase: SupabaseClient | null,
  planId: string | null,
  artifacts: ArtifactStore,
  status: "completed" | "failed" | "partial",
  errorMessage?: string,
): Promise<void> {
  if (!supabase || !planId) return;

  try {
    await supabase
      .from("execution_plans")
      .update({
        steps: artifacts.steps,
        total_tokens: artifacts.total_input_tokens + artifacts.total_output_tokens,
        total_cost_usd: artifacts.total_cost_usd,
        status,
        error_message: errorMessage || null,
        completed_at: new Date().toISOString(),
      })
      .eq("id", planId);
  } catch {
    // Non-fatal
  }
}
