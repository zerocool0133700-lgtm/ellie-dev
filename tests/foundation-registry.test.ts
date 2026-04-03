/**
 * Foundation Registry — Tests
 *
 * Task 3 of 6: Registry class for loading, caching, and managing foundations.
 * Uses an in-memory store — no Supabase required.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { FoundationRegistry } from "../src/foundation-registry.ts";
import type { Foundation, AgentDef, BehaviorRules, Recipe } from "../src/foundation-registry.ts";

// ── Test Data ─────────────────────────────────────────────────────

function makeBehavior(overrides: Partial<BehaviorRules> = {}): BehaviorRules {
  return {
    approvals: {},
    proactivity: "medium",
    tone: "professional and clear",
    escalation: "Ask when unsure",
    max_loop_iterations: 10,
    cost_cap_session: 5,
    cost_cap_daily: 20,
    coordinator_model: "claude-sonnet-4-6",
    ...overrides,
  };
}

const TEST_FOUNDATIONS: Foundation[] = [
  {
    name: "software-dev",
    description: "Software development foundation",
    active: true,
    agents: [
      {
        name: "james",
        role: "developer",
        tools: ["read", "write", "shell"],
        model: "claude-sonnet-4-6",
      },
      {
        name: "brian",
        role: "critic",
        tools: ["read"],
        model: "claude-sonnet-4-6",
      },
    ],
    recipes: [
      {
        name: "code-review",
        pattern: "pipeline",
        steps: ["james", "brian"],
        trigger: "When user asks for a code review",
      },
    ],
    behavior: makeBehavior({ tone: "technical and precise" }),
  },
  {
    name: "life-management",
    description: "Life management foundation",
    active: false,
    agents: [
      {
        name: "coach",
        role: "habits",
        tools: ["read", "write"],
        model: "claude-sonnet-4-6",
      },
      {
        name: "scheduler",
        role: "calendar",
        tools: ["read", "write", "calendar"],
        model: "claude-sonnet-4-6",
      },
    ],
    recipes: [
      {
        name: "daily-plan",
        pattern: "fan-out",
        agents: ["coach", "scheduler"],
        trigger: "When user asks for a daily plan",
      },
    ],
    behavior: makeBehavior({ tone: "warm and encouraging" }),
  },
];

// ── Helper ────────────────────────────────────────────────────────

/**
 * Build a FoundationRegistry backed by an in-memory store.
 * No Supabase required.
 */
function createTestRegistry(foundations: Foundation[]): FoundationRegistry {
  // Deep-copy so tests don't share state
  let data: Foundation[] = foundations.map((f) => ({ ...f, agents: [...f.agents], recipes: [...f.recipes] }));

  const store = {
    loadAll: async () => [...data],
    loadByName: async (name: string) => data.find((f) => f.name === name) ?? null,
    setActive: async (name: string) => {
      data = data.map((f) => ({ ...f, active: f.name === name }));
    },
  };

  return new FoundationRegistry(store);
}

// ── Tests ─────────────────────────────────────────────────────────

describe("FoundationRegistry", () => {
  let registry: FoundationRegistry;

  beforeEach(async () => {
    registry = createTestRegistry(TEST_FOUNDATIONS);
    await registry.refresh();
  });

  test("getActive returns the active foundation", () => {
    const active = registry.getActive();
    expect(active).not.toBeNull();
    expect(active!.name).toBe("software-dev");
  });

  test("getByName returns a specific foundation", () => {
    const f = registry.getByName("life-management");
    expect(f).not.toBeNull();
    expect(f!.name).toBe("life-management");
  });

  test("getByName returns null for unknown", () => {
    const f = registry.getByName("does-not-exist");
    expect(f).toBeNull();
  });

  test("listAll returns all foundations", () => {
    const all = registry.listAll();
    expect(all.length).toBe(2);
    const names = all.map((f) => f.name);
    expect(names).toContain("software-dev");
    expect(names).toContain("life-management");
  });

  test("switchTo changes the active foundation", async () => {
    const switched = await registry.switchTo("life-management");
    expect(switched.name).toBe("life-management");
    expect(registry.getActive()!.name).toBe("life-management");
  });

  test("switchTo throws for unknown foundation", async () => {
    await expect(registry.switchTo("not-a-foundation")).rejects.toThrow();
  });

  test("getAgentRoster returns agent names", () => {
    const roster = registry.getAgentRoster();
    expect(roster).toContain("james");
    expect(roster).toContain("brian");
  });

  test("getAgentTools returns tools for an agent", () => {
    const tools = registry.getAgentTools("james");
    expect(tools).toContain("read");
    expect(tools).toContain("write");
    expect(tools).toContain("shell");
  });

  test("getAgentTools returns empty for unknown agent", () => {
    const tools = registry.getAgentTools("unknown-agent");
    expect(tools).toEqual([]);
  });

  test("getBehavior returns behavior rules", () => {
    const behavior = registry.getBehavior();
    expect(behavior.tone).toBe("technical and precise");
    expect(behavior.proactivity).toBe("medium");
  });

  test("getCoordinatorPrompt contains foundation name, agent names, and tone", async () => {
    const prompt = await registry.getCoordinatorPrompt();
    expect(prompt).toContain("software-dev");
    expect(prompt).toContain("james");
    expect(prompt).toContain("brian");
    expect(prompt).toContain("technical and precise");
  });
});
