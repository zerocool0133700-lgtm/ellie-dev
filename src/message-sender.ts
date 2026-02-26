/**
 * Message Sender — response delivery + persistence.
 *
 * Extracted from relay.ts — ELLIE-207.
 * Contains: saveMessage, sendResponse, sendWithApprovals, sendWithApprovalsEllieChat.
 */

import type { Context } from "grammy";
import { InputFile, InlineKeyboard } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WebSocket } from "ws";
import { log } from "./logger.ts";
import { indexMessage } from "./elasticsearch.ts";

const logger = log.child("message-sender");
import { getOrCreateConversation, attachMessage, maybeGenerateSummary } from "./conversations.ts";
import { extractApprovalTags, storePendingAction } from "./approval.ts";

// ── External dependency setters ─────────────────────────────

let _supabase: SupabaseClient | null = null;
let _getActiveAgent: (channel?: string) => string = () => "general";

export function setSenderDeps(deps: {
  supabase: SupabaseClient | null;
  getActiveAgent: (channel?: string) => string;
}): void {
  _supabase = deps.supabase;
  _getActiveAgent = deps.getActiveAgent;
}

// ── Ellie Chat pending actions (shared with ellie-chat handler) ──

export const ellieChatPendingActions = new Map<string, {
  ws: WebSocket;
  description: string;
  sessionId: string | null;
  agentName: string;
  createdAt: number;
}>();

// ── saveMessage ──────────────────────────────────────────────

export async function saveMessage(
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
  channel: string = "telegram",
  userId?: string,
): Promise<string | null> {
  if (!_supabase) return null;
  try {
    const conversationId = await getOrCreateConversation(_supabase, channel);

    const row: Record<string, unknown> = {
      role,
      content,
      channel,
      metadata: metadata || {},
      conversation_id: conversationId,
    };
    if (userId) row.user_id = userId;

    const { data } = await _supabase.from("messages").insert(row).select("id").single();

    // Index to ES (fire-and-forget)
    if (data?.id) {
      indexMessage({
        id: data.id,
        content, role, channel,
        created_at: new Date().toISOString(),
        source_agent: _getActiveAgent(channel),
      }).catch(() => {});

      // Update conversation stats + maybe generate rolling summary (fire-and-forget)
      if (conversationId) {
        attachMessage(_supabase, data.id, conversationId).catch(() => {});
        maybeGenerateSummary(_supabase, conversationId).catch(() => {});
      }
    }

    return data?.id || null;
  } catch (error) {
    logger.error("Supabase save error", error);
    return null;
  }
}

// ── sendResponse (Telegram long message splitting) ───────────

export async function sendResponse(ctx: Context, response: string): Promise<void> {
  const MAX_LENGTH = 4000;
  const FILE_THRESHOLD = 8000;

  // Short response: send as-is
  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
    return;
  }

  // Very long response: truncate message + attach full output as file
  if (response.length > FILE_THRESHOLD) {
    const truncated = response.substring(0, MAX_LENGTH - 200);
    await ctx.reply(`${truncated}\n\n... (truncated — full output attached)`);

    const buffer = Buffer.from(response, "utf-8");
    await ctx.replyWithDocument(new InputFile(buffer, "output.txt"));
    return;
  }

  // Medium response: split into chunks
  const chunks = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

// ── sendWithApprovals (Telegram) ─────────────────────────────

/**
 * Send response with approval button handling.
 * Extracts [CONFIRM: ...] tags, sends text first, then each confirmation
 * as a separate message with Approve/Deny inline keyboard buttons.
 */
export async function sendWithApprovals(
  ctx: Context,
  response: string,
  currentSessionId: string | null,
  agentName?: string,
): Promise<string> {
  const { cleanedText, confirmations } = extractApprovalTags(response);

  if (confirmations.length > 0) {
    if (cleanedText) {
      await sendResponse(ctx, cleanedText);
    }
    for (const description of confirmations) {
      const actionId = crypto.randomUUID();
      const keyboard = new InlineKeyboard()
        .text("\u2705 Approve", `approve:${actionId}`)
        .text("\u274c Deny", `deny:${actionId}`);

      const sent = await ctx.reply(
        `\u26a0\ufe0f Confirm action:\n${description}`,
        { reply_markup: keyboard },
      );

      storePendingAction(
        actionId,
        description,
        currentSessionId,
        sent.chat.id,
        sent.message_id,
        { agentName: agentName || _getActiveAgent("telegram") },
      );
      console.log(`[approval] Pending: ${description.substring(0, 60)}`);
    }
  } else {
    await sendResponse(ctx, cleanedText);
  }

  return cleanedText;
}

// ── sendWithApprovalsEllieChat (WebSocket) ───────────────────

/**
 * Ellie Chat analog of sendWithApprovals.
 * Extracts [CONFIRM:] tags and sends them as confirm-type WS messages
 * so the frontend can render Approve/Deny buttons.
 */
export function sendWithApprovalsEllieChat(
  ws: WebSocket,
  response: string,
  currentSessionId: string | null,
  agentName: string,
): { cleanedText: string; hadConfirmations: boolean } {
  const { cleanedText, confirmations } = extractApprovalTags(response);

  if (confirmations.length > 0 && ws.readyState === 1 /* WebSocket.OPEN */) {
    // Send the text body first (if any)
    if (cleanedText) {
      ws.send(JSON.stringify({
        type: "response",
        text: cleanedText,
        agent: agentName,
        ts: Date.now(),
      }));
    }
    // Send each confirmation as a separate confirm message
    for (const description of confirmations) {
      const actionId = crypto.randomUUID();
      ellieChatPendingActions.set(actionId, {
        ws,
        description,
        sessionId: currentSessionId,
        agentName,
        createdAt: Date.now(),
      });
      console.log(`[ellie-chat approval] Pending: ${description.substring(0, 60)}`);
      ws.send(JSON.stringify({
        type: "confirm",
        id: actionId,
        description,
        ts: Date.now(),
      }));
    }
    return { cleanedText, hadConfirmations: true };
  }

  return { cleanedText, hadConfirmations: false };
}
