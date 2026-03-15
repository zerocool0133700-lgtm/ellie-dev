/**
 * Formation Cost Tracking — ELLIE-722
 *
 * Records per-agent token usage and costs within formation sessions.
 * Enforces monthly budgets and provides cost breakdowns.
 *
 * Database functions module — uses postgres.js via ellie-forest.
 */

import { sql } from "../../ellie-forest/src/index";
import type {
  AgentBudget,
  BudgetCheckResult,
  FormationCostRecord,
  RecordCostInput,
  AgentCostBreakdown,
  FormationCostBreakdown,
  SetBudgetInput,
} from "./types/formation-costs";

// ── Record Cost ─────────────────────────────────────────────

/**
 * Record a cost entry for an agent dispatch within a formation session.
 * Also atomically increments the agent's spent_this_month_cents.
 */
export async function recordCost(input: RecordCostInput): Promise<FormationCostRecord> {
  const [record] = await sql<FormationCostRecord[]>`
    INSERT INTO formation_costs (
      formation_session_id, agent_id, input_tokens, output_tokens,
      cost_cents, model, metadata
    )
    VALUES (
      ${input.formation_session_id}::uuid,
      ${input.agent_id}::uuid,
      ${input.input_tokens},
      ${input.output_tokens},
      ${input.cost_cents},
      ${input.model ?? null},
      ${sql.json(input.metadata ?? {})}
    )
    RETURNING *
  `;

  // Atomically increment the agent's monthly spend
  await sql`
    UPDATE agent_budgets
    SET
      spent_this_month_cents = spent_this_month_cents + ${input.cost_cents},
      updated_at = NOW()
    WHERE agent_id = ${input.agent_id}::uuid
  `;

  return record;
}

// ── Budget Check ────────────────────────────────────────────

/**
 * Check if an agent has budget remaining for execution.
 * Returns allowed=true if no budget row exists (uncapped agent).
 * Auto-resets the budget period if it has rolled over to a new month.
 */
export async function checkBudget(agentId: string): Promise<BudgetCheckResult> {
  const [budget] = await sql<AgentBudget[]>`
    SELECT * FROM agent_budgets WHERE agent_id = ${agentId}::uuid
  `;

  // No budget row = uncapped agent, always allowed
  if (!budget) {
    return {
      allowed: true,
      agent_id: agentId,
      monthly_budget_cents: 0,
      spent_this_month_cents: 0,
      remaining_cents: Infinity,
    };
  }

  // Check if budget period has rolled over (new month)
  const now = new Date();
  const periodStart = new Date(budget.budget_period_start);
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  if (periodStart < currentMonthStart) {
    // Auto-reset: new month has begun
    await sql`
      UPDATE agent_budgets
      SET
        spent_this_month_cents = 0,
        budget_period_start = ${currentMonthStart.toISOString()}::timestamptz,
        updated_at = NOW()
      WHERE agent_id = ${agentId}::uuid
    `;
    budget.spent_this_month_cents = 0;
    budget.budget_period_start = currentMonthStart;
  }

  // Budget of 0 means uncapped
  if (budget.monthly_budget_cents === 0) {
    return {
      allowed: true,
      agent_id: agentId,
      monthly_budget_cents: 0,
      spent_this_month_cents: budget.spent_this_month_cents,
      remaining_cents: Infinity,
    };
  }

  const remaining = budget.monthly_budget_cents - budget.spent_this_month_cents;

  if (remaining <= 0) {
    return {
      allowed: false,
      agent_id: agentId,
      monthly_budget_cents: budget.monthly_budget_cents,
      spent_this_month_cents: budget.spent_this_month_cents,
      remaining_cents: 0,
      reason: `Agent monthly budget exceeded: spent ${budget.spent_this_month_cents} of ${budget.monthly_budget_cents} cents`,
    };
  }

  return {
    allowed: true,
    agent_id: agentId,
    monthly_budget_cents: budget.monthly_budget_cents,
    spent_this_month_cents: budget.spent_this_month_cents,
    remaining_cents: remaining,
  };
}

// ── Set / Update Budget ─────────────────────────────────────

/**
 * Set or update an agent's monthly budget.
 * Creates the budget row if it doesn't exist (upsert).
 */
export async function setBudget(input: SetBudgetInput): Promise<AgentBudget> {
  const [budget] = await sql<AgentBudget[]>`
    INSERT INTO agent_budgets (agent_id, monthly_budget_cents)
    VALUES (${input.agent_id}::uuid, ${input.monthly_budget_cents})
    ON CONFLICT (agent_id) DO UPDATE SET
      monthly_budget_cents = ${input.monthly_budget_cents},
      updated_at = NOW()
    RETURNING *
  `;

  return budget;
}

/**
 * Get an agent's current budget.
 */
export async function getBudget(agentId: string): Promise<AgentBudget | null> {
  const [budget] = await sql<AgentBudget[]>`
    SELECT * FROM agent_budgets WHERE agent_id = ${agentId}::uuid
  `;
  return budget ?? null;
}

// ── Budget Reset ────────────────────────────────────────────

/**
 * Reset all agent budgets for a new monthly period.
 * Intended for cron or on-demand use.
 * Returns the number of budgets reset.
 */
export async function resetAllBudgets(): Promise<number> {
  const now = new Date();
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const rows = await sql<{ agent_id: string }[]>`
    UPDATE agent_budgets
    SET
      spent_this_month_cents = 0,
      budget_period_start = ${currentMonthStart.toISOString()}::timestamptz,
      updated_at = NOW()
    WHERE budget_period_start < ${currentMonthStart.toISOString()}::timestamptz
    RETURNING agent_id
  `;

  return rows.length;
}

/**
 * Reset a single agent's budget for the current month.
 */
export async function resetBudget(agentId: string): Promise<AgentBudget | null> {
  const now = new Date();
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [budget] = await sql<AgentBudget[]>`
    UPDATE agent_budgets
    SET
      spent_this_month_cents = 0,
      budget_period_start = ${currentMonthStart.toISOString()}::timestamptz,
      updated_at = NOW()
    WHERE agent_id = ${agentId}::uuid
    RETURNING *
  `;

  return budget ?? null;
}

// ── Formation Cost Breakdown ────────────────────────────────

/**
 * Get the full cost breakdown for a formation session,
 * including per-agent subtotals.
 */
export async function getFormationCostBreakdown(
  sessionId: string,
): Promise<FormationCostBreakdown> {
  const agents = await sql<AgentCostBreakdown[]>`
    SELECT
      agent_id,
      SUM(input_tokens)::int AS total_input_tokens,
      SUM(output_tokens)::int AS total_output_tokens,
      SUM(cost_cents)::int AS total_cost_cents,
      COUNT(*)::int AS dispatch_count
    FROM formation_costs
    WHERE formation_session_id = ${sessionId}::uuid
    GROUP BY agent_id
    ORDER BY total_cost_cents DESC
  `;

  const totalCost = agents.reduce((sum, a) => sum + a.total_cost_cents, 0);
  const totalInput = agents.reduce((sum, a) => sum + a.total_input_tokens, 0);
  const totalOutput = agents.reduce((sum, a) => sum + a.total_output_tokens, 0);

  return {
    formation_session_id: sessionId,
    total_cost_cents: totalCost,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    agents,
  };
}

/**
 * Get all cost records for a formation session.
 */
export async function getFormationCosts(
  sessionId: string,
): Promise<FormationCostRecord[]> {
  return sql<FormationCostRecord[]>`
    SELECT * FROM formation_costs
    WHERE formation_session_id = ${sessionId}::uuid
    ORDER BY recorded_at ASC
  `;
}

/**
 * Get an agent's total spend across all formations in the current budget period.
 */
export async function getAgentSpend(agentId: string): Promise<{
  agent_id: string;
  total_cost_cents: number;
  total_input_tokens: number;
  total_output_tokens: number;
  dispatch_count: number;
}> {
  // Get the agent's budget period start (or start of current month)
  const [budget] = await sql<AgentBudget[]>`
    SELECT * FROM agent_budgets WHERE agent_id = ${agentId}::uuid
  `;

  const periodStart = budget
    ? new Date(budget.budget_period_start)
    : new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  const [spend] = await sql<{
    total_cost_cents: number;
    total_input_tokens: number;
    total_output_tokens: number;
    dispatch_count: number;
  }[]>`
    SELECT
      COALESCE(SUM(cost_cents), 0)::int AS total_cost_cents,
      COALESCE(SUM(input_tokens), 0)::int AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0)::int AS total_output_tokens,
      COUNT(*)::int AS dispatch_count
    FROM formation_costs
    WHERE agent_id = ${agentId}::uuid
      AND recorded_at >= ${periodStart.toISOString()}::timestamptz
  `;

  return {
    agent_id: agentId,
    ...spend,
  };
}
