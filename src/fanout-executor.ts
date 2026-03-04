/**
 * ELLIE-524 — Fan-out executor (parallel mode).
 *
 * Dispatches all steps in parallel, collects successful results, then
 * synthesises them into a single response via a light LLM call.
 */

import { log } from "./logger.ts";
import { executeStep, callLightSkill } from "./step-runner.ts";
import { calculateStepCost } from "./orchestrator-costs.ts";
import {
  type PipelineStep,
  type OrchestratorOptions,
  type ArtifactStore,
  type ExecutionResult,
  PipelineStepError,
  MAX_PREVIOUS_OUTPUT_CHARS,
} from "./orchestrator-types.ts";
import type { DispatchResult } from "./agent-router.ts";

const logger = log.child("orchestrator");

export async function executeFanOut(
  steps: PipelineStep[],
  originalMessage: string,
  options: OrchestratorOptions,
  artifacts: ArtifactStore,
): Promise<ExecutionResult> {
  console.log(`[orchestrator] Fan-out: ${steps.length} parallel steps`);

  // Run all steps in parallel — track original index for correct step mapping
  const results = await Promise.all(
    steps.map(async (step, i) => {
      try {
        const { stepResult, dispatch } = await executeStep(
          step, i, steps.length, originalMessage, null, options, "parallel",
        );
        return { stepIndex: i, stepResult, dispatch, error: null };
      } catch (err) {
        logger.error("Fan-out step failed", { step: i }, err);
        return {
          stepIndex: i,
          stepResult: null,
          dispatch: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  // Collect successful results
  const successfulResults = results.filter((r) => r.stepResult !== null);
  const failedCount = results.length - successfulResults.length;

  if (successfulResults.length === 0) {
    throw new PipelineStepError(0, steps[0], "claude_error", null);
  }

  // Record all successful step results — use first step's dispatch as canonical
  let finalDispatch: DispatchResult | null = null;
  for (const r of successfulResults) {
    artifacts.steps.push(r.stepResult!);
    artifacts.total_duration_ms = Math.max(artifacts.total_duration_ms, r.stepResult!.duration_ms);
    artifacts.total_input_tokens += r.stepResult!.input_tokens;
    artifacts.total_output_tokens += r.stepResult!.output_tokens;
    artifacts.total_cost_usd += r.stepResult!.cost_usd;
    if (r.dispatch && !finalDispatch) finalDispatch = r.dispatch;
  }

  // Synthesize results via LLM — use tracked stepIndex for correct mapping
  const stepOutputs = successfulResults.map((r) => {
    const step = steps[r.stepIndex];
    return `[${step.agent_name}/${step.skill_name || "none"} — ${step.instruction}]:\n${r.stepResult!.output}`;
  }).join("\n\n---\n\n");

  const failureNote = failedCount > 0
    ? `\n\nNote: ${failedCount} of ${steps.length} tasks failed.`
    : "";

  const synthesisPrompt =
    `Multiple specialists worked on different parts of this request in parallel.\n` +
    `Original request: "${originalMessage}"\n\n` +
    `Results from each specialist:\n\n${stepOutputs}${failureNote}\n\n` +
    `Synthesize these into a single, coherent response for the user. ` +
    `Don't mention the specialists or parallel execution. Just provide the combined answer naturally.`;

  const synthesisStart = Date.now();
  let synthesisText: string;

  if (options.anthropicClient) {
    const result = await callLightSkill(synthesisPrompt, options);
    synthesisText = result.text;
    artifacts.total_input_tokens += result.input_tokens;
    artifacts.total_output_tokens += result.output_tokens;
    const cost = await calculateStepCost(options.supabase, "claude-haiku-4-5-20251001", result.input_tokens, result.output_tokens);
    artifacts.total_cost_usd += cost;
  } else {
    synthesisText = await options.callClaudeFn(synthesisPrompt, { resume: false });
  }

  artifacts.total_duration_ms += Date.now() - synthesisStart;

  if (options.onHeartbeat) options.onHeartbeat();

  if (!finalDispatch) {
    throw new PipelineStepError(0, steps[0], "dispatch_failed", null);
  }

  return {
    finalResponse: synthesisText,
    artifacts,
    stepResults: artifacts.steps,
    finalDispatch,
    mode: "fan-out",
  };
}
