/**
 * Foundation Types — Tests
 *
 * Task 1 of 6: Pure type + validation module.
 * No external dependencies required.
 */

import { describe, test, expect } from "bun:test";
import {
  validateFoundation,
  type Foundation,
  type AgentDef,
  type Recipe,
  type BehaviorRules,
  type ValidationResult,
} from "../src/foundation-types.ts";

// ── Helpers ──────────────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "dev",
    role: "Developer",
    tools: ["read", "write"],
    model: "claude-sonnet-4-6",
    ...overrides,
  };
}

function makeBehavior(overrides: Partial<BehaviorRules> = {}): BehaviorRules {
  return {
    approvals: { send_email: "always_confirm" },
    proactivity: "medium",
    tone: "professional and concise",
    escalation: "escalate blockers to Dave immediately",
    max_loop_iterations: 10,
    cost_cap_session: 5.0,
    cost_cap_daily: 20.0,
    coordinator_model: "claude-sonnet-4-6",
    ...overrides,
  };
}

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    name: "default-pipeline",
    pattern: "pipeline",
    steps: ["dev"],
    ...overrides,
  };
}

function makeFoundation(overrides: Partial<Foundation> = {}): Foundation {
  return {
    name: "test-foundation",
    description: "A foundation for unit tests",
    agents: [makeAgent()],
    recipes: [makeRecipe()],
    behavior: makeBehavior(),
    active: true,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("validateFoundation", () => {
  test("valid foundation passes validation", () => {
    const foundation = makeFoundation();
    const result: ValidationResult = validateFoundation(foundation);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("foundation with no agents fails", () => {
    const foundation = makeFoundation({ agents: [] });
    const result = validateFoundation(foundation);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some(e => e.toLowerCase().includes("agent"))).toBe(true);
  });

  test("foundation with empty name fails", () => {
    const foundation = makeFoundation({ name: "" });
    const result = validateFoundation(foundation);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some(e => e.toLowerCase().includes("name"))).toBe(true);
  });

  test("recipe referencing non-existent agent fails", () => {
    const foundation = makeFoundation({
      agents: [makeAgent({ name: "dev" })],
      recipes: [
        makeRecipe({ steps: ["dev", "ghost-agent"] }),
      ],
    });
    const result = validateFoundation(foundation);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some(e => e.includes("ghost-agent"))).toBe(true);
  });
});
