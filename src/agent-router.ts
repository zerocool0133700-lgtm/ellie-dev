/**
 * Agent Router — Relay-side wrapper
 *
 * Wraps the 3 agent edge functions (route-message, agent-dispatch, agent-sync)
 * into a clean interface. Falls back to default behavior if edge functions
 * are unavailable (Supabase not configured, functions not deployed, etc.).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyIntent, type ExecutionMode } from "./intent-classifier.ts";

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
      console.error("[agent-router] Route error:", error || "no agent_name");
      return null;
    }

    console.log(
      `[agent-router] Routed to "${data.agent_name}" via ${data.rule_name}`,
    );
    return data as RouteResult;
  } catch (err) {
    console.error("[agent-router] Route unavailable:", err);
    return null;
  }
}

/**
 * Dispatch: create/resume an agent session and get agent config.
 * Returns null if dispatch is unavailable.
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
      console.error("[agent-router] Dispatch error:", error || "no session_id");
      return null;
    }

    console.log(
      `[agent-router] ${data.is_new ? "New" : "Resumed"} session ${data.session_id.slice(0, 8)} for ${agentName}`,
    );
    return data as DispatchResult;
  } catch (err) {
    console.error("[agent-router] Dispatch unavailable:", err);
    return null;
  }
}

/**
 * Sync: log assistant response and update session stats.
 * Returns null if sync is unavailable (non-fatal — message already sent).
 */
export async function syncResponse(
  supabase: SupabaseClient | null,
  sessionId: string,
  assistantMessage: string,
  options?: {
    tokens?: number;
    duration_ms?: number;
    status?: "completed" | "failed";
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
      console.error("[agent-router] Sync error:", error);
      return null;
    }

    return data as SyncResult;
  } catch (err) {
    console.error("[agent-router] Sync unavailable:", err);
    return null;
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
    console.error("[agent-router] classifyIntent failed, trying edge function fallback:", err);
    const edgeRoute = await routeMessage(supabase, message, channel, userId);
    if (!edgeRoute) return null;
    route = { ...edgeRoute, confidence: 0.5, execution_mode: "single" as const };
  }

  const dispatchMessage = route.strippedMessage || message;

  const dispatch = await dispatchAgent(
    supabase,
    route.agent_name,
    userId,
    channel,
    dispatchMessage,
    undefined,
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
