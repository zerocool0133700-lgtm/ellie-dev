/**
 * ELLIE-524 — Orchestrator cost tracking.
 *
 * Model cost cache, per-step cost calculation, startup preload, and
 * pre-execution cost estimation. Extracted from orchestrator.ts to
 * allow step-runner and fanout-executor to import without circular deps.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { estimateTokens } from "./relay-utils.ts";
import { writeToDisk, readFromDisk } from "./config-cache.ts";
import { log } from "./logger.ts";
import type { ExecutionMode } from "./intent-classifier.ts";
import { FALLBACK_MODEL_COSTS, MAX_COST_PER_EXECUTION } from "./orchestrator-types.ts";

const logger = log.child("orchestrator");

// Model cost cache — ELLIE-235: extended to 30min, preloaded at startup
let _modelCostCache: Map<string, { input: number; output: number }> | null = null;
let _modelCostCacheTime = 0;
const MODEL_COST_CACHE_TTL_MS = 30 * 60_000;

/** Reset model cost cache — for unit tests only. */
export function _resetModelCostCacheForTesting(): void {
  _modelCostCache = null;
  _modelCostCacheTime = 0;
}

export async function getModelCosts(
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
      logger.info(`Model costs loaded from disk cache: ${_modelCostCache.size} models`);
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
  logger.info(`Model costs preloaded: ${costs.size} models`);
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

export async function calculateStepCost(
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
