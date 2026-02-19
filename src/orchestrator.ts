/**
 * Pipeline Orchestrator — ELLIE-54
 *
 * Executes sequential multi-agent pipelines where one agent's output
 * feeds into the next. Each step gets its own agent dispatch, prompt
 * construction, and Claude invocation.
 *
 * Receives relay functions (buildPrompt, callClaude) as callbacks
 * to avoid circular imports with relay.ts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatchAgent, syncResponse, type DispatchResult } from "./agent-router.ts";
import { processMemoryIntents } from "./memory.ts";
import { extractApprovalTags } from "./approval.ts";

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
  approx_tokens: number;
  session_id: string;
}

export interface ArtifactStore {
  original_message: string;
  steps: StepResult[];
  total_duration_ms: number;
  total_approx_tokens: number;
}

export interface PipelineResult {
  finalResponse: string;
  artifacts: ArtifactStore;
  stepResults: StepResult[];
  finalDispatch: DispatchResult;
}

export interface PipelineOptions {
  supabase: SupabaseClient | null;
  channel: string;
  userId: string;
  onHeartbeat?: () => void;
  // Pre-gathered context from relay
  contextDocket?: string;
  relevantContext?: string;
  elasticContext?: string;
  structuredContext?: string;
  recentMessages?: string;
  workItemContext?: string;
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
    public errorType: "dispatch_failed" | "claude_error" | "timeout",
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
const MAX_PIPELINE_TIMEOUT_MS = 600_000; // 10 minutes total
const MAX_PREVIOUS_OUTPUT_CHARS = 8_000;

// ────────────────────────────────────────────────────────────────
// Pipeline Execution
// ────────────────────────────────────────────────────────────────

export async function executePipeline(
  steps: PipelineStep[],
  originalMessage: string,
  options: PipelineOptions,
): Promise<PipelineResult> {
  const effectiveSteps = steps.slice(0, MAX_PIPELINE_DEPTH);

  const artifacts: ArtifactStore = {
    original_message: originalMessage,
    steps: [],
    total_duration_ms: 0,
    total_approx_tokens: 0,
  };

  let previousOutput: string | null = null;
  let finalDispatch: DispatchResult | null = null;
  const pipelineStart = Date.now();

  for (let i = 0; i < effectiveSteps.length; i++) {
    const step = effectiveSteps[i];
    const isLast = i === effectiveSteps.length - 1;

    // Check total pipeline timeout
    if (Date.now() - pipelineStart > MAX_PIPELINE_TIMEOUT_MS) {
      console.error(`[pipeline] Timeout after ${i} steps (${Date.now() - pipelineStart}ms)`);
      throw new PipelineStepError(i, step, "timeout", previousOutput);
    }

    console.log(`[pipeline] Step ${i + 1}/${effectiveSteps.length}: ${step.agent_name}/${step.skill_name || "none"} — "${step.instruction.substring(0, 60)}"`);

    // 1. Dispatch to this step's agent
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
      throw new PipelineStepError(i, step, "dispatch_failed", previousOutput);
    }

    finalDispatch = dispatch;

    // 2. Build step prompt
    const stepPrompt = buildStepPrompt(
      step, i, effectiveSteps.length,
      originalMessage, previousOutput,
      options, dispatch,
    );

    // 3. Call Claude (no session resume — each step is independent)
    const startTime = Date.now();
    const rawOutput = await options.callClaudeFn(stepPrompt, {
      resume: false,
      allowedTools: dispatch.agent.tools_enabled?.length
        ? dispatch.agent.tools_enabled
        : undefined,
      model: dispatch.agent.model || undefined,
    });
    const duration = Date.now() - startTime;

    // 4. Check for error response
    if (rawOutput.startsWith("Error:")) {
      console.error(`[pipeline] Step ${i + 1} returned error: ${rawOutput.substring(0, 200)}`);
      throw new PipelineStepError(i, step, "claude_error", previousOutput);
    }

    // 5. Record step result
    const stepResult: StepResult = {
      step_index: i,
      agent_name: step.agent_name,
      skill_name: step.skill_name,
      output: rawOutput,
      duration_ms: duration,
      approx_tokens: Math.ceil(rawOutput.length / 4),
      session_id: dispatch.session_id,
    };
    artifacts.steps.push(stepResult);
    artifacts.total_duration_ms += duration;
    artifacts.total_approx_tokens += stepResult.approx_tokens;

    // 6. Sync this step's response (fire-and-forget)
    syncResponse(options.supabase, dispatch.session_id, rawOutput, {
      duration_ms: duration,
    }).catch(() => {});

    // 7. Clean intermediate output for next step
    if (!isLast) {
      // Process memory intents (save them, strip tags)
      let cleanedOutput = await processMemoryIntents(options.supabase, rawOutput);
      // Strip approval tags from intermediate steps
      const { cleanedText } = extractApprovalTags(cleanedOutput);
      previousOutput = cleanedText;
    } else {
      // Final step — leave raw for relay to process
      previousOutput = rawOutput;
    }

    // Send heartbeat between steps
    if (!isLast && options.onHeartbeat) {
      options.onHeartbeat();
    }
  }

  return {
    finalResponse: previousOutput || "",
    artifacts,
    stepResults: artifacts.steps,
    finalDispatch: finalDispatch!,
  };
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
  options: PipelineOptions,
  dispatch: DispatchResult,
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
  );

  // Prepend pipeline context
  const pipelineContext: string[] = [
    `PIPELINE CONTEXT (Step ${stepIndex + 1} of ${totalSteps}):`,
    `Original user request: "${originalMessage}"`,
    `Your task in this step: ${step.instruction}`,
  ];

  if (previousOutput) {
    const truncated = previousOutput.length > MAX_PREVIOUS_OUTPUT_CHARS
      ? previousOutput.substring(0, MAX_PREVIOUS_OUTPUT_CHARS) + "\n... (truncated)"
      : previousOutput;

    pipelineContext.push(
      "",
      "OUTPUT FROM PREVIOUS STEP:",
      "---",
      truncated,
      "---",
      "Use the above output as input for your task. Build on it, don't repeat it.",
    );
  }

  if (stepIndex < totalSteps - 1) {
    pipelineContext.push(
      "",
      "Note: Your output will be passed to the next step. Provide complete, structured output.",
    );
  } else {
    pipelineContext.push(
      "",
      "Note: This is the FINAL step. Your response will be sent directly to the user.",
      "Make your response conversational and complete.",
    );
  }

  return pipelineContext.join("\n") + "\n\n" + basePrompt;
}
