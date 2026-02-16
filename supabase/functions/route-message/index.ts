/**
 * Route Message Edge Function
 *
 * Determines which agent should handle an incoming message.
 * Checks for active sessions first (continuity), then evaluates
 * routing rules by priority.
 *
 * POST body:
 *   { message: string, channel: string, user_id: string }
 *
 * Returns:
 *   { agent_id, agent_name, rule_name, session_id? }
 */

import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try {
    const { message, channel, user_id } = await req.json();

    if (!message) {
      return new Response(JSON.stringify({ error: "Missing message" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1. Check for active session (session continuity beats routing rules)
    if (user_id && channel) {
      const { data: activeSession } = await supabase
        .from("agent_sessions")
        .select("id, agent_id, agents(name)")
        .eq("user_id", user_id)
        .eq("channel", channel)
        .eq("state", "active")
        .order("last_activity", { ascending: false })
        .limit(1)
        .single();

      if (activeSession) {
        const agentName = (activeSession as any).agents?.name || "general";
        return new Response(
          JSON.stringify({
            agent_id: activeSession.agent_id,
            agent_name: agentName,
            rule_name: "session_continuity",
            session_id: activeSession.id,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // 2. Fetch active routing rules ordered by priority DESC
    const { data: rules, error: rulesError } = await supabase
      .from("routing_rules")
      .select("id, name, priority, conditions, target_agent_id, agents(name)")
      .eq("enabled", true)
      .order("priority", { ascending: false });

    if (rulesError) {
      return new Response(
        JSON.stringify({ error: `Rules fetch error: ${rulesError.message}` }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const messageLower = message.toLowerCase();

    // 3. Evaluate each rule
    for (const rule of rules || []) {
      const conditions = rule.conditions as Record<string, unknown>;
      if (!conditions) continue;

      // Skip fallback rules during matching — they're the default
      if (conditions.fallback) continue;

      let matched = false;

      // Keyword match: case-insensitive substring
      if (Array.isArray(conditions.keywords)) {
        matched = (conditions.keywords as string[]).some((kw) =>
          messageLower.includes(kw.toLowerCase())
        );
      }

      // Pattern match: regex
      if (!matched && typeof conditions.pattern === "string") {
        try {
          const regex = new RegExp(conditions.pattern, "i");
          matched = regex.test(message);
        } catch {
          // Invalid regex — skip
        }
      }

      // Channel match: exact (if specified)
      if (
        matched && typeof conditions.channel === "string" && channel
      ) {
        matched = conditions.channel === channel;
      }

      if (matched) {
        const agentName = (rule as any).agents?.name || "general";

        // Increment match_count (fire-and-forget)
        supabase
          .from("routing_rules")
          .update({
            match_count: (rule.match_count || 0) + 1,
            last_matched_at: new Date().toISOString(),
          })
          .eq("id", rule.id)
          .then(() => {});

        return new Response(
          JSON.stringify({
            agent_id: rule.target_agent_id,
            agent_name: agentName,
            rule_name: rule.name,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // 4. Fallback to general agent
    const fallbackRule = (rules || []).find(
      (r) => (r.conditions as any)?.fallback === true,
    );

    if (fallbackRule) {
      // Increment fallback match_count
      supabase
        .from("routing_rules")
        .update({
          match_count: (fallbackRule.match_count || 0) + 1,
          last_matched_at: new Date().toISOString(),
        })
        .eq("id", fallbackRule.id)
        .then(() => {});

      return new Response(
        JSON.stringify({
          agent_id: fallbackRule.target_agent_id,
          agent_name: (fallbackRule as any).agents?.name || "general",
          rule_name: fallbackRule.name,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // No rules at all — look up general agent directly
    const { data: generalAgent } = await supabase
      .from("agents")
      .select("id, name")
      .eq("name", "general")
      .eq("status", "active")
      .single();

    return new Response(
      JSON.stringify({
        agent_id: generalAgent?.id || null,
        agent_name: "general",
        rule_name: "hardcoded_fallback",
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
