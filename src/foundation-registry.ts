/**
 * Foundation Registry — Task 3 of 6
 *
 * Loads, caches, and manages swappable Foundation configurations.
 * The registry holds an in-memory cache populated by `refresh()` and
 * keeps track of which foundation is currently active.
 *
 * Production use: pass a `createSupabaseFoundationStore(supabase)` result.
 * Testing use:    pass any object that satisfies `FoundationStore`.
 */

import { log } from "./logger.ts";
export type { Foundation, AgentDef, BehaviorRules, Recipe } from "./foundation-types.ts";
import type { Foundation, AgentDef, BehaviorRules, Recipe } from "./foundation-types.ts";

const logger = log.child("foundation-registry");

// ── Store Interface ───────────────────────────────────────────────

/**
 * Persistence adapter for foundations.
 * Implement this for any backing store (Supabase, in-memory, file, etc.).
 */
export interface FoundationStore {
  /** Return all known foundations. */
  loadAll: () => Promise<Foundation[]>;
  /** Return a single foundation by name, or null if not found. */
  loadByName: (name: string) => Promise<Foundation | null>;
  /** Mark a foundation as active (clears any previously active one). */
  setActive: (name: string) => Promise<void>;
}

// ── Default Behavior ──────────────────────────────────────────────

const DEFAULT_BEHAVIOR: BehaviorRules = {
  approvals: {},
  proactivity: "medium",
  tone: "helpful and concise",
  escalation: "Ask the user when uncertain about scope or intent.",
  max_loop_iterations: 10,
  cost_cap_session: 5,
  cost_cap_daily: 20,
  coordinator_model: "claude-sonnet-4-6",
};

// ── Registry ──────────────────────────────────────────────────────

export class FoundationRegistry {
  private store: FoundationStore;
  private cache: Map<string, Foundation> = new Map();
  private activeName: string | null = null;

  constructor(store: FoundationStore) {
    this.store = store;
  }

  // ── Lifecycle ────────────────────────────────────────────────

  /**
   * Load all foundations from the store into the in-memory cache.
   * Must be called before any read operations.
   */
  async refresh(): Promise<void> {
    logger.info("Refreshing foundation cache");
    const foundations = await this.store.loadAll();
    this.cache.clear();
    this.activeName = null;

    for (const f of foundations) {
      this.cache.set(f.name, f);
      if (f.active) {
        this.activeName = f.name;
      }
    }

    logger.info("Foundation cache refreshed", {
      count: this.cache.size,
      active: this.activeName,
    });
  }

  // ── Reads ────────────────────────────────────────────────────

  /** Return the currently active foundation, or null if none is active. */
  getActive(): Foundation | null {
    if (!this.activeName) return null;
    return this.cache.get(this.activeName) ?? null;
  }

  /** Return a foundation by name from the cache, or null if not found. */
  getByName(name: string): Foundation | null {
    return this.cache.get(name) ?? null;
  }

  /** Return all cached foundations. */
  listAll(): Foundation[] {
    return Array.from(this.cache.values());
  }

  // ── Writes ───────────────────────────────────────────────────

  /**
   * Switch to a named foundation.
   * Persists via `store.setActive`, then updates the cache.
   * Throws if the foundation is not found in the cache.
   */
  async switchTo(name: string): Promise<Foundation> {
    const target = this.cache.get(name);
    if (!target) {
      throw new Error(`Foundation "${name}" not found in registry`);
    }

    logger.info("Switching active foundation", { from: this.activeName, to: name });
    await this.store.setActive(name);

    // Update cache: deactivate old, activate new
    if (this.activeName && this.activeName !== name) {
      const prev = this.cache.get(this.activeName);
      if (prev) {
        this.cache.set(this.activeName, { ...prev, active: false });
      }
    }
    const activated = { ...target, active: true };
    this.cache.set(name, activated);
    this.activeName = name;

    return activated;
  }

  // ── Convenience Accessors ────────────────────────────────────

  /** Return the agent names in the active foundation. */
  getAgentRoster(): string[] {
    return this.getActive()?.agents.map((a) => a.name) ?? [];
  }

  /**
   * Return the tool categories for a named agent in the active foundation.
   * Returns an empty array if the agent is not found.
   */
  getAgentTools(agentName: string): string[] {
    const agent = this._findAgent(agentName);
    return agent?.tools ?? [];
  }

  /**
   * Return the full AgentDef for a named agent in the active foundation.
   * Returns null if the agent is not found.
   */
  getAgentDef(agentName: string): AgentDef | null {
    return this._findAgent(agentName) ?? null;
  }

  /**
   * Return the behavior rules from the active foundation.
   * Falls back to sensible defaults if no foundation is active.
   */
  getBehavior(): BehaviorRules {
    return this.getActive()?.behavior ?? DEFAULT_BEHAVIOR;
  }

  /** Return the recipes from the active foundation. */
  getRecipes(): Recipe[] {
    return this.getActive()?.recipes ?? [];
  }

  /**
   * Build a coordinator system prompt from the active foundation.
   *
   * Includes:
   * - Agent roster with roles and tools
   * - Recipe list with triggers
   * - Behavior rules (tone, proactivity, escalation)
   * - Core dispatch instruction
   */
  getCoordinatorPrompt(): string {
    const foundation = this.getActive();
    const behavior = this.getBehavior();
    const recipes = this.getRecipes();

    const lines: string[] = [];

    // Header
    if (foundation) {
      lines.push(`# Coordinator — ${foundation.name}`);
      if (foundation.description) {
        lines.push(foundation.description);
      }
    } else {
      lines.push("# Coordinator");
    }

    lines.push("");

    // Core instruction
    lines.push(
      "Your specialists have tools you don't — dispatch them rather than saying you can't do it.",
    );
    lines.push("");

    // Agent roster
    lines.push("## Agent Roster");
    const agents = foundation?.agents ?? [];
    if (agents.length === 0) {
      lines.push("No agents defined.");
    } else {
      for (const agent of agents) {
        const toolList = agent.tools.join(", ");
        lines.push(`- **${agent.name}** (${agent.role}): tools=[${toolList}]`);
      }
    }
    lines.push("");

    // Recipes
    lines.push("## Recipes");
    if (recipes.length === 0) {
      lines.push("No recipes defined.");
    } else {
      for (const recipe of recipes) {
        const trigger = recipe.trigger ?? "No trigger specified";
        lines.push(`- **${recipe.name}** [${recipe.pattern}]: ${trigger}`);
      }
    }
    lines.push("");

    // Behavior
    lines.push("## Behavior");
    lines.push(`- **Tone**: ${behavior.tone}`);
    lines.push(`- **Proactivity**: ${behavior.proactivity}`);
    lines.push(`- **Escalation**: ${behavior.escalation}`);

    return lines.join("\n");
  }

  // ── Private ──────────────────────────────────────────────────

  private _findAgent(name: string): AgentDef | undefined {
    return this.getActive()?.agents.find((a) => a.name === name);
  }
}

// ── Supabase Store Factory ────────────────────────────────────────

/**
 * Create a FoundationStore backed by Supabase.
 *
 * Table: `foundations`
 * Columns: name, description, icon, version, agents (jsonb), recipes (jsonb),
 *          behavior (jsonb), active (boolean), coordinator_prompt, agent_prompts (jsonb)
 *
 * @param supabase — A Supabase client instance (from @supabase/supabase-js)
 */
export function createSupabaseFoundationStore(supabase: {
  from: (table: string) => any;
}): FoundationStore {
  return {
    async loadAll(): Promise<Foundation[]> {
      const { data, error } = await supabase
        .from("foundations")
        .select("*")
        .order("name");

      if (error) {
        logger.error("Failed to load foundations", { error });
        throw new Error(`loadAll failed: ${error.message}`);
      }

      return (data ?? []) as Foundation[];
    },

    async loadByName(name: string): Promise<Foundation | null> {
      const { data, error } = await supabase
        .from("foundations")
        .select("*")
        .eq("name", name)
        .maybeSingle();

      if (error) {
        logger.error("Failed to load foundation by name", { name, error });
        throw new Error(`loadByName failed: ${error.message}`);
      }

      return data ?? null;
    },

    async setActive(name: string): Promise<void> {
      // Clear all active flags
      const { error: clearError } = await supabase
        .from("foundations")
        .update({ active: false })
        .eq("active", true);

      if (clearError) {
        logger.error("Failed to clear active foundations", { error: clearError });
        throw new Error(`setActive (clear) failed: ${clearError.message}`);
      }

      // Set the target foundation active
      const { error: setError } = await supabase
        .from("foundations")
        .update({ active: true })
        .eq("name", name);

      if (setError) {
        logger.error("Failed to set active foundation", { name, error: setError });
        throw new Error(`setActive (set) failed: ${setError.message}`);
      }
    },
  };
}
