/**
 * Agent-Doc Dependency Mapping — ELLIE-761
 *
 * Bidirectional graph between agents and River documents.
 * Shows which docs each agent needs and which agents each doc serves.
 *
 * Builds on ELLIE-760 (river-inventory) DOC_AGENT_MAP.
 * Pure module — sources data from inventory, not hardcoded.
 */

import { DOC_AGENT_MAP, RIVER_DOC_REGISTRY, buildInventoryFromData } from "./river-inventory.ts";
import { getCachedRiverDoc } from "./prompt-builder.ts";
import { estimateTokens } from "./relay-utils.ts";

// ── Types ────────────────────────────────────────────────────

export interface AgentDocProfile {
  docs: string[];
  total_tokens: number;
}

export interface DocAgentProfile {
  used_by: string[];
  shared: boolean;
  path: string;
  tokens: number;
}

export interface AgentMapResult {
  agents: Record<string, AgentDocProfile>;
  docs: Record<string, DocAgentProfile>;
}

// ── Build Agent Map ─────────────────────────────────────────

/**
 * Build the bidirectional agent-doc dependency map.
 * Uses live River doc cache for token counts.
 */
export function buildAgentMap(): AgentMapResult {
  // Build agent -> docs (invert the DOC_AGENT_MAP)
  const agentDocs: Record<string, Set<string>> = {};

  for (const [docKey, agents] of Object.entries(DOC_AGENT_MAP)) {
    for (const agent of agents) {
      if (!agentDocs[agent]) agentDocs[agent] = new Set();
      agentDocs[agent].add(docKey);
    }
  }

  // Build agents side with token counts
  const agents: Record<string, AgentDocProfile> = {};
  for (const [agent, docSet] of Object.entries(agentDocs)) {
    const docs = Array.from(docSet);
    let totalTokens = 0;
    for (const docKey of docs) {
      const cached = getCachedRiverDoc(docKey);
      if (cached) totalTokens += estimateTokens(cached);
    }
    agents[agent] = { docs, total_tokens: totalTokens };
  }

  // Build docs side with shared flag
  const docs: Record<string, DocAgentProfile> = {};
  for (const { key, path } of RIVER_DOC_REGISTRY) {
    const usedBy = DOC_AGENT_MAP[key] ?? [];
    const cached = getCachedRiverDoc(key);
    docs[key] = {
      used_by: usedBy,
      shared: usedBy.length > 1,
      path: `river/${path}`,
      tokens: cached ? estimateTokens(cached) : 0,
    };
  }

  return { agents, docs };
}

/**
 * Build agent map from pre-provided data (for testing without cache).
 * Pure function.
 */
export function buildAgentMapFromData(
  tokenData: Record<string, number>,
): AgentMapResult {
  // Build agent -> docs
  const agentDocs: Record<string, Set<string>> = {};
  for (const [docKey, agents] of Object.entries(DOC_AGENT_MAP)) {
    for (const agent of agents) {
      if (!agentDocs[agent]) agentDocs[agent] = new Set();
      agentDocs[agent].add(docKey);
    }
  }

  const agents: Record<string, AgentDocProfile> = {};
  for (const [agent, docSet] of Object.entries(agentDocs)) {
    const docs = Array.from(docSet);
    const totalTokens = docs.reduce((sum, d) => sum + (tokenData[d] ?? 0), 0);
    agents[agent] = { docs, total_tokens: totalTokens };
  }

  const docs: Record<string, DocAgentProfile> = {};
  for (const { key, path } of RIVER_DOC_REGISTRY) {
    const usedBy = DOC_AGENT_MAP[key] ?? [];
    docs[key] = {
      used_by: usedBy,
      shared: usedBy.length > 1,
      path: `river/${path}`,
      tokens: tokenData[key] ?? 0,
    };
  }

  return { agents, docs };
}

/**
 * Get the list of all agents that appear in the dependency graph.
 */
export function getAgentNames(): string[] {
  const agents = new Set<string>();
  for (const agentList of Object.values(DOC_AGENT_MAP)) {
    for (const agent of agentList) agents.add(agent);
  }
  return Array.from(agents).sort();
}

/**
 * Get shared docs (used by more than one agent).
 */
export function getSharedDocs(map: AgentMapResult): string[] {
  return Object.entries(map.docs)
    .filter(([, profile]) => profile.shared)
    .map(([key]) => key);
}

/**
 * Get agent-specific docs (used by exactly one agent).
 */
export function getAgentSpecificDocs(map: AgentMapResult): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [key, profile] of Object.entries(map.docs)) {
    if (!profile.shared && profile.used_by.length === 1) {
      const agent = profile.used_by[0];
      if (!result[agent]) result[agent] = [];
      result[agent].push(key);
    }
  }
  return result;
}

// ── Impact Analysis ─────────────────────────────────────────

export interface DocImpactAnalysis {
  doc_key: string;
  affected_agents: string[];
  agent_count: number;
  risk_level: "low" | "medium" | "high";
  warning: string;
}

/**
 * Analyze the impact of editing a River document.
 * Pure function.
 */
export function analyzeDocImpact(docKey: string, map: AgentMapResult): DocImpactAnalysis {
  const doc = map.docs[docKey];
  if (!doc) {
    return {
      doc_key: docKey,
      affected_agents: [],
      agent_count: 0,
      risk_level: "low",
      warning: `Document "${docKey}" not found in the agent map`,
    };
  }

  const count = doc.used_by.length;
  const risk = count >= 5 ? "high" : count >= 2 ? "medium" : "low";
  const warning = count >= 5
    ? `Editing ${docKey} affects ${count} agents — review all downstream prompts after changes`
    : count >= 2
      ? `Editing ${docKey} affects ${count} agents — verify no regressions`
      : `Editing ${docKey} affects only ${doc.used_by[0] ?? "no"} agent`;

  return {
    doc_key: docKey,
    affected_agents: doc.used_by,
    agent_count: count,
    risk_level: risk,
    warning,
  };
}

/**
 * Build the full dependency matrix (agents x docs) for table rendering.
 * Pure function.
 */
export function buildDependencyMatrix(map: AgentMapResult): {
  agents: string[];
  docs: string[];
  matrix: boolean[][];
} {
  const agents = Object.keys(map.agents).sort();
  const docs = Object.keys(map.docs).sort();
  const matrix = agents.map(agent =>
    docs.map(doc => map.agents[agent]?.docs.includes(doc) ?? false),
  );
  return { agents, docs, matrix };
}
