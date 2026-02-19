/**
 * Intent Classifier — ELLIE-50 + ELLIE-53
 *
 * Replaces keyword/regex routing (route-message edge function) with
 * a three-tier classification system:
 *   1. Slash command fast-path (0ms)
 *   2. Session continuity check (10-50ms)
 *   3. Haiku LLM classification (200-400ms)
 *
 * ELLIE-53 adds skill-level matching: the classifier now routes to
 * specific skills (which map to agents) instead of just agents.
 *
 * ELLIE-54 adds pipeline detection: the classifier returns a complexity
 * hint ('single' | 'pipeline') and optional pipeline_steps array for
 * multi-step requests that span multiple skills/agents.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import { getConversationContext } from "./conversations.ts";

export interface ClassificationResult {
  agent_name: string;
  rule_name: string;
  confidence: number;
  reasoning?: string;
  strippedMessage?: string;
  skill_name?: string;
  skill_description?: string;
  complexity: "single" | "pipeline";
  pipeline_steps?: Array<{
    agent: string;
    skill: string;
    instruction: string;
  }>;
}

interface AgentDescription {
  name: string;
  type: string;
  capabilities: string[];
}

interface SkillDescription {
  name: string;
  description: string;
  agent_name: string;
  triggers: string[];
  priority: number;
}

// Module-level state, initialized via initClassifier()
let _anthropic: Anthropic | null = null;
let _supabase: SupabaseClient | null = null;

// Agent description cache
let _agentCache: AgentDescription[] | null = null;
let _agentCacheTime = 0;

// Skill description cache
let _skillCache: SkillDescription[] | null = null;
let _skillCacheTime = 0;

const CACHE_TTL_MS = 5 * 60_000;
const CONFIDENCE_THRESHOLD = 0.7;

const SLASH_COMMANDS: Record<string, string> = {
  "/dev": "dev",
  "/research": "research",
  "/content": "content",
  "/finance": "finance",
  "/strategy": "strategy",
  "/critic": "critic",
  "/general": "general",
};

/**
 * Initialize the classifier with shared clients.
 * Call once at startup after anthropic + supabase are ready.
 */
export function initClassifier(
  anthropic: Anthropic,
  supabase: SupabaseClient,
): void {
  _anthropic = anthropic;
  _supabase = supabase;
  console.log("[classifier] Initialized");
}

/**
 * Main entry point — classifies a message to determine which skill/agent handles it.
 * Tries slash commands → session continuity → Haiku LLM, in order.
 */
export async function classifyIntent(
  message: string,
  channel: string,
  userId: string,
): Promise<ClassificationResult> {
  // Tier 1: Slash command fast-path (0ms)
  const slash = parseSlashCommand(message);
  if (slash) {
    console.log(`[classifier] Slash command → "${slash.agent}"`);
    return {
      agent_name: slash.agent,
      rule_name: "slash_command",
      confidence: 1.0,
      complexity: "single",
      strippedMessage: slash.strippedMessage,
    };
  }

  // Tier 2: Session continuity (10-50ms)
  const continuity = await checkSessionContinuity(userId, channel);
  if (continuity) {
    console.log(`[classifier] Session continuity → "${continuity.agent_name}"`);
    return continuity;
  }

  // Tier 3: Haiku LLM classification (200-400ms)
  if (!_anthropic) {
    console.warn("[classifier] No Anthropic client — falling back to general");
    return { agent_name: "general", rule_name: "no_anthropic_fallback", confidence: 0, complexity: "single" };
  }

  return classifyWithHaiku(message, channel);
}

// ────────────────────────────────────────────────────────────────
// Tier 1: Slash commands
// ────────────────────────────────────────────────────────────────

function parseSlashCommand(
  message: string,
): { agent: string; strippedMessage: string } | null {
  const trimmed = message.trimStart();
  for (const [cmd, agent] of Object.entries(SLASH_COMMANDS)) {
    if (trimmed === cmd || trimmed.startsWith(cmd + " ")) {
      const stripped = trimmed.slice(cmd.length).trim();
      return { agent, strippedMessage: stripped || trimmed };
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// Tier 2: Session continuity
// ────────────────────────────────────────────────────────────────

async function checkSessionContinuity(
  userId: string,
  channel: string,
): Promise<ClassificationResult | null> {
  if (!_supabase || !userId || !channel) return null;

  try {
    const { data: activeSession } = await _supabase
      .from("agent_sessions")
      .select("id, agent_id, agents(name)")
      .eq("user_id", userId)
      .eq("channel", channel)
      .eq("state", "active")
      .order("last_activity", { ascending: false })
      .limit(1)
      .single();

    if (!activeSession) return null;

    const agentName = (activeSession as any).agents?.name || "general";
    return {
      agent_name: agentName,
      rule_name: "session_continuity",
      confidence: 1.0,
      complexity: "single",
    };
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// Tier 3: Haiku LLM classification with skill matching
// ────────────────────────────────────────────────────────────────

async function classifyWithHaiku(
  message: string,
  channel: string,
): Promise<ClassificationResult> {
  const [agents, skills] = await Promise.all([
    getAgentDescriptions(),
    getSkillDescriptions(),
  ]);

  // Get conversation context from ELLIE-51 (non-fatal if unavailable)
  let conversationContext: {
    agent: string;
    summary: string | null;
    recentMessages: Array<{ role: string; content: string }>;
  } | undefined;

  try {
    const ctx = await getConversationContext(_supabase!, channel);
    if (ctx) {
      conversationContext = {
        agent: ctx.agent,
        summary: ctx.summary,
        recentMessages: ctx.recentMessages,
      };
    }
  } catch {
    // Non-fatal — classify without context
  }

  const prompt = buildClassifierPrompt(message, agents, skills, conversationContext);

  try {
    const response = await _anthropic!.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 250,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");

    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```\s*$/m, "");

    const parsed = JSON.parse(cleaned);
    const agentName = parsed.agent || "general";
    const skillName = parsed.skill && parsed.skill !== "none" ? parsed.skill : undefined;
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
    const reasoning = parsed.reasoning || "";

    // Parse pipeline fields (ELLIE-54)
    const complexity = parsed.complexity === "pipeline" ? "pipeline" as const : "single" as const;
    const pipelineSteps = complexity === "pipeline" && Array.isArray(parsed.pipeline_steps)
      ? parsed.pipeline_steps as Array<{ agent: string; skill: string; instruction: string }>
      : undefined;

    // Validate agent name
    const valid = agents.find((a) => a.name === agentName);
    if (!valid) {
      console.warn(`[classifier] Unknown agent "${agentName}" — falling back`);
      return { agent_name: "general", rule_name: "unknown_agent_fallback", confidence: 0, complexity: "single" };
    }

    // Resolve skill — if skill maps to a different agent, the skill's agent wins
    let resolvedAgent = agentName;
    let skillDescription: string | undefined;
    if (skillName) {
      const matchedSkill = skills.find((s) => s.name === skillName);
      if (matchedSkill) {
        skillDescription = matchedSkill.description;
        resolvedAgent = matchedSkill.agent_name;
      }
    }

    // Confidence threshold
    if (confidence < CONFIDENCE_THRESHOLD) {
      console.log(`[classifier] Low confidence (${confidence}) for "${resolvedAgent}": ${reasoning}`);
      return { agent_name: "general", rule_name: "low_confidence_fallback", confidence, reasoning, complexity: "single" };
    }

    const pipelineLabel = complexity === "pipeline" ? ` [pipeline: ${pipelineSteps?.length} steps]` : "";
    console.log(`[classifier] LLM → "${resolvedAgent}"${skillName ? ` [${skillName}]` : ""}${pipelineLabel} (${confidence}): ${reasoning}`);
    return {
      agent_name: resolvedAgent,
      rule_name: "llm_classification",
      confidence,
      reasoning,
      skill_name: skillName,
      skill_description: skillDescription,
      complexity,
      pipeline_steps: pipelineSteps,
    };
  } catch (err) {
    console.error("[classifier] Haiku classification failed:", err);
    return { agent_name: "general", rule_name: "error_fallback", confidence: 0, complexity: "single" };
  }
}

function buildClassifierPrompt(
  message: string,
  agents: AgentDescription[],
  skills: SkillDescription[],
  conversationContext?: {
    agent: string;
    summary: string | null;
    recentMessages: Array<{ role: string; content: string }>;
  },
): string {
  // Group skills by agent
  const skillsByAgent: Record<string, SkillDescription[]> = {};
  for (const skill of skills) {
    if (!skillsByAgent[skill.agent_name]) skillsByAgent[skill.agent_name] = [];
    skillsByAgent[skill.agent_name].push(skill);
  }

  const lines: string[] = [];
  for (const agent of agents) {
    const agentSkills = skillsByAgent[agent.name] || [];
    if (agentSkills.length > 0) {
      const skillList = agentSkills
        .map((s) => `  - ${s.name}: ${s.description}`)
        .join("\n");
      lines.push(`${agent.name} (${agent.type}):\n${skillList}`);
    } else {
      lines.push(`${agent.name} (${agent.type}): [${agent.capabilities.join(", ")}]`);
    }
  }

  let contextBlock = "";
  if (conversationContext) {
    const recentLines = conversationContext.recentMessages
      .map((m) => `[${m.role}]: ${m.content.substring(0, 150)}`)
      .join("\n");
    contextBlock = `
Active conversation context:
Current agent: ${conversationContext.agent}
Summary: ${conversationContext.summary || "No summary yet"}
Recent messages:
${recentLines}
`;
  }

  return `You are a message router. Classify which skill should handle this message.

Available skills by agent:
${lines.join("\n")}
${contextBlock}
User message: "${message}"

Instructions:
- Determine if this message requires a SINGLE skill or a PIPELINE of multiple sequential skills.
- A pipeline is needed when the message contains two or more distinct tasks that must happen in order (e.g., "research X and summarize it", "check my calendar and draft an email about it").
- Most messages are "single". Only use "pipeline" when the message clearly requires multiple sequential steps. Max 5 steps.
- For single: choose the best skill and agent.
- For pipeline: list the steps in execution order, each with agent, skill, and a brief instruction.
- If no skill is a clear match, set skill to "none" and pick the best agent.
- If ambiguous or conversational, choose agent "general" with skill "none" and complexity "single".
- Consider conversation context — if the user is mid-topic, the current agent may still be best.

Respond with ONLY a JSON object (no markdown fences):
{"skill": "<primary_skill_or_none>", "agent": "<primary_agent>", "confidence": <0.0-1.0>, "reasoning": "<one sentence>", "complexity": "single", "pipeline_steps": null}

For pipeline requests, use:
{"skill": "<first_skill>", "agent": "<first_agent>", "confidence": <0.0-1.0>, "reasoning": "<one sentence>", "complexity": "pipeline", "pipeline_steps": [{"agent": "<agent>", "skill": "<skill_or_none>", "instruction": "<what this step does>"}]}`;
}

// ────────────────────────────────────────────────────────────────
// Caches
// ────────────────────────────────────────────────────────────────

async function getAgentDescriptions(): Promise<AgentDescription[]> {
  const now = Date.now();
  if (_agentCache && now - _agentCacheTime < CACHE_TTL_MS) {
    return _agentCache;
  }

  if (!_supabase) return [];

  const { data: agents } = await _supabase
    .from("agents")
    .select("name, type, capabilities")
    .eq("status", "active");

  _agentCache = (agents || []).map((a) => ({
    name: a.name,
    type: a.type,
    capabilities: a.capabilities || [],
  }));
  _agentCacheTime = now;

  console.log(`[classifier] Agent cache refreshed: ${_agentCache.length} agents`);
  return _agentCache;
}

async function getSkillDescriptions(): Promise<SkillDescription[]> {
  const now = Date.now();
  if (_skillCache && now - _skillCacheTime < CACHE_TTL_MS) {
    return _skillCache;
  }

  if (!_supabase) return [];

  const { data: skills } = await _supabase
    .from("skills")
    .select("name, description, triggers, priority, agents(name)")
    .eq("enabled", true)
    .order("priority", { ascending: false });

  _skillCache = (skills || []).map((s: any) => ({
    name: s.name,
    description: s.description,
    agent_name: s.agents?.name || "general",
    triggers: s.triggers || [],
    priority: s.priority || 0,
  }));
  _skillCacheTime = now;

  console.log(`[classifier] Skill cache refreshed: ${_skillCache.length} skills`);
  return _skillCache;
}
