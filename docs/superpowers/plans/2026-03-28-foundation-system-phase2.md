# Foundation System — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the hardcoded software-dev configuration from the coordinator into a swappable foundation system, so different agent rosters, tools, coordination recipes, approval flows, and personality can be loaded at runtime.

**Architecture:** Foundations are defined in two places: structured data in Supabase (`foundations` table) and markdown prompts in the River vault (`foundations/*.md`). A `FoundationRegistry` loads and caches them, and the coordinator reads the active foundation on each request. Users swap foundations via `/foundation <name>` or natural language.

**Tech Stack:** Bun + TypeScript, Supabase (cloud Postgres), River vault (Obsidian markdown), existing coordinator infrastructure from Phase 1.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/foundation-types.ts` | Create | Type definitions for Foundation, AgentDef, Recipe, BehaviorRules |
| `src/foundation-registry.ts` | Create | Load, cache, and swap foundations. Single source of truth for active foundation. |
| `migrations/supabase/20260328_foundations.sql` | Create | Schema for `foundations` table |
| `seeds/supabase/002_foundations.sql` | Create | Seed data: software-dev and life-management foundations |
| `src/coordinator.ts` | Modify | Replace hardcoded config with foundation registry lookups |
| `src/telegram-handlers.ts` | Modify | Pass active foundation to coordinator instead of hardcoded "software-dev" |
| `src/ellie-chat-handler.ts` | Modify | Same |
| `src/http-routes.ts` | Modify | Same + add `/foundation` slash command handling |
| `tests/foundation-registry.test.ts` | Create | Tests for foundation loading, caching, and swapping |
| `tests/foundation-types.test.ts` | Create | Tests for type validation |

---

### Task 1: Foundation Type Definitions

**Files:**
- Create: `src/foundation-types.ts`
- Test: `tests/foundation-types.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/foundation-types.test.ts
import { describe, test, expect } from "bun:test";
import {
  type Foundation,
  type AgentDef,
  type Recipe,
  type BehaviorRules,
  validateFoundation,
} from "../src/foundation-types";

describe("Foundation types", () => {
  test("validateFoundation accepts a valid foundation", () => {
    const foundation: Foundation = {
      name: "software-dev",
      description: "Full-stack development with code review and deploy",
      icon: "hammer",
      version: 1,
      agents: [
        {
          name: "james",
          role: "developer",
          tools: ["read", "write", "edit", "git", "bash_builds", "plane_mcp", "forest_bridge"],
          model: "claude-sonnet-4-6",
          prompt_key: "dev-agent-template",
        },
      ],
      recipes: [
        {
          name: "code-review",
          pattern: "pipeline",
          steps: ["james", "brian"],
          trigger: "before merge",
        },
      ],
      behavior: {
        approvals: { send_email: "always_confirm", git_push: "confirm_first_time", plane_update: "auto" },
        proactivity: "high",
        tone: "direct, technical",
        escalation: "block and ask user",
        max_loop_iterations: 10,
        cost_cap_session: 2.0,
        cost_cap_daily: 20.0,
        coordinator_model: "claude-sonnet-4-6",
      },
      active: true,
    };

    const result = validateFoundation(foundation);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("validateFoundation rejects foundation with no agents", () => {
    const foundation = {
      name: "empty",
      description: "No agents",
      agents: [],
      recipes: [],
      behavior: {
        approvals: {},
        proactivity: "low",
        tone: "casual",
        escalation: "suggest and move on",
        max_loop_iterations: 5,
        cost_cap_session: 1.0,
        cost_cap_daily: 10.0,
        coordinator_model: "claude-sonnet-4-6",
      },
      active: true,
    };
    const result = validateFoundation(foundation as Foundation);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("agent"))).toBe(true);
  });

  test("validateFoundation rejects foundation with no name", () => {
    const foundation = {
      name: "",
      description: "Missing name",
      agents: [{ name: "a", role: "r", tools: ["read"], model: "claude-sonnet-4-6" }],
      recipes: [],
      behavior: {
        approvals: {},
        proactivity: "low",
        tone: "casual",
        escalation: "suggest",
        max_loop_iterations: 5,
        cost_cap_session: 1.0,
        cost_cap_daily: 10.0,
        coordinator_model: "claude-sonnet-4-6",
      },
      active: true,
    };
    const result = validateFoundation(foundation as Foundation);
    expect(result.valid).toBe(false);
  });

  test("recipe steps reference agents that exist", () => {
    const foundation: Foundation = {
      name: "test",
      description: "Test",
      agents: [{ name: "james", role: "dev", tools: ["read"], model: "claude-sonnet-4-6" }],
      recipes: [{ name: "review", pattern: "pipeline", steps: ["james", "unknown_agent"] }],
      behavior: {
        approvals: {},
        proactivity: "medium",
        tone: "neutral",
        escalation: "ask",
        max_loop_iterations: 10,
        cost_cap_session: 2.0,
        cost_cap_daily: 20.0,
        coordinator_model: "claude-sonnet-4-6",
      },
      active: true,
    };
    const result = validateFoundation(foundation);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("unknown_agent"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/foundation-types.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/foundation-types.ts
/**
 * Foundation Type Definitions — The data model for swappable agent configurations.
 *
 * A foundation defines: who the agents are, what tools they have,
 * how they coordinate, and how the system behaves.
 */

export interface AgentDef {
  name: string;
  role: string;
  tools: string[];              // Tool category names from tool-access-control.ts
  model: string;                // e.g. "claude-sonnet-4-6"
  prompt_key?: string;          // River doc key for agent's system prompt
}

export interface Recipe {
  name: string;
  pattern: "pipeline" | "fan-out" | "debate" | "round-table";
  steps?: string[];             // Agent names (for pipeline)
  agents?: string[];            // Agent names (for fan-out, debate, round-table)
  phases?: string[];            // Phase names (for round-table)
  trigger?: string;             // Hint for coordinator: when to use this recipe
}

export interface BehaviorRules {
  approvals: Record<string, string>;  // action → "always_confirm" | "confirm_first_time" | "auto"
  proactivity: string;                // "high" | "medium" | "low"
  tone: string;                       // Free-text description of communication style
  escalation: string;                 // Free-text escalation policy
  max_loop_iterations: number;
  cost_cap_session: number;           // USD
  cost_cap_daily: number;             // USD
  coordinator_model: string;          // Model for the coordinator loop
}

export interface Foundation {
  name: string;
  description: string;
  icon?: string;
  version?: number;
  agents: AgentDef[];
  recipes: Recipe[];
  behavior: BehaviorRules;
  active: boolean;
  // Loaded at runtime from River vault (not stored in DB)
  coordinator_prompt?: string;
  agent_prompts?: Record<string, string>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateFoundation(f: Foundation): ValidationResult {
  const errors: string[] = [];

  if (!f.name || f.name.trim().length === 0) {
    errors.push("Foundation must have a name.");
  }

  if (!f.agents || f.agents.length === 0) {
    errors.push("Foundation must have at least one agent.");
  }

  // Check that recipe steps/agents reference actual agents in the roster
  const agentNames = new Set(f.agents.map(a => a.name));
  for (const recipe of f.recipes) {
    const refs = [...(recipe.steps || []), ...(recipe.agents || [])];
    for (const ref of refs) {
      if (!agentNames.has(ref)) {
        errors.push(`Recipe "${recipe.name}" references agent "${ref}" which is not in the roster.`);
      }
    }
  }

  // Check agents have required fields
  for (const agent of f.agents) {
    if (!agent.name) errors.push("Agent must have a name.");
    if (!agent.role) errors.push(`Agent "${agent.name}" must have a role.`);
    if (!agent.tools || agent.tools.length === 0) errors.push(`Agent "${agent.name}" must have at least one tool.`);
  }

  return { valid: errors.length === 0, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ellie/ellie-dev && bun test tests/foundation-types.test.ts`
Expected: 4 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev && git add src/foundation-types.ts tests/foundation-types.test.ts && git commit -m "feat: add foundation type definitions and validation"
```

---

### Task 2: Supabase Migration and Seed Data

**Files:**
- Create: `migrations/supabase/20260328_foundations.sql`
- Create: `seeds/supabase/002_foundations.sql`

- [ ] **Step 1: Write the migration**

```sql
-- migrations/supabase/20260328_foundations.sql
-- Foundation System — swappable agent configurations
-- Each foundation defines a complete operating mode: agents, tools, recipes, behavior.

CREATE TABLE IF NOT EXISTS foundations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  agents JSONB NOT NULL DEFAULT '[]'::jsonb,
  recipes JSONB NOT NULL DEFAULT '[]'::jsonb,
  behavior JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one foundation can be active at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_foundations_active
  ON foundations (active) WHERE active = true;

-- Index for name lookups
CREATE INDEX IF NOT EXISTS idx_foundations_name ON foundations (name);
```

- [ ] **Step 2: Write the seed data**

```sql
-- seeds/supabase/002_foundations.sql
-- Initial foundations: software-dev (active) and life-management

DELETE FROM foundations WHERE name IN ('software-dev', 'life-management');

-- Software Development Foundation (active by default)
INSERT INTO foundations (name, description, icon, version, agents, recipes, behavior, active)
VALUES (
  'software-dev',
  'Full-stack development with code review, testing, and deployment',
  'hammer',
  1,
  '[
    {"name": "james", "role": "developer", "tools": ["read", "write", "edit", "glob", "grep", "bash_builds", "bash_tests", "systemctl", "plane_mcp", "forest_bridge_read", "forest_bridge_write", "git", "supabase_mcp", "psql_forest"], "model": "claude-sonnet-4-6", "prompt_key": "dev-agent-template"},
    {"name": "brian", "role": "critic", "tools": ["read", "glob", "grep", "forest_bridge_read", "forest_bridge_write", "plane_mcp", "bash_tests", "bash_type_checks"], "model": "claude-sonnet-4-6", "prompt_key": "critic-agent-template"},
    {"name": "kate", "role": "researcher", "tools": ["brave_search", "forest_bridge", "qmd_search", "google_workspace", "grep_glob_codebase", "memory_extraction"], "model": "claude-sonnet-4-6", "prompt_key": "research-agent-template"},
    {"name": "alan", "role": "strategist", "tools": ["brave_web_search", "forest_bridge_read", "forest_bridge_write", "qmd_search", "plane_mcp", "miro", "memory_extraction"], "model": "claude-sonnet-4-6", "prompt_key": "strategy-agent-template"},
    {"name": "jason", "role": "ops", "tools": ["bash_systemctl", "bash_journalctl", "bash_process_mgmt", "health_endpoint_checks", "log_analysis", "forest_bridge_read", "forest_bridge_write", "plane_mcp", "github_mcp", "telegram", "google_chat"], "model": "claude-sonnet-4-6"},
    {"name": "amy", "role": "content", "tools": ["google_workspace", "forest_bridge_read", "qmd_search", "brave_web_search", "memory_extraction"], "model": "claude-sonnet-4-6"},
    {"name": "marcus", "role": "finance", "tools": ["plane_mcp", "forest_bridge_read", "forest_bridge_write", "memory_extraction", "transaction_import", "receipt_parsing"], "model": "claude-sonnet-4-6"}
  ]'::jsonb,
  '[
    {"name": "code-review", "pattern": "pipeline", "steps": ["james", "brian"], "trigger": "before merge"},
    {"name": "architecture-decision", "pattern": "round-table", "agents": ["james", "brian", "alan"], "phases": ["convene", "discuss", "converge", "deliver"]},
    {"name": "deploy-checklist", "pattern": "pipeline", "steps": ["james", "jason"], "trigger": "before deploy"}
  ]'::jsonb,
  jsonb_build_object(
    'approvals', jsonb_build_object('send_email', 'always_confirm', 'git_push', 'confirm_first_time', 'plane_update', 'auto'),
    'proactivity', 'high',
    'tone', 'direct, technical, concise',
    'escalation', 'block and ask user',
    'max_loop_iterations', 10,
    'cost_cap_session', 2.00,
    'cost_cap_daily', 20.00,
    'coordinator_model', 'claude-sonnet-4-6'
  ),
  true  -- active
);

-- Life Management Foundation
INSERT INTO foundations (name, description, icon, version, agents, recipes, behavior, active)
VALUES (
  'life-management',
  'Personal life management — habits, calendar, notes, gentle check-ins',
  'leaf',
  1,
  '[
    {"name": "coach", "role": "habits", "tools": ["forest_bridge", "memory_extraction", "plane_mcp"], "model": "claude-sonnet-4-6"},
    {"name": "scheduler", "role": "calendar", "tools": ["google_workspace", "forest_bridge", "memory_extraction"], "model": "claude-sonnet-4-6"},
    {"name": "scribe", "role": "notes", "tools": ["forest_bridge", "forest_bridge_write", "qmd_search", "memory_extraction"], "model": "claude-sonnet-4-6"},
    {"name": "buddy", "role": "check-ins", "tools": ["forest_bridge", "memory_extraction", "brave_web_search"], "model": "claude-haiku-4-5"}
  ]'::jsonb,
  '[
    {"name": "morning-routine", "pattern": "pipeline", "steps": ["scheduler", "coach"], "trigger": "morning"},
    {"name": "weekly-review", "pattern": "fan-out", "agents": ["coach", "scheduler", "scribe"], "trigger": "sunday evening"},
    {"name": "habit-check", "pattern": "pipeline", "steps": ["coach", "buddy"], "trigger": "daily evening"}
  ]'::jsonb,
  jsonb_build_object(
    'approvals', jsonb_build_object('send_email', 'always_confirm', 'calendar_event', 'confirm_first_time'),
    'proactivity', 'medium',
    'tone', 'warm, encouraging, patient',
    'escalation', 'suggest and move on',
    'max_loop_iterations', 6,
    'cost_cap_session', 1.00,
    'cost_cap_daily', 10.00,
    'coordinator_model', 'claude-haiku-4-5'
  ),
  false  -- not active by default
);
```

- [ ] **Step 3: Apply the migration**

Run: `cd /home/ellie/ellie-dev && bun run migrate --db supabase`

If the migration runner is unavailable, apply manually:
Run: `cd /home/ellie/ellie-dev && psql "$DATABASE_URL" -f migrations/supabase/20260328_foundations.sql`

- [ ] **Step 4: Apply the seed**

Run: `cd /home/ellie/ellie-dev && psql "$DATABASE_URL" -f seeds/supabase/002_foundations.sql`

- [ ] **Step 5: Verify**

Run: `cd /home/ellie/ellie-dev && psql "$DATABASE_URL" -c "SELECT name, active, jsonb_array_length(agents) as agent_count FROM foundations;"`
Expected: Two rows — software-dev (active, 7 agents) and life-management (not active, 4 agents)

- [ ] **Step 6: Commit**

```bash
cd /home/ellie/ellie-dev && git add migrations/supabase/20260328_foundations.sql seeds/supabase/002_foundations.sql && git commit -m "feat: add foundations table schema and seed data (software-dev + life-management)"
```

---

### Task 3: Foundation Registry

**Files:**
- Create: `src/foundation-registry.ts`
- Test: `tests/foundation-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/foundation-registry.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import {
  FoundationRegistry,
  type Foundation,
} from "../src/foundation-registry";

// In-memory store for testing (no Supabase dependency)
function createTestRegistry(foundations: Foundation[]): FoundationRegistry {
  return new FoundationRegistry({
    loadAll: async () => foundations,
    loadByName: async (name) => foundations.find(f => f.name === name) ?? null,
    setActive: async (name) => {
      foundations.forEach(f => f.active = f.name === name);
    },
  });
}

const softwareDev: Foundation = {
  name: "software-dev",
  description: "Development",
  agents: [
    { name: "james", role: "developer", tools: ["read", "write"], model: "claude-sonnet-4-6" },
    { name: "brian", role: "critic", tools: ["read", "grep"], model: "claude-sonnet-4-6" },
  ],
  recipes: [{ name: "code-review", pattern: "pipeline", steps: ["james", "brian"] }],
  behavior: {
    approvals: { git_push: "confirm_first_time" },
    proactivity: "high",
    tone: "direct, technical",
    escalation: "block and ask",
    max_loop_iterations: 10,
    cost_cap_session: 2.0,
    cost_cap_daily: 20.0,
    coordinator_model: "claude-sonnet-4-6",
  },
  active: true,
};

const lifeManagement: Foundation = {
  name: "life-management",
  description: "Life management",
  agents: [
    { name: "coach", role: "habits", tools: ["forest_bridge"], model: "claude-sonnet-4-6" },
    { name: "scheduler", role: "calendar", tools: ["google_workspace"], model: "claude-sonnet-4-6" },
  ],
  recipes: [{ name: "morning-routine", pattern: "pipeline", steps: ["scheduler", "coach"] }],
  behavior: {
    approvals: {},
    proactivity: "medium",
    tone: "warm, encouraging",
    escalation: "suggest and move on",
    max_loop_iterations: 6,
    cost_cap_session: 1.0,
    cost_cap_daily: 10.0,
    coordinator_model: "claude-haiku-4-5",
  },
  active: false,
};

describe("FoundationRegistry", () => {
  test("getActive returns the active foundation", async () => {
    const registry = createTestRegistry([softwareDev, lifeManagement]);
    await registry.refresh();

    const active = registry.getActive();
    expect(active).not.toBeNull();
    expect(active!.name).toBe("software-dev");
  });

  test("getByName returns a specific foundation", async () => {
    const registry = createTestRegistry([softwareDev, lifeManagement]);
    await registry.refresh();

    const lm = registry.getByName("life-management");
    expect(lm).not.toBeNull();
    expect(lm!.agents).toHaveLength(2);
  });

  test("getByName returns null for unknown foundation", async () => {
    const registry = createTestRegistry([softwareDev]);
    await registry.refresh();

    expect(registry.getByName("unknown")).toBeNull();
  });

  test("listAll returns all foundations", async () => {
    const registry = createTestRegistry([softwareDev, lifeManagement]);
    await registry.refresh();

    const all = registry.listAll();
    expect(all).toHaveLength(2);
  });

  test("switchTo changes the active foundation", async () => {
    const foundations = [{ ...softwareDev }, { ...lifeManagement }];
    const registry = createTestRegistry(foundations);
    await registry.refresh();

    expect(registry.getActive()!.name).toBe("software-dev");

    await registry.switchTo("life-management");

    expect(registry.getActive()!.name).toBe("life-management");
  });

  test("switchTo throws for unknown foundation", async () => {
    const registry = createTestRegistry([softwareDev]);
    await registry.refresh();

    expect(registry.switchTo("unknown")).rejects.toThrow();
  });

  test("getAgentRoster returns agent names from active foundation", async () => {
    const registry = createTestRegistry([softwareDev]);
    await registry.refresh();

    const roster = registry.getAgentRoster();
    expect(roster).toEqual(["james", "brian"]);
  });

  test("getAgentTools returns tool categories for an agent", async () => {
    const registry = createTestRegistry([softwareDev]);
    await registry.refresh();

    const tools = registry.getAgentTools("james");
    expect(tools).toEqual(["read", "write"]);
  });

  test("getAgentTools returns empty for unknown agent", async () => {
    const registry = createTestRegistry([softwareDev]);
    await registry.refresh();

    expect(registry.getAgentTools("unknown")).toEqual([]);
  });

  test("getBehavior returns behavior rules from active foundation", async () => {
    const registry = createTestRegistry([softwareDev]);
    await registry.refresh();

    const behavior = registry.getBehavior();
    expect(behavior.proactivity).toBe("high");
    expect(behavior.max_loop_iterations).toBe(10);
  });

  test("getCoordinatorPrompt builds prompt with foundation context", async () => {
    const registry = createTestRegistry([softwareDev]);
    await registry.refresh();

    const prompt = registry.getCoordinatorPrompt();
    expect(prompt).toContain("software-dev");
    expect(prompt).toContain("james");
    expect(prompt).toContain("brian");
    expect(prompt).toContain("direct, technical");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/foundation-registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/foundation-registry.ts
/**
 * Foundation Registry — Loads, caches, and manages swappable foundations.
 * Single source of truth for the active foundation configuration.
 */

import { log } from "./logger.ts";
import type { Foundation, AgentDef, BehaviorRules, Recipe } from "./foundation-types.ts";

// Re-export types for convenience
export type { Foundation, AgentDef, BehaviorRules, Recipe };

const logger = log.child("foundation-registry");

export interface FoundationStore {
  loadAll: () => Promise<Foundation[]>;
  loadByName: (name: string) => Promise<Foundation | null>;
  setActive: (name: string) => Promise<void>;
}

export class FoundationRegistry {
  private store: FoundationStore;
  private cache: Map<string, Foundation> = new Map();
  private activeName: string | null = null;

  constructor(store: FoundationStore) {
    this.store = store;
  }

  async refresh(): Promise<void> {
    const all = await this.store.loadAll();
    this.cache.clear();
    this.activeName = null;

    for (const f of all) {
      this.cache.set(f.name, f);
      if (f.active) {
        this.activeName = f.name;
      }
    }

    logger.info("Foundations loaded", {
      count: all.length,
      active: this.activeName,
      names: all.map(f => f.name),
    });
  }

  getActive(): Foundation | null {
    if (!this.activeName) return null;
    return this.cache.get(this.activeName) ?? null;
  }

  getByName(name: string): Foundation | null {
    return this.cache.get(name) ?? null;
  }

  listAll(): Foundation[] {
    return Array.from(this.cache.values());
  }

  async switchTo(name: string): Promise<Foundation> {
    const target = this.cache.get(name);
    if (!target) {
      throw new Error(`Foundation "${name}" not found. Available: ${Array.from(this.cache.keys()).join(", ")}`);
    }

    await this.store.setActive(name);

    // Update local cache
    for (const [key, f] of this.cache) {
      f.active = key === name;
    }
    this.activeName = name;

    logger.info("Foundation switched", { from: this.activeName, to: name });
    return target;
  }

  getAgentRoster(): string[] {
    const active = this.getActive();
    if (!active) return [];
    return active.agents.map(a => a.name);
  }

  getAgentTools(agentName: string): string[] {
    const active = this.getActive();
    if (!active) return [];
    const agent = active.agents.find(a => a.name === agentName);
    return agent?.tools ?? [];
  }

  getAgentDef(agentName: string): AgentDef | null {
    const active = this.getActive();
    if (!active) return null;
    return active.agents.find(a => a.name === agentName) ?? null;
  }

  getBehavior(): BehaviorRules {
    const active = this.getActive();
    if (!active) {
      return {
        approvals: {},
        proactivity: "medium",
        tone: "helpful",
        escalation: "ask user",
        max_loop_iterations: 10,
        cost_cap_session: 2.0,
        cost_cap_daily: 20.0,
        coordinator_model: "claude-sonnet-4-6",
      };
    }
    return active.behavior;
  }

  getRecipes(): Recipe[] {
    return this.getActive()?.recipes ?? [];
  }

  getCoordinatorPrompt(): string {
    const active = this.getActive();
    if (!active) {
      return "You are Ellie, a coordinator. No foundation is loaded.";
    }

    const agentList = active.agents
      .map(a => `- **${a.name}** (${a.role}): tools = ${a.tools.join(", ")}`)
      .join("\n");

    const recipeList = active.recipes.length > 0
      ? active.recipes.map(r => `- **${r.name}** (${r.pattern}): ${r.trigger || "on request"}`).join("\n")
      : "No recipes defined.";

    return `You are Ellie, a coordinator for Dave. Your specialists have tools you don't — Google Calendar, Gmail, GitHub, code editing, system ops, etc. When a request needs those capabilities, ALWAYS dispatch the right specialist using dispatch_agent rather than saying you can't do it. Your read_context tool only covers Forest, Plane, memory, and sessions. For everything else, dispatch. For greetings or simple chat, use complete directly.

## Active Foundation: ${active.name}
${active.description}

## Your Agent Team
${agentList}

## Coordination Recipes
${recipeList}

## Behavior
- Tone: ${active.behavior.tone}
- Proactivity: ${active.behavior.proactivity}
- Escalation: ${active.behavior.escalation}`;
  }
}

/**
 * Create a FoundationRegistry backed by Supabase.
 */
export function createSupabaseFoundationStore(supabase: { from: (table: string) => any }): FoundationStore {
  return {
    loadAll: async () => {
      const { data, error } = await supabase
        .from("foundations")
        .select("*")
        .order("name");
      if (error) {
        logger.error("Failed to load foundations", { error: error.message });
        return [];
      }
      return (data || []).map(mapRowToFoundation);
    },

    loadByName: async (name: string) => {
      const { data, error } = await supabase
        .from("foundations")
        .select("*")
        .eq("name", name)
        .single();
      if (error || !data) return null;
      return mapRowToFoundation(data);
    },

    setActive: async (name: string) => {
      // Deactivate all, then activate target
      await supabase.from("foundations").update({ active: false }).eq("active", true);
      const { error } = await supabase.from("foundations").update({ active: true }).eq("name", name);
      if (error) throw new Error(`Failed to activate foundation "${name}": ${error.message}`);
    },
  };
}

function mapRowToFoundation(row: Record<string, unknown>): Foundation {
  return {
    name: row.name as string,
    description: (row.description as string) || "",
    icon: row.icon as string | undefined,
    version: row.version as number | undefined,
    agents: (row.agents as AgentDef[]) || [],
    recipes: (row.recipes as Recipe[]) || [],
    behavior: (row.behavior as BehaviorRules) || {
      approvals: {},
      proactivity: "medium",
      tone: "helpful",
      escalation: "ask user",
      max_loop_iterations: 10,
      cost_cap_session: 2.0,
      cost_cap_daily: 20.0,
      coordinator_model: "claude-sonnet-4-6",
    },
    active: row.active as boolean,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ellie/ellie-dev && bun test tests/foundation-registry.test.ts`
Expected: 11 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev && git add src/foundation-registry.ts tests/foundation-registry.test.ts && git commit -m "feat: add FoundationRegistry with in-memory cache and Supabase store"
```

---

### Task 4: Wire Foundation into Coordinator

**Files:**
- Modify: `src/coordinator.ts`
- Modify: `src/telegram-handlers.ts`
- Modify: `src/ellie-chat-handler.ts`
- Modify: `src/http-routes.ts`

- [ ] **Step 1: Update coordinator.ts to use foundation registry**

In `src/coordinator.ts`, replace the hardcoded `AGENT_TOOLS` lookup in `buildCoordinatorDeps` with foundation-aware tool lookup. Replace `agentRoster` in `CoordinatorOpts` with an optional override (the registry provides the default).

Add a new import at the top:
```typescript
import type { FoundationRegistry } from "./foundation-registry.ts";
```

Add `registry?: FoundationRegistry` to the `CoordinatorOpts` interface.

Update `runCoordinatorLoop` to read from registry when available:
```typescript
// Near the top of runCoordinatorLoop, after destructuring opts:
const behavior = opts.registry?.getBehavior();
const effectiveMaxIterations = behavior?.max_loop_iterations ?? maxIterations;
const effectiveCostCap = behavior?.cost_cap_session ?? costCapUsd;
const effectiveModel = behavior?.coordinator_model ?? model;
const effectiveRoster = opts.registry?.getAgentRoster() ?? agentRoster;
const effectivePrompt = opts.registry?.getCoordinatorPrompt() ?? systemPrompt;
```

Update the `AGENT_TOOLS` lookup in `buildCoordinatorDeps.callSpecialist` to use the registry:
```typescript
// Replace the hardcoded AGENT_TOOLS with:
const agentToolCategories = opts.registry
  ? (opts.registry.getAgentTools(agent) || [])
  : (AGENT_TOOLS[agent] ?? AGENT_TOOLS["general"]);
```

Keep the hardcoded `AGENT_TOOLS` as fallback for when no registry is provided (backward compatibility).

- [ ] **Step 2: Update telegram-handlers.ts**

Replace the hardcoded coordinator config with registry lookup. Add import:
```typescript
import { FoundationRegistry, createSupabaseFoundationStore } from "./foundation-registry.ts";
```

Replace the hardcoded `foundation: "software-dev"`, `agentRoster`, and `systemPrompt` with:
```typescript
const coordinatorResult = await runCoordinatorLoop({
  message: effectiveText,
  channel: "telegram",
  userId: userId,
  registry: foundationRegistry,  // Pass the registry
  foundation: foundationRegistry?.getActive()?.name || "software-dev",
  systemPrompt: foundationRegistry?.getCoordinatorPrompt() || "You are Ellie, a coordinator for Dave.",
  model: foundationRegistry?.getBehavior()?.coordinator_model || agentModel || "claude-sonnet-4-6",
  agentRoster: foundationRegistry?.getAgentRoster() || ["james", "brian", "kate", "alan", "jason", "amy", "marcus"],
  // ... rest unchanged
```

The `foundationRegistry` needs to be initialized at module level or passed in. For now, create it lazily:
```typescript
let _foundationRegistry: FoundationRegistry | null = null;
async function getFoundationRegistry(): Promise<FoundationRegistry | null> {
  if (_foundationRegistry) return _foundationRegistry;
  const { supabase } = getRelayDeps();
  if (!supabase) return null;
  const { createSupabaseFoundationStore, FoundationRegistry } = await import("./foundation-registry.ts");
  _foundationRegistry = new FoundationRegistry(createSupabaseFoundationStore(supabase));
  await _foundationRegistry.refresh();
  return _foundationRegistry;
}
```

- [ ] **Step 3: Update ellie-chat-handler.ts with the same pattern**

Same approach as telegram-handlers — lazy registry initialization, pass to `runCoordinatorLoop`.

- [ ] **Step 4: Update http-routes.ts with the same pattern**

Same approach. Also add `/foundation` command handling in the Google Chat message path:
```typescript
// After the /plan command handling, add:
const foundationMatch = parsed.text.match(/^\/foundation\s+(\S+)$/i);
if (foundationMatch) {
  const registry = await getFoundationRegistry();
  if (registry) {
    try {
      await registry.switchTo(foundationMatch[1]);
      const response = { text: `Switched to foundation: ${foundationMatch[1]}` };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (err) {
      const response = { text: `Failed to switch: ${err.message}` };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    }
  }
  return;
}
```

- [ ] **Step 5: Run tests**

Run: `cd /home/ellie/ellie-dev && bun test tests/coordinator.test.ts tests/foundation-registry.test.ts tests/foundation-types.test.ts`
Expected: All pass (coordinator tests use `_testResponses` so they don't need a real registry)

- [ ] **Step 6: Commit**

```bash
cd /home/ellie/ellie-dev && git add src/coordinator.ts src/telegram-handlers.ts src/ellie-chat-handler.ts src/http-routes.ts && git commit -m "feat: wire foundation registry into coordinator and all handlers"
```

---

### Task 5: Foundation Swap Command

**Files:**
- Modify: `src/ellie-chat-handler.ts` — add `/foundation` slash command in ellie-chat
- Modify: `src/coordinator-tools.ts` — add foundation info to `read_context` source enum

- [ ] **Step 1: Add `/foundation` command to ellie-chat handler**

In `src/ellie-chat-handler.ts`, find the slash command handling section (near the `/plan`, `/ticket` commands). Add:

```typescript
// /foundation <name> — switch active foundation
if (text.startsWith("/foundation")) {
  const parts = text.split(/\s+/);
  const subcommand = parts[1];
  const registry = await getFoundationRegistry();

  if (!registry) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "response", text: "Foundation system not available (no database connection).", agent: "system", ts: Date.now() }));
    }
    return;
  }

  if (!subcommand || subcommand === "list") {
    const all = registry.listAll();
    const active = registry.getActive();
    const list = all.map(f => `${f.name === active?.name ? "**→** " : "  "}${f.name} — ${f.description} (${f.agents.length} agents)`).join("\n");
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "response", text: `Foundations:\n${list}`, agent: "system", ts: Date.now() }));
    }
    return;
  }

  try {
    const switched = await registry.switchTo(subcommand);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "response", text: `Switched to **${switched.name}** — ${switched.description}\n${switched.agents.length} agents: ${switched.agents.map(a => a.name).join(", ")}`, agent: "system", ts: Date.now() }));
    }
  } catch (err) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "response", text: `Failed to switch: ${(err as Error).message}`, agent: "system", ts: Date.now() }));
    }
  }
  return;
}
```

- [ ] **Step 2: Add "foundations" to read_context source enum**

In `src/coordinator-tools.ts`, update the `read_context` tool's source enum to include "foundations":

```typescript
source: {
  type: "string",
  enum: ["forest", "plane", "memory", "sessions", "foundations"],
  description: "Which system to query.",
},
```

And in `src/coordinator.ts`, add the handler for "foundations" in the `read_context` switch:

```typescript
case "foundations": {
  if (opts.registry) {
    const all = opts.registry.listAll();
    const active = opts.registry.getActive();
    data = `Active: ${active?.name || "none"}\nAvailable: ${all.map(f => `${f.name} (${f.agents.length} agents)`).join(", ")}`;
  } else {
    data = "Foundation registry not available.";
  }
  break;
}
```

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-dev && git add src/ellie-chat-handler.ts src/coordinator-tools.ts src/coordinator.ts && git commit -m "feat: add /foundation slash command and foundations read_context source"
```

---

### Task 6: End-to-End Validation

**Files:**
- No new files

- [ ] **Step 1: Run all foundation tests**

Run: `cd /home/ellie/ellie-dev && bun test tests/foundation-types.test.ts tests/foundation-registry.test.ts tests/coordinator.test.ts tests/coordinator-tools.test.ts tests/coordinator-context.test.ts tests/dispatch-envelope.test.ts`
Expected: All pass

- [ ] **Step 2: Apply migration and seed to database**

Run: `cd /home/ellie/ellie-dev && bun run migrate --db supabase` (or apply manually via psql)
Run: `cd /home/ellie/ellie-dev && psql "$DATABASE_URL" -f seeds/supabase/002_foundations.sql`

- [ ] **Step 3: Restart relay and test**

Run: `systemctl --user restart claude-telegram-relay`

- [ ] **Step 4: Test foundation list**

In Ellie Chat, send: `/foundation list`
Expected: Shows software-dev (active) and life-management

- [ ] **Step 5: Test foundation switch**

In Ellie Chat, send: `/foundation life-management`
Expected: Switches to life-management, shows new agent roster

- [ ] **Step 6: Test coordinator uses new foundation**

Send a message to Ellie. Verify logs show the life-management agents (coach, scheduler, scribe, buddy) instead of software-dev agents.

- [ ] **Step 7: Switch back**

Send: `/foundation software-dev`
Verify: Back to james, brian, kate, etc.

---

## Summary

| Task | What It Builds | Files | Tests |
|------|---------------|-------|-------|
| 1 | Foundation types and validation | `src/foundation-types.ts` | 4 tests |
| 2 | Database schema and seed data | `migrations/`, `seeds/` | Manual verification |
| 3 | Foundation Registry | `src/foundation-registry.ts` | 11 tests |
| 4 | Wire into coordinator + handlers | 4 modified files | Existing tests pass |
| 5 | `/foundation` command + read_context | 3 modified files | — |
| 6 | End-to-end validation | — | Manual testing |

**Total:** 3 new files, 6 modified files, 2 SQL files, ~15 automated tests, 6 commits.
