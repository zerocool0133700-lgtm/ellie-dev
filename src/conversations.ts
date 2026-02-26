/**
 * Conversation Tracking Module — ELLIE-51
 *
 * Manages conversation lifecycle: create, attach messages, generate
 * rolling summaries, close, and expire idle conversations.
 *
 * Replaces the old "consolidate after the fact" model with live tracking.
 * Every incoming message gets attached to an active conversation immediately.
 */

import { spawn } from "bun";
import type { SupabaseClient } from "@supabase/supabase-js";
import { indexConversation, indexMemory, classifyDomain } from "./elasticsearch.ts";
import { log } from "./logger.ts";

const logger = log.child("conversation");

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const USER_TIMEZONE = process.env.USER_TIMEZONE || "UTC";

// How many messages between rolling summary updates
const SUMMARY_INTERVAL = 8;
// Idle timeout in minutes before a conversation auto-expires
const IDLE_TIMEOUT_MINUTES = 30;

interface ConversationRecord {
  id: string;
  channel: string;
  agent: string;
  status: string;
  summary: string | null;
  message_count: number;
  started_at: string;
  last_message_at: string;
}

/**
 * Get or create the active conversation for a channel.
 * Uses the DB function which handles idle expiry atomically.
 * Returns the conversation_id.
 */
export async function getOrCreateConversation(
  supabase: SupabaseClient,
  channel: string,
  agent: string = "general",
): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc("get_or_create_conversation", {
      p_channel: channel,
      p_agent: agent,
      p_idle_minutes: IDLE_TIMEOUT_MINUTES,
    });

    if (error) {
      logger.error("get_or_create error", error);
      return null;
    }

    return data as string;
  } catch (err) {
    logger.error("get_or_create failed", err);
    return null;
  }
}

/**
 * Attach a message to the active conversation.
 * Updates message_count and last_message_at on the conversation.
 * Returns the conversation_id the message was attached to.
 */
export async function attachMessage(
  supabase: SupabaseClient,
  messageId: string,
  conversationId: string,
): Promise<void> {
  try {
    // Link message to conversation
    await supabase
      .from("messages")
      .update({ conversation_id: conversationId })
      .eq("id", messageId);

    // Update conversation stats (increment message_count, update last_message_at)
    const { data: convo } = await supabase
      .from("conversations")
      .select("message_count")
      .eq("id", conversationId)
      .single();

    if (convo) {
      await supabase
        .from("conversations")
        .update({
          message_count: (convo.message_count || 0) + 1,
          last_message_at: new Date().toISOString(),
        })
        .eq("id", conversationId);
    }
  } catch (err) {
    logger.error("attachMessage error", err);
  }
}

/**
 * Check if a rolling summary is due and generate one if so.
 * Summaries are generated every SUMMARY_INTERVAL messages.
 */
export async function maybeGenerateSummary(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<void> {
  try {
    const { data: convo } = await supabase
      .from("conversations")
      .select("message_count, summary, channel")
      .eq("id", conversationId)
      .single();

    if (!convo) return;

    // Generate summary every N messages (starting after first batch)
    if (convo.message_count < SUMMARY_INTERVAL) return;
    if (convo.message_count % SUMMARY_INTERVAL !== 0) return;

    console.log(`[conversation] Summary due for ${conversationId} (${convo.message_count} msgs)`);

    // Fetch recent messages for this conversation
    const { data: messages } = await supabase
      .from("messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    if (!messages?.length) return;

    await generateAndStoreSummary(supabase, conversationId, messages, convo.summary, convo.channel);
  } catch (err) {
    logger.error("maybeGenerateSummary error", err);
  }
}

/**
 * Generate a rolling summary using Claude CLI and store it.
 */
async function generateAndStoreSummary(
  supabase: SupabaseClient,
  conversationId: string,
  messages: Array<{ role: string; content: string; created_at: string }>,
  existingSummary: string | null,
  channel: string,
): Promise<void> {
  const transcript = messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n");

  const previousContext = existingSummary
    ? `\nPREVIOUS SUMMARY (update and extend this):\n${existingSummary}\n`
    : "";

  const prompt = `You are a conversation summarizer. Generate a concise rolling summary of this conversation.
${previousContext}
CONVERSATION (${channel} channel):
${transcript}

Instructions:
- Write 2-4 sentences capturing the key topics, decisions, and current state
- If there's a previous summary, integrate new information into it (don't just append)
- Focus on what matters: decisions made, tasks discussed, key facts shared
- Write in third person ("Dave discussed...", "They decided...")
- Be concise — this will be used as context for future messages

Return ONLY the summary text, nothing else.`;

  try {
    const summary = await callClaudeCLI(prompt);

    if (summary && summary.length > 10) {
      await supabase
        .from("conversations")
        .update({ summary })
        .eq("id", conversationId);

      console.log(`[conversation] Summary updated: ${summary.substring(0, 80)}...`);
    }
  } catch (err) {
    logger.error("summary generation failed", { conversationId }, err);
    // Non-fatal — conversation tracking continues without summary
  }
}

/**
 * Close a conversation explicitly (e.g., from dashboard button or API).
 * Triggers final consolidation (memory extraction).
 */
export async function closeConversation(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<void> {
  try {
    // Generate final summary if we don't have one
    const { data: convo } = await supabase
      .from("conversations")
      .select("summary, channel, message_count")
      .eq("id", conversationId)
      .single();

    if (!convo) return;

    // If conversation has messages but no summary, generate one
    if (convo.message_count > 2 && !convo.summary) {
      const { data: messages } = await supabase
        .from("messages")
        .select("role, content, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

      if (messages?.length) {
        await generateAndStoreSummary(supabase, conversationId, messages, null, convo.channel);
      }
    }

    // Close the conversation
    await supabase.rpc("close_conversation", {
      p_conversation_id: conversationId,
    });

    // Run memory extraction on the closed conversation
    await extractMemories(supabase, conversationId);

    console.log(`[conversation] Closed: ${conversationId}`);
  } catch (err) {
    logger.error("closeConversation error", { conversationId }, err);
  }
}

/**
 * Close the active conversation for a channel.
 * Used by idle timers and consolidation triggers.
 */
export async function closeActiveConversation(
  supabase: SupabaseClient,
  channel: string,
): Promise<boolean> {
  try {
    const { data: convo } = await supabase
      .from("conversations")
      .select("id, message_count")
      .eq("channel", channel)
      .eq("status", "active")
      .order("started_at", { ascending: false })
      .limit(1)
      .single();

    if (!convo) return false;

    // Skip conversations with very few messages (not worth summarizing)
    if (convo.message_count < 2) {
      // Just close it without extraction
      await supabase.rpc("close_conversation", {
        p_conversation_id: convo.id,
      });
      return true;
    }

    await closeConversation(supabase, convo.id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract memories (facts, action items) from a closed conversation.
 * This replaces the old consolidation memory extraction for conversations
 * that were tracked live.
 */
async function extractMemories(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<void> {
  try {
    const { data: convo } = await supabase
      .from("conversations")
      .select("channel, agent, summary, started_at, last_message_at")
      .eq("id", conversationId)
      .single();

    if (!convo) return;

    const { data: messages } = await supabase
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    if (!messages?.length) return;

    const transcript = messages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n");

    const timeRange = `${formatTime(convo.started_at)} – ${formatTime(convo.last_message_at || convo.started_at)}`;

    const prompt = `You are a memory extraction system. You process a single conversation transcript and extract structured data.

This conversation happened on the "${convo.channel}" channel, ${timeRange}.

Return a JSON object with two fields:
1. "summary": A 1-3 sentence summary of what was discussed (standalone, no references to "the conversation")
2. "memories": An array of extracted memory objects, each with:
   - "type": one of "fact", "action_item"
   - "content": concise, standalone sentence

Guidelines:
- FACTS: things learned about Dave — preferences, projects, people, decisions, technical details
- ACTION ITEMS: things Dave asked to be done, follow-ups, commitments
- Skip small talk, greetings, and trivial exchanges
- Be concise. Each memory should be one clear sentence.
- If nothing worth extracting, return: {"summary": "...", "memories": []}

Return ONLY valid JSON. No markdown fences, no explanation.

TRANSCRIPT:
${transcript}`;

    let responseText: string;
    try {
      responseText = await callClaudeCLI(prompt);
    } catch (err) {
      logger.error("memory extraction CLI failed", { conversationId }, err);
      return;
    }

    let parsed: {
      summary?: string;
      memories?: Array<{ type: string; content: string }>;
    };
    try {
      const cleaned = responseText
        .replace(/^```(?:json)?\s*/m, "")
        .replace(/\s*```\s*$/m, "")
        .trim();
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        const jsonMatch = cleaned.match(/\{[\s\S]*"summary"[\s\S]*"memories"[\s\S]*\}/);
        if (!jsonMatch) throw new Error("No JSON found in response");
        parsed = JSON.parse(jsonMatch[0]);
      }
    } catch {
      logger.error("failed to parse memory extraction", { conversationId, responsePreview: responseText.substring(0, 200) });
      return;
    }

    // Mark messages as summarized
    await supabase
      .from("messages")
      .update({ summarized: true })
      .eq("conversation_id", conversationId);

    // Update conversation summary if extraction produced a better one
    if (parsed.summary) {
      await supabase
        .from("conversations")
        .update({ summary: parsed.summary })
        .eq("id", conversationId);

      // Index conversation to Elasticsearch
      indexConversation({
        id: conversationId,
        summary: parsed.summary,
        channel: convo.channel,
        started_at: convo.started_at,
        ended_at: convo.last_message_at || convo.started_at,
        message_count: messages.length,
      }).catch(() => {});
    }

    // Insert extracted memories
    const validTypes = ["fact", "action_item"];
    const validMemories = (parsed.memories || []).filter(
      (m) => validTypes.includes(m.type) && m.content?.trim(),
    );

    if (validMemories.length > 0) {
      const { data: insertedMemories } = await supabase.from("memory").insert(
        validMemories.map((m) => ({
          type: m.type,
          content: m.content,
          conversation_id: conversationId,
          source_agent: convo.agent || "general",
          visibility: "shared",
          metadata: { source: "conversation_close" },
        })),
      ).select("id, type, content");

      for (const mem of validMemories) {
        console.log(`  [${mem.type}] ${mem.content}`);
      }

      // Index memories to Elasticsearch
      if (insertedMemories) {
        for (const mem of insertedMemories) {
          indexMemory({
            id: mem.id,
            content: mem.content,
            type: mem.type,
            domain: classifyDomain(mem.content),
            created_at: new Date().toISOString(),
            conversation_id: conversationId,
          }).catch(() => {});
        }
      }
    }

    // Insert summary as memory entry for semantic search
    if (parsed.summary) {
      const { data: summaryData } = await supabase.from("memory").insert({
        type: "summary",
        content: parsed.summary,
        conversation_id: conversationId,
        source_agent: convo.agent || "general",
        visibility: "shared",
        metadata: { source: "conversation_close", channel: convo.channel },
      }).select("id").single();

      if (summaryData?.id) {
        indexMemory({
          id: summaryData.id,
          content: parsed.summary,
          type: "summary",
          domain: classifyDomain(parsed.summary),
          created_at: new Date().toISOString(),
          conversation_id: conversationId,
        }).catch(() => {});
      }
    }

    console.log(`[conversation] Memories extracted for ${conversationId}: ${validMemories.length} memories`);
  } catch (err) {
    logger.error("extractMemories error", { conversationId }, err);
  }
}

/**
 * Load full conversation messages for the active conversation (ELLIE-202).
 * This is the primary context source — the ground-truth thread.
 *
 * Smart truncation for long conversations:
 *  - Short (≤40 messages): return all
 *  - Medium (≤100): first 5 + last 35
 *  - Long (>100): first 5 + rolling summary + last 35
 */
export async function getConversationMessages(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<{ text: string; messageCount: number; conversationId: string }> {
  try {
    // Fetch conversation metadata (for summary fallback)
    const { data: convo } = await supabase
      .from("conversations")
      .select("summary, message_count")
      .eq("id", conversationId)
      .single();

    if (!convo) return { text: "", messageCount: 0, conversationId };

    // Fetch all messages in the conversation
    const { data: messages, error } = await supabase
      .from("messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    if (error || !messages?.length) return { text: "", messageCount: 0, conversationId };

    const total = messages.length;

    const fmt = (m: { role: string; content: string }) =>
      `[${m.role}]: ${m.content}`;

    let lines: string[];

    if (total <= 40) {
      // Short conversation — include everything
      lines = messages.map(fmt);
    } else if (total <= 100) {
      // Medium — first 5 (for context anchoring) + last 35
      const head = messages.slice(0, 5).map(fmt);
      const tail = messages.slice(-35).map(fmt);
      lines = [...head, `\n[... ${total - 40} earlier messages omitted ...]\n`, ...tail];
    } else {
      // Long — first 5 + rolling summary (if available) + last 35
      const head = messages.slice(0, 5).map(fmt);
      const tail = messages.slice(-35).map(fmt);
      const summaryLine = convo.summary
        ? `\n[CONVERSATION SUMMARY (${total - 40} earlier messages): ${convo.summary}]\n`
        : `\n[... ${total - 40} earlier messages omitted ...]\n`;
      lines = [...head, summaryLine, ...tail];
    }

    const text = "CURRENT CONVERSATION:\n" + lines.join("\n");
    return { text, messageCount: total, conversationId };
  } catch (err) {
    logger.error("getConversationMessages error", { conversationId }, err);
    return { text: "", messageCount: 0, conversationId };
  }
}

/**
 * Get conversation context for ELLIE-50 classifier.
 * Returns structured info about the active conversation on a channel.
 */
export async function getConversationContext(
  supabase: SupabaseClient,
  channel: string,
): Promise<{
  conversationId: string;
  agent: string;
  summary: string | null;
  messageCount: number;
  startedAt: string;
  recentMessages: Array<{ role: string; content: string }>;
} | null> {
  try {
    const { data } = await supabase.rpc("get_conversation_context", {
      p_channel: channel,
    });

    if (!data?.length) return null;

    const convo = data[0];

    // Get last 3 messages for immediate context
    const { data: recentMsgs } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", convo.conversation_id)
      .order("created_at", { ascending: false })
      .limit(3);

    return {
      conversationId: convo.conversation_id,
      agent: convo.agent,
      summary: convo.summary,
      messageCount: convo.message_count,
      startedAt: convo.started_at,
      recentMessages: (recentMsgs || []).reverse(),
    };
  } catch (err) {
    logger.error("getConversationContext error", { channel }, err);
    return null;
  }
}

/**
 * Expire all idle conversations across all channels.
 * Called periodically as a safety net.
 */
export async function expireIdleConversations(
  supabase: SupabaseClient,
): Promise<number> {
  try {
    const { data, error } = await supabase.rpc("expire_idle_conversations", {
      p_idle_minutes: IDLE_TIMEOUT_MINUTES,
    });

    if (error) {
      logger.error("expire error", error);
      return 0;
    }

    const count = data as number;
    if (count > 0) {
      console.log(`[conversation] Expired ${count} idle conversation(s)`);
    }
    return count;
  } catch (err) {
    logger.error("expireIdleConversations error", err);
    return 0;
  }
}

// --- Helpers ---

async function callClaudeCLI(prompt: string): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt, "--output-format", "text"];

  const proc = spawn(args, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDECODE: "",
      ANTHROPIC_API_KEY: "",
    },
  });

  const TIMEOUT_MS = 60_000;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    logger.error(`CLI timeout after ${TIMEOUT_MS / 1000}s — killing`);
    proc.kill();
  }, TIMEOUT_MS);

  const output = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  clearTimeout(timeout);

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const msg = timedOut ? "timed out" : stderr || `exit code ${exitCode}`;
    throw new Error(`Claude CLI failed: ${msg}`);
  }

  return output.trim();
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: USER_TIMEZONE,
  });
}
