/**
 * Inline Conversation Consolidation
 *
 * Called by the relay when a conversation naturally ends:
 *   - Voice call disconnects
 *   - Telegram goes idle for 10+ minutes
 *
 * Processes unprocessed messages → creates conversation record →
 * extracts summary/facts/action_items via Claude CLI (Max subscription).
 *
 * The batch consolidation timer (every 4h) stays as a safety net.
 */

import { spawn } from "bun";
import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./logger.ts";
import { indexConversation, indexMemory, classifyDomain } from "./elasticsearch.ts";
import { insertMemoryWithDedup } from "./memory.ts";
import { contentHash } from "./ums/content-hash.ts";
import { tryAcquireConsolidationLock, releaseConsolidationLock } from "./ums/consolidation-lock.ts";
import forestSql from "../../ellie-forest/src/db";

const logger = log.child("consolidate");

const CHUNK_SIZE = 15; // messages per chunk for chunked consolidation (ELLIE-1033)
const INLINE_WINDOW_HOURS = parseInt(process.env.UMS_INLINE_WINDOW_HOURS || "24", 10); // ELLIE-1037

/** Split an array of messages into chunks of the given size. */
export function chunkMessages<T>(messages: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < messages.length; i += size) {
    chunks.push(messages.slice(i, i + size));
  }
  return chunks;
}

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

import { USER_TIMEZONE } from "./timezone.ts";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

/**
 * Consolidate all unprocessed messages into conversations.
 * Returns true if any conversations were created.
 */
export async function consolidateNow(
  supabase: SupabaseClient,
  options?: { channel?: string; onComplete?: () => void }
): Promise<boolean> {
  // Fetch unprocessed messages, optionally filtered by channel
  // ELLIE-1037: Bound query to inline time window to avoid reprocessing ancient messages
  const windowStart = new Date(Date.now() - INLINE_WINDOW_HOURS * 60 * 60_000).toISOString();
  let query = supabase
    .from("messages")
    .select("id, role, content, channel, created_at")
    .eq("summarized", false)
    .gte("created_at", windowStart)
    .order("created_at", { ascending: true })
    .limit(50);

  if (options?.channel) {
    query = query.eq("channel", options.channel);
  }

  const { data: messages, error } = await query;

  if (error) {
    logger.error("Failed to fetch messages", error);
    return false;
  }

  if (!messages || messages.length === 0) {
    logger.info("No unprocessed messages.");
    return false;
  }

  logger.info(`Processing ${messages.length} messages...`);

  const blocks = groupIntoBlocks(messages);
  logger.info(`Grouped into ${blocks.length} conversation(s).`);

  for (const block of blocks) {
    await processBlock(supabase, block);
  }

  logger.info("Done.");
  options?.onComplete?.();
  return true;
}

/**
 * Call Claude CLI to extract memories from a transcript.
 * Uses Max subscription (no API credits consumed).
 */
async function callClaudeCLI(prompt: string): Promise<string> {
  const args = [
    CLAUDE_PATH,
    "-p",
    "--output-format", "text",
    "--no-session-persistence",
    "--allowedTools", "",
    "--model", "haiku",
  ];

  const proc = spawn(args, {
    stdin: new Blob([prompt]),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDECODE: "",
      ANTHROPIC_API_KEY: "",  // Don't override Max subscription with API key
    },
  });

  const TIMEOUT_MS = 60_000;
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const timeout = setTimeout(() => {
    timedOut = true;
    logger.error("CLI timeout — sending SIGTERM", { timeoutMs: TIMEOUT_MS });
    proc.kill();
    // SIGKILL fallback if SIGTERM doesn't work (ELLIE-239)
    killTimer = setTimeout(() => {
      try { process.kill(proc.pid, 0); proc.kill(9); } catch {}
    }, 5_000);
  }, TIMEOUT_MS);

  const output = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  clearTimeout(timeout);
  if (killTimer) clearTimeout(killTimer);

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const msg = timedOut ? "timed out" : stderr || `exit code ${exitCode}`;
    throw new Error(`Claude CLI failed: ${msg}`);
  }

  return output.trim();
}

async function resolveAgentForBlock(
  supabase: SupabaseClient,
  block: ConversationBlock,
): Promise<string> {
  try {
    // Look up the most recent agent session active during this block's time window
    const { data } = await supabase
      .from("agent_sessions")
      .select("agents(name)")
      .eq("channel", block.channel)
      .lte("created_at", block.endedAt)
      .gte("last_activity", block.startedAt)
      .order("last_activity", { ascending: false })
      .limit(1)
      .single();

    const agentName = (data as Record<string, Record<string, string>> | null)?.agents?.name;
    if (agentName) return agentName;
  } catch {
    // Query failed or no match — fall through
  }
  return "general";
}

async function processBlock(
  supabase: SupabaseClient,
  block: ConversationBlock
): Promise<void> {
  // ELLIE-1035: Acquire distributed lock to prevent duplicate consolidation
  const lockAcquired = await tryAcquireConsolidationLock(forestSql, block.channel, block.startedAt);
  if (!lockAcquired) {
    logger.info("Skipping block — consolidation lock held by another process", { channel: block.channel });
    return;
  }

  try {
  // Resolve which agent handled this conversation block
  const blockAgent = await resolveAgentForBlock(supabase, block);

  // 1. Create conversation record
  const { data: convo, error: convoErr } = await supabase
    .from("conversations")
    .insert({
      channel: block.channel,
      agent: blockAgent,
      started_at: block.startedAt,
      ended_at: block.endedAt,
      message_count: block.messages.length,
      metadata: {},
    })
    .select("id")
    .single();

  if (convoErr || !convo) {
    logger.error("Failed to create conversation", convoErr);
    return;
  }

  const conversationId = convo.id;

  // 2. Link messages to this conversation (mark summarized AFTER successful extraction)
  await supabase
    .from("messages")
    .update({ conversation_id: conversationId })
    .in("id", block.messageIds);

  // 3. Ask Claude to extract memories — chunked for large blocks (ELLIE-1033)
  const timeRange = `${formatTime(block.startedAt)} – ${formatTime(block.endedAt)}`;
  const chunks = chunkMessages(block.messages, CHUNK_SIZE);
  const allMemories: Array<{ type: string; content: string }> = [];
  let fullSummary = "";
  let chunkFailures = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkTranscript = chunk.map((m) => `[${m.role}]: ${m.content}`).join("\n");

    const chunkContext = chunks.length > 1
      ? `\nThis is chunk ${i + 1} of ${chunks.length} from a longer conversation.${
          i > 0 && fullSummary ? `\nPrevious chunks summary: ${fullSummary}` : ""
        }\n`
      : "";

    const prompt = `You are a memory extraction system. You process a single conversation transcript and extract structured data.

This conversation happened on the "${block.channel}" channel, ${timeRange}.
${chunkContext}
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
${chunkTranscript}`;

    let responseText: string;
    try {
      responseText = await callClaudeCLI(prompt);
    } catch (err) {
      chunkFailures++;
      logger.error("Chunk CLI call failed", { chunk: i + 1, total: chunks.length, err });
      // Continue with remaining chunks — don't abort entire block
      continue;
    }

    let chunkParsed: {
      summary?: string;
      memories?: Array<{ type: string; content: string }>;
    };
    try {
      const cleaned = responseText
        .replace(/^```(?:json)?\s*/m, "")
        .replace(/\s*```\s*$/m, "")
        .trim();
      try {
        chunkParsed = JSON.parse(cleaned);
      } catch {
        const jsonMatch = cleaned.match(/\{[\s\S]*"summary"[\s\S]*"memories"[\s\S]*\}/);
        if (!jsonMatch) throw new Error("No JSON found in response");
        chunkParsed = JSON.parse(jsonMatch[0]);
      }
    } catch {
      chunkFailures++;
      logger.error("Chunk parse failed", { chunk: i + 1, total: chunks.length, preview: responseText.substring(0, 200) });
      continue;
    }

    if (chunkParsed.summary) {
      fullSummary += (fullSummary ? " " : "") + chunkParsed.summary;
    }
    if (chunkParsed.memories) {
      allMemories.push(...chunkParsed.memories);
    }
  }

  // If ALL chunks failed, rollback entirely
  if (chunkFailures === chunks.length) {
    logger.error("All chunks failed — rolling back block", { totalChunks: chunks.length });
    await supabase.from("messages").update({ conversation_id: null }).in("id", block.messageIds);
    await supabase.from("conversations").delete().eq("id", conversationId);
    return;
  }

  const parsed = { summary: fullSummary || undefined, memories: allMemories };

  // Mark messages as summarized now that extraction succeeded
  await supabase
    .from("messages")
    .update({ summarized: true })
    .in("id", block.messageIds);

  // 4. Update conversation with summary
  if (parsed.summary) {
    await supabase
      .from("conversations")
      .update({ summary: parsed.summary })
      .eq("id", conversationId);
    logger.info(`${block.channel} (${block.messages.length} msgs): ${parsed.summary}`);

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
    for (const mem of validMemories) {
      const hash = contentHash(mem.content);
      const result = await insertMemoryWithDedup(supabase, {
        type: mem.type,
        content: mem.content,
        source_agent: blockAgent,
        visibility: "shared",
        conversation_id: conversationId,
        metadata: { source: "consolidation", content_hash: hash },
      });
      logger.info(`${mem.content} → ${result.action}${result.resolution ? ` (${result.resolution.reason})` : ""}`, { type: mem.type });
    }
  }

  // 6. Insert summary as memory entry for semantic search
  if (parsed.summary) {
    const { data: summaryData } = await supabase.from("memory").insert({
      type: "summary",
      content: parsed.summary,
      conversation_id: conversationId,
      source_agent: blockAgent,
      visibility: "shared",
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
  } finally {
    // ELLIE-1035: Always release the consolidation lock
    await releaseConsolidationLock(forestSql, block.channel, block.startedAt);
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
