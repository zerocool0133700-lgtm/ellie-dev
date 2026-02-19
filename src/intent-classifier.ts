/**
 * Intent Classifier — ELLIE-50 + ELLIE-53 + ELLIE-58 + ELLIE-59
 *
 * Replaces keyword/regex routing (route-message edge function) with
 * a classification system:
 *   1. Slash command fast-path (0ms)
 *   2. Session continuity + Haiku LLM in parallel (200-400ms)
 *   3. Decision: LLM overrides session continuity for cross-domain switches
 *
 * ELLIE-53 adds skill-level matching: the classifier now routes to
 * specific skills (which map to agents) instead of just agents.
 *
 * ELLIE-58 adds execution_mode with four modes:
 *   - single: One skill handles the request (default)
 *   - pipeline: Sequential steps, output feeds next
 *   - fan-out: Independent tasks in parallel, merged at end
 *   - critic-loop: Iterative producer + critic refinement
 *
 * ELLIE-59 fixes session continuity overriding the classifier for
 * cross-domain messages. Session continuity and LLM now run in parallel;
 * if the LLM detects a different domain with high confidence (≥0.85),
 * it overrides session continuity.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import { getConversationContext } from "./conversations.ts";

export type ExecutionMode = "single" | "pipeline" | "fan-out" | "critic-loop";

export interface ClassificationResult {
  agent_name: string;
  rule_name: string;
  confidence: number;
  reasoning?: string;
  strippedMessage?: string;
  skill_name?: string;
  skill_description?: string;
  execution_mode: ExecutionMode;
  skills?: Array<{
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
const CROSS_DOMAIN_OVERRIDE_THRESHOLD = 0.85;

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
 *
 * Flow: Slash commands → [Session continuity ‖ Haiku LLM] → Decision
 *
 * Session continuity and the LLM classifier run in parallel. If the LLM
 * detects a different domain with high confidence, it overrides session
 * continuity (ELLIE-59).
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
      execution_mode: "single",
      strippedMessage: slash.strippedMessage,
    };
  }

  // Tier 2+3: Run session continuity and LLM classification in parallel
  if (!_anthropic) {
    // No LLM available — fall back to session continuity or general
    const continuity = await checkSessionContinuity(userId, channel);
    if (continuity) {
      console.log(`[classifier] Session continuity (no LLM) → "${continuity.agent_name}"`);
      return continuity;
    }
    console.warn("[classifier] No Anthropic client — falling back to general");
    return { agent_name: "general", rule_name: "no_anthropic_fallback", confidence: 0, execution_mode: "single" };
  }

  const [continuity, llmResult] = await Promise.all([
    checkSessionContinuity(userId, channel),
    classifyWithHaiku(message, channel),
  ]);

  // No active session → use LLM result directly
  if (!continuity) {
    return llmResult;
  }

  // Active session exists — decide whether LLM should override
  if (
    llmResult.agent_name !== continuity.agent_name &&
    llmResult.confidence >= CROSS_DOMAIN_OVERRIDE_THRESHOLD
  ) {
    // Cross-domain breakout: LLM is highly confident about a different domain
    console.log(
      `[classifier] Cross-domain override: ${continuity.agent_name} → ${llmResult.agent_name}` +
      ` (${llmResult.confidence}): ${llmResult.reasoning}`,
    );
    return llmResult;
  }

  // Session continuity holds — same agent or low LLM confidence for switch
  if (llmResult.agent_name !== continuity.agent_name) {
    console.log(
      `[classifier] Session continuity held: ${continuity.agent_name}` +
      ` (LLM suggested ${llmResult.agent_name} at ${llmResult.confidence})`,
    );
  } else {
    console.log(`[classifier] Session continuity confirmed by LLM → "${continuity.agent_name}"`);
  }
  return continuity;
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
      confidence: 0.85,
      execution_mode: "single",
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

    // Parse execution mode (ELLIE-58)
    const validModes: ExecutionMode[] = ["single", "pipeline", "fan-out", "critic-loop"];
    const executionMode: ExecutionMode = validModes.includes(parsed.execution_mode)
      ? parsed.execution_mode
      : (parsed.complexity === "pipeline" ? "pipeline" : "single");
    const rawSkills = executionMode !== "single" && Array.isArray(parsed.skills)
      ? parsed.skills
      : (executionMode !== "single" && Array.isArray(parsed.pipeline_steps)
        ? parsed.pipeline_steps
        : undefined);
    // Validate and truncate parsed skill fields
    const parsedSkills = rawSkills
      ? (rawSkills as any[]).map((s) => ({
          agent: String(s.agent || "general").slice(0, 100),
          skill: String(s.skill || "none").slice(0, 100),
          instruction: String(s.instruction || "").slice(0, 2000),
        }))
      : undefined;

    // Validate agent name
    const valid = agents.find((a) => a.name === agentName);
    if (!valid) {
      console.warn(`[classifier] Unknown agent "${agentName}" — falling back`);
      return { agent_name: "general", rule_name: "unknown_agent_fallback", confidence: 0, execution_mode: "single" };
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
      return { agent_name: "general", rule_name: "low_confidence_fallback", confidence, reasoning, execution_mode: "single" };
    }

    const modeLabel = executionMode !== "single" ? ` [${executionMode}: ${parsedSkills?.length} steps]` : "";
    console.log(`[classifier] LLM → "${resolvedAgent}"${skillName ? ` [${skillName}]` : ""}${modeLabel} (${confidence}): ${reasoning}`);
    return {
      agent_name: resolvedAgent,
      rule_name: "llm_classification",
      confidence,
      reasoning,
      skill_name: skillName,
      skill_description: skillDescription,
      execution_mode: executionMode,
      skills: parsedSkills,
    };
  } catch (err) {
    console.error("[classifier] Haiku classification failed:", err);
    return { agent_name: "general", rule_name: "error_fallback", confidence: 0, execution_mode: "single" };
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

NOTE: The user has an active session with the "${conversationContext.agent}" agent.
If this message is clearly for a different domain, recommend the appropriate agent with high confidence (>=0.85).
If ambiguous or a continuation of the current topic, recommend the current agent.
`;
  }

  return `You are a message router. Classify which skill should handle this message.

Available skills by agent:
${lines.join("\n")}
${contextBlock}
User message: "${message}"

Instructions:
- Choose an execution_mode: "single", "pipeline", "fan-out", or "critic-loop".
- **single**: One skill handles the request. Most messages use this.
- **pipeline**: Sequential steps where output feeds into the next (e.g., "research X then summarize it"). Max 5 steps.
- **fan-out**: Independent tasks run in parallel, results merged (e.g., "check my email, calendar, and tasks").
- **critic-loop**: Iterative refinement — producer creates, critic evaluates (e.g., "write a proposal and make it really good"). Exactly 2 skills: [producer, critic].
- For single: choose the best skill and agent.
- For multi-step modes: list the skills array in execution order, each with agent, skill, and a brief instruction.
- If no skill is a clear match, set skill to "none" and pick the best agent.
- If ambiguous or conversational, choose agent "general" with skill "none" and execution_mode "single".
- Consider conversation context — if the user is mid-topic, the current agent may still be best.

Respond with ONLY a JSON object (no markdown fences):
{"skill": "<primary_skill_or_none>", "agent": "<primary_agent>", "confidence": <0.0-1.0>, "reasoning": "<one sentence>", "execution_mode": "single", "skills": null}

For multi-step requests:
{"skill": "<first_skill>", "agent": "<first_agent>", "confidence": <0.0-1.0>, "reasoning": "<one sentence>", "execution_mode": "pipeline", "skills": [{"agent": "<agent>", "skill": "<skill_or_none>", "instruction": "<what this step does>"}]}`;
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
