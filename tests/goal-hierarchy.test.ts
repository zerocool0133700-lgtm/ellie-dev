/**
 * Goal Hierarchy Integration Tests — ELLIE-731
 *
 * Tests for goal-formation linkage:
 * - Migration SQL structure
 * - Type shapes and constants
 * - Goal CRUD
 * - Goal hierarchy (ancestry, children, company roots)
 * - Formation-goal linkage
 * - Progress tracking (update, increment, isGoalMet, percent)
 * - Prompt builder (pure)
 * - E2E lifecycle (ticket example)
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import type { Goal, GoalAncestryEntry } from "../src/goal-hierarchy.ts";

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
  createGoal,
  getGoal,
  updateGoalProgress,
  incrementGoalProgress,
  updateGoalStatus,
  getGoalAncestry,
  getChildGoals,
  getCompanyGoals,
  linkFormationToGoal,
  getFormationsForGoal,
  buildGoalPromptContext,
  isGoalMet,
  goalProgressPercent,
  VALID_GOAL_LEVELS,
  VALID_GOAL_STATUSES,
} = await import("../src/goal-hierarchy.ts");

// ── Setup ───────────────────────────────────────────────────

beforeEach(() => {
  resetSqlMock();
});

// ── Helpers ─────────────────────────────────────────────────

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    created_at: new Date(),
    updated_at: new Date(),
    company_id: "comp-1",
    parent_goal_id: null,
    title: "Build profitable billing business",
    description: null,
    level: "company",
    status: "active",
    target_metric: "monthly_revenue",
    target_value: 50000,
    current_value: 12000,
    unit: "cents",
    due_date: null,
    metadata: {},
    ...overrides,
  };
}

// ── Migration SQL ───────────────────────────────────────────

describe("migration SQL", () => {
  function readMigration(): string {
    return readFileSync(
      join(import.meta.dir, "../migrations/supabase/20260315_goal_hierarchy.sql"),
      "utf-8",
    );
  }

  test("creates goals table", () => {
    expect(readMigration()).toContain("CREATE TABLE IF NOT EXISTS goals");
  });

  test("has company_id FK", () => {
    expect(readMigration()).toContain("company_id UUID NOT NULL REFERENCES companies(id)");
  });

  test("has self-referential parent_goal_id", () => {
    expect(readMigration()).toContain("parent_goal_id UUID REFERENCES goals(id)");
  });

  test("has level CHECK constraint", () => {
    const sql = readMigration();
    expect(sql).toContain("'company'");
    expect(sql).toContain("'team'");
    expect(sql).toContain("'individual'");
  });

  test("has status CHECK constraint", () => {
    const sql = readMigration();
    expect(sql).toContain("'active'");
    expect(sql).toContain("'paused'");
    expect(sql).toContain("'completed'");
    expect(sql).toContain("'abandoned'");
  });

  test("has target metric columns", () => {
    const sql = readMigration();
    expect(sql).toContain("target_metric TEXT");
    expect(sql).toContain("target_value NUMERIC");
    expect(sql).toContain("current_value NUMERIC");
    expect(sql).toContain("unit TEXT");
  });

  test("adds goal_id to formation_sessions", () => {
    const sql = readMigration();
    expect(sql).toContain("ALTER TABLE formation_sessions");
    expect(sql).toContain("goal_id UUID REFERENCES goals(id)");
  });

  test("has indexes for company, parent, level, status", () => {
    const sql = readMigration();
    expect(sql).toContain("idx_goals_company");
    expect(sql).toContain("idx_goals_parent");
    expect(sql).toContain("idx_goals_level");
    expect(sql).toContain("idx_goals_status");
  });

  test("has RLS enabled", () => {
    expect(readMigration()).toContain("ENABLE ROW LEVEL SECURITY");
  });
});

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("VALID_GOAL_LEVELS", () => {
    expect(VALID_GOAL_LEVELS).toContain("company");
    expect(VALID_GOAL_LEVELS).toContain("team");
    expect(VALID_GOAL_LEVELS).toContain("individual");
    expect(VALID_GOAL_LEVELS).toHaveLength(3);
  });

  test("VALID_GOAL_STATUSES", () => {
    expect(VALID_GOAL_STATUSES).toContain("active");
    expect(VALID_GOAL_STATUSES).toContain("paused");
    expect(VALID_GOAL_STATUSES).toContain("completed");
    expect(VALID_GOAL_STATUSES).toContain("abandoned");
    expect(VALID_GOAL_STATUSES).toHaveLength(4);
  });
});

// ── createGoal ──────────────────────────────────────────────

describe("createGoal", () => {
  test("creates and returns goal", async () => {
    pushSqlResult([makeGoal()]);

    const goal = await createGoal({
      company_id: "comp-1",
      title: "Build profitable billing business",
      level: "company",
      target_metric: "monthly_revenue",
      target_value: 50000,
      unit: "cents",
    });
    expect(goal.title).toBe("Build profitable billing business");
    expect(goal.level).toBe("company");
  });

  test("defaults to team level", async () => {
    pushSqlResult([makeGoal({ level: "team" })]);

    await createGoal({ company_id: "comp-1", title: "Test" });

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("INSERT INTO goals");
  });
});

// ── getGoal ─────────────────────────────────────────────────

describe("getGoal", () => {
  test("returns goal when found", async () => {
    pushSqlResult([makeGoal()]);
    const goal = await getGoal("goal-1");
    expect(goal).not.toBeNull();
  });

  test("returns null when not found", async () => {
    pushSqlResult([]);
    expect(await getGoal("nonexistent")).toBeNull();
  });
});

// ── Progress Tracking ───────────────────────────────────────

describe("updateGoalProgress", () => {
  test("sets current_value", async () => {
    pushSqlResult([makeGoal({ current_value: 25000 })]);
    const goal = await updateGoalProgress("goal-1", 25000);
    expect(goal!.current_value).toBe(25000);
  });

  test("returns null for nonexistent goal", async () => {
    pushSqlResult([]);
    expect(await updateGoalProgress("nonexistent", 100)).toBeNull();
  });
});

describe("incrementGoalProgress", () => {
  test("increments current_value", async () => {
    pushSqlResult([makeGoal({ current_value: 12500 })]);
    const goal = await incrementGoalProgress("goal-1", 500);
    expect(goal!.current_value).toBe(12500);

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("current_value = current_value +");
  });
});

describe("updateGoalStatus", () => {
  test("updates status", async () => {
    pushSqlResult([makeGoal({ status: "completed" })]);
    const goal = await updateGoalStatus("goal-1", "completed");
    expect(goal!.status).toBe("completed");
  });
});

// ── isGoalMet (Pure) ────────────────────────────────────────

describe("isGoalMet", () => {
  test("returns true when current >= target", () => {
    expect(isGoalMet({ target_value: 100, current_value: 100 })).toBe(true);
    expect(isGoalMet({ target_value: 100, current_value: 150 })).toBe(true);
  });

  test("returns false when current < target", () => {
    expect(isGoalMet({ target_value: 100, current_value: 50 })).toBe(false);
  });

  test("returns false when no target", () => {
    expect(isGoalMet({ target_value: null, current_value: 50 })).toBe(false);
  });
});

// ── goalProgressPercent (Pure) ──────────────────────────────

describe("goalProgressPercent", () => {
  test("calculates percentage", () => {
    expect(goalProgressPercent({ target_value: 100, current_value: 50 })).toBe(50);
    expect(goalProgressPercent({ target_value: 200, current_value: 100 })).toBe(50);
  });

  test("caps at 100%", () => {
    expect(goalProgressPercent({ target_value: 100, current_value: 150 })).toBe(100);
  });

  test("returns 0 when no target", () => {
    expect(goalProgressPercent({ target_value: null, current_value: 50 })).toBe(0);
    expect(goalProgressPercent({ target_value: 0, current_value: 50 })).toBe(0);
  });

  test("rounds to nearest integer", () => {
    expect(goalProgressPercent({ target_value: 3, current_value: 1 })).toBe(33);
  });
});

// ── Hierarchy Queries ───────────────────────────────────────

describe("getGoalAncestry", () => {
  test("returns ancestry chain via recursive CTE", async () => {
    pushSqlResult([
      { id: "g1", title: "Build billing business", level: "company", target_metric: "revenue", target_value: 50000, current_value: 12000, unit: "cents", depth: 1 },
      { id: "g2", title: "Process 10k claims/month", level: "team", target_metric: "claims", target_value: 10000, current_value: 3000, unit: "claims", depth: 0 },
    ]);

    const ancestry = await getGoalAncestry("g2");
    expect(ancestry).toHaveLength(2);
    expect(ancestry[0].level).toBe("company"); // depth DESC = company first
  });

  test("uses recursive CTE", async () => {
    pushSqlResult([]);
    await getGoalAncestry("g1");
    expect(sqlCalls[0].strings.join("?")).toContain("WITH RECURSIVE");
  });
});

describe("getChildGoals", () => {
  test("returns children of a parent goal", async () => {
    pushSqlResult([
      makeGoal({ id: "g2", parent_goal_id: "g1", level: "team", title: "Team goal 1" }),
      makeGoal({ id: "g3", parent_goal_id: "g1", level: "team", title: "Team goal 2" }),
    ]);

    const children = await getChildGoals("g1");
    expect(children).toHaveLength(2);
  });
});

describe("getCompanyGoals", () => {
  test("returns company-level goals", async () => {
    pushSqlResult([makeGoal()]);
    const goals = await getCompanyGoals("comp-1");
    expect(goals).toHaveLength(1);

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("level = 'company'");
  });

  test("filters by status", async () => {
    pushSqlResult([]);
    await getCompanyGoals("comp-1", { status: "active" });

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("status =");
  });
});

// ── Formation Linkage ───────────────────────────────────────

describe("linkFormationToGoal", () => {
  test("updates formation_sessions with goal_id", async () => {
    pushSqlResult([]);
    await linkFormationToGoal("sess-1", "goal-1");

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("UPDATE formation_sessions");
    expect(sqlText).toContain("goal_id =");
  });
});

describe("getFormationsForGoal", () => {
  test("returns formations linked to a goal", async () => {
    pushSqlResult([
      { id: "s1", formation_name: "billing-ops", state: "completed", created_at: new Date() },
      { id: "s2", formation_name: "billing-ops", state: "active", created_at: new Date() },
    ]);

    const formations = await getFormationsForGoal("goal-1");
    expect(formations).toHaveLength(2);
  });
});

// ── buildGoalPromptContext (Pure) ────────────────────────────

describe("buildGoalPromptContext", () => {
  test("builds formatted prompt context from ancestry", () => {
    const ancestry: GoalAncestryEntry[] = [
      { id: "g1", title: "Build profitable billing business", level: "company", target_metric: "revenue", target_value: 50000, current_value: 12000, unit: "cents", depth: 0 },
      { id: "g2", title: "Process 10k claims/month", level: "team", target_metric: "claims", target_value: 10000, current_value: 3000, unit: "claims", depth: 1 },
    ];

    const prompt = buildGoalPromptContext(ancestry);
    expect(prompt).toContain("## Goal Context");
    expect(prompt).toContain("[company] Build profitable billing business");
    expect(prompt).toContain("12000/50000 cents");
    expect(prompt).toContain("[team] Process 10k claims/month");
    expect(prompt).toContain("3000/10000 claims");
    expect(prompt).toContain("advance the goals above");
  });

  test("returns empty string for no ancestry", () => {
    expect(buildGoalPromptContext([])).toBe("");
  });

  test("handles goals without targets", () => {
    const ancestry: GoalAncestryEntry[] = [
      { id: "g1", title: "Strategic direction", level: "company", target_metric: null, target_value: null, current_value: 0, unit: null, depth: 0 },
    ];

    const prompt = buildGoalPromptContext(ancestry);
    expect(prompt).toContain("[company] Strategic direction");
    expect(prompt).not.toContain("/");
  });

  test("indents by depth", () => {
    const ancestry: GoalAncestryEntry[] = [
      { id: "g1", title: "Root", level: "company", target_metric: null, target_value: null, current_value: 0, unit: null, depth: 0 },
      { id: "g2", title: "Child", level: "team", target_metric: null, target_value: null, current_value: 0, unit: null, depth: 1 },
      { id: "g3", title: "Grandchild", level: "individual", target_metric: null, target_value: null, current_value: 0, unit: null, depth: 2 },
    ];

    const prompt = buildGoalPromptContext(ancestry);
    expect(prompt).toContain("[company] Root");
    expect(prompt).toContain("  [team] Child");
    expect(prompt).toContain("    [individual] Grandchild");
  });
});

// ── E2E: Ticket Example ─────────────────────────────────────

describe("E2E: ticket example lifecycle", () => {
  test("company goal -> team goal -> link formation -> track progress", async () => {
    // Create company goal
    pushSqlResult([makeGoal({
      id: "cg-1",
      title: "Build profitable medical billing business",
      level: "company",
      target_metric: "monthly_revenue",
      target_value: 100000,
      current_value: 0,
      unit: "cents",
    })]);
    const companyGoal = await createGoal({
      company_id: "comp-1",
      title: "Build profitable medical billing business",
      level: "company",
      target_metric: "monthly_revenue",
      target_value: 100000,
      unit: "cents",
    });
    expect(companyGoal.level).toBe("company");

    resetSqlMock();

    // Create team goal under company goal
    pushSqlResult([makeGoal({
      id: "tg-1",
      parent_goal_id: "cg-1",
      title: "Process 10,000 claims/month with <2% denial rate",
      level: "team",
      target_metric: "claims_processed",
      target_value: 10000,
      current_value: 0,
      unit: "claims",
    })]);
    const teamGoal = await createGoal({
      company_id: "comp-1",
      parent_goal_id: "cg-1",
      title: "Process 10,000 claims/month with <2% denial rate",
      level: "team",
      target_metric: "claims_processed",
      target_value: 10000,
      unit: "claims",
    });
    expect(teamGoal.parent_goal_id).toBe("cg-1");

    resetSqlMock();

    // Link formation to team goal
    pushSqlResult([]);
    await linkFormationToGoal("sess-billing", "tg-1");

    resetSqlMock();

    // Get ancestry for prompt injection
    pushSqlResult([
      { id: "cg-1", title: "Build profitable medical billing business", level: "company", target_metric: "monthly_revenue", target_value: 100000, current_value: 15000, unit: "cents", depth: 1 },
      { id: "tg-1", title: "Process 10,000 claims/month", level: "team", target_metric: "claims_processed", target_value: 10000, current_value: 3200, unit: "claims", depth: 0 },
    ]);
    const ancestry = await getGoalAncestry("tg-1");

    // Build prompt (pure)
    const prompt = buildGoalPromptContext(ancestry);
    expect(prompt).toContain("Build profitable medical billing business");
    expect(prompt).toContain("Process 10,000 claims/month");
    expect(prompt).toContain("## Goal Context");

    resetSqlMock();

    // Formation completes — update progress
    pushSqlResult([makeGoal({ current_value: 3700 })]);
    const updated = await incrementGoalProgress("tg-1", 500);
    expect(updated!.current_value).toBe(3700);

    // Check progress
    expect(goalProgressPercent({ target_value: 10000, current_value: 3700 })).toBe(37);
    expect(isGoalMet({ target_value: 10000, current_value: 3700 })).toBe(false);
  });
});

// ── SQL Safety ──────────────────────────────────────────────

describe("SQL safety", () => {
  test("createGoal uses parameterized queries", async () => {
    pushSqlResult([makeGoal()]);
    await createGoal({ company_id: "comp-1", title: "Test" });

    const rawSql = sqlCalls[0].strings.join("");
    expect(rawSql).not.toContain("comp-1");
    expect(rawSql).not.toContain("Test");
  });

  test("getGoalAncestry uses parameterized queries", async () => {
    pushSqlResult([]);
    await getGoalAncestry("goal-1");
    expect(sqlCalls[0].values).toContain("goal-1");
  });
});
