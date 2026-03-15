/**
 * Formation Cost Tracking Types — ELLIE-722
 *
 * Types for per-agent budgets and per-formation cost recording.
 * Pure types module — no side effects.
 */

// ── Agent Budgets ───────────────────────────────────────────

/** A per-agent monthly budget record (maps to agent_budgets table). */
export interface AgentBudget {
  agent_id: string;
  created_at: Date;
  updated_at: Date;
  monthly_budget_cents: number;
  spent_this_month_cents: number;
  budget_period_start: Date;
}

/** Result of a budget check before agent execution. */
export interface BudgetCheckResult {
  allowed: boolean;
  agent_id: string;
  monthly_budget_cents: number;
  spent_this_month_cents: number;
  remaining_cents: number;
  /** If not allowed, reason why. */
  reason?: string;
}

// ── Formation Costs ─────────────────────────────────────────

/** A single cost record for one agent dispatch within a formation (maps to formation_costs table). */
export interface FormationCostRecord {
  id: string;
  formation_session_id: string;
  agent_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  model: string | null;
  recorded_at: Date;
  metadata: Record<string, unknown>;
}

/** Input for recording a cost entry. */
export interface RecordCostInput {
  formation_session_id: string;
  agent_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  model?: string;
  metadata?: Record<string, unknown>;
}

/** Per-agent cost subtotal within a formation session. */
export interface AgentCostBreakdown {
  agent_id: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_cents: number;
  dispatch_count: number;
}

/** Full formation cost breakdown with per-agent detail. */
export interface FormationCostBreakdown {
  formation_session_id: string;
  total_cost_cents: number;
  total_input_tokens: number;
  total_output_tokens: number;
  agents: AgentCostBreakdown[];
}

/** Input for setting/updating an agent budget. */
export interface SetBudgetInput {
  agent_id: string;
  monthly_budget_cents: number;
}

// ── Constants ───────────────────────────────────────────────

/** Known model cost rates (per million tokens, in cents). */
export const MODEL_COST_RATES: Record<string, { input_cents_per_mtok: number; output_cents_per_mtok: number }> = {
  "claude-haiku-4-5-20251001": { input_cents_per_mtok: 80, output_cents_per_mtok: 400 },
  "claude-sonnet-4-5-20250929": { input_cents_per_mtok: 300, output_cents_per_mtok: 1500 },
  "claude-sonnet-4-6": { input_cents_per_mtok: 300, output_cents_per_mtok: 1500 },
  "claude-opus-4-6": { input_cents_per_mtok: 1500, output_cents_per_mtok: 7500 },
};

/**
 * Calculate cost in cents from token counts and model.
 * Returns 0 if model is unknown.
 */
export function calculateCostCents(
  inputTokens: number,
  outputTokens: number,
  model: string,
): number {
  const rates = MODEL_COST_RATES[model];
  if (!rates) return 0;

  const inputCost = (inputTokens / 1_000_000) * rates.input_cents_per_mtok;
  const outputCost = (outputTokens / 1_000_000) * rates.output_cents_per_mtok;

  return Math.ceil(inputCost + outputCost);
}
