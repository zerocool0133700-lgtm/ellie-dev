/**
 * Agent Dispatch Edge Function
 *
 * Creates or resumes an agent session and returns the agent's config.
 *
 * POST body:
 *   { agent_name: string, user_id: string, channel: string, message: string, work_item_id?: string }
 *
 * Returns:
 *   { session_id, agent: { name, system_prompt, model, tools_enabled, capabilities }, is_new, context_summary? }
 */

import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try {
    const { agent_name, user_id, channel, message, work_item_id } =
      await req.json();

    if (!agent_name || !message) {
      return new Response(
        JSON.stringify({ error: "Missing agent_name or message" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1. Look up agent (must be active)
    const { data: agent, error: agentError } = await supabase
      .from("agents")
      .select("id, name, type, system_prompt, model, tools_enabled, capabilities, metadata")
      .eq("name", agent_name)
      .eq("status", "active")
      .single();

    if (agentError || !agent) {
      return new Response(
        JSON.stringify({ error: `Agent not found: ${agent_name}` }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    // 2. Check for existing active session
    const { data: existingSession } = await supabase
      .from("agent_sessions")
      .select("id, context_summary, turn_count, last_activity")
      .eq("agent_id", agent.id)
      .eq("user_id", user_id || "")
      .eq("channel", channel || "telegram")
      .eq("state", "active")
      .order("last_activity", { ascending: false })
      .limit(1)
      .single();

    let sessionId: string;
    let isNew: boolean;
    let contextSummary: string | null = null;

    if (existingSession) {
      // 3a. Resume existing session
      sessionId = existingSession.id;
      isNew = false;
      contextSummary = existingSession.context_summary;

      await supabase
        .from("agent_sessions")
        .update({ last_activity: new Date().toISOString() })
        .eq("id", sessionId);
    } else {
      // 3b. Create new session
      const { data: newSession, error: sessionError } = await supabase
        .from("agent_sessions")
        .insert({
          agent_id: agent.id,
          user_id: user_id || "",
          channel: channel || "telegram",
          work_item_id: work_item_id || null,
          state: "active",
          last_activity: new Date().toISOString(),
        })
        .select("id")
        .single();

      if (sessionError || !newSession) {
        return new Response(
          JSON.stringify({
            error: `Session creation failed: ${sessionError?.message}`,
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }

      sessionId = newSession.id;
      isNew = true;

      // Increment agent's total_sessions counter
      await supabase
        .from("agents")
        .update({ total_sessions: (agent as any).total_sessions + 1 })
        .eq("id", agent.id);
    }

    // 4. Insert user message into agent_messages
    await supabase.from("agent_messages").insert({
      session_id: sessionId,
      role: "user",
      content: message,
    });

    return new Response(
      JSON.stringify({
        session_id: sessionId,
        agent: {
          name: agent.name,
          type: agent.type,
          system_prompt: agent.system_prompt,
          model: agent.model,
          tools_enabled: agent.tools_enabled,
          capabilities: agent.capabilities,
        },
        is_new: isNew,
        context_summary: contextSummary,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
