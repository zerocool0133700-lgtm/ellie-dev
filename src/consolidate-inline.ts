/**
 * Inline Conversation Consolidation
 *
 * Called by the relay when a conversation naturally ends:
 *   - Voice call disconnects
 *   - Telegram goes idle for 10+ minutes
 *
 * Processes unprocessed messages → creates conversation record →
 * extracts summary/facts/action_items via Haiku API.
 *
 * The batch consolidation timer (every 4h) stays as a safety net.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { indexConversation, indexMemory, classifyDomain } from "./elasticsearch.ts";

interface RawMessage {
  id: string;
  role: string;
  content: string;
  channel: string;
  created_at: string;
}

interface ConversationBlock {
  channel: string;
  startedAt: string;
  endedAt: string;
  messageIds: string[];
  messages: Array<{ role: string; content: string; created_at: string }>;
}

const USER_TIMEZONE = process.env.USER_TIMEZONE || "UTC";

/**
 * Consolidate all unprocessed messages into conversations.
 * Returns true if any conversations were created.
 */
export async function consolidateNow(
  supabase: SupabaseClient,
  anthropicKey: string,
  options?: { channel?: string; onComplete?: () => void }
): Promise<boolean> {
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  // Fetch unprocessed messages, optionally filtered by channel
  let query = supabase
    .from("messages")
    .select("id, role, content, channel, created_at")
    .eq("summarized", false)
    .order("created_at", { ascending: true })
    .limit(50);

  if (options?.channel) {
    query = query.eq("channel", options.channel);
  }

  const { data: messages, error } = await query;

  if (error) {
    console.error("[consolidate] Failed to fetch messages:", error);
    return false;
  }

  if (!messages || messages.length === 0) {
    console.log("[consolidate] No unprocessed messages.");
    return false;
  }

  console.log(`[consolidate] Processing ${messages.length} messages...`);

  const blocks = groupIntoBlocks(messages);
  console.log(`[consolidate] Grouped into ${blocks.length} conversation(s).`);

  for (const block of blocks) {
    await processBlock(supabase, anthropic, block);
  }

  console.log("[consolidate] Done.");
  options?.onComplete?.();
  return true;
}

async function processBlock(
  supabase: SupabaseClient,
  anthropic: Anthropic,
  block: ConversationBlock
): Promise<void> {
  // 1. Create conversation record
  const { data: convo, error: convoErr } = await supabase
    .from("conversations")
    .insert({
      channel: block.channel,
      started_at: block.startedAt,
      ended_at: block.endedAt,
      message_count: block.messages.length,
      metadata: {},
    })
    .select("id")
    .single();

  if (convoErr || !convo) {
    console.error("[consolidate] Failed to create conversation:", convoErr);
    return;
  }

  const conversationId = convo.id;

  // 2. Link messages to this conversation
  await supabase
    .from("messages")
    .update({ summarized: true, conversation_id: conversationId })
    .in("id", block.messageIds);

  // 3. Ask Claude to extract memories
  const transcript = block.messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n");

  const timeRange = `${formatTime(block.startedAt)} – ${formatTime(block.endedAt)}`;

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1500,
    system: `You are a memory extraction system. You process a single conversation transcript and extract structured data.

This conversation happened on the "${block.channel}" channel, ${timeRange}.

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

Return ONLY valid JSON. No markdown fences, no explanation.`,
    messages: [{ role: "user", content: transcript }],
  });

  const responseText = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  let parsed: {
    summary?: string;
    memories?: Array<{ type: string; content: string }>;
  };
  try {
    const cleaned = responseText
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```\s*$/m, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    console.error(
      "[consolidate] Failed to parse response:",
      responseText.substring(0, 200)
    );
    return;
  }

  // 4. Update conversation with summary
  if (parsed.summary) {
    await supabase
      .from("conversations")
      .update({ summary: parsed.summary })
      .eq("id", conversationId);
    console.log(
      `[consolidate] ${block.channel} (${block.messages.length} msgs): ${parsed.summary}`
    );

    // Index conversation to Elasticsearch
    indexConversation({
      id: conversationId,
      summary: parsed.summary,
      channel: block.channel,
      started_at: block.startedAt,
      ended_at: block.endedAt,
      message_count: block.messages.length,
    }).catch(() => {});
  }

  // 5. Insert extracted memories
  const validTypes = ["fact", "action_item"];
  const validMemories = (parsed.memories || []).filter(
    (m) => validTypes.includes(m.type) && m.content?.trim()
  );

  if (validMemories.length > 0) {
    const { data: insertedMemories } = await supabase.from("memory").insert(
      validMemories.map((m) => ({
        type: m.type,
        content: m.content,
        conversation_id: conversationId,
        metadata: { source: "consolidation" },
      }))
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

  // 6. Insert summary as memory entry for semantic search
  if (parsed.summary) {
    const { data: summaryData } = await supabase.from("memory").insert({
      type: "summary",
      content: parsed.summary,
      conversation_id: conversationId,
      metadata: { source: "consolidation", channel: block.channel },
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
}

function groupIntoBlocks(messages: RawMessage[]): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  let current: ConversationBlock | null = null;

  for (const msg of messages) {
    const gap = current
      ? (new Date(msg.created_at).getTime() -
          new Date(current.endedAt).getTime()) /
        60_000
      : Infinity;

    if (!current || current.channel !== msg.channel || gap > 30) {
      current = {
        channel: msg.channel,
        startedAt: msg.created_at,
        endedAt: msg.created_at,
        messageIds: [],
        messages: [],
      };
      blocks.push(current);
    }

    current.messageIds.push(msg.id);
    current.endedAt = msg.created_at;
    current.messages.push({
      role: msg.role,
      content: msg.content,
      created_at: msg.created_at,
    });
  }

  return blocks;
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
