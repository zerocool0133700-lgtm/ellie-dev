/**
 * Goal Hierarchy Integration — ELLIE-731
 *
 * Tie formation sessions to company/team goals.
 * Goal ancestry chain injected into facilitator prompts.
 * Progress tracking from formation outcomes.
 */

import { sql } from "../../ellie-forest/src/index";

// ── Types ────────────────────────────────────────────────────

export type GoalLevel = "company" | "team" | "individual";
export type GoalStatus = "active" | "paused" | "completed" | "abandoned";

export const VALID_GOAL_LEVELS = ["company", "team", "individual"] as const;
export const VALID_GOAL_STATUSES = ["active", "paused", "completed", "abandoned"] as const;

export interface Goal {
  id: string;
  created_at: Date;
  updated_at: Date;
  company_id: string;
  parent_goal_id: string | null;
  title: string;
  description: string | null;
  level: GoalLevel;
  status: GoalStatus;
  target_metric: string | null;
  target_value: number | null;
  current_value: number;
  unit: string | null;
  due_date: string | null;
  metadata: Record<string, unknown>;
}

export interface CreateGoalInput {
  company_id: string;
  title: string;
  description?: string;
  level?: GoalLevel;
  parent_goal_id?: string;
  target_metric?: string;
  target_value?: number;
  unit?: string;
  due_date?: string;
  metadata?: Record<string, unknown>;
}

/** A goal with its depth in the hierarchy (from recursive CTE). */
export interface GoalAncestryEntry {
  id: string;
  title: string;
  level: GoalLevel;
  target_metric: string | null;
  target_value: number | null;
  current_value: number;
  unit: string | null;
  depth: number;
}

// ── CRUD ────────────────────────────────────────────────────

export async function createGoal(input: CreateGoalInput): Promise<Goal> {
  const [goal] = await sql<Goal[]>`
    INSERT INTO goals (
      company_id, parent_goal_id, title, description, level,
      target_metric, target_value, unit, due_date, metadata
    )
    VALUES (
      ${input.company_id}::uuid,
      ${input.parent_goal_id ?? null}::uuid,
      ${input.title},
      ${input.description ?? null},
      ${input.level ?? "team"},
      ${input.target_metric ?? null},
      ${input.target_value ?? null},
      ${input.unit ?? null},
      ${input.due_date ?? null},
      ${sql.json(input.metadata ?? {})}
    )
    RETURNING *
  `;
  return goal;
}

export async function getGoal(goalId: string): Promise<Goal | null> {
  const [goal] = await sql<Goal[]>`SELECT * FROM goals WHERE id = ${goalId}::uuid`;
  return goal ?? null;
}

export async function updateGoalProgress(
  goalId: string,
  currentValue: number,
): Promise<Goal | null> {
  const [goal] = await sql<Goal[]>`
    UPDATE goals
    SET current_value = ${currentValue}, updated_at = NOW()
    WHERE id = ${goalId}::uuid
    RETURNING *
  `;
  return goal ?? null;
}

export async function incrementGoalProgress(
  goalId: string,
  delta: number,
): Promise<Goal | null> {
  const [goal] = await sql<Goal[]>`
    UPDATE goals
    SET current_value = current_value + ${delta}, updated_at = NOW()
    WHERE id = ${goalId}::uuid
    RETURNING *
  `;
  return goal ?? null;
}

export async function updateGoalStatus(
  goalId: string,
  status: GoalStatus,
): Promise<Goal | null> {
  const [goal] = await sql<Goal[]>`
    UPDATE goals SET status = ${status}, updated_at = NOW()
    WHERE id = ${goalId}::uuid
    RETURNING *
  `;
  return goal ?? null;
}

// ── Hierarchy Queries ───────────────────────────────────────

/**
 * Get the ancestry chain from a goal up to the root company goal.
 * Returns ordered from the leaf goal up to the top.
 */
export async function getGoalAncestry(goalId: string): Promise<GoalAncestryEntry[]> {
  return sql<GoalAncestryEntry[]>`
    WITH RECURSIVE ancestry AS (
      SELECT id, title, level, target_metric, target_value, current_value, unit,
             parent_goal_id, 0 AS depth
      FROM goals WHERE id = ${goalId}::uuid

      UNION ALL

      SELECT g.id, g.title, g.level, g.target_metric, g.target_value, g.current_value, g.unit,
             g.parent_goal_id, a.depth + 1
      FROM goals g
      INNER JOIN ancestry a ON g.id = a.parent_goal_id
    )
    SELECT id, title, level, target_metric, target_value, current_value, unit, depth
    FROM ancestry
    ORDER BY depth DESC
  `;
}

/**
 * Get child goals of a parent.
 */
export async function getChildGoals(parentGoalId: string): Promise<Goal[]> {
  return sql<Goal[]>`
    SELECT * FROM goals
    WHERE parent_goal_id = ${parentGoalId}::uuid
    ORDER BY level, title
  `;
}

/**
 * Get root goals (company-level) for a company.
 */
export async function getCompanyGoals(
  companyId: string,
  opts: { status?: GoalStatus } = {},
): Promise<Goal[]> {
  if (opts.status) {
    return sql<Goal[]>`
      SELECT * FROM goals
      WHERE company_id = ${companyId}::uuid AND level = 'company' AND status = ${opts.status}
      ORDER BY title
    `;
  }
  return sql<Goal[]>`
    SELECT * FROM goals
    WHERE company_id = ${companyId}::uuid AND level = 'company'
    ORDER BY title
  `;
}

// ── Formation-Goal Linkage ──────────────────────────────────

/**
 * Link a formation session to a goal.
 */
export async function linkFormationToGoal(
  sessionId: string,
  goalId: string,
): Promise<void> {
  await sql`
    UPDATE formation_sessions
    SET goal_id = ${goalId}::uuid, updated_at = NOW()
    WHERE id = ${sessionId}::uuid
  `;
}

/**
 * Get formations linked to a goal.
 */
export async function getFormationsForGoal(
  goalId: string,
): Promise<{ id: string; formation_name: string; state: string; created_at: Date }[]> {
  return sql<{ id: string; formation_name: string; state: string; created_at: Date }[]>`
    SELECT id, formation_name, state, created_at
    FROM formation_sessions
    WHERE goal_id = ${goalId}::uuid
    ORDER BY created_at DESC
  `;
}

// ── Prompt Builder (Pure) ───────────────────────────────────

/**
 * Build a goal context string for injection into a facilitator prompt.
 * Shows the full ancestry chain so agents understand the 'why'.
 *
 * Pure function — no DB calls.
 */
export function buildGoalPromptContext(ancestry: GoalAncestryEntry[]): string {
  if (ancestry.length === 0) return "";

  const lines: string[] = ["## Goal Context\n"];

  for (const entry of ancestry) {
    const indent = "  ".repeat(entry.depth);
    const progress = entry.target_value
      ? ` (${entry.current_value}/${entry.target_value} ${entry.unit ?? ""})`
      : "";
    const levelTag = `[${entry.level}]`;
    lines.push(`${indent}${levelTag} ${entry.title}${progress}`);
  }

  lines.push(
    "",
    "Every action in this formation should advance the goals above.",
  );

  return lines.join("\n");
}

/**
 * Check if a goal has met its target.
 * Pure function.
 */
export function isGoalMet(goal: Pick<Goal, "target_value" | "current_value">): boolean {
  if (goal.target_value === null || goal.target_value === undefined) return false;
  return goal.current_value >= goal.target_value;
}

/**
 * Calculate goal progress as a percentage (0-100).
 * Pure function.
 */
export function goalProgressPercent(
  goal: Pick<Goal, "target_value" | "current_value">,
): number {
  if (!goal.target_value || goal.target_value === 0) return 0;
  const pct = (goal.current_value / goal.target_value) * 100;
  return Math.min(100, Math.round(pct));
}
