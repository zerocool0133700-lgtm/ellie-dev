/**
 * Memory Module
 *
 * Persistent facts, goals, and preferences stored in Supabase.
 * Claude manages memory automatically via intent tags in its responses:
 *   [REMEMBER: fact]
 *   [GOAL: text | DEADLINE: date]
 *   [DONE: search text]
 *
 * The relay parses these tags, saves to Supabase, and strips them
 * from the response before sending to the user.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { indexMemory, classifyDomain } from "./elasticsearch.ts";

/**
 * Parse Claude's response for memory intent tags.
 * Saves facts/goals to Supabase and returns the cleaned response.
 */
export async function processMemoryIntents(
  supabase: SupabaseClient | null,
  response: string,
  sourceAgent: string = "general",
): Promise<string> {
  if (!supabase) return response;

  let clean = response;

  // [REMEMBER: fact to store]
  for (const match of response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)) {
    const { data } = await supabase.from("memory").insert({
      type: "fact",
      content: match[1],
      source_agent: sourceAgent,
      visibility: "shared",
    }).select("id").single();

    if (data?.id) {
      indexMemory({
        id: data.id,
        content: match[1],
        type: "fact",
        domain: classifyDomain(match[1]),
        created_at: new Date().toISOString(),
      }).catch(() => {});
    }
    clean = clean.replace(match[0], "");
  }

  // [GOAL: text] or [GOAL: text | DEADLINE: date]
  for (const match of response.matchAll(
    /\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi
  )) {
    const { data } = await supabase.from("memory").insert({
      type: "goal",
      content: match[1],
      deadline: match[2] || null,
      source_agent: sourceAgent,
      visibility: "shared",
    }).select("id").single();

    if (data?.id) {
      indexMemory({
        id: data.id,
        content: match[1],
        type: "goal",
        domain: classifyDomain(match[1]),
        created_at: new Date().toISOString(),
      }).catch(() => {});
    }
    clean = clean.replace(match[0], "");
  }

  // [DONE: search text for completed goal]
  for (const match of response.matchAll(/\[DONE:\s*(.+?)\]/gi)) {
    const { data } = await supabase
      .from("memory")
      .select("id")
      .eq("type", "goal")
      .ilike("content", `%${match[1]}%`)
      .limit(1);

    if (data?.[0]) {
      await supabase
        .from("memory")
        .update({
          type: "completed_goal",
          completed_at: new Date().toISOString(),
        })
        .eq("id", data[0].id);
    }
    clean = clean.replace(match[0], "");
  }

  return clean.trim();
}

/**
 * Get all facts and active goals for prompt context.
 */
export async function getMemoryContext(
  supabase: SupabaseClient | null
): Promise<string> {
  if (!supabase) return "";

  try {
    const [factsResult, goalsResult] = await Promise.all([
      supabase.rpc("get_facts"),
      supabase.rpc("get_active_goals"),
    ]);

    const parts: string[] = [];

    if (factsResult.data?.length) {
      parts.push(
        "FACTS:\n" +
          factsResult.data.map((f: any) => `- ${f.content}`).join("\n")
      );
    }

    if (goalsResult.data?.length) {
      parts.push(
        "GOALS:\n" +
          goalsResult.data
            .map((g: any) => {
              const deadline = g.deadline
                ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
                : "";
              return `- ${g.content}${deadline}`;
            })
            .join("\n")
      );
    }

    return parts.join("\n\n");
  } catch (error) {
    console.error("Memory context error:", error);
    return "";
  }
}

/**
 * Get the most recent messages for conversation continuity.
 * This ensures Claude always has the immediate conversation thread,
 * not just semantically similar messages.
 */
export async function getRecentMessages(
  supabase: SupabaseClient | null,
  limit: number = 10
): Promise<string> {
  if (!supabase) return "";

  try {
    const { data, error } = await supabase
      .from("messages")
      .select("role, content, created_at")
      .in("channel", ["telegram", "voice", "google-chat"])
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error || !data?.length) return "";

    // Reverse so oldest is first (chronological order)
    const messages = data.reverse();

    return (
      "RECENT CONVERSATION:\n" +
      messages
        .map((m: any) => `[${m.role}]: ${m.content}`)
        .join("\n")
    );
  } catch (error) {
    console.error("Recent messages error:", error);
    return "";
  }
}

/**
 * Semantic search for relevant past messages via the search Edge Function.
 * The Edge Function handles embedding generation (OpenAI key stays in Supabase).
 */
export async function getRelevantContext(
  supabase: SupabaseClient | null,
  query: string
): Promise<string> {
  if (!supabase) return "";

  try {
    const { data, error } = await supabase.functions.invoke("search", {
      body: { query, match_count: 5, table: "messages" },
    });

    if (error || !data?.length) return "";

    return (
      "RELEVANT PAST MESSAGES:\n" +
      data
        .map((m: any) => `[${m.role}]: ${m.content}`)
        .join("\n")
    );
  } catch {
    // Search not available yet (Edge Functions not deployed) — that's fine
    return "";
  }
}
