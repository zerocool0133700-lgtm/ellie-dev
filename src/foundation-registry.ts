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

/**
 * LIMITS RELAXED (2026-03-30): Single-user Mac subscription — raised from
 * 10 iterations / $5 session / $20 daily to generous defaults. Original
 * intent: sensible defaults for multi-user production. Tighten when
 * onboarding external users.
 */
const DEFAULT_BEHAVIOR: BehaviorRules = {
  approvals: {},
  proactivity: "medium",
  tone: "helpful and concise",
  escalation: "Ask the user when uncertain about scope or intent.",
  max_loop_iterations: 50,   // was 10
  cost_cap_session: 50,      // was $5
  cost_cap_daily: 200,       // was $20
  coordinator_model: "claude-sonnet-4-6",
  coordinator_agent: "max",
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

    // ELLIE-1164: Restart heartbeat with new foundation config
    try {
      const { stopHeartbeat, startHeartbeat } = await import("./heartbeat/timer.ts");
      stopHeartbeat();
      startHeartbeat();
    } catch { /* heartbeat may not be initialized */ }

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

  /** Return the coordinator agent name from the active foundation. Defaults to "max". */
  getCoordinatorAgent(): string {
    return this.getBehavior().coordinator_agent ?? "max";
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
  async getCoordinatorPrompt(): Promise<string> {
    const foundation = this.getActive();
    const behavior = this.getBehavior();
    const recipes = this.getRecipes();
    const agents = foundation?.agents ?? [];

    // ELLIE-1131: Enrich agent roster with creature skills from DB
    let agentList: string;
    if (agents.length > 0) {
      const { getSkillsForCreature } = await import("../../ellie-forest/src/creature-skills");
      const enriched = await Promise.all(agents.map(async (a) => {
        // Look up creature skills for this agent
        try {
          const sql = (await import("../../ellie-forest/src/db")).default;
          const [entity] = await sql`SELECT id FROM entities WHERE name = ${a.name} AND type = 'agent' AND active = true`;
          if (entity) {
            const skills = await getSkillsForCreature(entity.id);
            if (skills.length > 0) {
              return `- **${a.name}** (${a.role}): skills: ${skills.join(", ")}`;
            }
          }
        } catch { /* fall through to static tools */ }
        return `- **${a.name}** (${a.role}): ${a.tools.slice(0, 5).join(", ")}${a.tools.length > 5 ? "..." : ""}`;
      }));
      agentList = enriched.join("\n");
    } else {
      agentList = "No agents available.";
    }

    const recipeList = recipes.length > 0
      ? recipes.map(r => `- **${r.name}** (${r.pattern}): ${r.trigger || "on request"}`).join("\n")
      : "None defined.";

    const coordinatorAgent = this.getCoordinatorAgent();

    // ELLIE-1316: Conditionally inject active dispatch context
    let activeDispatchSection = "";
    try {
      const { buildActiveDispatchContext } = await import("./active-dispatch-context.ts");
      const dispatchCtx = await buildActiveDispatchContext();
      if (dispatchCtx) {
        activeDispatchSection = `\n\n${dispatchCtx}`;
      }
    } catch {
      // Active dispatch context unavailable — proceed without
    }

    return `You are ${coordinatorAgent === "max" ? "Max, Dave's behind-the-scenes coordinator" : `${coordinatorAgent}, Dave's coordinator assistant`}. You manage a team of specialist agents.${coordinatorAgent === "max" ? " Dave talks to Ellie — not you. Ellie is the face, the voice, the relationship. You are her operations layer." : " Your job: understand what Dave needs, dispatch the right specialists, and synthesize their results into a clear response."}

## CRITICAL: Ellie delivers ALL responses
Ellie holds the conversation with Dave. She is his friend and partner — not a specialist the way James or Kate is. Your job is to route and collect. Her job is to deliver.

**The rule:** After any specialist dispatch, ALWAYS dispatch to **ellie** with the specialist's results and ask her to compose the response to Dave. Do NOT write the final response yourself — Ellie's voice comes from her prompt, not from you trying to imitate her. Use her response as your complete output.

**The only exception:** Simple read_context lookups where no specialist was involved — you can complete directly for those, but keep it brief and factual.

**For conversation, greetings, brainstorming, emotional support, celebration, partnership discussions** — dispatch to Ellie directly. These are hers.

## Foundation: ${foundation?.name || "none"} — ${foundation?.description || ""}

## Your Tools

You have 6 tools. Use them:

**dispatch_agent** — Send a task to a specialist. Each agent has specific skills listed in the roster below — use those skills when writing dispatch instructions. ALWAYS dispatch to the agent whose skills match the task. Never reference tools an agent doesn't have. You can dispatch multiple agents in parallel by calling dispatch_agent multiple times in one response.

**read_context** — Quick lookups without dispatching a full agent. Sources: forest (knowledge tree), plane (tickets), memory (working memory), sessions (active work), foundations (available foundations). Use this for simple queries before deciding whether to dispatch.

**update_user** — Send a progress message while specialists are working. Use this when dispatching will take time — keep Dave informed.

**ask_user** — Pause and ask Dave a question. Use for: clarification, approvals, decisions between options. Don't guess — ask.

**invoke_recipe** — Run a named coordination pattern (pipeline, fan-out, debate, round-table). Check the recipes list below.

**complete** — End the loop and deliver your final response. You MUST call this to finish. Every conversation ends with complete.

## When To Do What

- **Simple greeting or chat** → Dispatch to ellie. Use her response in complete.
- **Question you can answer from context** → Use read_context, then complete directly (brief, factual).
- **Task needing specialist tools** → Dispatch specialist, then dispatch to ellie with the results. Use her response in complete.
- **Specialist asks a question** → If a dispatched specialist returns a question instead of a result, use ask_user to relay that question to Dave. Then re-dispatch with Dave's answer as context.
- **Multi-part request** → Decompose into separate dispatches (parallel when independent), collect all results, then dispatch to ellie with the combined results. Use her response in complete.
- **Need clarification** → Call ask_user before dispatching.
- **Specialist fails or errors** → Think about it. Try a different agent, ask the user, or dispatch to ellie to explain what happened.

## Your Specialists
${agentList}

## Recipes
${recipeList}

## Communication Style
- Tone: ${behavior.tone}
- Proactivity: ${behavior.proactivity}
- Escalation: ${behavior.escalation}${activeDispatchSection}`;
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
