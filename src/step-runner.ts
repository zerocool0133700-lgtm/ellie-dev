/**
 * ELLIE-524 — Unified step executor.
 *
 * Handles: agent dispatch, skill complexity lookup (light/heavy), prompt
 * building, Claude invocation, cost calculation, and response sync.
 * Shared by all three execution modes (pipeline, fan-out, critic-loop).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatchAgent, syncResponse, type DispatchResult } from "./agent-router.ts";
import { resilientTask } from "./resilient-task.ts";
import { estimateTokens } from "./relay-utils.ts";
import { log } from "./logger.ts";
import {
  type PipelineStep,
  type StepResult,
  type OrchestratorOptions,
  PipelineStepError,
  MAX_PREVIOUS_OUTPUT_CHARS,
  MAX_INSTRUCTION_CHARS,
  STEP_TIMEOUT_LIGHT_MS,
  STEP_TIMEOUT_HEAVY_MS,
} from "./orchestrator-types.ts";
import { calculateStepCost } from "./orchestrator-costs.ts";

const logger = log.child("orchestrator");

// ────────────────────────────────────────────────────────────────
// Skill Complexity Cache
// ────────────────────────────────────────────────────────────────

let _skillComplexityCache: Map<string, "light" | "heavy"> | null = null;
let _skillComplexityCacheTime = 0;
const SKILL_CACHE_TTL_MS = 5 * 60_000;

/** Reset skill complexity cache — for unit tests only. */
export function _resetSkillCacheForTesting(): void {
  _skillComplexityCache = null;
  _skillComplexityCacheTime = 0;
}

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

export function buildStepPrompt(
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
// Light Skill Execution (Direct API)
// ────────────────────────────────────────────────────────────────

export async function callLightSkill(
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
// Step Timeout Helper
// ────────────────────────────────────────────────────────────────

/** ELLIE-521: Race a promise against a timeout that throws the given error. */
async function withStepTimeout<T>(promise: Promise<T>, timeoutMs: number, error: Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(error), timeoutMs);
  });
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timer);
    return result;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ────────────────────────────────────────────────────────────────
// Execute Step
// ────────────────────────────────────────────────────────────────

export async function executeStep(
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

  // 4. Execute (ELLIE-521: per-step timeout)
  const stepTimeoutMs = options.stepTimeoutMs ?? (isLight ? STEP_TIMEOUT_LIGHT_MS : STEP_TIMEOUT_HEAVY_MS);
  const timeoutError = new PipelineStepError(stepIndex, step, "timeout", previousOutput);

  const startTime = Date.now();
  let rawOutput: string;
  let inputTokens = 0;
  let outputTokens = 0;

  if (isLight) {
    const result = await withStepTimeout(
      callLightSkill(stepPrompt, options, {
        systemPrompt: dispatch.agent.system_prompt || undefined,
      }),
      stepTimeoutMs,
      timeoutError,
    );
    rawOutput = result.text;
    inputTokens = result.input_tokens;
    outputTokens = result.output_tokens;
  } else {
    rawOutput = await withStepTimeout(
      options.callClaudeFn(stepPrompt, {
        resume: false,
        allowedTools: dispatch.agent.tools_enabled?.length
          ? dispatch.agent.tools_enabled
          : undefined,
        model: dispatch.agent.model || undefined,
        runId: options.runId,
      }),
      stepTimeoutMs,
      timeoutError,
    );
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

  // 8. Sync step response (ELLIE-479: resilient fire-and-forget)
  resilientTask("syncResponse", "critical", () => syncResponse(options.supabase, dispatch.session_id, rawOutput, {
    duration_ms: duration,
  }));

  return { stepResult, dispatch };
}
