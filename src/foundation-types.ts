/**
 * Foundation Types — Core Data Model
 *
 * Task 1 of 6 in the Foundation System plan.
 *
 * Defines the Foundation data model: a named configuration that bundles
 * agent definitions, coordination recipes, and behavior rules. Used by
 * the Foundation Registry (Task 3) and the coordinator (Task 4).
 *
 * Pure module — types and validation only, no external dependencies.
 */

// ── Agent Definition ─────────────────────────────────────────────

/**
 * Defines an agent that can participate in a Foundation.
 * Tool names must reference categories from tool-access-control.ts.
 */
export interface AgentDef {
  /** Unique agent name within this foundation. */
  name: string;
  /** Human-readable role description (e.g. "Developer", "Critic"). */
  role: string;
  /** Tool category names from tool-access-control.ts (e.g. "read", "write"). */
  tools: string[];
  /** Model identifier (e.g. "claude-sonnet-4-6"). */
  model: string;
  /** River doc key for this agent's system prompt. Loaded at runtime. */
  prompt_key?: string;
}

// ── Recipe ───────────────────────────────────────────────────────

/**
 * A coordination recipe defines how agents collaborate on a task.
 *
 * Patterns:
 * - pipeline:    Sequential steps, each agent hands off to the next.
 * - fan-out:     All agents work in parallel, outputs merged.
 * - debate:      Agents argue positions, coordinator decides.
 * - round-table: Multi-phase structured discussion.
 */
export interface Recipe {
  /** Unique name for this recipe. */
  name: string;
  /** Coordination pattern. */
  pattern: "pipeline" | "fan-out" | "debate" | "round-table";
  /** Agent names in execution order (pipeline). */
  steps?: string[];
  /** Agent names participating in parallel/debate/round-table. */
  agents?: string[];
  /** Phase names for round-table pattern. */
  phases?: string[];
  /** Hint for the coordinator on when to use this recipe. */
  trigger?: string;
}

// ── Behavior Rules ───────────────────────────────────────────────

/**
 * Governs runtime behavior: approvals, cost caps, communication style.
 */
export interface BehaviorRules {
  /** Maps action names to approval policy: "always_confirm" | "confirm_first_time" | "auto". */
  approvals: Record<string, string>;
  /** How proactively the system acts without being asked: "high" | "medium" | "low". */
  proactivity: string;
  /** Free-text description of the desired communication style. */
  tone: string;
  /** Free-text policy describing when and how to escalate. */
  escalation: string;
  /** Max agentic loop iterations before aborting. */
  max_loop_iterations: number;
  /** USD cost cap per session. */
  cost_cap_session: number;
  /** USD cost cap per day. */
  cost_cap_daily: number;
  /** Model used by the coordinator agent. */
  coordinator_model: string;
}

// ── Foundation ───────────────────────────────────────────────────

/**
 * A Foundation is a named, versioned configuration that bundles agents,
 * recipes, and behavior rules into a deployable unit.
 *
 * Prompts are loaded from the River vault at runtime and stored in
 * coordinator_prompt / agent_prompts — they are not persisted to disk.
 */
export interface Foundation {
  /** Unique human-readable name for this foundation. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Optional display icon (emoji or identifier). */
  icon?: string;
  /** Schema version. Increment on breaking changes. */
  version?: number;
  /** Agents available within this foundation. */
  agents: AgentDef[];
  /** Coordination recipes available within this foundation. */
  recipes: Recipe[];
  /** Runtime behavior rules. */
  behavior: BehaviorRules;
  /** Whether this foundation is currently active. */
  active: boolean;
  /** Coordinator system prompt — loaded from River at runtime. */
  coordinator_prompt?: string;
  /** Per-agent system prompts — loaded from River at runtime. Keyed by agent name. */
  agent_prompts?: Record<string, string>;
}

// ── Validation ───────────────────────────────────────────────────

/** Result of validating a Foundation. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a Foundation configuration.
 *
 * Checks:
 * - name is non-empty
 * - at least one agent defined
 * - each agent has name, role, and at least one tool
 * - recipe steps/agents only reference agents in the roster
 */
export function validateFoundation(f: Foundation): ValidationResult {
  const errors: string[] = [];

  // name must be non-empty
  if (!f.name || !f.name.trim()) {
    errors.push("Foundation name must be non-empty");
  }

  // at least one agent
  if (!f.agents || f.agents.length === 0) {
    errors.push("Foundation must define at least one agent");
  }

  // validate each agent
  const agentNames = new Set<string>();
  for (let i = 0; i < (f.agents ?? []).length; i++) {
    const agent = f.agents[i];
    if (!agent.name || !agent.name.trim()) {
      errors.push(`agents[${i}]: name must be non-empty`);
    } else {
      agentNames.add(agent.name);
    }
    if (!agent.role || !agent.role.trim()) {
      errors.push(`agents[${i}] (${agent.name || "?"}): role must be non-empty`);
    }
    if (!agent.tools || agent.tools.length === 0) {
      errors.push(`agents[${i}] (${agent.name || "?"}): must have at least one tool`);
    }
  }

  // validate recipes reference known agents
  for (let i = 0; i < (f.recipes ?? []).length; i++) {
    const recipe = f.recipes[i];
    const label = `recipes[${i}] (${recipe.name || "?"})`;

    const referencedAgents: string[] = [
      ...(recipe.steps ?? []),
      ...(recipe.agents ?? []),
    ];

    for (const agentName of referencedAgents) {
      if (!agentNames.has(agentName)) {
        errors.push(
          `${label}: references agent "${agentName}" which is not in the foundation's agent roster`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
