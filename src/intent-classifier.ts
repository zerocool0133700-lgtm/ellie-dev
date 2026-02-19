/**
 * Intent Classifier — ELLIE-50
 *
 * Replaces keyword/regex routing (route-message edge function) with
 * a three-tier classification system:
 *   1. Slash command fast-path (0ms)
 *   2. Session continuity check (10-50ms)
 *   3. Haiku LLM classification (200-400ms)
 *
 * Runs relay-side where the Anthropic SDK and conversation context
 * are already available.
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
}

interface AgentDescription {
  name: string;
  type: string;
  capabilities: string[];
}

// Module-level state, initialized via initClassifier()
let _anthropic: Anthropic | null = null;
let _supabase: SupabaseClient | null = null;

// Agent description cache
let _agentCache: AgentDescription[] | null = null;
let _agentCacheTime = 0;
const AGENT_CACHE_TTL_MS = 5 * 60_000;

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
 * Main entry point — classifies a message to determine which agent handles it.
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
    return { agent_name: "general", rule_name: "no_anthropic_fallback", confidence: 0 };
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
    };
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// Tier 3: Haiku LLM classification
// ────────────────────────────────────────────────────────────────

async function classifyWithHaiku(
  message: string,
  channel: string,
): Promise<ClassificationResult> {
  const agents = await getAgentDescriptions();

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

  const prompt = buildClassifierPrompt(message, agents, conversationContext);

  try {
    const response = await _anthropic!.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
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
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
    const reasoning = parsed.reasoning || "";

    // Validate agent name
    const valid = agents.find((a) => a.name === agentName);
    if (!valid) {
      console.warn(`[classifier] Unknown agent "${agentName}" — falling back`);
      return { agent_name: "general", rule_name: "unknown_agent_fallback", confidence: 0 };
    }

    // Confidence threshold
    if (confidence < CONFIDENCE_THRESHOLD) {
      console.log(`[classifier] Low confidence (${confidence}) for "${agentName}": ${reasoning}`);
      return { agent_name: "general", rule_name: "low_confidence_fallback", confidence, reasoning };
    }

    console.log(`[classifier] LLM → "${agentName}" (${confidence}): ${reasoning}`);
    return { agent_name: agentName, rule_name: "llm_classification", confidence, reasoning };
  } catch (err) {
    console.error("[classifier] Haiku classification failed:", err);
    return { agent_name: "general", rule_name: "error_fallback", confidence: 0 };
  }
}

function buildClassifierPrompt(
  message: string,
  agents: AgentDescription[],
  conversationContext?: {
    agent: string;
    summary: string | null;
    recentMessages: Array<{ role: string; content: string }>;
  },
): string {
  const agentList = agents
    .map((a) => `- ${a.name} (${a.type}): [${a.capabilities.join(", ")}]`)
    .join("\n");

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

  return `You are a message router. Classify which agent should handle this message.

Available agents:
${agentList}
${contextBlock}
User message: "${message}"

Instructions:
- Choose the single best agent for this message.
- If ambiguous, conversational, or doesn't clearly fit a specialist, choose "general".
- Consider conversation context — if the user is mid-topic, the current agent may still be best.

Respond with ONLY a JSON object (no markdown fences):
{"agent": "<agent_name>", "confidence": <0.0-1.0>, "reasoning": "<one sentence>"}`;
}

// ────────────────────────────────────────────────────────────────
// Agent description cache
// ────────────────────────────────────────────────────────────────

async function getAgentDescriptions(): Promise<AgentDescription[]> {
  const now = Date.now();
  if (_agentCache && now - _agentCacheTime < AGENT_CACHE_TTL_MS) {
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
