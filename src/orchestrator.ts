/**
 * Orchestrator — ELLIE-54 + ELLIE-58
 *
 * Executes multi-agent plans in four modes:
 *   - pipeline:    Sequential steps, output N feeds step N+1
 *   - fan-out:     Independent steps in parallel, merged via synthesis LLM call
 *   - critic-loop: Iterative producer + critic refinement (max 3 rounds)
 *   - single:      Passthrough (handled by relay, not here)
 *
 * Light skills use direct Anthropic API (Haiku, ~300ms, no tools).
 * Heavy skills use CLI spawn (full tool access, variable duration).
 *
 * Receives relay functions (buildPrompt, callClaude) as callbacks
 * to avoid circular imports with relay.ts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import { dispatchAgent, syncResponse, type DispatchResult } from "./agent-router.ts";
import { processMemoryIntents } from "./memory.ts";
import { extractApprovalTags } from "./approval.ts";
import type { ExecutionMode } from "./intent-classifier.ts";
import { log } from "./logger.ts";
import { estimateTokens } from "./relay-utils.ts";
import { writeToDisk, readFromDisk } from "./config-cache.ts";

const logger = log.child("orchestrator");

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface PipelineStep {
  agent_name: string;
  skill_name?: string;
  skill_description?: string;
  instruction: string;
}

export interface StepResult {
  step_index: number;
  agent_name: string;
  skill_name?: string;
  output: string;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  execution_type: "light" | "heavy";
  session_id: string;
}

export interface ArtifactStore {
  original_message: string;
  steps: StepResult[];
  total_duration_ms: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
}

export interface ExecutionResult {
  finalResponse: string;
  artifacts: ArtifactStore;
  stepResults: StepResult[];
  finalDispatch: DispatchResult;
  mode: ExecutionMode;
  planId?: string;
  /** Set to true when the response was truncated due to cost limits. */
  cost_truncated?: boolean;
}

interface CriticVerdict {
  accepted: boolean;
  feedback: string;
  score: number;
  issues: string[];
}

export interface OrchestratorOptions {
  supabase: SupabaseClient | null;
  channel: string;
  userId: string;
  onHeartbeat?: () => void;
  conversationId?: string;
  anthropicClient?: Anthropic | null;
  // Pre-gathered context from relay
  contextDocket?: string;
  relevantContext?: string;
  elasticContext?: string;
  structuredContext?: string;
  recentMessages?: string;
  workItemContext?: string;
  forestContext?: string;
  // Injected relay functions (avoids circular import)
  buildPromptFn: (
    userMessage: string,
    contextDocket?: string,
    relevantContext?: string,
    elasticContext?: string,
    channel?: string,
    agentConfig?: { system_prompt?: string | null; name?: string; tools_enabled?: string[] },
    workItemContext?: string,
    structuredContext?: string,
    recentMessages?: string,
    skillContext?: { name: string; description: string },
    forestContext?: string,
  ) => string;
  callClaudeFn: (
    prompt: string,
    options?: { resume?: boolean; allowedTools?: string[]; model?: string },
  ) => Promise<string>;
}

export class PipelineStepError extends Error {
  constructor(
    public stepIndex: number,
    public step: PipelineStep,
    public errorType: "dispatch_failed" | "claude_error" | "timeout" | "cost_exceeded",
    public partialOutput: string | null,
  ) {
    super(`Pipeline step ${stepIndex} (${step.agent_name}/${step.skill_name || "none"}) failed: ${errorType}`);
    this.name = "PipelineStepError";
  }
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const MAX_PIPELINE_DEPTH = 5;
const MAX_PIPELINE_TIMEOUT_MS = 120_000; // 2 minutes total
const MAX_PREVIOUS_OUTPUT_CHARS = 8_000;
const MAX_INSTRUCTION_CHARS = 500;
const MAX_CRITIC_ROUNDS = 3;
const COST_WARN_THRESHOLD = 0.50; // warn at $0.50
const MAX_COST_PER_EXECUTION = 2.00; // hard limit per execution

/**
 * Fallback model pricing (USD per million tokens) used when the Supabase
 * `models` table is unavailable. These are estimates based on Anthropic's
 * published pricing as of 2025-05-01 and may drift over time. The
 * authoritative source is the `models` table; these values are only used
 * when the DB lookup fails or Supabase is not configured.
 */
const FALLBACK_MODEL_COSTS = new Map<string, { input: number; output: number }>([
  ["claude-haiku-4-5-20251001", { input: 0.80, output: 4.0 }],
  ["claude-sonnet-4-5-20250929", { input: 3.0, output: 15.0 }],
  ["claude-opus-4-6", { input: 15.0, output: 75.0 }],
]);

// Skill complexity cache
let _skillComplexityCache: Map<string, "light" | "heavy"> | null = null;
let _skillComplexityCacheTime = 0;
const SKILL_CACHE_TTL_MS = 5 * 60_000;

// Model cost cache — ELLIE-235: extended to 30min, preloaded at startup
let _modelCostCache: Map<string, { input: number; output: number }> | null = null;
let _modelCostCacheTime = 0;
const MODEL_COST_CACHE_TTL_MS = 30 * 60_000;

/** Reset internal caches — test-only. */
export function _resetCachesForTesting(): void {
  _skillComplexityCache = null;
  _skillComplexityCacheTime = 0;
  _modelCostCache = null;
  _modelCostCacheTime = 0;
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

  if (effectiveSteps.length === 0) {
    throw new Error(`Orchestrator received empty steps array for mode "${mode}"`);
  }

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

    // Cost enforcement
    if (artifacts.total_cost_usd > MAX_COST_PER_EXECUTION) {
      logger.error("Cost limit exceeded", { cost: artifacts.total_cost_usd, limit: MAX_COST_PER_EXECUTION });
    } else if (artifacts.total_cost_usd > COST_WARN_THRESHOLD) {
      logger.warn("High cost", { cost: artifacts.total_cost_usd, mode, steps: effectiveSteps.length });
    }

    console.log(
      `[orchestrator] Completed ${mode} in ${artifacts.total_duration_ms}ms, ` +
      `${artifacts.total_input_tokens + artifacts.total_output_tokens} tokens, ` +
      `$${artifacts.total_cost_usd.toFixed(4)}`,
    );

    return result;
  } catch (err) {
    await completeExecutionPlan(
      options.supabase, planId, artifacts, "failed",
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }
}

// Backward compat — relay.ts currently imports executePipeline directly
export { executePipeline };

// ────────────────────────────────────────────────────────────────
// Pipeline (Sequential)
// ────────────────────────────────────────────────────────────────

async function executePipeline(
  steps: PipelineStep[],
  originalMessage: string,
  options: OrchestratorOptions,
  artifacts: ArtifactStore,
): Promise<ExecutionResult> {
  let previousOutput: string | null = null;
  let finalDispatch: DispatchResult | null = null;
  const pipelineStart = Date.now();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const isLast = i === steps.length - 1;

    // Check total pipeline timeout
    if (Date.now() - pipelineStart > MAX_PIPELINE_TIMEOUT_MS) {
      logger.error("Pipeline timeout", { completedSteps: i, elapsed_ms: Date.now() - pipelineStart });
      throw new PipelineStepError(i, step, "timeout", previousOutput);
    }

    console.log(`[orchestrator] Pipeline ${i + 1}/${steps.length}: ${step.agent_name}/${step.skill_name || "none"} — "${sanitizeInstruction(step.instruction).substring(0, 60)}"`);

    const { stepResult, dispatch } = await executeStep(
      step, i, steps.length, originalMessage, previousOutput, options,
      isLast ? "final" : "intermediate",
    );

    finalDispatch = dispatch;
    artifacts.steps.push(stepResult);
    artifacts.total_duration_ms += stepResult.duration_ms;
    artifacts.total_input_tokens += stepResult.input_tokens;
    artifacts.total_output_tokens += stepResult.output_tokens;
    artifacts.total_cost_usd += stepResult.cost_usd;

    // Cost guard — abort if running total exceeds hard limit
    if (artifacts.total_cost_usd > MAX_COST_PER_EXECUTION) {
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

    // Send heartbeat between steps
    if (!isLast && options.onHeartbeat) {
      options.onHeartbeat();
    }
  }

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

// ────────────────────────────────────────────────────────────────
// Fan-Out (Parallel)
// ────────────────────────────────────────────────────────────────

async function executeFanOut(
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

// ────────────────────────────────────────────────────────────────
// Critic Loop (Iterative Refinement)
// ────────────────────────────────────────────────────────────────

async function executeCriticLoop(
  steps: PipelineStep[],
  originalMessage: string,
  options: OrchestratorOptions,
  artifacts: ArtifactStore,
): Promise<ExecutionResult> {
  // Exactly 2 skills: producer and critic
  const producer = steps[0];
  const critic = steps.length > 1
    ? steps[1]
    : { agent_name: "critic", skill_name: "critical_review", instruction: "Review and provide constructive feedback" };

  console.log(`[orchestrator] Critic-loop: producer=${producer.agent_name}/${producer.skill_name || "none"}, critic=${critic.agent_name}/${critic.skill_name || "none"}`);

  let producerOutput = "";
  let feedback: string | null = null;
  let finalDispatch: DispatchResult | null = null;
  let round = 0;
  let costTruncated = false;

  for (round = 0; round < MAX_CRITIC_ROUNDS; round++) {
    // 1. Producer generates
    const producerInstruction = round === 0
      ? producer.instruction
      : `${producer.instruction}\n\nPrevious feedback to address:\n${feedback}\n\nImprove your previous output based on this feedback.`;

    const producerStep: PipelineStep = { ...producer, instruction: producerInstruction };

    const { stepResult: producerResult, dispatch: producerDispatch } = await executeStep(
      producerStep, round * 2, MAX_CRITIC_ROUNDS * 2,
      originalMessage, round > 0 ? producerOutput : null, options,
      "intermediate",
    );

    finalDispatch = producerDispatch;
    artifacts.steps.push(producerResult);
    artifacts.total_duration_ms += producerResult.duration_ms;
    artifacts.total_input_tokens += producerResult.input_tokens;
    artifacts.total_output_tokens += producerResult.output_tokens;
    artifacts.total_cost_usd += producerResult.cost_usd;

    // Cost guard — flag partial result so the caller knows refinement was cut short
    if (artifacts.total_cost_usd > MAX_COST_PER_EXECUTION) {
      logger.error("Critic-loop aborted: cost exceeds limit", { cost: artifacts.total_cost_usd, limit: MAX_COST_PER_EXECUTION });
      costTruncated = true;
      break;
    }

    producerOutput = await processMemoryIntents(options.supabase, producerResult.output, producerStep.agent_name);
    const { cleanedText } = extractApprovalTags(producerOutput);
    producerOutput = cleanedText;

    if (options.onHeartbeat) options.onHeartbeat();

    // 2. Critic evaluates
    const criticInstruction =
      `Evaluate the following output for the request: "${originalMessage}"\n\n` +
      `Output to review:\n---\n${producerOutput.substring(0, MAX_PREVIOUS_OUTPUT_CHARS)}\n---\n\n` +
      `Respond with ONLY a JSON object (no markdown fences):\n` +
      `{"accepted": true/false, "score": 1-10, "feedback": "overall assessment", "issues": ["specific issue 1", "specific issue 2"]}`;

    const criticStep: PipelineStep = { ...critic, instruction: criticInstruction };

    const { stepResult: criticResult, dispatch: criticDispatch } = await executeStep(
      criticStep, round * 2 + 1, MAX_CRITIC_ROUNDS * 2,
      originalMessage, null, options,
      "intermediate",
    );

    if (criticDispatch) finalDispatch = criticDispatch;
    artifacts.steps.push(criticResult);
    artifacts.total_duration_ms += criticResult.duration_ms;
    artifacts.total_input_tokens += criticResult.input_tokens;
    artifacts.total_output_tokens += criticResult.output_tokens;
    artifacts.total_cost_usd += criticResult.cost_usd;

    if (options.onHeartbeat) options.onHeartbeat();

    // 3. Parse critic verdict
    const verdict = parseCriticVerdict(criticResult.output, round);

    console.log(`[orchestrator] Critic round ${round + 1}: score=${verdict.score}, accepted=${verdict.accepted}`);

    if (verdict.accepted) {
      break;
    }

    feedback = verdict.feedback;
  }

  if (!finalDispatch) {
    throw new PipelineStepError(0, producer, "dispatch_failed", producerOutput || null);
  }

  return {
    finalResponse: producerOutput,
    artifacts,
    stepResults: artifacts.steps,
    finalDispatch,
    mode: "critic-loop",
    ...(costTruncated ? { cost_truncated: true } : {}),
  };
}

export function parseCriticVerdict(output: string, round: number): CriticVerdict {
  try {
    const cleaned = output
      .trim()
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```\s*$/m, "");
    const parsed = JSON.parse(cleaned);
    const issues: string[] = Array.isArray(parsed.issues)
      ? parsed.issues.map((i: unknown) => String(i).slice(0, 500)).slice(0, 10)
      : [];
    // Combine feedback + issues for actionable revision guidance
    const feedback = String(parsed.feedback || "No specific feedback provided.").slice(0, 2000);
    const fullFeedback = issues.length > 0
      ? `${feedback}\n\nSpecific issues:\n${issues.map((i, idx) => `${idx + 1}. ${i}`).join("\n")}`
      : feedback;
    return {
      accepted: Boolean(parsed.accepted),
      score: Math.min(Math.max(typeof parsed.score === "number" ? parsed.score : 5, 1), 10),
      feedback: fullFeedback,
      issues,
    };
  } catch {
    // Log the raw output so malformed critic responses are debuggable
    const truncatedRaw = output.length > 500 ? output.substring(0, 500) + "..." : output;
    const isFinalRound = round >= MAX_CRITIC_ROUNDS - 1;
    logger.warn(
      `Could not parse critic verdict, ${isFinalRound ? "accepting (final round)" : "rejecting for retry"}`,
      { round: round + 1, maxRounds: MAX_CRITIC_ROUNDS, rawOutput: truncatedRaw },
    );
    return {
      accepted: isFinalRound,
      score: isFinalRound ? 5 : 3,
      feedback: isFinalRound
        ? "Critic returned malformed response on final round — accepted with caveats. Review output manually."
        : "Unable to parse critic feedback. Please revise and provide clearer output.",
      issues: isFinalRound ? ["critic-parse-error: malformed JSON on final round"] : [],
    };
  }
}

// ────────────────────────────────────────────────────────────────
// Unified Step Executor
// ────────────────────────────────────────────────────────────────

async function executeStep(
  step: PipelineStep,
  stepIndex: number,
  totalSteps: number,
  originalMessage: string,
  previousOutput: string | null,
  options: OrchestratorOptions,
  stepRole: "intermediate" | "final" | "parallel",
): Promise<{ stepResult: StepResult; dispatch: DispatchResult }> {
  // 1. Dispatch to agent
  const dispatch = await dispatchAgent(
    options.supabase,
    step.agent_name,
    options.userId,
    options.channel,
    originalMessage,
    undefined,
    step.skill_name,
  );

  if (!dispatch) {
    throw new PipelineStepError(stepIndex, step, "dispatch_failed", previousOutput);
  }

  // 2. Determine light vs heavy
  const skillComplexity = await getSkillComplexity(options.supabase, step.skill_name);
  const isLight = skillComplexity === "light" && options.anthropicClient;

  // 3. Build prompt
  const stepPrompt = buildStepPrompt(
    step, stepIndex, totalSteps,
    originalMessage, previousOutput,
    options, dispatch, stepRole,
  );

  // 4. Execute
  const startTime = Date.now();
  let rawOutput: string;
  let inputTokens = 0;
  let outputTokens = 0;

  if (isLight) {
    const result = await callLightSkill(stepPrompt, options, {
      systemPrompt: dispatch.agent.system_prompt || undefined,
    });
    rawOutput = result.text;
    inputTokens = result.input_tokens;
    outputTokens = result.output_tokens;
  } else {
    rawOutput = await options.callClaudeFn(stepPrompt, {
      resume: false,
      allowedTools: dispatch.agent.tools_enabled?.length
        ? dispatch.agent.tools_enabled
        : undefined,
      model: dispatch.agent.model || undefined,
    });
    // Token estimation via proper tokenizer (ELLIE-245)
    inputTokens = estimateTokens(stepPrompt);
    outputTokens = estimateTokens(rawOutput);
  }

  const duration = Date.now() - startTime;

  // 5. Check for error
  if (rawOutput.startsWith("Error:")) {
    logger.error("Step returned error", { step: stepIndex + 1, output: rawOutput.substring(0, 200) });
    throw new PipelineStepError(stepIndex, step, "claude_error", previousOutput);
  }

  // 6. Calculate cost
  const modelId = isLight ? "claude-haiku-4-5-20251001" : (dispatch.agent.model || "claude-sonnet-4-5-20250929");
  const cost = await calculateStepCost(options.supabase, modelId, inputTokens, outputTokens);

  // 7. Build result
  const stepResult: StepResult = {
    step_index: stepIndex,
    agent_name: dispatch.agent.name || step.agent_name,
    skill_name: step.skill_name,
    output: rawOutput,
    duration_ms: duration,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: cost,
    execution_type: isLight ? "light" : "heavy",
    session_id: dispatch.session_id,
  };

  // 8. Sync step response (fire-and-forget)
  syncResponse(options.supabase, dispatch.session_id, rawOutput, {
    duration_ms: duration,
  }).catch(() => {});

  return { stepResult, dispatch };
}

// ────────────────────────────────────────────────────────────────
// Light Skill Execution (Direct API)
// ────────────────────────────────────────────────────────────────

async function callLightSkill(
  prompt: string,
  options: OrchestratorOptions,
  config?: { systemPrompt?: string },
): Promise<{ text: string; input_tokens: number; output_tokens: number }> {
  if (!options.anthropicClient) {
    // Fallback to heavy — estimate tokens via proper tokenizer (ELLIE-245)
    const text = await options.callClaudeFn(prompt, { resume: false });
    return {
      text,
      input_tokens: estimateTokens(prompt),
      output_tokens: estimateTokens(text),
    };
  }

  const messages: Array<{ role: "user"; content: string }> = [
    { role: "user", content: prompt },
  ];

  const response = await options.anthropicClient.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    ...(config?.systemPrompt ? { system: config.systemPrompt } : {}),
    messages,
  });

  const text = response.content
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { type: string; text: string }) => b.text)
    .join("");

  // Log estimated vs actual for accuracy tracking (ELLIE-245)
  const estInput = estimateTokens(prompt);
  const estOutput = estimateTokens(text);
  const actualInput = response.usage.input_tokens;
  const actualOutput = response.usage.output_tokens;
  if (Math.abs(estInput - actualInput) > actualInput * 0.15) {
    logger.info("Token estimation variance", {
      estInput, actualInput, inputDrift: `${((estInput - actualInput) / actualInput * 100).toFixed(1)}%`,
      estOutput, actualOutput, outputDrift: `${((estOutput - actualOutput) / actualOutput * 100).toFixed(1)}%`,
    });
  }

  return {
    text,
    input_tokens: actualInput,
    output_tokens: actualOutput,
  };
}

// ────────────────────────────────────────────────────────────────
// Instruction Sanitization
// ────────────────────────────────────────────────────────────────

export function sanitizeInstruction(instruction: string): string {
  return instruction
    .replace(/[\x00-\x1F\x7F]/g, " ")         // strip control chars
    .replace(/\[CONFIRM:/gi, "[_CONFIRM_:")     // neutralize approval tags
    .replace(/\[REMEMBER:/gi, "[_REMEMBER_:")   // neutralize memory tags
    .replace(/ELLIE::/gi, "ELLIE__")            // neutralize playbook tags
    .slice(0, MAX_INSTRUCTION_CHARS);
}

// ────────────────────────────────────────────────────────────────
// Step Prompt Builder
// ────────────────────────────────────────────────────────────────

function buildStepPrompt(
  step: PipelineStep,
  stepIndex: number,
  totalSteps: number,
  originalMessage: string,
  previousOutput: string | null,
  options: OrchestratorOptions,
  dispatch: DispatchResult,
  stepRole: "intermediate" | "final" | "parallel",
): string {
  // Build the standard agent prompt
  const basePrompt = options.buildPromptFn(
    step.instruction,
    options.contextDocket,
    options.relevantContext,
    options.elasticContext,
    options.channel,
    {
      system_prompt: dispatch.agent.system_prompt,
      name: dispatch.agent.name,
      tools_enabled: dispatch.agent.tools_enabled,
    },
    options.workItemContext,
    options.structuredContext,
    options.recentMessages,
    dispatch.skill_context,
    options.forestContext,
  );

  // Prepend execution context (sanitize instruction to prevent tag injection)
  const safeInstruction = sanitizeInstruction(step.instruction);
  const context: string[] = [
    `EXECUTION CONTEXT (Step ${stepIndex + 1} of ${totalSteps}):`,
    `Original user request: "${originalMessage}"`,
    `Your task in this step: ${safeInstruction}`,
  ];

  if (previousOutput) {
    const truncated = previousOutput.length > MAX_PREVIOUS_OUTPUT_CHARS
      ? previousOutput.substring(0, MAX_PREVIOUS_OUTPUT_CHARS) + "\n... (truncated)"
      : previousOutput;

    context.push(
      "",
      "OUTPUT FROM PREVIOUS STEP:",
      "---",
      truncated,
      "---",
      "Use the above output as input for your task. Build on it, don't repeat it.",
    );
  }

  if (stepRole === "final") {
    context.push(
      "",
      "Note: This is the FINAL step. Your response will be sent directly to the user.",
      "Make your response conversational and complete.",
    );
  } else if (stepRole === "intermediate") {
    context.push(
      "",
      "Note: Your output will be passed to the next step. Provide complete, structured output.",
    );
  } else {
    // parallel — fan-out step
    context.push(
      "",
      "Note: You are one of several specialists working on different parts of this request.",
      "Focus only on your assigned task and provide thorough output.",
    );
  }

  return context.join("\n") + "\n\n" + basePrompt;
}

// ────────────────────────────────────────────────────────────────
// Skill Complexity Lookup
// ────────────────────────────────────────────────────────────────

async function getSkillComplexity(
  supabase: SupabaseClient | null,
  skillName?: string,
): Promise<"light" | "heavy"> {
  if (!skillName || !supabase) return "heavy";

  const now = Date.now();
  if (!_skillComplexityCache || now - _skillComplexityCacheTime > SKILL_CACHE_TTL_MS) {
    try {
      const { data, error } = await supabase
        .from("skills")
        .select("name, complexity")
        .eq("enabled", true);

      if (error) {
        logger.warn("Skill cache refresh failed, using fallback", { error: error.message ?? error.code ?? "unknown" });
        // Return cached value if available, otherwise default to heavy
        return _skillComplexityCache?.get(skillName) || "heavy";
      }

      _skillComplexityCache = new Map();
      for (const s of data || []) {
        _skillComplexityCache.set(s.name, s.complexity || "heavy");
      }
      _skillComplexityCacheTime = now;
    } catch (err) {
      // Table may not exist on first run, or network error — log and fallback gracefully
      logger.warn("Skill cache query error (table may not exist), defaulting to heavy", err);
      return _skillComplexityCache?.get(skillName) || "heavy";
    }
  }

  return _skillComplexityCache?.get(skillName) || "heavy";
}

// ────────────────────────────────────────────────────────────────
// Cost Tracking
// ────────────────────────────────────────────────────────────────

async function getModelCosts(
  supabase: SupabaseClient | null,
): Promise<Map<string, { input: number; output: number }>> {
  // ELLIE-235: Use dedicated TTL (30min) instead of skill cache TTL (5min)
  if (_modelCostCache && Date.now() - _modelCostCacheTime < MODEL_COST_CACHE_TTL_MS) {
    return _modelCostCache;
  }

  if (!supabase) return FALLBACK_MODEL_COSTS;

  try {
    const { data } = await supabase
      .from("models")
      .select("model_id, cost_input_mtok, cost_output_mtok")
      .eq("enabled", true);

    _modelCostCache = new Map();
    for (const m of data || []) {
      _modelCostCache.set(m.model_id, {
        input: Number(m.cost_input_mtok) || 0,
        output: Number(m.cost_output_mtok) || 0,
      });
    }
    _modelCostCacheTime = Date.now();
    // ELLIE-230: Persist to disk for offline fallback
    writeToDisk("model-costs", Object.fromEntries(_modelCostCache));
    return _modelCostCache;
  } catch {
    // ELLIE-230: Try disk cache before falling back to hardcoded costs
    const diskCosts = await readFromDisk<Record<string, { input: number; output: number }>>("model-costs");
    if (diskCosts && Object.keys(diskCosts).length > 0) {
      _modelCostCache = new Map(Object.entries(diskCosts));
      _modelCostCacheTime = Date.now();
      console.log(`[orchestrator] Model costs loaded from disk cache: ${_modelCostCache.size} models`);
      return _modelCostCache;
    }
    return FALLBACK_MODEL_COSTS;
  }
}

/**
 * ELLIE-235: Preload model costs into cache at startup.
 * Avoids first-request latency and ensures costs are available immediately.
 */
export async function preloadModelCosts(
  supabase: SupabaseClient | null,
): Promise<void> {
  const costs = await getModelCosts(supabase);
  console.log(`[orchestrator] Model costs preloaded: ${costs.size} models`);
}

/**
 * ELLIE-235: Estimate cost of an execution before running it.
 * Uses cached model costs and token estimation to predict total cost.
 * Returns { estimatedCost, wouldExceedLimit, modelId }.
 */
export async function estimateExecutionCost(
  supabase: SupabaseClient | null,
  opts: {
    promptText: string;
    mode: ExecutionMode;
    modelId: string;
    steps?: number;
  },
): Promise<{ estimatedCost: number; wouldExceedLimit: boolean; modelId: string }> {
  const inputTokens = estimateTokens(opts.promptText);
  // Estimate output as ~40% of input (conservative average across modes)
  const outputRatio = opts.mode === "critic-loop" ? 0.6 : 0.4;
  const estimatedOutputTokens = Math.ceil(inputTokens * outputRatio);
  const stepCount = opts.steps || (opts.mode === "critic-loop" ? 3 : opts.mode === "fan-out" ? 2 : 1);

  const costs = await getModelCosts(supabase);
  const model = costs.get(opts.modelId);
  if (!model) {
    return { estimatedCost: 0, wouldExceedLimit: false, modelId: opts.modelId };
  }

  const perStep = (inputTokens * model.input + estimatedOutputTokens * model.output) / 1_000_000;
  const estimatedCost = perStep * stepCount;

  return {
    estimatedCost,
    wouldExceedLimit: estimatedCost > MAX_COST_PER_EXECUTION,
    modelId: opts.modelId,
  };
}

async function calculateStepCost(
  supabase: SupabaseClient | null,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): Promise<number> {
  const costs = await getModelCosts(supabase);
  const model = costs.get(modelId);
  if (!model) return 0;

  // costs are per million tokens
  return (inputTokens * model.input + outputTokens * model.output) / 1_000_000;
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
