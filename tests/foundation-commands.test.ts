/**
 * Tests for /foundation slash command — ELLIE-1114
 *
 * Covers command parsing, valid/invalid inputs, output formatting, and error handling.
 * Follows the same pattern as round-table-commands.test.ts: extracted parse + execute
 * functions with injectable dependencies.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  parseFoundationCommand,
  executeFoundationCommand,
  type FoundationCommandDeps,
  type FoundationCommandResult,
} from "../src/foundation-commands.ts";
import type { Foundation, BehaviorRules } from "../src/foundation-registry.ts";

// ── Test Data ─────────────────────────────────────────────────────

function makeBehavior(overrides: Partial<BehaviorRules> = {}): BehaviorRules {
  return {
    approvals: {},
    proactivity: "medium",
    tone: "professional",
    escalation: "Ask when unsure",
    max_loop_iterations: 10,
    cost_cap_session: 5,
    cost_cap_daily: 20,
    coordinator_model: "claude-sonnet-4-6",
    ...overrides,
  };
}

const SOFTWARE_DEV: Foundation = {
  name: "software-dev",
  description: "Software development foundation",
  active: true,
  agents: [
    { name: "james", role: "developer", tools: ["read", "write", "shell"], model: "claude-sonnet-4-6" },
    { name: "brian", role: "critic", tools: ["read"], model: "claude-sonnet-4-6" },
  ],
  recipes: [{ name: "code-review", pattern: "pipeline", steps: ["james", "brian"], trigger: "code review" }],
  behavior: makeBehavior({ tone: "technical and precise" }),
};

const LIFE_MGMT: Foundation = {
  name: "life-management",
  description: "Life management foundation",
  active: false,
  agents: [
    { name: "coach", role: "habits", tools: ["read", "write"], model: "claude-sonnet-4-6" },
  ],
  recipes: [],
  behavior: makeBehavior({ tone: "warm and encouraging" }),
};

// ── Mock Deps ─────────────────────────────────────────────────────

function makeDeps(foundations: Foundation[]): FoundationCommandDeps {
  let data = foundations.map((f) => ({ ...f, agents: [...f.agents], recipes: [...f.recipes] }));

  return {
    listAll: () => [...data],
    getActive: () => data.find((f) => f.active) ?? null,
    switchTo: async (name: string) => {
      const target = data.find((f) => f.name === name);
      if (!target) throw new Error(`Foundation "${name}" not found`);
      data = data.map((f) => ({ ...f, active: f.name === name }));
      return { ...target, active: true };
    },
  };
}

// ── Parsing ───────────────────────────────────────────────────────

describe("parseFoundationCommand", () => {
  test("bare /foundation → list subcommand", () => {
    const cmd = parseFoundationCommand("/foundation");
    expect(cmd.subcommand).toBe("list");
    expect(cmd.args).toBe("");
  });

  test("/foundation list → list subcommand", () => {
    const cmd = parseFoundationCommand("/foundation list");
    expect(cmd.subcommand).toBe("list");
    expect(cmd.args).toBe("");
  });

  test("/foundation <name> → switch subcommand", () => {
    const cmd = parseFoundationCommand("/foundation software-dev");
    expect(cmd.subcommand).toBe("switch");
    expect(cmd.args).toBe("software-dev");
  });

  test("/foundation with extra whitespace is trimmed", () => {
    const cmd = parseFoundationCommand("/foundation   life-management  ");
    expect(cmd.subcommand).toBe("switch");
    expect(cmd.args).toBe("life-management");
  });
});

// ── Execution: list ───────────────────────────────────────────────

describe("executeFoundationCommand — list", () => {
  let deps: FoundationCommandDeps;

  beforeEach(() => {
    deps = makeDeps([SOFTWARE_DEV, LIFE_MGMT]);
  });

  test("lists all foundations with active marker", async () => {
    const result = await executeFoundationCommand({ subcommand: "list", args: "" }, deps);
    expect(result.success).toBe(true);
    expect(result.output).toContain("software-dev");
    expect(result.output).toContain("life-management");
    // Active foundation gets arrow marker
    expect(result.output).toContain("→");
    expect(result.output).toMatch(/→\s+software-dev/);
  });

  test("list shows descriptions and agent counts", async () => {
    const result = await executeFoundationCommand({ subcommand: "list", args: "" }, deps);
    expect(result.output).toContain("Software development foundation");
    expect(result.output).toContain("2 agents");
    expect(result.output).toContain("1 agent");
  });

  test("list with no foundations returns empty message", async () => {
    const emptyDeps = makeDeps([]);
    const result = await executeFoundationCommand({ subcommand: "list", args: "" }, emptyDeps);
    expect(result.success).toBe(true);
    expect(result.output).toContain("No foundations");
  });
});

// ── Execution: switch ─────────────────────────────────────────────

describe("executeFoundationCommand — switch", () => {
  let deps: FoundationCommandDeps;

  beforeEach(() => {
    deps = makeDeps([SOFTWARE_DEV, LIFE_MGMT]);
  });

  test("switches to a valid foundation", async () => {
    const result = await executeFoundationCommand({ subcommand: "switch", args: "life-management" }, deps);
    expect(result.success).toBe(true);
    expect(result.output).toContain("life-management");
    expect(result.output).toContain("Life management foundation");
    expect(result.output).toContain("coach");
  });

  test("switch output includes agent count", async () => {
    const result = await executeFoundationCommand({ subcommand: "switch", args: "software-dev" }, deps);
    expect(result.success).toBe(true);
    expect(result.output).toContain("2 agents");
  });

  test("switch to unknown foundation fails gracefully", async () => {
    const result = await executeFoundationCommand({ subcommand: "switch", args: "does-not-exist" }, deps);
    expect(result.success).toBe(false);
    expect(result.output).toContain("Failed to switch");
    expect(result.output).toContain("does-not-exist");
  });
});

// ── Null registry (no DB) ─────────────────────────────────────────

describe("executeFoundationCommand — null deps", () => {
  test("returns unavailable message when deps is null", async () => {
    const result = await executeFoundationCommand({ subcommand: "list", args: "" }, null);
    expect(result.success).toBe(false);
    expect(result.output).toContain("not available");
  });

  test("switch also fails with null deps", async () => {
    const result = await executeFoundationCommand({ subcommand: "switch", args: "software-dev" }, null);
    expect(result.success).toBe(false);
    expect(result.output).toContain("not available");
  });
});
