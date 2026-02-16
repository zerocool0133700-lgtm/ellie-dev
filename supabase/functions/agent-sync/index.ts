/**
 * Agent Sync Edge Function
 *
 * Logs assistant response, updates session stats, handles handoffs.
 *
 * POST body:
 *   {
 *     session_id: string,
 *     assistant_message: string,
 *     tokens?: number,
 *     duration_ms?: number,
 *     status?: "completed" | "failed",
 *     handoff?: { to_agent: string, reason: string, context_summary: string }
 *   }
 *
 * Returns:
 *   { success: boolean, handoff_id?: string, new_session_id?: string }
 */

import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try {
    const {
      session_id,
      assistant_message,
      tokens,
      duration_ms,
      status,
      handoff,
    } = await req.json();

    if (!session_id || !assistant_message) {
      return new Response(
        JSON.stringify({ error: "Missing session_id or assistant_message" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1. Insert assistant message
    await supabase.from("agent_messages").insert({
      session_id,
      role: "assistant",
      content: assistant_message,
      tokens: tokens || 0,
      duration_ms: duration_ms || null,
    });

    // 2. Get current session
    const { data: session, error: sessionError } = await supabase
      .from("agent_sessions")
      .select("id, agent_id, turn_count, user_id, channel")
      .eq("id", session_id)
      .single();

    if (sessionError || !session) {
      return new Response(
        JSON.stringify({ error: `Session not found: ${session_id}` }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    // 3. Update session: increment turn count, set last_activity
    const sessionUpdate: Record<string, unknown> = {
      turn_count: (session.turn_count || 0) + 1,
      last_activity: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (tokens) {
      sessionUpdate.output_tokens = tokens;
    }
    if (duration_ms) {
      sessionUpdate.duration_ms = duration_ms;
    }

    // 4. If status provided, close the session
    if (status === "completed" || status === "failed") {
      sessionUpdate.state = status;
      sessionUpdate.completed_at = new Date().toISOString();

      // Update agent performance counters
      const counterField = status === "completed"
        ? "successful_sessions"
        : "failed_sessions";
      const { data: agent } = await supabase
        .from("agents")
        .select(`id, ${counterField}`)
        .eq("id", session.agent_id)
        .single();

      if (agent) {
        await supabase
          .from("agents")
          .update({
            [counterField]: ((agent as any)[counterField] || 0) + 1,
          })
          .eq("id", agent.id);
      }
    }

    await supabase
      .from("agent_sessions")
      .update(sessionUpdate)
      .eq("id", session_id);

    // 5. Handle handoff
    let handoffId: string | undefined;
    let newSessionId: string | undefined;

    if (handoff?.to_agent) {
      // Look up target agent
      const { data: targetAgent } = await supabase
        .from("agents")
        .select("id, name")
        .eq("name", handoff.to_agent)
        .eq("status", "active")
        .single();

      if (targetAgent) {
        // Close current session as handed_off
        await supabase
          .from("agent_sessions")
          .update({
            state: "handed_off",
            context_summary: handoff.context_summary,
            completed_at: new Date().toISOString(),
          })
          .eq("id", session_id);

        // Create new session for target agent
        const { data: newSession } = await supabase
          .from("agent_sessions")
          .insert({
            agent_id: targetAgent.id,
            user_id: session.user_id,
            channel: session.channel,
            state: "active",
            context_summary: handoff.context_summary,
            parent_session_id: session_id,
            last_activity: new Date().toISOString(),
          })
          .select("id")
          .single();

        if (newSession) {
          newSessionId = newSession.id;

          // Create handoff record
          const { data: handoffRecord } = await supabase
            .from("agent_handoffs")
            .insert({
              from_agent_id: session.agent_id,
              to_agent_id: targetAgent.id,
              from_session_id: session_id,
              to_session_id: newSession.id,
              reason: handoff.reason,
              context_summary: handoff.context_summary,
              state: "accepted",
            })
            .select("id")
            .single();

          handoffId = handoffRecord?.id;
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        handoff_id: handoffId,
        new_session_id: newSessionId,
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
