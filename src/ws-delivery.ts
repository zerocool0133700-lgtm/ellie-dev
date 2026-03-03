/**
 * WebSocket Delivery Tracking — ELLIE-399
 *
 * Ensures responses persist through WebSocket disconnects:
 * 1. Marks delivery_status in DB on success/failure
 * 2. Tracks in-flight processing per user for sticky typing state
 * 3. Provides catch-up query for reconnecting clients
 */

import { WebSocket } from "ws";
import { log } from "./logger.ts";

const logger = log.child("ws-delivery");

let _supabase: any = null;

export function initDelivery(supabase: any) {
  _supabase = supabase;
}

// ── ELLIE-463: In-memory delivery buffer ─────────────────────
//
// Secondary safety net: holds messages that failed to send (WS closed)
// so they can be delivered when the client reconnects — even if Supabase
// is temporarily unavailable (no DB write / no DB read on reconnect).
//
// Per-userId ring buffer: max 20 messages, 15-min TTL.

const MAX_BUFFER_PER_USER = 20;
const BUFFER_TTL_MS = 15 * 60_000;

interface BufferedMessage {
  payload: Record<string, unknown>;
  bufferedAt: number;
}

const _memoryBuffer = new Map<string, BufferedMessage[]>();

function pushToMemoryBuffer(userId: string, payload: Record<string, unknown>): void {
  if (!userId) return;
  let buf = _memoryBuffer.get(userId);
  if (!buf) { buf = []; _memoryBuffer.set(userId, buf); }
  buf.push({ payload, bufferedAt: Date.now() });
  // Trim to ring size
  if (buf.length > MAX_BUFFER_PER_USER) buf.splice(0, buf.length - MAX_BUFFER_PER_USER);
}

/**
 * Send any buffered messages to a reconnecting client.
 * Called from websocket-servers.ts deliverCatchUp on every reconnect.
 *
 * Returns the memoryIds of messages that were successfully sent so the
 * caller can exclude them from the DB catch-up query (ELLIE-467 dedup).
 */
export function drainMemoryBuffer(userId: string, ws: WebSocket): string[] {
  if (!userId) return [];
  const buf = _memoryBuffer.get(userId);
  if (!buf || buf.length === 0) return [];

  const now = Date.now();
  const fresh = buf.filter(m => now - m.bufferedAt < BUFFER_TTL_MS);
  _memoryBuffer.delete(userId);

  if (fresh.length === 0) return [];
  logger.info(`[buffer] Draining ${fresh.length} buffered message(s) for ${userId}`);
  const deliveredIds: string[] = [];
  for (const { payload } of fresh) {
    if (ws.readyState !== WebSocket.OPEN) break;
    try {
      ws.send(JSON.stringify({ ...payload, buffered: true }));
      if (typeof payload.memoryId === "string") deliveredIds.push(payload.memoryId);
    } catch {
      // Client closed again during drain — stop
      break;
    }
  }
  return deliveredIds;
}

// ── In-flight processing tracker ─────────────────────────────

/** Track which users have a response currently being generated. */
const processingUsers = new Map<string, { startedAt: number; text: string }>();

export function markProcessing(userId: string, text: string) {
  processingUsers.set(userId, { startedAt: Date.now(), text });
}

export function clearProcessing(userId: string) {
  processingUsers.delete(userId);
}

export function getProcessingState(userId: string): { startedAt: number; text: string } | null {
  const state = processingUsers.get(userId);
  if (!state) return null;
  // Auto-expire after 10 minutes (safety net)
  if (Date.now() - state.startedAt > 600_000) {
    processingUsers.delete(userId);
    return null;
  }
  return state;
}

// ── Delivery-aware send ──────────────────────────────────────

/**
 * Send a response over WebSocket and update delivery_status in the DB.
 * If the socket is closed, marks the message as 'failed' so catch-up can recover it.
 * ELLIE-463: On failure, also pushes to in-memory buffer for immediate drain on reconnect.
 */
export function deliverResponse(
  ws: WebSocket,
  payload: {
    type: string;
    text: string;
    agent: string;
    memoryId?: string | null;
    ts: number;
    duration_ms?: number;
    channelId?: string;
  },
  userId?: string,
): boolean {
  const sent = trySend(ws, payload);
  if (payload.memoryId) {
    updateDeliveryStatus(payload.memoryId, sent ? "sent" : "failed").catch(() => {});
  }
  // ELLIE-463: Buffer failed sends for immediate reconnect drain
  if (!sent && userId) {
    pushToMemoryBuffer(userId, payload as Record<string, unknown>);
  }
  return sent;
}

/** Low-level send — returns true if message was sent. */
function trySend(ws: WebSocket, payload: Record<string, unknown>): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

// ── DB helpers ───────────────────────────────────────────────

async function updateDeliveryStatus(messageId: string, status: "sent" | "failed") {
  if (!_supabase) return;
  try {
    const update: Record<string, unknown> = { delivery_status: status };
    if (status === "sent") update.sent_at = new Date().toISOString();
    await _supabase
      .from("messages")
      .update(update)
      .eq("id", messageId);
  } catch (err) {
    logger.error("Failed to update delivery_status", { messageId, status, err });
  }
}

/**
 * Fetch undelivered ellie-chat messages for a user since a given timestamp.
 * Returns messages that were saved but never successfully delivered via WS.
 */
export async function getUndeliveredMessages(
  userId: string,
  sinceTs?: number,
): Promise<Array<{ id: string; content: string; role: string; created_at: string; metadata: Record<string, unknown> }>> {
  if (!_supabase) return [];
  try {
    let query = _supabase
      .from("messages")
      .select("id, content, role, created_at, metadata")
      .eq("channel", "ellie-chat")
      .eq("role", "assistant")
      .in("delivery_status", ["pending", "failed"])
      .order("created_at", { ascending: true })
      .limit(50);

    // If user has a real ID, filter by it; otherwise get all ellie-chat undelivered
    if (userId && userId !== "system-dashboard") {
      query = query.eq("user_id", userId);
    }

    // Time filter — only get messages from the last hour to avoid ancient undelivered messages
    const since = sinceTs
      ? new Date(sinceTs).toISOString()
      : new Date(Date.now() - 3600_000).toISOString();
    query = query.gte("created_at", since);

    const { data, error } = await query;
    if (error) {
      logger.error("Catch-up query failed", error);
      return [];
    }
    return data || [];
  } catch (err) {
    logger.error("Catch-up query error", err);
    return [];
  }
}

/**
 * Fetch recent conversation history for session restoration.
 * Returns both user and assistant messages regardless of delivery_status.
 * Used when a client reconnects and sessionStorage may be lost (mobile, new tab).
 */
export async function getRecentHistory(
  channel: string,
  userId?: string,
  limit: number = 50,
): Promise<Array<{ id: string; content: string; role: string; created_at: string; metadata: Record<string, unknown> }>> {
  if (!_supabase) return [];
  try {
    // Get the last N messages from the channel (last 24 hours max)
    const since = new Date(Date.now() - 86400_000).toISOString();
    let query = _supabase
      .from("messages")
      .select("id, content, role, created_at, metadata")
      .eq("channel", channel)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(limit);

    // Filter to this user's messages (same guard as getUndeliveredMessages)
    if (userId && userId !== "system-dashboard") {
      query = query.eq("user_id", userId);
    }

    const { data, error } = await query;
    if (error) {
      logger.error("History query failed", error);
      return [];
    }
    // Reverse to chronological order
    return (data || []).reverse();
  } catch (err) {
    logger.error("History query error", err);
    return [];
  }
}

/**
 * Mark recovered messages as sent after successful catch-up delivery.
 */
export async function markDelivered(messageIds: string[]) {
  if (!_supabase || !messageIds.length) return;
  try {
    await _supabase
      .from("messages")
      .update({ delivery_status: "sent", sent_at: new Date().toISOString() })
      .in("id", messageIds);
  } catch (err) {
    logger.error("Failed to mark catch-up messages as sent", err);
  }
}
