/**
 * Seed SQL → TypeScript Round-Trip Validation (ELLIE-1116)
 *
 * Parses JSON blobs embedded in seed SQL files and validates them
 * against the TypeScript interfaces that consume them at runtime.
 * Catches field-name mismatches (e.g. max_iterations vs max_loop_iterations,
 * type vs pattern) that would otherwise only surface at runtime.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  validateFoundation,
  type AgentDef,
  type Recipe,
  type BehaviorRules,
  type Foundation,
} from "../src/foundation-types.ts";

// ── Helpers ──────────────────────────────────────────────────────

const SEEDS_DIR = join(import.meta.dir, "..", "seeds", "supabase");

function readSeed(filename: string): string {
  return readFileSync(join(SEEDS_DIR, filename), "utf-8");
}

/**
 * Extract JSONB literals from a seed SQL file.
 * Matches `'{...}'::jsonb` or `'[...]'::jsonb` blocks.
 */
function extractJsonbLiterals(sql: string): string[] {
  const results: string[] = [];
  // Match single-quoted JSON that ends with ::jsonb
  // The JSON can span multiple lines and contain nested quotes
  const regex = /'(\{[\s\S]*?\})'::jsonb|'(\[[\s\S]*?\])'::jsonb/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sql)) !== null) {
    const jsonStr = match[1] ?? match[2];
    results.push(jsonStr);
  }
  return results;
}

/**
 * Group extracted JSONB literals by foundation INSERT.
 * Each foundation INSERT has 3 JSONB columns: agents, recipes, behavior.
 * Returns arrays of [agents, recipes, behavior] tuples.
 */
function extractFoundationInserts(sql: string): Array<{
  agents: unknown[];
  recipes: unknown[];
  behavior: unknown;
}> {
  const jsonbs = extractJsonbLiterals(sql);
  const foundations: Array<{
    agents: unknown[];
    recipes: unknown[];
    behavior: unknown;
  }> = [];

  // Each foundation INSERT has exactly 3 JSONB literals in order:
  // agents (array), recipes (array), behavior (object)
  for (let i = 0; i + 2 < jsonbs.length; i += 3) {
    foundations.push({
      agents: JSON.parse(jsonbs[i]),
      recipes: JSON.parse(jsonbs[i + 1]),
      behavior: JSON.parse(jsonbs[i + 2]),
    });
  }

  return foundations;
}

// ── AgentDef field validation ────────────────────────────────────

const REQUIRED_AGENT_FIELDS: (keyof AgentDef)[] = [
  "name",
  "role",
  "tools",
  "model",
];

function validateAgentDef(obj: Record<string, unknown>, label: string) {
  for (const field of REQUIRED_AGENT_FIELDS) {
    expect(obj).toHaveProperty(
      field,
      expect.anything(),
    );
  }
  expect(typeof obj.name).toBe("string");
  expect(typeof obj.role).toBe("string");
  expect(typeof obj.model).toBe("string");
  expect(Array.isArray(obj.tools)).toBe(true);

  // Reject common misspellings / wrong field names
  const allowed = new Set<string>(["name", "role", "tools", "model", "prompt_key"]);
  for (const key of Object.keys(obj)) {
    expect(allowed.has(key)).toBe(true);
  }
}

// ── Recipe field validation ──────────────────────────────────────

const VALID_PATTERNS = new Set(["pipeline", "fan-out", "debate", "round-table"]);

function validateRecipe(obj: Record<string, unknown>, label: string) {
  expect(obj).toHaveProperty("name");
  expect(typeof obj.name).toBe("string");

  // Must use "pattern", NOT "type"
  expect(obj).toHaveProperty("pattern");
  expect(obj).not.toHaveProperty("type");
  expect(VALID_PATTERNS.has(obj.pattern as string)).toBe(true);

  // steps/agents must be arrays of strings if present
  if (obj.steps !== undefined) {
    expect(Array.isArray(obj.steps)).toBe(true);
    for (const s of obj.steps as unknown[]) {
      expect(typeof s).toBe("string");
    }
  }
  if (obj.agents !== undefined) {
    expect(Array.isArray(obj.agents)).toBe(true);
    for (const a of obj.agents as unknown[]) {
      expect(typeof a).toBe("string");
    }
  }
  if (obj.trigger !== undefined) {
    expect(typeof obj.trigger).toBe("string");
  }

  // Reject unknown fields
  const allowed = new Set<string>(["name", "pattern", "steps", "agents", "phases", "trigger"]);
  for (const key of Object.keys(obj)) {
    expect(allowed.has(key)).toBe(true);
  }
}

// ── BehaviorRules field validation ───────────────────────────────

const REQUIRED_BEHAVIOR_FIELDS: (keyof BehaviorRules)[] = [
  "proactivity",
  "tone",
  "escalation",
  "max_loop_iterations",
  "cost_cap_session",
  "cost_cap_daily",
  "coordinator_model",
];

function validateBehaviorRules(obj: Record<string, unknown>, label: string) {
  for (const field of REQUIRED_BEHAVIOR_FIELDS) {
    expect(obj).toHaveProperty(
      field,
      expect.anything(),
    );
  }

  // Must use "max_loop_iterations", NOT "max_iterations"
  expect(obj).toHaveProperty("max_loop_iterations");
  expect(obj).not.toHaveProperty("max_iterations");
  expect(typeof obj.max_loop_iterations).toBe("number");

  expect(typeof obj.proactivity).toBe("string");
  expect(typeof obj.tone).toBe("string");
  expect(typeof obj.escalation).toBe("string");
  expect(typeof obj.cost_cap_session).toBe("number");
  expect(typeof obj.cost_cap_daily).toBe("number");
  expect(typeof obj.coordinator_model).toBe("string");

  if (obj.approvals !== undefined) {
    expect(typeof obj.approvals).toBe("object");
    expect(obj.approvals).not.toBeNull();
  }

  // Reject unknown fields
  const allowed = new Set<string>([
    "approvals",
    "proactivity",
    "tone",
    "escalation",
    "max_loop_iterations",
    "cost_cap_session",
    "cost_cap_daily",
    "coordinator_model",
  ]);
  for (const key of Object.keys(obj)) {
    expect(allowed.has(key)).toBe(true);
  }
}

// ── Tests ────────────────────────────────────────────────────────

describe("Seed SQL → TypeScript round-trip validation", () => {
  const foundationSql = readSeed("002_foundations.sql");
  const inserts = extractFoundationInserts(foundationSql);

  test("extracts at least one foundation from seed SQL", () => {
    expect(inserts.length).toBeGreaterThanOrEqual(1);
  });

  describe("002_foundations.sql — agent definitions", () => {
    for (let fi = 0; fi < inserts.length; fi++) {
      const { agents } = inserts[fi];

      test(`foundation[${fi}] agents is a non-empty array`, () => {
        expect(Array.isArray(agents)).toBe(true);
        expect(agents.length).toBeGreaterThan(0);
      });

      for (let ai = 0; ai < agents.length; ai++) {
        const agent = agents[ai] as Record<string, unknown>;
        test(`foundation[${fi}].agents[${ai}] (${agent.name}) matches AgentDef`, () => {
          validateAgentDef(agent, `foundation[${fi}].agents[${ai}]`);
        });
      }
    }
  });

  describe("002_foundations.sql — recipes", () => {
    for (let fi = 0; fi < inserts.length; fi++) {
      const { recipes, agents } = inserts[fi];
      const agentNames = new Set(
        (agents as Array<Record<string, unknown>>).map((a) => a.name as string),
      );

      test(`foundation[${fi}] recipes is an array`, () => {
        expect(Array.isArray(recipes)).toBe(true);
      });

      for (let ri = 0; ri < recipes.length; ri++) {
        const recipe = recipes[ri] as Record<string, unknown>;
        test(`foundation[${fi}].recipes[${ri}] (${recipe.name}) matches Recipe`, () => {
          validateRecipe(recipe, `foundation[${fi}].recipes[${ri}]`);
        });

        test(`foundation[${fi}].recipes[${ri}] (${recipe.name}) only references roster agents`, () => {
          const refs = [
            ...((recipe.steps as string[]) ?? []),
            ...((recipe.agents as string[]) ?? []),
          ];
          for (const ref of refs) {
            expect(agentNames.has(ref)).toBe(true);
          }
        });
      }
    }
  });

  describe("002_foundations.sql — behavior rules", () => {
    for (let fi = 0; fi < inserts.length; fi++) {
      const { behavior } = inserts[fi];
      test(`foundation[${fi}] behavior matches BehaviorRules`, () => {
        validateBehaviorRules(
          behavior as Record<string, unknown>,
          `foundation[${fi}].behavior`,
        );
      });
    }
  });

  describe("002_foundations.sql — full validateFoundation() pass", () => {
    for (let fi = 0; fi < inserts.length; fi++) {
      const insert = inserts[fi];
      test(`foundation[${fi}] passes validateFoundation()`, () => {
        const foundation: Foundation = {
          name: `seed-foundation-${fi}`,
          description: "Loaded from seed SQL",
          agents: insert.agents as AgentDef[],
          recipes: insert.recipes as Recipe[],
          behavior: insert.behavior as BehaviorRules,
          active: fi === 0,
        };
        const result = validateFoundation(foundation);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      });
    }
  });
});
