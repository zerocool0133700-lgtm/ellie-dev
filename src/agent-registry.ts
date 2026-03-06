/**
 * Agent Registry — ELLIE-599
 *
 * In-memory registry tracking active agent sessions for agent-to-agent
 * routing. Maps agent names to session endpoints, capabilities, and
 * availability status.
 *
 * Used by the coordinator and sub-commitment system (ELLIE-598) to
 * route requests between agents (e.g., dev asks critic for a review).
 *
 * Pure module — zero side effects beyond the in-memory store.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** Agent availability status. */
export type AgentStatus = "idle" | "busy" | "offline";

/** A capability an agent can fulfill. */
export interface AgentCapability {
  name: string;
  description?: string;
}

/** A registered agent entry. */
export interface RegisteredAgent {
  agentName: string;
  agentType: string;
  sessionId?: string;
  endpoint?: string;
  status: AgentStatus;
  capabilities: AgentCapability[];
  registeredAt: string;
  lastActiveAt: string;
}

/** Input for registering an agent. */
export interface RegisterAgentInput {
  agentName: string;
  agentType: string;
  capabilities?: AgentCapability[];
  endpoint?: string;
}

/** Result of looking up an agent for routing. */
export type AgentLookupResult =
  | { found: true; agent: RegisteredAgent; available: boolean }
  | { found: false; agentName: string; reason: "not_registered" | "offline" };

// ── Storage ──────────────────────────────────────────────────────────────────

const _registry = new Map<string, RegisteredAgent>();

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Register an agent in the registry.
 * If already registered, updates the entry (preserves session if active).
 */
export function registerAgent(input: RegisterAgentInput): RegisteredAgent {
  const now = new Date().toISOString();
  const existing = _registry.get(input.agentName);

  const agent: RegisteredAgent = {
    agentName: input.agentName,
    agentType: input.agentType,
    sessionId: existing?.sessionId,
    endpoint: input.endpoint ?? existing?.endpoint,
    status: existing?.status ?? "idle",
    capabilities: input.capabilities ?? existing?.capabilities ?? [],
    registeredAt: existing?.registeredAt ?? now,
    lastActiveAt: now,
  };

  _registry.set(input.agentName, agent);
  return agent;
}

/**
 * Unregister an agent — removes it from the registry entirely.
 */
export function unregisterAgent(agentName: string): boolean {
  return _registry.delete(agentName);
}

// ── Session lifecycle ────────────────────────────────────────────────────────

/**
 * Mark an agent as busy with a session.
 * Called when a work session starts for this agent.
 */
export function startAgentSession(
  agentName: string,
  sessionId: string,
  endpoint?: string,
): RegisteredAgent | null {
  const agent = _registry.get(agentName);
  if (!agent) return null;

  const updated: RegisteredAgent = {
    ...agent,
    sessionId,
    endpoint: endpoint ?? agent.endpoint,
    status: "busy",
    lastActiveAt: new Date().toISOString(),
  };
  _registry.set(agentName, updated);
  return updated;
}

/**
 * Mark an agent as idle (session complete).
 * Called when a work session ends.
 */
export function completeAgentSession(agentName: string): RegisteredAgent | null {
  const agent = _registry.get(agentName);
  if (!agent) return null;

  const updated: RegisteredAgent = {
    ...agent,
    sessionId: undefined,
    status: "idle",
    lastActiveAt: new Date().toISOString(),
  };
  _registry.set(agentName, updated);
  return updated;
}

/**
 * Mark an agent as offline.
 */
export function setAgentOffline(agentName: string): RegisteredAgent | null {
  const agent = _registry.get(agentName);
  if (!agent) return null;

  const updated: RegisteredAgent = {
    ...agent,
    status: "offline",
    lastActiveAt: new Date().toISOString(),
  };
  _registry.set(agentName, updated);
  return updated;
}

// ── Lookup ───────────────────────────────────────────────────────────────────

/**
 * Look up an agent for routing.
 * Returns routing info and availability, or reason if not found.
 */
export function lookupAgent(agentName: string): AgentLookupResult {
  const agent = _registry.get(agentName);

  if (!agent) {
    return { found: false, agentName, reason: "not_registered" };
  }

  if (agent.status === "offline") {
    return { found: false, agentName, reason: "offline" };
  }

  return {
    found: true,
    agent,
    available: agent.status === "idle",
  };
}

/**
 * Get a registered agent by name.
 */
export function getAgent(agentName: string): RegisteredAgent | null {
  return _registry.get(agentName) ?? null;
}

/**
 * List all registered agents, optionally filtered by status.
 */
export function listAgents(status?: AgentStatus): RegisteredAgent[] {
  const all = [..._registry.values()];
  if (!status) return all;
  return all.filter(a => a.status === status);
}

/**
 * Find agents that have a specific capability.
 */
export function findAgentsByCapability(capabilityName: string): RegisteredAgent[] {
  return [..._registry.values()].filter(a =>
    a.capabilities.some(c => c.name === capabilityName),
  );
}

/**
 * Check if a specific agent can fulfill a capability.
 */
export function agentHasCapability(agentName: string, capabilityName: string): boolean {
  const agent = _registry.get(agentName);
  if (!agent) return false;
  return agent.capabilities.some(c => c.name === capabilityName);
}

// ── Routing helper ───────────────────────────────────────────────────────────

/** Route resolution result. */
export type RouteResult =
  | { routable: true; agent: RegisteredAgent }
  | { routable: false; reason: string };

/**
 * Resolve a route to an agent, validating capability if specified.
 * Used by the coordinator to validate agent-to-agent requests.
 */
export function resolveRoute(
  agentName: string,
  requiredCapability?: string,
): RouteResult {
  const lookup = lookupAgent(agentName);

  if (!lookup.found) {
    return {
      routable: false,
      reason: lookup.reason === "offline"
        ? `Agent '${agentName}' is offline`
        : `Agent '${agentName}' is not registered`,
    };
  }

  if (!lookup.available) {
    return {
      routable: false,
      reason: `Agent '${agentName}' is busy (session: ${lookup.agent.sessionId})`,
    };
  }

  if (requiredCapability && !agentHasCapability(agentName, requiredCapability)) {
    return {
      routable: false,
      reason: `Agent '${agentName}' does not have capability '${requiredCapability}'`,
    };
  }

  return { routable: true, agent: lookup.agent };
}

// ── Testing ──────────────────────────────────────────────────────────────────

/** Reset registry — for testing only. */
export function _resetRegistryForTesting(): void {
  _registry.clear();
}
