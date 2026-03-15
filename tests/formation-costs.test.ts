/**
 * Formation Cost Tracking Tests — ELLIE-722
 *
 * Tests for per-agent and per-formation cost tracking:
 * - Migration SQL structure
 * - Type shapes and cost calculation
 * - Cost recording
 * - Budget checking (with auto-reset, uncapped, exceeded)
 * - Budget set/get/reset
 * - Formation cost breakdown
 * - Agent spend queries
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  calculateCostCents,
  MODEL_COST_RATES,
  type AgentBudget,
  type BudgetCheckResult,
  type FormationCostRecord,
  type RecordCostInput,
  type AgentCostBreakdown,
  type FormationCostBreakdown,
  type SetBudgetInput,
} from "../src/types/formation-costs.ts";

// ── Mock SQL Layer ──────────────────────────────────────────

type SqlRow = Record<string, unknown>;
type SqlResult = SqlRow[];

let sqlMockResults: SqlResult[] = [];
let sqlCallIndex = 0;
let sqlCalls: { strings: TemplateStringsArray; values: unknown[] }[] = [];

function resetSqlMock() {
  sqlMockResults = [];
  sqlCallIndex = 0;
  sqlCalls = [];
}

function pushSqlResult(rows: SqlResult) {
  sqlMockResults.push(rows);
}

const mockSql = Object.assign(
  function sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlResult> {
    sqlCalls.push({ strings, values });
    const result = sqlMockResults[sqlCallIndex] ?? [];
    sqlCallIndex++;
    return Promise.resolve(result);
  },
  { json: (v: unknown) => v, array: (v: unknown) => v },
);

mock.module("../../ellie-forest/src/index", () => ({
  sql: mockSql,
}));

const {
  recordCost,
  checkBudget,
  setBudget,
  getBudget,
  resetAllBudgets,
  resetBudget,
  getFormationCostBreakdown,
  getFormationCosts,
  getAgentSpend,
} = await import("../src/formation-costs.ts");

// ── Setup ───────────────────────────────────────────────────

beforeEach(() => {
  resetSqlMock();
});

// ── Migration SQL ───────────────────────────────────────────

describe("migration SQL", () => {
  const migrationPath = join(
    import.meta.dir,
    "../migrations/supabase/20260315_formation_costs.sql",
  );

  function readMigration(): string {
    return readFileSync(migrationPath, "utf-8");
  }

  test("migration file exists", () => {
    const sql = readMigration();
    expect(sql.length).toBeGreaterThan(0);
  });

  test("creates agent_budgets table", () => {
    const sql = readMigration();
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS agent_budgets");
  });

  test("agent_budgets has agent_id PK with FK to agents", () => {
    const sql = readMigration();
    expect(sql).toContain("agent_id UUID PRIMARY KEY REFERENCES agents(id)");
  });

  test("agent_budgets has monthly_budget_cents", () => {
    const sql = readMigration();
    expect(sql).toContain("monthly_budget_cents INTEGER");
  });

  test("agent_budgets has spent_this_month_cents", () => {
    const sql = readMigration();
    expect(sql).toContain("spent_this_month_cents INTEGER");
  });

  test("agent_budgets has budget_period_start", () => {
    const sql = readMigration();
    expect(sql).toContain("budget_period_start TIMESTAMPTZ");
  });

  test("creates formation_costs table", () => {
    const sql = readMigration();
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS formation_costs");
  });

  test("formation_costs has FK to formation_sessions", () => {
    const sql = readMigration();
    expect(sql).toContain("REFERENCES formation_sessions(id)");
  });

  test("formation_costs has FK to agents", () => {
    const sql = readMigration();
    expect(sql).toContain("REFERENCES agents(id)");
  });

  test("formation_costs has token columns", () => {
    const sql = readMigration();
    expect(sql).toContain("input_tokens INTEGER");
    expect(sql).toContain("output_tokens INTEGER");
  });

  test("formation_costs has cost_cents column", () => {
    const sql = readMigration();
    expect(sql).toContain("cost_cents INTEGER");
  });

  test("formation_costs has model column", () => {
    const sql = readMigration();
    expect(sql).toContain("model TEXT");
  });

  test("has indexes for session, agent, and recorded_at lookups", () => {
    const sql = readMigration();
    expect(sql).toContain("idx_formation_costs_session");
    expect(sql).toContain("idx_formation_costs_agent");
    expect(sql).toContain("idx_formation_costs_recorded");
    expect(sql).toContain("idx_formation_costs_session_agent");
  });

  test("has RLS enabled", () => {
    const sql = readMigration();
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
  });

  test("has ON DELETE CASCADE for formation_session_id", () => {
    const sql = readMigration();
    expect(sql).toContain("ON DELETE CASCADE");
  });
});

// ── calculateCostCents ──────────────────────────────────────

describe("calculateCostCents", () => {
  test("calculates haiku cost correctly", () => {
    // 1M input tokens * 80 cents/Mtok + 1M output tokens * 400 cents/Mtok = 480 cents
    const cost = calculateCostCents(1_000_000, 1_000_000, "claude-haiku-4-5-20251001");
    expect(cost).toBe(480);
  });

  test("calculates sonnet cost correctly", () => {
    // 1M input * 300 + 1M output * 1500 = 1800 cents
    const cost = calculateCostCents(1_000_000, 1_000_000, "claude-sonnet-4-5-20250929");
    expect(cost).toBe(1800);
  });

  test("calculates opus cost correctly", () => {
    // 1M input * 1500 + 1M output * 7500 = 9000 cents
    const cost = calculateCostCents(1_000_000, 1_000_000, "claude-opus-4-6");
    expect(cost).toBe(9000);
  });

  test("rounds up to nearest cent", () => {
    // Small token count: 100 input * 300/1M = 0.03 cents → rounds up to 1
    const cost = calculateCostCents(100, 0, "claude-sonnet-4-5-20250929");
    expect(cost).toBe(1);
  });

  test("returns 0 for unknown model", () => {
    const cost = calculateCostCents(1_000_000, 1_000_000, "unknown-model");
    expect(cost).toBe(0);
  });

  test("returns 0 for zero tokens", () => {
    const cost = calculateCostCents(0, 0, "claude-sonnet-4-5-20250929");
    expect(cost).toBe(0);
  });

  test("handles typical dispatch sizes", () => {
    // Typical: 5000 input, 2000 output on sonnet
    // 5000 * 300/1M + 2000 * 1500/1M = 1.5 + 3.0 = 4.5 → 5 cents
    const cost = calculateCostCents(5000, 2000, "claude-sonnet-4-5-20250929");
    expect(cost).toBe(5);
  });
});

// ── MODEL_COST_RATES ────────────────────────────────────────

describe("MODEL_COST_RATES", () => {
  test("has rates for haiku", () => {
    expect(MODEL_COST_RATES["claude-haiku-4-5-20251001"]).toBeDefined();
  });

  test("has rates for sonnet", () => {
    expect(MODEL_COST_RATES["claude-sonnet-4-5-20250929"]).toBeDefined();
    expect(MODEL_COST_RATES["claude-sonnet-4-6"]).toBeDefined();
  });

  test("has rates for opus", () => {
    expect(MODEL_COST_RATES["claude-opus-4-6"]).toBeDefined();
  });

  test("output costs more than input for all models", () => {
    for (const [, rates] of Object.entries(MODEL_COST_RATES)) {
      expect(rates.output_cents_per_mtok).toBeGreaterThan(rates.input_cents_per_mtok);
    }
  });
});

// ── Type Shapes ─────────────────────────────────────────────

describe("type shapes", () => {
  test("AgentBudget has all expected fields", () => {
    const budget: AgentBudget = {
      agent_id: "test-agent",
      created_at: new Date(),
      updated_at: new Date(),
      monthly_budget_cents: 5000,
      spent_this_month_cents: 1200,
      budget_period_start: new Date(),
    };
    expect(budget.monthly_budget_cents).toBe(5000);
    expect(budget.spent_this_month_cents).toBe(1200);
  });

  test("FormationCostRecord has all expected fields", () => {
    const record: FormationCostRecord = {
      id: "cost-id",
      formation_session_id: "session-id",
      agent_id: "agent-id",
      input_tokens: 5000,
      output_tokens: 2000,
      cost_cents: 5,
      model: "claude-sonnet-4-5-20250929",
      recorded_at: new Date(),
      metadata: {},
    };
    expect(record.input_tokens).toBe(5000);
    expect(record.cost_cents).toBe(5);
  });

  test("BudgetCheckResult has reason when not allowed", () => {
    const result: BudgetCheckResult = {
      allowed: false,
      agent_id: "agent-id",
      monthly_budget_cents: 5000,
      spent_this_month_cents: 5100,
      remaining_cents: 0,
      reason: "Budget exceeded",
    };
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
  });

  test("FormationCostBreakdown aggregates agents", () => {
    const breakdown: FormationCostBreakdown = {
      formation_session_id: "session-id",
      total_cost_cents: 150,
      total_input_tokens: 50000,
      total_output_tokens: 20000,
      agents: [
        { agent_id: "a1", total_input_tokens: 30000, total_output_tokens: 12000, total_cost_cents: 90, dispatch_count: 3 },
        { agent_id: "a2", total_input_tokens: 20000, total_output_tokens: 8000, total_cost_cents: 60, dispatch_count: 2 },
      ],
    };
    expect(breakdown.agents).toHaveLength(2);
    expect(breakdown.total_cost_cents).toBe(150);
  });
});

// ── recordCost ──────────────────────────────────────────────

describe("recordCost", () => {
  const input: RecordCostInput = {
    formation_session_id: "sess-1",
    agent_id: "agent-1",
    input_tokens: 5000,
    output_tokens: 2000,
    cost_cents: 5,
    model: "claude-sonnet-4-5-20250929",
  };

  test("inserts cost record and returns it", async () => {
    const now = new Date();
    pushSqlResult([{
      id: "cost-1",
      formation_session_id: "sess-1",
      agent_id: "agent-1",
      input_tokens: 5000,
      output_tokens: 2000,
      cost_cents: 5,
      model: "claude-sonnet-4-5-20250929",
      recorded_at: now,
      metadata: {},
    }]);
    // UPDATE agent_budgets
    pushSqlResult([]);

    const record = await recordCost(input);
    expect(record.id).toBe("cost-1");
    expect(record.cost_cents).toBe(5);
    expect(record.input_tokens).toBe(5000);
  });

  test("increments agent_budgets spent_this_month_cents", async () => {
    pushSqlResult([{
      id: "cost-1", formation_session_id: "sess-1", agent_id: "agent-1",
      input_tokens: 5000, output_tokens: 2000, cost_cents: 5,
      model: "claude-sonnet-4-5-20250929", recorded_at: new Date(), metadata: {},
    }]);
    pushSqlResult([]);

    await recordCost(input);

    // Second SQL call should be the UPDATE to agent_budgets
    expect(sqlCalls).toHaveLength(2);
    const updateSql = sqlCalls[1].strings.join("?");
    expect(updateSql).toContain("UPDATE agent_budgets");
    expect(updateSql).toContain("spent_this_month_cents = spent_this_month_cents +");
  });

  test("passes cost_cents value to budget increment", async () => {
    pushSqlResult([{
      id: "cost-1", formation_session_id: "sess-1", agent_id: "agent-1",
      input_tokens: 5000, output_tokens: 2000, cost_cents: 42,
      model: "claude-sonnet-4-5-20250929", recorded_at: new Date(), metadata: {},
    }]);
    pushSqlResult([]);

    await recordCost({ ...input, cost_cents: 42 });

    // The cost_cents value should be in the UPDATE parameters
    expect(sqlCalls[1].values).toContain(42);
  });

  test("handles null model", async () => {
    pushSqlResult([{
      id: "cost-1", formation_session_id: "sess-1", agent_id: "agent-1",
      input_tokens: 5000, output_tokens: 2000, cost_cents: 0,
      model: null, recorded_at: new Date(), metadata: {},
    }]);
    pushSqlResult([]);

    const record = await recordCost({
      formation_session_id: "sess-1",
      agent_id: "agent-1",
      input_tokens: 5000,
      output_tokens: 2000,
      cost_cents: 0,
    });
    expect(record.model).toBeNull();
  });
});

// ── checkBudget ─────────────────────────────────────────────

describe("checkBudget", () => {
  const agentId = "agent-1";

  test("allows uncapped agent (no budget row)", async () => {
    pushSqlResult([]); // No budget row

    const result = await checkBudget(agentId);
    expect(result.allowed).toBe(true);
    expect(result.remaining_cents).toBe(Infinity);
  });

  test("allows agent with budget remaining", async () => {
    pushSqlResult([{
      agent_id: agentId,
      created_at: new Date(),
      updated_at: new Date(),
      monthly_budget_cents: 5000,
      spent_this_month_cents: 1200,
      budget_period_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    }]);

    const result = await checkBudget(agentId);
    expect(result.allowed).toBe(true);
    expect(result.remaining_cents).toBe(3800);
    expect(result.monthly_budget_cents).toBe(5000);
    expect(result.spent_this_month_cents).toBe(1200);
  });

  test("blocks agent when budget exceeded", async () => {
    pushSqlResult([{
      agent_id: agentId,
      created_at: new Date(),
      updated_at: new Date(),
      monthly_budget_cents: 5000,
      spent_this_month_cents: 5100,
      budget_period_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    }]);

    const result = await checkBudget(agentId);
    expect(result.allowed).toBe(false);
    expect(result.remaining_cents).toBe(0);
    expect(result.reason).toContain("exceeded");
  });

  test("blocks agent when budget exactly at limit", async () => {
    pushSqlResult([{
      agent_id: agentId,
      created_at: new Date(),
      updated_at: new Date(),
      monthly_budget_cents: 5000,
      spent_this_month_cents: 5000,
      budget_period_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    }]);

    const result = await checkBudget(agentId);
    expect(result.allowed).toBe(false);
    expect(result.remaining_cents).toBe(0);
  });

  test("allows agent with zero budget (uncapped)", async () => {
    pushSqlResult([{
      agent_id: agentId,
      created_at: new Date(),
      updated_at: new Date(),
      monthly_budget_cents: 0,
      spent_this_month_cents: 99999,
      budget_period_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    }]);

    const result = await checkBudget(agentId);
    expect(result.allowed).toBe(true);
    expect(result.remaining_cents).toBe(Infinity);
  });

  test("auto-resets budget when period has rolled over", async () => {
    // Budget period from last month
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    lastMonth.setDate(1);

    pushSqlResult([{
      agent_id: agentId,
      created_at: new Date(),
      updated_at: new Date(),
      monthly_budget_cents: 5000,
      spent_this_month_cents: 4500,
      budget_period_start: lastMonth,
    }]);
    // UPDATE for reset
    pushSqlResult([]);

    const result = await checkBudget(agentId);
    expect(result.allowed).toBe(true);
    // After reset, spent should be 0 and remaining should be full budget
    expect(result.spent_this_month_cents).toBe(0);
    expect(result.remaining_cents).toBe(5000);
  });

  test("auto-reset issues UPDATE to clear spent amount", async () => {
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    lastMonth.setDate(1);

    pushSqlResult([{
      agent_id: agentId,
      created_at: new Date(),
      updated_at: new Date(),
      monthly_budget_cents: 5000,
      spent_this_month_cents: 4500,
      budget_period_start: lastMonth,
    }]);
    pushSqlResult([]);

    await checkBudget(agentId);

    // Should have issued an UPDATE to reset
    expect(sqlCalls).toHaveLength(2);
    const updateSql = sqlCalls[1].strings.join("?");
    expect(updateSql).toContain("UPDATE agent_budgets");
    expect(updateSql).toContain("spent_this_month_cents = 0");
  });
});

// ── setBudget ───────────────────────────────────────────────

describe("setBudget", () => {
  test("upserts budget and returns it", async () => {
    pushSqlResult([{
      agent_id: "agent-1",
      created_at: new Date(),
      updated_at: new Date(),
      monthly_budget_cents: 10000,
      spent_this_month_cents: 0,
      budget_period_start: new Date(),
    }]);

    const budget = await setBudget({ agent_id: "agent-1", monthly_budget_cents: 10000 });
    expect(budget.monthly_budget_cents).toBe(10000);
  });

  test("uses ON CONFLICT for upsert", async () => {
    pushSqlResult([{
      agent_id: "agent-1",
      created_at: new Date(),
      updated_at: new Date(),
      monthly_budget_cents: 10000,
      spent_this_month_cents: 0,
      budget_period_start: new Date(),
    }]);

    await setBudget({ agent_id: "agent-1", monthly_budget_cents: 10000 });

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("ON CONFLICT");
    expect(sqlText).toContain("DO UPDATE SET");
  });
});

// ── getBudget ───────────────────────────────────────────────

describe("getBudget", () => {
  test("returns budget when found", async () => {
    pushSqlResult([{
      agent_id: "agent-1",
      created_at: new Date(),
      updated_at: new Date(),
      monthly_budget_cents: 5000,
      spent_this_month_cents: 200,
      budget_period_start: new Date(),
    }]);

    const budget = await getBudget("agent-1");
    expect(budget).not.toBeNull();
    expect(budget!.monthly_budget_cents).toBe(5000);
  });

  test("returns null when not found", async () => {
    pushSqlResult([]);

    const budget = await getBudget("nonexistent");
    expect(budget).toBeNull();
  });
});

// ── resetAllBudgets ─────────────────────────────────────────

describe("resetAllBudgets", () => {
  test("resets stale budget periods and returns count", async () => {
    pushSqlResult([
      { agent_id: "agent-1" },
      { agent_id: "agent-2" },
    ]);

    const count = await resetAllBudgets();
    expect(count).toBe(2);
  });

  test("returns 0 when no budgets need reset", async () => {
    pushSqlResult([]);

    const count = await resetAllBudgets();
    expect(count).toBe(0);
  });

  test("only resets budgets with old period_start", async () => {
    pushSqlResult([]);

    await resetAllBudgets();

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("budget_period_start <");
    expect(sqlText).toContain("spent_this_month_cents = 0");
  });
});

// ── resetBudget ─────────────────────────────────────────────

describe("resetBudget", () => {
  test("resets a single agent budget", async () => {
    pushSqlResult([{
      agent_id: "agent-1",
      created_at: new Date(),
      updated_at: new Date(),
      monthly_budget_cents: 5000,
      spent_this_month_cents: 0,
      budget_period_start: new Date(),
    }]);

    const budget = await resetBudget("agent-1");
    expect(budget).not.toBeNull();
    expect(budget!.spent_this_month_cents).toBe(0);
  });

  test("returns null if agent has no budget", async () => {
    pushSqlResult([]);

    const budget = await resetBudget("nonexistent");
    expect(budget).toBeNull();
  });
});

// ── getFormationCostBreakdown ───────────────────────────────

describe("getFormationCostBreakdown", () => {
  test("aggregates per-agent costs", async () => {
    pushSqlResult([
      { agent_id: "dev", total_input_tokens: 30000, total_output_tokens: 12000, total_cost_cents: 90, dispatch_count: 3 },
      { agent_id: "critic", total_input_tokens: 20000, total_output_tokens: 8000, total_cost_cents: 60, dispatch_count: 2 },
    ]);

    const breakdown = await getFormationCostBreakdown("sess-1");
    expect(breakdown.formation_session_id).toBe("sess-1");
    expect(breakdown.total_cost_cents).toBe(150);
    expect(breakdown.total_input_tokens).toBe(50000);
    expect(breakdown.total_output_tokens).toBe(20000);
    expect(breakdown.agents).toHaveLength(2);
    expect(breakdown.agents[0].agent_id).toBe("dev");
    expect(breakdown.agents[0].dispatch_count).toBe(3);
  });

  test("returns zero totals for empty session", async () => {
    pushSqlResult([]);

    const breakdown = await getFormationCostBreakdown("sess-empty");
    expect(breakdown.total_cost_cents).toBe(0);
    expect(breakdown.total_input_tokens).toBe(0);
    expect(breakdown.total_output_tokens).toBe(0);
    expect(breakdown.agents).toHaveLength(0);
  });

  test("SQL groups by agent_id and orders by cost DESC", async () => {
    pushSqlResult([]);

    await getFormationCostBreakdown("sess-1");

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("GROUP BY agent_id");
    expect(sqlText).toContain("ORDER BY total_cost_cents DESC");
  });
});

// ── getFormationCosts ───────────────────────────────────────

describe("getFormationCosts", () => {
  test("returns all cost records for a session", async () => {
    const now = new Date();
    pushSqlResult([
      { id: "c1", formation_session_id: "sess-1", agent_id: "dev", input_tokens: 5000, output_tokens: 2000, cost_cents: 5, model: "claude-sonnet-4-5-20250929", recorded_at: now, metadata: {} },
      { id: "c2", formation_session_id: "sess-1", agent_id: "critic", input_tokens: 3000, output_tokens: 1000, cost_cents: 3, model: "claude-sonnet-4-5-20250929", recorded_at: now, metadata: {} },
    ]);

    const costs = await getFormationCosts("sess-1");
    expect(costs).toHaveLength(2);
  });

  test("orders by recorded_at ASC", async () => {
    pushSqlResult([]);

    await getFormationCosts("sess-1");

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("ORDER BY recorded_at ASC");
  });
});

// ── getAgentSpend ───────────────────────────────────────────

describe("getAgentSpend", () => {
  test("returns agent spend with budget period context", async () => {
    // Budget query
    pushSqlResult([{
      agent_id: "agent-1",
      created_at: new Date(),
      updated_at: new Date(),
      monthly_budget_cents: 5000,
      spent_this_month_cents: 1200,
      budget_period_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    }]);
    // Spend aggregation
    pushSqlResult([{
      total_cost_cents: 1200,
      total_input_tokens: 500000,
      total_output_tokens: 200000,
      dispatch_count: 45,
    }]);

    const spend = await getAgentSpend("agent-1");
    expect(spend.agent_id).toBe("agent-1");
    expect(spend.total_cost_cents).toBe(1200);
    expect(spend.dispatch_count).toBe(45);
  });

  test("falls back to current month start when no budget row", async () => {
    pushSqlResult([]); // No budget row
    pushSqlResult([{
      total_cost_cents: 300,
      total_input_tokens: 100000,
      total_output_tokens: 50000,
      dispatch_count: 10,
    }]);

    const spend = await getAgentSpend("agent-1");
    expect(spend.total_cost_cents).toBe(300);

    // The spend query should filter by recorded_at >= start of current month
    const spendSql = sqlCalls[1].strings.join("?");
    expect(spendSql).toContain("recorded_at >=");
  });
});

// ── E2E: Full Cost Lifecycle ────────────────────────────────

describe("E2E: cost tracking lifecycle", () => {
  test("set budget → check → record cost → check again", async () => {
    // Step 1: Set budget
    pushSqlResult([{
      agent_id: "dev",
      created_at: new Date(),
      updated_at: new Date(),
      monthly_budget_cents: 1000,
      spent_this_month_cents: 0,
      budget_period_start: new Date(),
    }]);
    const budget = await setBudget({ agent_id: "dev", monthly_budget_cents: 1000 });
    expect(budget.monthly_budget_cents).toBe(1000);

    resetSqlMock();

    // Step 2: Check budget (should be allowed)
    pushSqlResult([{
      agent_id: "dev",
      created_at: new Date(),
      updated_at: new Date(),
      monthly_budget_cents: 1000,
      spent_this_month_cents: 0,
      budget_period_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    }]);
    const check1 = await checkBudget("dev");
    expect(check1.allowed).toBe(true);
    expect(check1.remaining_cents).toBe(1000);

    resetSqlMock();

    // Step 3: Record a cost
    pushSqlResult([{
      id: "cost-1", formation_session_id: "sess-1", agent_id: "dev",
      input_tokens: 100000, output_tokens: 50000, cost_cents: 800,
      model: "claude-opus-4-6", recorded_at: new Date(), metadata: {},
    }]);
    pushSqlResult([]); // budget update
    await recordCost({
      formation_session_id: "sess-1",
      agent_id: "dev",
      input_tokens: 100000,
      output_tokens: 50000,
      cost_cents: 800,
      model: "claude-opus-4-6",
    });

    resetSqlMock();

    // Step 4: Check budget again (should still be allowed but less remaining)
    pushSqlResult([{
      agent_id: "dev",
      created_at: new Date(),
      updated_at: new Date(),
      monthly_budget_cents: 1000,
      spent_this_month_cents: 800,
      budget_period_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    }]);
    const check2 = await checkBudget("dev");
    expect(check2.allowed).toBe(true);
    expect(check2.remaining_cents).toBe(200);

    resetSqlMock();

    // Step 5: Record another cost that exceeds budget
    pushSqlResult([{
      id: "cost-2", formation_session_id: "sess-1", agent_id: "dev",
      input_tokens: 50000, output_tokens: 25000, cost_cents: 300,
      model: "claude-opus-4-6", recorded_at: new Date(), metadata: {},
    }]);
    pushSqlResult([]);
    await recordCost({
      formation_session_id: "sess-1",
      agent_id: "dev",
      input_tokens: 50000,
      output_tokens: 25000,
      cost_cents: 300,
      model: "claude-opus-4-6",
    });

    resetSqlMock();

    // Step 6: Check budget (should be blocked)
    pushSqlResult([{
      agent_id: "dev",
      created_at: new Date(),
      updated_at: new Date(),
      monthly_budget_cents: 1000,
      spent_this_month_cents: 1100,
      budget_period_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    }]);
    const check3 = await checkBudget("dev");
    expect(check3.allowed).toBe(false);
    expect(check3.remaining_cents).toBe(0);
    expect(check3.reason).toContain("exceeded");
  });

  test("budget reset → allows agent again", async () => {
    // Budget is exceeded
    pushSqlResult([{
      agent_id: "dev",
      created_at: new Date(),
      updated_at: new Date(),
      monthly_budget_cents: 1000,
      spent_this_month_cents: 1100,
      budget_period_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    }]);
    const check1 = await checkBudget("dev");
    expect(check1.allowed).toBe(false);

    resetSqlMock();

    // Reset budget
    pushSqlResult([{
      agent_id: "dev",
      created_at: new Date(),
      updated_at: new Date(),
      monthly_budget_cents: 1000,
      spent_this_month_cents: 0,
      budget_period_start: new Date(),
    }]);
    const reset = await resetBudget("dev");
    expect(reset!.spent_this_month_cents).toBe(0);

    resetSqlMock();

    // Now allowed
    pushSqlResult([{
      agent_id: "dev",
      created_at: new Date(),
      updated_at: new Date(),
      monthly_budget_cents: 1000,
      spent_this_month_cents: 0,
      budget_period_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    }]);
    const check2 = await checkBudget("dev");
    expect(check2.allowed).toBe(true);
    expect(check2.remaining_cents).toBe(1000);
  });

  test("formation breakdown with multiple agents", async () => {
    pushSqlResult([
      { agent_id: "dev", total_input_tokens: 100000, total_output_tokens: 50000, total_cost_cents: 800, dispatch_count: 4 },
      { agent_id: "critic", total_input_tokens: 60000, total_output_tokens: 30000, total_cost_cents: 480, dispatch_count: 3 },
      { agent_id: "strategy", total_input_tokens: 40000, total_output_tokens: 20000, total_cost_cents: 320, dispatch_count: 2 },
    ]);

    const breakdown = await getFormationCostBreakdown("sess-1");
    expect(breakdown.total_cost_cents).toBe(1600);
    expect(breakdown.agents).toHaveLength(3);
    // Ordered by cost DESC
    expect(breakdown.agents[0].agent_id).toBe("dev");
    expect(breakdown.agents[2].agent_id).toBe("strategy");
  });
});

// ── SQL Safety ──────────────────────────────────────────────

describe("SQL safety", () => {
  test("recordCost uses parameterized queries", async () => {
    pushSqlResult([{
      id: "c1", formation_session_id: "sess-1", agent_id: "agent-1",
      input_tokens: 5000, output_tokens: 2000, cost_cents: 5,
      model: "claude-sonnet-4-5-20250929", recorded_at: new Date(), metadata: {},
    }]);
    pushSqlResult([]);

    await recordCost({
      formation_session_id: "sess-1",
      agent_id: "agent-1",
      input_tokens: 5000,
      output_tokens: 2000,
      cost_cents: 5,
      model: "claude-sonnet-4-5-20250929",
    });

    const insertCall = sqlCalls[0];
    const rawSql = insertCall.strings.join("");
    // UUIDs should be parameters, not interpolated
    expect(rawSql).not.toContain("sess-1");
    expect(rawSql).not.toContain("agent-1");
  });

  test("checkBudget uses parameterized queries", async () => {
    pushSqlResult([]);

    await checkBudget("agent-1");

    const rawSql = sqlCalls[0].strings.join("");
    expect(rawSql).not.toContain("agent-1");
    expect(sqlCalls[0].values).toContain("agent-1");
  });
});
