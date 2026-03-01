/**
 * Agent Router — Relay-side wrapper
 *
 * Wraps the 3 agent edge functions (route-message, agent-dispatch, agent-sync)
 * into a clean interface. Falls back to default behavior if edge functions
 * are unavailable (Supabase not configured, functions not deployed, etc.).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyIntent, type ExecutionMode } from "./intent-classifier.ts";
import { log } from "./logger.ts";

const logger = log.child("agent-router");

export interface AgentConfig {
  name: string;
  type: string;
  system_prompt: string | null;
  model: string | null;
  tools_enabled: string[];
  capabilities: string[];
}

export interface RouteResult {
  agent_id?: string;
  agent_name: string;
  rule_name: string;
  confidence: number;
  reasoning?: string;
  strippedMessage?: string;
  session_id?: string;
  skill_name?: string;
  skill_description?: string;
  execution_mode: ExecutionMode;
  skills?: Array<{
    agent: string;
    skill: string;
    instruction: string;
  }>;
}

export interface DispatchResult {
  session_id: string;
  agent: AgentConfig;
  is_new: boolean;
  context_summary?: string;
  skill_context?: {
    name: string;
    description: string;
  };
}

export interface SyncResult {
  success: boolean;
  handoff_id?: string;
  new_session_id?: string;
}

/**
 * Route a message to the appropriate agent.
 * Returns null if routing is unavailable (falls back to default behavior).
 */
export async function routeMessage(
  supabase: SupabaseClient | null,
  message: string,
  channel: string,
  userId: string,
): Promise<RouteResult | null> {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.functions.invoke("route-message", {
      body: { message, channel, user_id: userId },
    });

    if (error || !data?.agent_name) {
      logger.error("Route error", error || "no agent_name");
      return null;
    }

    console.log(
      `[agent-router] Routed to "${data.agent_name}" via ${data.rule_name}`,
    );
    return data as RouteResult;
  } catch (err) {
    logger.error("Route unavailable", err);
    return null;
  }
}

/**
 * Local dispatch — queries Supabase tables directly, bypassing the edge function.
 * Mirrors the logic in supabase/functions/agent-dispatch/index.ts.
 */
async function localDispatch(
  supabase: SupabaseClient,
  agentName: string,
  userId: string,
  channel: string,
  message: string,
  workItemId?: string,
  skillName?: string,
): Promise<DispatchResult | null> {
  // 1. Look up agent
  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .select("id, name, type, system_prompt, model, tools_enabled, capabilities")
    .eq("name", agentName)
    .eq("status", "active")
    .single();

  if (agentError || !agent) {
    logger.error("Local dispatch: agent not found", { agentName });
    return null;
  }

  // 1b. Look up matched skill
  let skillContext: { name: string; description: string } | undefined;
  if (skillName) {
    const { data: skill } = await supabase
      .from("skills")
      .select("name, description")
      .eq("agent_id", agent.id)
      .eq("name", skillName)
      .eq("enabled", true)
      .single();

    if (skill) {
      skillContext = { name: skill.name, description: skill.description };
    }
  }

  // 2. Check for existing active session
  // ELLIE-376: Include work_item_id to isolate sessions per ticket.
  // Without this, two dispatches to the same agent for different tickets
  // could share a session, leaking context between work items.
  let sessionQuery = supabase
    .from("agent_sessions")
    .select("id, context_summary")
    .eq("agent_id", agent.id)
    .eq("user_id", userId || "")
    .eq("channel", channel || "telegram")
    .eq("state", "active");
  if (workItemId) {
    sessionQuery = sessionQuery.eq("work_item_id", workItemId);
  } else {
    sessionQuery = sessionQuery.is("work_item_id", null);
  }
  const { data: existingSession } = await sessionQuery
    .order("last_activity", { ascending: false })
    .limit(1)
    .single();

  let sessionId: string;
  let isNew: boolean;
  let contextSummary: string | undefined;

  if (existingSession) {
    sessionId = existingSession.id;
    isNew = false;
    contextSummary = existingSession.context_summary ?? undefined;

    await supabase
      .from("agent_sessions")
      .update({ last_activity: new Date().toISOString() })
      .eq("id", sessionId);
  } else {
    const { data: newSession, error: sessionError } = await supabase
      .from("agent_sessions")
      .insert({
        agent_id: agent.id,
        user_id: userId || "",
        channel: channel || "telegram",
        work_item_id: workItemId || null,
        state: "active",
        last_activity: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (sessionError || !newSession) {
      logger.error("Local dispatch: session creation failed", sessionError?.message);
      return null;
    }

    sessionId = newSession.id;
    isNew = true;
  }

  // 3. Insert user message
  await supabase.from("agent_messages").insert({
    session_id: sessionId,
    role: "user",
    content: message,
  });

  console.log(
    `[agent-router] Local dispatch: ${isNew ? "New" : "Resumed"} session ${sessionId.slice(0, 8)} for ${agentName}`,
  );

  return {
    session_id: sessionId,
    agent: {
      name: agent.name,
      type: agent.type,
      system_prompt: agent.system_prompt,
      model: agent.model,
      tools_enabled: agent.tools_enabled || [],
      capabilities: agent.capabilities || [],
    },
    is_new: isNew,
    context_summary: contextSummary,
    skill_context: skillContext,
  };
}

/**
 * Dispatch: create/resume an agent session and get agent config.
 * Tries edge function first, falls back to local dispatch on failure.
 */
export async function dispatchAgent(
  supabase: SupabaseClient | null,
  agentName: string,
  userId: string,
  channel: string,
  message: string,
  workItemId?: string,
  skillName?: string,
): Promise<DispatchResult | null> {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.functions.invoke("agent-dispatch", {
      body: {
        agent_name: agentName,
        user_id: userId,
        channel,
        message,
        work_item_id: workItemId,
        skill_name: skillName,
      },
    });

    if (error || !data?.session_id) {
      logger.warn("Edge dispatch failed, trying local fallback", error || "no session_id");
      return localDispatch(supabase, agentName, userId, channel, message, workItemId, skillName);
    }

    console.log(
      `[agent-router] ${data.is_new ? "New" : "Resumed"} session ${data.session_id.slice(0, 8)} for ${agentName}`,
    );
    return data as DispatchResult;
  } catch (err) {
    logger.warn("Edge dispatch unavailable, trying local fallback", err);
    return localDispatch(supabase, agentName, userId, channel, message, workItemId, skillName);
  }
}

/**
 * Local sync — logs assistant response and updates session directly via Supabase.
 * Mirrors the logic in supabase/functions/agent-sync/index.ts (sans handoffs).
 */
async function localSync(
  supabase: SupabaseClient,
  sessionId: string,
  assistantMessage: string,
  options?: {
    tokens?: number;
    duration_ms?: number;
    status?: "completed" | "failed";
    agent_name?: string;
  },
): Promise<SyncResult | null> {
  // 1. Insert assistant message
  await supabase.from("agent_messages").insert({
    session_id: sessionId,
    role: "assistant",
    content: assistantMessage,
    tokens: options?.tokens || 0,
    duration_ms: options?.duration_ms || null,
  });

  // 2. Get current session
  const { data: session, error: sessionError } = await supabase
    .from("agent_sessions")
    .select("id, agent_id, turn_count")
    .eq("id", sessionId)
    .single();

  if (sessionError || !session) {
    logger.error("Local sync: session not found", { sessionId });
    return null;
  }

  // 3. Update session
  const sessionUpdate: Record<string, unknown> = {
    turn_count: (session.turn_count || 0) + 1,
    last_activity: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (options?.tokens) sessionUpdate.output_tokens = options.tokens;
  if (options?.duration_ms) sessionUpdate.duration_ms = options.duration_ms;

  if (options?.status === "completed" || options?.status === "failed") {
    sessionUpdate.state = options.status;
    sessionUpdate.completed_at = new Date().toISOString();
  }

  await supabase
    .from("agent_sessions")
    .update(sessionUpdate)
    .eq("id", sessionId);

  return { success: true };
}

/**
 * Sync: log assistant response and update session stats.
 * Tries edge function first, falls back to local sync on failure.
 * Non-fatal — message is already sent by the time sync runs.
 */
export async function syncResponse(
  supabase: SupabaseClient | null,
  sessionId: string,
  assistantMessage: string,
  options?: {
    tokens?: number;
    duration_ms?: number;
    status?: "completed" | "failed";
    agent_name?: string;
    handoff?: {
      to_agent: string;
      reason: string;
      context_summary: string;
    };
  },
): Promise<SyncResult | null> {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.functions.invoke("agent-sync", {
      body: {
        session_id: sessionId,
        assistant_message: assistantMessage,
        ...options,
      },
    });

    if (error) {
      logger.warn("Edge sync failed, trying local fallback", error);
      return localSync(supabase, sessionId, assistantMessage, options);
    }

    return data as SyncResult;
  } catch (err) {
    logger.warn("Edge sync unavailable, trying local fallback", err);
    return localSync(supabase, sessionId, assistantMessage, options);
  }
}

/**
 * Full pipeline: route → dispatch → return config.
 * The relay calls this before buildPrompt(), then calls syncResponse() after.
 *
 * Returns null if any step fails — caller should fall back to default behavior.
 */
export async function routeAndDispatch(
  supabase: SupabaseClient | null,
  message: string,
  channel: string,
  userId: string,
  workItemId?: string,
  agentOverride?: string,
): Promise<{
  route: RouteResult;
  dispatch: DispatchResult;
} | null> {
  // Use LLM-based classifier (ELLIE-50), fall back to edge function on failure
  let route: RouteResult;
  try {
    const classification = await classifyIntent(message, channel, userId);
    route = { ...classification };
  } catch (err) {
    logger.error("classifyIntent failed, trying edge function fallback", err);
    const edgeRoute = await routeMessage(supabase, message, channel, userId);
    if (!edgeRoute) return null;
    route = { ...edgeRoute, confidence: edgeRoute.confidence || 0.5, execution_mode: edgeRoute.execution_mode || "single" as const };
  }

  // ELLIE-381: Mode-based agent override (skill-only → road-runner)
  if (agentOverride && route.agent_name !== agentOverride) {
    logger.info(`[routing] Agent override: ${route.agent_name} → ${agentOverride} (mode-based)`);
    route.agent_name = agentOverride;
    route.rule_name = "mode_override";
  }

  const effectiveWorkItemId = workItemId;

  const dispatchMessage = route.strippedMessage || message;

  const dispatch = await dispatchAgent(
    supabase,
    route.agent_name,
    userId,
    channel,
    dispatchMessage,
    effectiveWorkItemId,
    route.skill_name,
  );
  if (!dispatch) return null;

  // Attach skill context from classifier (edge function may also return it)
  if (route.skill_name && route.skill_description && !dispatch.skill_context) {
    dispatch.skill_context = {
      name: route.skill_name,
      description: route.skill_description,
    };
  }

  return { route, dispatch };
}
