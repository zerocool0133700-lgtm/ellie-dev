/**
 * ELLIE-524 — Shared orchestrator types, constants, and error classes.
 *
 * Extracted from orchestrator.ts to break circular-import chains between
 * the focused executor modules (pipeline, fan-out, critic-loop, step-runner).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import type { DispatchResult } from "./agent-router.ts";
import type { ExecutionMode } from "./intent-classifier.ts";
import type { FailureAction, PipelineCheckpoint } from "./pipeline-state.ts";

// ────────────────────────────────────────────────────────────────
// Interfaces
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
  /** ELLIE-521: Set to true when this step was interrupted by a per-step timeout. */
  timed_out?: boolean;
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
    options?: { resume?: boolean; allowedTools?: string[]; model?: string; runId?: string },
  ) => Promise<string>;
  /** ELLIE-390: Run ID for heartbeat tracking during long pipeline steps */
  runId?: string;
  /** ELLIE-394: Callback for step failure — returns action (retry/skip/abort). Defaults to abort. */
  onStepFailure?: (step: PipelineStep, stepIndex: number, error: Error) => Promise<FailureAction>;
  /** ELLIE-394: Resume from a checkpoint — skips already-completed steps. */
  resumeCheckpoint?: PipelineCheckpoint;
  /**
   * ELLIE-521: Per-step execution timeout in ms.
   * Defaults to STEP_TIMEOUT_LIGHT_MS (30s) for light skills, STEP_TIMEOUT_HEAVY_MS (60s) for heavy.
   * Override to set a uniform timeout for all steps (useful in tests).
   */
  stepTimeoutMs?: number;
  /** Plane work item ID (e.g. "ELLIE-473") — if set, ticket is rolled back to Todo on failure. */
  workItemId?: string;
  /** Forest work session tree ID — if set, session is completed with failure summary on pipeline error. */
  forestSessionId?: string;
  /**
   * ELLIE-522: Max retries for fan-out synthesis LLM call.
   * Defaults to 2. Set to 0 to disable retry.
   */
  synthesisMaxRetries?: number;
}

// ────────────────────────────────────────────────────────────────
// Error classes
// ────────────────────────────────────────────────────────────────

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

export class PipelineValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineValidationError";
  }
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

export const MAX_PIPELINE_DEPTH = 5;
export const MAX_PIPELINE_TIMEOUT_MS = 300_000; // 5 minutes total — research pipelines need headroom
/** ELLIE-521: Per-step timeout for light skills (45 seconds). */
export const STEP_TIMEOUT_LIGHT_MS = 45_000;
/** ELLIE-521: Per-step timeout for heavy skills (120 seconds) — web_search + synthesis needs time. */
export const STEP_TIMEOUT_HEAVY_MS = 120_000;
export const MAX_PREVIOUS_OUTPUT_CHARS = 8_000;
export const MAX_INSTRUCTION_CHARS = 500;
export const MAX_CRITIC_ROUNDS = 3;
export const COST_WARN_THRESHOLD = 0.50; // warn at $0.50
/**
 * LIMITS RELAXED (2026-03-30): Raised from $2 to $50. Single-user Mac
 * subscription — the $2 hard limit was aborting complex pipelines and
 * critic loops prematurely. Original intent: prevent runaway costs in
 * multi-user scenarios. Lower this when onboarding external users.
 */
export const MAX_COST_PER_EXECUTION = 50.00; // was $2.00 — relaxed for single-user dev

/**
 * Fallback model pricing (USD per million tokens) used when the Supabase
 * `models` table is unavailable. These are estimates based on Anthropic's
 * published pricing as of 2025-05-01 and may drift over time.
 */
export const FALLBACK_MODEL_COSTS = new Map<string, { input: number; output: number }>([
  ["claude-haiku-4-5-20251001", { input: 0.80, output: 4.0 }],
  ["claude-sonnet-4-5-20250929", { input: 3.0, output: 15.0 }],
  ["claude-opus-4-6", { input: 15.0, output: 75.0 }],
]);
