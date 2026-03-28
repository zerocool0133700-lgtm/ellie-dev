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
import { RELAY_EPOCH } from "./relay-epoch.ts";
import { breakers } from "./resilience.ts";
import { guardAgentDispatch, resolveRbacEntityId, formatDenialMessage, type GuardConfig, DEFAULT_GUARD_CONFIG } from "./permission-guard.ts";
import { logCheck } from "./permission-audit.ts";
import { getAllowedMCPs, getAllowedToolsForCLI } from "./tool-access-control.ts";
import { filterTools, getDeferredToolSummary } from "./tool-discovery-filter.ts";
import { canPerformRole } from "./segregation-of-duties.ts";

const logger = log.child("agent-router");

export type DispatchFailureReason = "breaker_open" | "timeout" | "edge_fn_error" | "missing_data" | "local_fallback_failed";

/** Classify why a circuit breaker call returned fallback. */
function classifyBreakerFailure(breaker: typeof breakers.edgeFn, hadResult: boolean): DispatchFailureReason {
  const { state } = breaker.getState();
  if (state === "open") return "breaker_open";
  const lastErr = breaker.lastError;
  if (lastErr instanceof Error && lastErr.message.includes("timeout")) return "timeout";
  if (!hadResult) return "edge_fn_error";
  return "missing_data";
}

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
  allowed_mcps?: string[];  // Filtered list of allowed MCP servers (ELLIE-970)

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

  // ELLIE-484: circuit breaker — throw on error so failures are recorded
  const invoked = await breakers.edgeFn.call(
    async () => {
      const r = await supabase!.functions.invoke("route-message", { body: { message, channel, user_id: userId } });
      if (r.error) throw r.error;
      return r;
    },
    null,
  );

  if (!invoked || !invoked.data?.agent_name) {
    const reason = classifyBreakerFailure(breakers.edgeFn, !!invoked);
    logger.error("Route failed", { reason, error: reason !== "missing_data" ? String(breakers.edgeFn.lastError) : "edge function returned no agent_name" });
    return null;
  }

  logger.info(`Routed to "${invoked.data.agent_name}" via ${invoked.data.rule_name}`);
  return invoked.data as RouteResult;
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
        metadata: { relay_epoch: RELAY_EPOCH },
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

  logger.info(
    `Local dispatch: ${isNew ? "New" : "Resumed"} session ${sessionId.slice(0, 8)} for ${agentName}`,
  );

  // ELLIE-970: Apply tool access filtering
  const allowedMCPs = getAllowedMCPs(agent.tools_enabled, agent.name);

  // ELLIE-1059: Filter tools by archetype + message intent
  const agentArchetype = agent.name || "general";
  const toolDefs = (agent.tools_enabled || []).map((t: string) => ({ name: t, description: t }));
  const filtered = filterTools(toolDefs, { archetype: agentArchetype, message });
  const filteredToolNames = filtered.included.map(t => t.name);
  const deferredSummary = getDeferredToolSummary(filtered.deferred);

  // ELLIE-1092: Convert tool categories to CLI format
  const cliTools = getAllowedToolsForCLI(agent.tools_enabled, agent.name);

  return {
    session_id: sessionId,
    agent: {
      name: agent.name,
      type: agent.type,
      system_prompt: agent.system_prompt,
      model: agent.model,
      tools_enabled: cliTools,  // ELLIE-1092: Use CLI-formatted tools
      capabilities: agent.capabilities || [],
    },
    is_new: isNew,
    context_summary: contextSummary ? (deferredSummary ? `${contextSummary}\n${deferredSummary}` : contextSummary) : deferredSummary || undefined,
    skill_context: skillContext,
    allowed_mcps: allowedMCPs,
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

  // ELLIE-484: circuit breaker — throw on error so failures are recorded; falls back to localDispatch
  const invoked = await breakers.edgeFn.call(
    async () => {
      const r = await supabase!.functions.invoke("agent-dispatch", {
        body: { agent_name: agentName, user_id: userId, channel, message, work_item_id: workItemId, skill_name: skillName },
      });
      if (r.error) throw r.error;
      return r;
    },
    null,
  );

  if (!invoked || !invoked.data?.session_id) {
    const reason = classifyBreakerFailure(breakers.edgeFn, !!invoked);
    logger.warn("Edge dispatch failed, trying local fallback", { reason, error: String(breakers.edgeFn.lastError) });
    const localResult = await localDispatch(supabase, agentName, userId, channel, message, workItemId, skillName);
    if (!localResult) {
      logger.error("Local dispatch also failed", { reason: "local_fallback_failed", agent: agentName });
    }
    return localResult;
  }

  logger.info(
    `${invoked.data.is_new ? "New" : "Resumed"} session ${invoked.data.session_id.slice(0, 8)} for ${agentName}`,
  );

  // ELLIE-970: Apply tool access filtering for edge function result
  const result = invoked.data as DispatchResult;
  if (!result.allowed_mcps) {
    result.allowed_mcps = getAllowedMCPs(result.agent.tools_enabled, result.agent.name);
  }

  // ELLIE-1092: Convert tools to CLI format for edge function results
  result.agent.tools_enabled = getAllowedToolsForCLI(result.agent.tools_enabled, result.agent.name);

  return result;
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

  // ELLIE-484: circuit breaker — throw on error so failures are recorded; falls back to localSync
  const invoked = await breakers.edgeFn.call(
    async () => {
      const r = await supabase!.functions.invoke("agent-sync", {
        body: { session_id: sessionId, assistant_message: assistantMessage, ...options },
      });
      if (r.error) throw r.error;
      return r;
    },
    null,
  );

  if (!invoked) {
    const reason = classifyBreakerFailure(breakers.edgeFn, false);
    logger.warn("Edge sync failed, trying local fallback", { reason, error: String(breakers.edgeFn.lastError) });
    return localSync(supabase, sessionId, assistantMessage, options);
  }

  return invoked.data as SyncResult;
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

  // ELLIE-803: RBAC guard — check permissions before dispatch
  try {
    const { default: forestSql } = await import('../../ellie-forest/src/db');
    const entityId = await resolveRbacEntityId(forestSql, route.agent_name);
    if (!entityId) {
      // Cannot resolve agent entity — fail closed
      logger.error(`[rbac] Cannot resolve entity ID for agent '${route.agent_name}', denying dispatch`);
      return null;
    }
    const guard = await guardAgentDispatch(forestSql, entityId, route.agent_name);
    logCheck(entityId, "agents", "dispatch", guard.allowed ? "allow" : "deny", undefined, route.agent_name);
    if (!guard.allowed && guard.denial) {
      logger.warn(`[rbac] ${formatDenialMessage(guard.denial)}`);
      return null;
    }
  } catch (err) {
    // RBAC check failure should block dispatch — security checks must fail closed
    logger.error("[rbac] Guard check failed, denying dispatch", err);
    return null;
  }

  // SOD check — verify creature can perform this role (advisory only)
  try {
    const creatureArchetype = route.agent_name; // e.g., "dev", "critic"
    // Determine role from context: if this is a review request, role is "reviewer"
    // For now, just validate the creature can be a "maker" (default role)
    const defaultRole = "maker" as const;
    if (!canPerformRole(creatureArchetype, defaultRole)) {
      logger.warn(`[sod] ${creatureArchetype} cannot perform role ${defaultRole}`, { agent: route.agent_name });
      // Don't block — just warn. SOD is advisory for now.
    }
  } catch (err) {
    // SOD is advisory — don't block dispatch on failure
    logger.warn("[sod] Check failed, continuing dispatch", err);
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
