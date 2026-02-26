/**
 * Message Delivery Module (ELLIE-33)
 *
 * Handles reliable message delivery with:
 * - Retry logic with exponential backoff
 * - Delivery status tracking (updates message metadata in Supabase)
 * - Channel fallback (Google Chat → Telegram)
 * - Pending response awareness (nudges if no reply)
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { sendGoogleChatMessage, type GchatSendResult } from "./google-chat.ts";
import { log } from "./logger.ts";

const logger = log.child("delivery");

// ============================================================
// TYPES
// ============================================================

export interface DeliveryResult {
  status: "sent" | "failed" | "fallback";
  channel: string; // actual channel delivered on
  externalId?: string;
  threadName?: string;
  attempts: number;
  error?: string;
}

export interface DeliveryOptions {
  /** Primary channel to deliver on */
  channel: "google-chat" | "telegram";
  /** Supabase message ID (for updating delivery status) */
  messageId?: string;
  /** Google Chat space name */
  spaceName?: string;
  /** Google Chat thread name */
  threadName?: string | null;
  /** Telegram chat ID for fallback */
  telegramChatId?: string;
  /** Bot instance for Telegram fallback */
  telegramBot?: { api: { sendMessage: (chatId: string, text: string) => Promise<{ message_id: number }> } };
  /** Max retry attempts per channel */
  maxRetries?: number;
  /** Whether to try fallback channel on failure */
  fallback?: boolean;
}

// ============================================================
// RETRY WITH BACKOFF
// ============================================================

const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 2000;

async function retry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  label: string,
): Promise<{ result: T; attempts: number }> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      return { result, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
        console.log(`[delivery] ${label} attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms: ${lastError.message}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}

// ============================================================
// DELIVERY TRACKING
// ============================================================

async function updateDeliveryStatus(
  supabase: SupabaseClient | null,
  messageId: string | undefined,
  delivery: DeliveryResult,
): Promise<void> {
  if (!supabase || !messageId) return;

  try {
    // Get current metadata, merge delivery info
    const { data: existing } = await supabase
      .from("messages")
      .select("metadata")
      .eq("id", messageId)
      .single();

    const metadata = {
      ...(existing?.metadata || {}),
      delivery: {
        status: delivery.status,
        channel: delivery.channel,
        external_id: delivery.externalId,
        thread_name: delivery.threadName,
        attempts: delivery.attempts,
        sent_at: new Date().toISOString(),
        ...(delivery.error ? { error: delivery.error } : {}),
      },
    };

    await supabase
      .from("messages")
      .update({ metadata })
      .eq("id", messageId);
  } catch (err) {
    logger.error("Failed to update delivery status", err);
  }
}

// ============================================================
// CORE DELIVERY FUNCTION
// ============================================================

/**
 * Deliver a message with retry logic, delivery tracking, and optional fallback.
 *
 * Flow:
 * 1. Try primary channel with retries (exponential backoff)
 * 2. If all retries fail and fallback enabled, try alternate channel
 * 3. Update message metadata with delivery result
 * 4. Track as pending response for follow-up awareness
 */
export async function deliverMessage(
  supabase: SupabaseClient | null,
  text: string,
  options: DeliveryOptions,
): Promise<DeliveryResult> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  // Try primary channel
  try {
    if (options.channel === "google-chat") {
      const { result, attempts } = await retry(
        () => sendGoogleChatMessage(options.spaceName!, text, options.threadName),
        maxRetries,
        `gchat→${options.spaceName}`,
      );

      const delivery: DeliveryResult = {
        status: "sent",
        channel: "google-chat",
        externalId: result.externalId,
        threadName: result.threadName || undefined,
        attempts,
      };

      await updateDeliveryStatus(supabase, options.messageId, delivery);
      trackPendingResponse(options.messageId, options.channel);
      return delivery;
    }

    if (options.channel === "telegram") {
      const { result, attempts } = await retry(
        async () => {
          if (!options.telegramBot || !options.telegramChatId) {
            throw new Error("Telegram bot or chat ID not configured");
          }
          return options.telegramBot.api.sendMessage(options.telegramChatId, text);
        },
        maxRetries,
        `telegram→${options.telegramChatId}`,
      );

      const delivery: DeliveryResult = {
        status: "sent",
        channel: "telegram",
        externalId: `telegram:${result.message_id}`,
        attempts,
      };

      await updateDeliveryStatus(supabase, options.messageId, delivery);
      trackPendingResponse(options.messageId, options.channel);
      return delivery;
    }

    throw new Error(`Unknown channel: ${options.channel}`);
  } catch (primaryErr) {
    const errMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    logger.error("Primary channel failed after retries", { channel: options.channel, maxRetries, error: errMsg });

    // Try fallback channel
    if (options.fallback) {
      return attemptFallback(supabase, text, options, errMsg);
    }

    // No fallback — mark as failed
    const delivery: DeliveryResult = {
      status: "failed",
      channel: options.channel,
      attempts: maxRetries,
      error: errMsg,
    };
    await updateDeliveryStatus(supabase, options.messageId, delivery);
    return delivery;
  }
}

async function attemptFallback(
  supabase: SupabaseClient | null,
  text: string,
  options: DeliveryOptions,
  primaryError: string,
): Promise<DeliveryResult> {
  // Determine fallback channel
  const fallbackChannel = options.channel === "google-chat" ? "telegram" : "google-chat";
  console.log(`[delivery] Attempting fallback: ${options.channel} → ${fallbackChannel}`);

  try {
    if (fallbackChannel === "telegram" && options.telegramBot && options.telegramChatId) {
      const prefix = `[Sent via Telegram — Google Chat delivery failed]\n\n`;
      const sent = await options.telegramBot.api.sendMessage(
        options.telegramChatId,
        prefix + text,
      );

      const delivery: DeliveryResult = {
        status: "fallback",
        channel: "telegram",
        externalId: `telegram:${sent.message_id}`,
        attempts: 1,
      };
      await updateDeliveryStatus(supabase, options.messageId, delivery);
      console.log(`[delivery] Fallback successful: delivered via Telegram`);
      return delivery;
    }

    if (fallbackChannel === "google-chat" && options.spaceName) {
      const prefix = `[Sent via Google Chat — Telegram delivery failed]\n\n`;
      const result = await sendGoogleChatMessage(
        options.spaceName,
        prefix + text,
        options.threadName,
      );

      const delivery: DeliveryResult = {
        status: "fallback",
        channel: "google-chat",
        externalId: result.externalId,
        threadName: result.threadName || undefined,
        attempts: 1,
      };
      await updateDeliveryStatus(supabase, options.messageId, delivery);
      console.log(`[delivery] Fallback successful: delivered via Google Chat`);
      return delivery;
    }

    throw new Error(`Fallback channel ${fallbackChannel} not configured`);
  } catch (fallbackErr) {
    const fbErrMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
    logger.error("Fallback also failed", { error: fbErrMsg });

    const delivery: DeliveryResult = {
      status: "failed",
      channel: options.channel,
      attempts: (options.maxRetries ?? DEFAULT_MAX_RETRIES) + 1,
      error: `Primary: ${primaryError}; Fallback: ${fbErrMsg}`,
    };
    await updateDeliveryStatus(supabase, options.messageId, delivery);
    return delivery;
  }
}

// ============================================================
// PENDING RESPONSE TRACKING
// ============================================================

interface PendingResponse {
  messageId: string | undefined;
  channel: string;
  sentAt: number;
  nudged: boolean;
}

const pendingResponses: Map<string, PendingResponse> = new Map();
let nudgeTimer: ReturnType<typeof setInterval> | null = null;

// How long to wait before nudging (5 minutes)
const NUDGE_DELAY_MS = 5 * 60_000;

function trackPendingResponse(messageId: string | undefined, channel: string): void {
  const key = `${channel}:${Date.now()}`;
  pendingResponses.set(key, {
    messageId,
    channel,
    sentAt: Date.now(),
    nudged: false,
  });
}

/**
 * Mark that the user has responded on a channel,
 * clearing all pending responses for that channel.
 */
export function acknowledgeChannel(channel: string): void {
  for (const [key, pending] of pendingResponses) {
    if (pending.channel === channel) {
      pendingResponses.delete(key);
    }
  }
}

/**
 * Get pending responses that haven't been acknowledged after NUDGE_DELAY_MS.
 * Returns them and marks them as nudged so we don't nudge twice.
 */
export function getStaleResponses(): PendingResponse[] {
  const stale: PendingResponse[] = [];
  const now = Date.now();

  for (const [key, pending] of pendingResponses) {
    if (!pending.nudged && now - pending.sentAt > NUDGE_DELAY_MS) {
      pending.nudged = true;
      stale.push(pending);
    }
    // Clean up very old entries (> 1 hour)
    if (now - pending.sentAt > 60 * 60_000) {
      pendingResponses.delete(key);
    }
  }

  return stale;
}

/**
 * Start the nudge checker. Runs every 60s, checks for stale responses,
 * and calls the provided callback with the channel to nudge on.
 */
export function startNudgeChecker(
  onNudge: (channel: string, count: number) => void,
): void {
  if (nudgeTimer) return;
  nudgeTimer = setInterval(() => {
    const stale = getStaleResponses();
    if (stale.length === 0) return;

    // Group by channel
    const byChannel = new Map<string, number>();
    for (const s of stale) {
      byChannel.set(s.channel, (byChannel.get(s.channel) || 0) + 1);
    }

    for (const [channel, count] of byChannel) {
      onNudge(channel, count);
    }
  }, 60_000);
}

export function stopNudgeChecker(): void {
  if (nudgeTimer) {
    clearInterval(nudgeTimer);
    nudgeTimer = null;
  }
}
