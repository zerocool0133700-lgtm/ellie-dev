/**
 * ELLIE-524 — Pipeline executor (sequential mode).
 *
 * Runs steps sequentially, passing output of step N to step N+1.
 * Supports ELLIE-394 checkpointing, step failure handling (retry/skip/abort),
 * cost guards, and heartbeat calls between steps.
 */

import { processMemoryIntents } from "./memory.ts";
import { extractApprovalTags } from "./approval.ts";
import { log } from "./logger.ts";
import {
  saveCheckpoint,
  deleteCheckpoint,
  setActiveCheckpoint,
  removeActiveCheckpoint,
  initCheckpointStore,
  type PipelineCheckpoint,
} from "./pipeline-state.ts";
import { withRetry } from "./dispatch-retry.ts";
import { emitEvent } from "./orchestration-ledger.ts";
import { executeStep, sanitizeInstruction } from "./step-runner.ts";
import {
  type PipelineStep,
  type OrchestratorOptions,
  type ArtifactStore,
  type ExecutionResult,
  PipelineStepError,
  MAX_PIPELINE_TIMEOUT_MS,
  MAX_COST_PER_EXECUTION,
} from "./orchestrator-types.ts";
import type { DispatchResult } from "./agent-router.ts";

const logger = log.child("orchestrator");

export async function executePipeline(
  steps: PipelineStep[],
  originalMessage: string,
  options: OrchestratorOptions,
  artifacts: ArtifactStore,
): Promise<ExecutionResult> {
  let previousOutput: string | null = null;
  let finalDispatch: DispatchResult | null = null;
  const pipelineStart = Date.now();
  const pipelineId = options.runId || crypto.randomUUID();

  // ELLIE-519: Initialize checkpoint store with Supabase client
  initCheckpointStore(options.supabase);

  // ELLIE-394: Resume from checkpoint if provided
  let startIndex = 0;
  if (options.resumeCheckpoint) {
    const cp = options.resumeCheckpoint;
    startIndex = cp.nextStepIndex;
    previousOutput = cp.lastOutput;
    artifacts.steps.push(...cp.completedSteps);
    artifacts.total_duration_ms += cp.artifacts.total_duration_ms;
    artifacts.total_input_tokens += cp.artifacts.total_input_tokens;
    artifacts.total_output_tokens += cp.artifacts.total_output_tokens;
    artifacts.total_cost_usd += cp.artifacts.total_cost_usd;
    logger.info("Resuming pipeline from checkpoint", {
      pipelineId: pipelineId.slice(0, 8),
      startIndex,
      completedSteps: cp.completedSteps.length,
    });
  }

  // ELLIE-394: Create initial checkpoint
  const checkpoint: PipelineCheckpoint = {
    pipelineId,
    originalMessage,
    steps,
    nextStepIndex: startIndex,
    completedSteps: [...artifacts.steps],
    lastOutput: previousOutput,
    artifacts: {
      total_duration_ms: artifacts.total_duration_ms,
      total_input_tokens: artifacts.total_input_tokens,
      total_output_tokens: artifacts.total_output_tokens,
      total_cost_usd: artifacts.total_cost_usd,
    },
    channel: options.channel,
    runId: options.runId,
    updatedAt: Date.now(),
  };
  setActiveCheckpoint(checkpoint);

  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];
    const isLast = i === steps.length - 1;

    // Check total pipeline timeout
    if (Date.now() - pipelineStart > MAX_PIPELINE_TIMEOUT_MS) {
      // ELLIE-394: Save checkpoint before throwing so pipeline can be resumed
      checkpoint.nextStepIndex = i;
      checkpoint.failureError = "Pipeline timeout";
      checkpoint.failedStepIndex = i;
      await saveCheckpoint(checkpoint);
      logger.error("Pipeline timeout", { completedSteps: i, elapsed_ms: Date.now() - pipelineStart });
      throw new PipelineStepError(i, step, "timeout", previousOutput);
    }

    console.log(`[orchestrator] Pipeline ${i + 1}/${steps.length}: ${step.agent_name}/${step.skill_name || "none"} — "${sanitizeInstruction(step.instruction).substring(0, 60)}"`);

    let stepResult: import("./orchestrator-types.ts").StepResult;
    let dispatch: DispatchResult;

    try {
      const result = await executeStep(
        step, i, steps.length, originalMessage, previousOutput, options,
        isLast ? "final" : "intermediate",
      );
      stepResult = result.stepResult;
      dispatch = result.dispatch;
    } catch (stepError) {
      // ELLIE-394: Step failure — save checkpoint and consult failure handler
      checkpoint.nextStepIndex = i;
      checkpoint.failureError = stepError instanceof Error ? stepError.message : String(stepError);
      checkpoint.failedStepIndex = i;
      await saveCheckpoint(checkpoint);

      const action = options.onStepFailure
        ? await options.onStepFailure(step, i, stepError instanceof Error ? stepError : new Error(String(stepError)))
        : "abort";

      if (action === "retry") {
        // ELLIE-394 + ELLIE-392: Use retry with backoff
        logger.info("Step failure — retrying", { step: i, agent: step.agent_name });
        const retryResult = await withRetry(
          () => executeStep(step, i, steps.length, originalMessage, previousOutput, options, isLast ? "final" : "intermediate"),
          { runId: options.runId, agentType: step.agent_name, maxRetries: 2 },
        );
        if (!retryResult.success || !retryResult.result) {
          checkpoint.failureError = `Step retry exhausted: ${retryResult.error?.message}`;
          await saveCheckpoint(checkpoint);
          throw retryResult.error || new PipelineStepError(i, step, "claude_error", previousOutput);
        }
        stepResult = retryResult.result.stepResult;
        dispatch = retryResult.result.dispatch;
      } else if (action === "skip") {
        // ELLIE-394: Skip this step — carry forward previous output
        logger.warn("Step failure — skipping", { step: i, agent: step.agent_name });
        emitEvent(options.runId || pipelineId, "progress", step.agent_name, null, {
          step: i,
          action: "skipped",
          error: checkpoint.failureError?.slice(0, 200),
        });
        continue;
      } else {
        // abort — rethrow
        throw stepError;
      }
    }

    finalDispatch = dispatch;
    artifacts.steps.push(stepResult);
    artifacts.total_duration_ms += stepResult.duration_ms;
    artifacts.total_input_tokens += stepResult.input_tokens;
    artifacts.total_output_tokens += stepResult.output_tokens;
    artifacts.total_cost_usd += stepResult.cost_usd;

    // Cost guard — abort if running total exceeds hard limit
    if (artifacts.total_cost_usd > MAX_COST_PER_EXECUTION) {
      checkpoint.nextStepIndex = i + 1;
      checkpoint.failureError = "Cost limit exceeded";
      await saveCheckpoint(checkpoint);
      logger.error("Pipeline aborted: cost exceeds limit", { cost: artifacts.total_cost_usd, limit: MAX_COST_PER_EXECUTION });
      throw new PipelineStepError(i, step, "cost_exceeded", previousOutput || stepResult.output);
    }

    // Clean intermediate output for next step
    if (!isLast) {
      let cleanedOutput = await processMemoryIntents(options.supabase, stepResult.output, step.agent_name);
      const { cleanedText } = extractApprovalTags(cleanedOutput);
      previousOutput = cleanedText;
    } else {
      previousOutput = stepResult.output;
    }

    // ELLIE-394: Update checkpoint after successful step
    checkpoint.nextStepIndex = i + 1;
    checkpoint.completedSteps = [...artifacts.steps];
    checkpoint.lastOutput = previousOutput;
    checkpoint.artifacts = {
      total_duration_ms: artifacts.total_duration_ms,
      total_input_tokens: artifacts.total_input_tokens,
      total_output_tokens: artifacts.total_output_tokens,
      total_cost_usd: artifacts.total_cost_usd,
    };
    checkpoint.failureError = undefined;
    checkpoint.failedStepIndex = undefined;
    await saveCheckpoint(checkpoint);

    // Send heartbeat between steps
    if (!isLast && options.onHeartbeat) {
      options.onHeartbeat();
    }
  }

  // ELLIE-394: Pipeline completed — clean up checkpoint
  removeActiveCheckpoint(pipelineId);
  await deleteCheckpoint(pipelineId);

  if (!finalDispatch) {
    throw new PipelineStepError(
      steps.length - 1, steps[steps.length - 1] || steps[0],
      "dispatch_failed", previousOutput,
    );
  }

  return {
    finalResponse: previousOutput || "",
    artifacts,
    stepResults: artifacts.steps,
    finalDispatch,
    mode: "pipeline",
  };
}
