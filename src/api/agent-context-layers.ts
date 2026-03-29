/**
 * Agent Context Layers API — ELLIE-1124
 *
 * GET /api/agents/:name/context-layers
 *
 * Returns the prompt assembly layers for an agent — what content gets injected
 * into the agent's prompt and at what priority. Powers the Context Layers tab
 * in the agents page.
 */

import { log } from "../logger.ts";
import { getCreatureProfile } from "../creature-profile.ts";
import { getCachedRiverDoc, AGENT_PROFILE_MAP } from "../prompt-builder.ts";
import { getSkillSnapshot } from "../skills/index.ts";
import { getRelayDeps } from "../relay-state.ts";
import type { ApiRequest, ApiResponse } from "./types.ts";

const logger = log.child("agent-context-layers");

// ── Types ─────────────────────────────────────────────────────────────────────

interface ContextLayer {
  name: string;
  priority: number;
  source: string;
  content: string | null;
  token_estimate: number;
  configured: boolean;
  metadata?: Record<string, unknown>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token */
function estimateTokens(text: string | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Truncate content to first 500 chars for preview */
function truncate(text: string | null): string | null {
  if (!text) return null;
  return text.length > 500 ? text.slice(0, 500) + "…" : text;
}

// ── GET /api/agents/:name/context-layers ─────────────────────────────────────

/**
 * Returns the ordered context layers that will be assembled into this agent's
 * system prompt. Each layer shows its priority, source, a content preview, and
 * whether it is currently configured (i.e. the underlying doc/data is available).
 */
export async function getContextLayersEndpoint(
  req: ApiRequest,
  res: ApiResponse,
): Promise<void> {
  const agentName = (req.params?.name ?? req.query?.name) as string | undefined;

  if (!agentName) {
    res.status(400).json({ error: "Missing agent name" });
    return;
  }

  const normalized = agentName.toLowerCase().replace(/[^a-z0-9-]/g, "");

  // ── Fetch agent row from Supabase ─────────────────────────────────────────
  let agentRow: {
    tools_enabled: string[] | null;
    capabilities: string[] | null;
    metadata: Record<string, unknown> | null;
  } | null = null;

  try {
    const { supabase } = getRelayDeps();
    if (supabase) {
      const { data } = await supabase
        .from("agents")
        .select("tools_enabled, capabilities, metadata")
        .eq("name", normalized)
        .single();
      agentRow = data ?? null;
    }
  } catch (err) {
    logger.warn("Failed to fetch agent row from Supabase", { agentName }, err);
  }

  // ── Creature profile (token budget, allowed skills, creature name) ─────────
  const profile = getCreatureProfile(normalized);

  // Resolve creature name from the shared AGENT_PROFILE_MAP (exported from prompt-builder)
  const creatureName = AGENT_PROFILE_MAP[normalized] ?? normalized;

  const tokenBudget = profile?.token_budget ?? null;

  // ── Build layers ──────────────────────────────────────────────────────────
  const layers: ContextLayer[] = [];

  // Layer 1 — Soul
  try {
    const soulContent = getCachedRiverDoc("soul");
    const preview = truncate(soulContent);
    layers.push({
      name: "Soul",
      priority: 1,
      source: "River vault (soul.md)",
      content: preview,
      token_estimate: estimateTokens(soulContent),
      configured: soulContent !== null,
    });
  } catch (err) {
    logger.error("Failed to load Soul layer", { agentName }, err);
    layers.push({
      name: "Soul",
      priority: 1,
      source: "River vault (soul.md)",
      content: null,
      token_estimate: 0,
      configured: false,
    });
  }

  // Layer 2 — Creature DNA
  try {
    const dnaContent = getCachedRiverDoc(creatureName);
    const preview = truncate(dnaContent);
    layers.push({
      name: "Creature DNA",
      priority: 2,
      source: `River vault (${creatureName}.md)`,
      content: preview,
      token_estimate: estimateTokens(dnaContent),
      configured: dnaContent !== null,
      metadata: {
        creature: creatureName,
        cognitive_style: profile ? "configured" : "unknown",
        token_budget: tokenBudget,
      },
    });
  } catch (err) {
    logger.error("Failed to load Creature DNA layer", { agentName }, err);
    layers.push({
      name: "Creature DNA",
      priority: 2,
      source: `River vault (${creatureName}.md)`,
      content: null,
      token_estimate: 0,
      configured: false,
      metadata: { creature: creatureName, token_budget: tokenBudget },
    });
  }

  // Layer 3 — Role Template
  try {
    const templateKey = `${normalized}-agent-template`;
    const templateContent = getCachedRiverDoc(templateKey);
    const preview = truncate(templateContent);
    layers.push({
      name: "Role Template",
      priority: 3,
      source: `River vault (${templateKey}.md)`,
      content: preview,
      token_estimate: estimateTokens(templateContent),
      configured: templateContent !== null,
    });
  } catch (err) {
    logger.error("Failed to load Role Template layer", { agentName }, err);
    layers.push({
      name: "Role Template",
      priority: 3,
      source: `River vault (${normalized}-agent-template.md)`,
      content: null,
      token_estimate: 0,
      configured: false,
    });
  }

  // Layer 4 — Skills (pass undefined instead of "" to allow caching)
  try {
    const snapshot = await getSkillSnapshot(profile?.allowed_skills);
    const skillCount = snapshot.skills.length;
    const preview = truncate(snapshot.prompt || null);
    layers.push({
      name: "Skills",
      priority: 4,
      source: "skills/ directory",
      content: preview,
      token_estimate: estimateTokens(snapshot.prompt || null),
      configured: skillCount > 0 || (profile?.allowed_skills !== undefined),
      metadata: {
        skill_count: skillCount,
        allowed_skills: profile?.allowed_skills ?? [],
      },
    });
  } catch (err) {
    logger.error("Failed to load Skills layer", { agentName }, err);
    layers.push({
      name: "Skills",
      priority: 4,
      source: "skills/ directory",
      content: null,
      token_estimate: 0,
      configured: false,
      metadata: {
        skill_count: 0,
        allowed_skills: profile?.allowed_skills ?? [],
      },
    });
  }

  // Layer 5 — Working Memory (always configured; content is dynamic per session)
  layers.push({
    name: "Working Memory",
    priority: 5,
    source: "Forest DB (working_memory table)",
    content: [
      "7 sections (dynamic per session):",
      "  session_identity, task_stack, conversation_thread,",
      "  investigation_state, decision_log, context_anchors,",
      "  resumption_prompt",
    ].join("\n"),
    token_estimate: 0,
    configured: true,
  });

  // Layer 6 — Tools Enabled
  try {
    const toolsEnabled = agentRow?.tools_enabled ?? null;
    const capabilities = agentRow?.capabilities ?? null;

    // Rough categorisation of tools into groups
    const toolCategories: string[] = [];
    if (toolsEnabled) {
      const tools = toolsEnabled.map((t: string) => t.toLowerCase());
      if (tools.some((t) => t.includes("bash") || t.includes("computer"))) toolCategories.push("computer-use");
      if (tools.some((t) => t.includes("web") || t.includes("search"))) toolCategories.push("web");
      if (tools.some((t) => t.includes("file") || t.includes("read") || t.includes("write"))) toolCategories.push("file-ops");
      if (tools.some((t) => t.includes("mcp"))) toolCategories.push("mcp");
    }

    // Estimate tokens on full content, truncate for preview
    const fullToolsText = toolsEnabled ? `Tools: ${toolsEnabled.join(", ")}` : null;
    const preview = truncate(fullToolsText);

    layers.push({
      name: "Tools Enabled",
      priority: 6,
      source: "Supabase agents table",
      content: preview,
      token_estimate: estimateTokens(fullToolsText),
      configured: toolsEnabled !== null,
      metadata: {
        tool_categories: toolCategories,
        capabilities: capabilities ?? [],
      },
    });
  } catch (err) {
    logger.error("Failed to load Tools Enabled layer", { agentName }, err);
    layers.push({
      name: "Tools Enabled",
      priority: 6,
      source: "Supabase agents table",
      content: null,
      token_estimate: 0,
      configured: false,
      metadata: { tool_categories: [], capabilities: [] },
    });
  }

  res.json({
    agent: normalized,
    creature: creatureName,
    token_budget: tokenBudget,
    layers,
  });
}
