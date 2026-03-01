/**
 * Notification Cadence Policy (ELLIE-80)
 *
 * Defines per-event, per-channel notification rules:
 * - Which channels each event type routes to
 * - Minimum interval between updates (batching)
 * - Priority levels for escalation
 *
 * Channel routing philosophy:
 * - Telegram: summaries + critical alerts (phone-friendly, brief)
 * - Google Chat: full detail, threaded by work item (desktop, verbose)
 * - Voice/Alexa: on-demand only (never unsolicited)
 */

import { sendGoogleChatMessage } from "./google-chat.ts";
import type { Bot } from "grammy";
import { log } from "./logger.ts";

const logger = log.child("notify");

// ============================================================
// TYPES
// ============================================================

export type NotificationChannel = "telegram" | "google-chat";
export type NotificationPriority = "critical" | "high" | "normal" | "low";

export type NotificationEvent =
  | "session_start"
  | "session_update"
  | "session_decision"
  | "session_complete"
  | "session_pause"
  | "session_resume"
  | "incident_raised"
  | "incident_update"
  | "incident_resolved"
  | "memory_contradiction"
  | "dispatch_confirm"
  | "run_stale"
  | "run_failed"
  | "error"
  | "rollup"
  | "weekly_review";

interface ChannelPolicy {
  enabled: boolean;
  /** Minimum seconds between notifications of this type per work item. 0 = no throttle. */
  minIntervalSec: number;
}

interface EventPolicy {
  priority: NotificationPriority;
  channels: Record<NotificationChannel, ChannelPolicy>;
}

// ============================================================
// POLICY CONFIG
// ============================================================

export const NOTIFICATION_POLICY: Record<NotificationEvent, EventPolicy> = {
  session_start: {
    priority: "high",
    channels: {
      telegram: { enabled: true, minIntervalSec: 0 },
      "google-chat": { enabled: true, minIntervalSec: 0 },
    },
  },
  session_update: {
    priority: "normal",
    channels: {
      telegram: { enabled: false, minIntervalSec: 0 }, // too noisy for phone
      "google-chat": { enabled: true, minIntervalSec: 60 },
    },
  },
  session_decision: {
    priority: "high",
    channels: {
      telegram: { enabled: true, minIntervalSec: 0 }, // decisions always go through
      "google-chat": { enabled: true, minIntervalSec: 0 },
    },
  },
  session_complete: {
    priority: "high",
    channels: {
      telegram: { enabled: true, minIntervalSec: 0 },
      "google-chat": { enabled: true, minIntervalSec: 0 },
    },
  },
  session_pause: {
    priority: "normal",
    channels: {
      telegram: { enabled: true, minIntervalSec: 0 },
      "google-chat": { enabled: true, minIntervalSec: 0 },
    },
  },
  session_resume: {
    priority: "normal",
    channels: {
      telegram: { enabled: true, minIntervalSec: 0 },
      "google-chat": { enabled: true, minIntervalSec: 0 },
    },
  },
  incident_raised: {
    priority: "critical",
    channels: {
      telegram: { enabled: true, minIntervalSec: 0 }, // always alert on incidents
      "google-chat": { enabled: true, minIntervalSec: 0 },
    },
  },
  incident_update: {
    priority: "normal",
    channels: {
      telegram: { enabled: false, minIntervalSec: 0 }, // silent on intermediate updates
      "google-chat": { enabled: true, minIntervalSec: 30 },
    },
  },
  incident_resolved: {
    priority: "high",
    channels: {
      telegram: { enabled: true, minIntervalSec: 0 }, // always alert on resolution
      "google-chat": { enabled: true, minIntervalSec: 0 },
    },
  },
  memory_contradiction: {
    priority: "normal",
    channels: {
      telegram: { enabled: true, minIntervalSec: 300 }, // max 1 per 5 min per memory
      "google-chat": { enabled: true, minIntervalSec: 60 },
    },
  },
  dispatch_confirm: {
    priority: "normal",
    channels: {
      telegram: { enabled: true, minIntervalSec: 0 },
      "google-chat": { enabled: true, minIntervalSec: 0 },
    },
  },
  // ELLIE-387: Proactive status alerts for orchestration lifecycle
  run_stale: {
    priority: "high",
    channels: {
      telegram: { enabled: true, minIntervalSec: 120 }, // max 1 per 2 min per run
      "google-chat": { enabled: true, minIntervalSec: 60 },
    },
  },
  // ELLIE-397: Added throttle for parity with run_stale
  run_failed: {
    priority: "critical",
    channels: {
      telegram: { enabled: true, minIntervalSec: 30 },
      "google-chat": { enabled: true, minIntervalSec: 30 },
    },
  },
  error: {
    priority: "critical",
    channels: {
      telegram: { enabled: true, minIntervalSec: 0 },
      "google-chat": { enabled: true, minIntervalSec: 0 },
    },
  },
  rollup: {
    priority: "low",
    channels: {
      telegram: { enabled: true, minIntervalSec: 0 }, // summary only
      "google-chat": { enabled: true, minIntervalSec: 0 }, // full detail
    },
  },
  weekly_review: {
    priority: "low",
    channels: {
      telegram: { enabled: true, minIntervalSec: 0 },
      "google-chat": { enabled: true, minIntervalSec: 0 },
    },
  },
};

// ============================================================
// THROTTLE STATE
// ============================================================

/** key = `${event}:${workItemId}:${channel}`, value = last send timestamp */
const lastSent = new Map<string, number>();

/** Pending batched messages: key = throttle key, value = latest message */
const pendingBatch = new Map<string, { message: string; timer: ReturnType<typeof setTimeout> }>();

function throttleKey(event: NotificationEvent, channel: NotificationChannel, workItemId: string): string {
  return `${event}:${workItemId}:${channel}`;
}

/**
 * Check if a notification should be sent now based on throttle rules.
 * Returns true if allowed, false if throttled.
 */
function isThrottled(event: NotificationEvent, channel: NotificationChannel, workItemId: string): boolean {
  const policy = NOTIFICATION_POLICY[event]?.channels[channel];
  if (!policy?.enabled || policy.minIntervalSec === 0) return false;

  const key = throttleKey(event, channel, workItemId);
  const last = lastSent.get(key);
  if (!last) return false;

  const elapsed = (Date.now() - last) / 1000;
  return elapsed < policy.minIntervalSec;
}

function markSent(event: NotificationEvent, channel: NotificationChannel, workItemId: string): void {
  const key = throttleKey(event, channel, workItemId);
  lastSent.set(key, Date.now());

  // Clean up old entries (older than 10 minutes)
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of lastSent) {
    if (v < cutoff) lastSent.delete(k);
  }
}

// ============================================================
// ELLIE-397: FAILURE COALESCING
// ============================================================

/** Events eligible for coalescing — multiple within window → single summary. */
const COALESCABLE_EVENTS: Set<NotificationEvent> = new Set(["run_stale", "run_failed", "error"]);
const COALESCE_WINDOW_MS = 30_000; // 30s window
const COALESCE_IMMEDIATE_MS = 2_000; // send immediately if only 1 after 2s

interface CoalesceEntry {
  workItemId: string;
  telegramMessage: string;
  gchatMessage?: string;
  event: NotificationEvent;
}

interface CoalesceBuffer {
  entries: CoalesceEntry[];
  timer: ReturnType<typeof setTimeout>;
  ctx: NotifyContext;
  channel: NotificationChannel;
  startedAt: number;
}

/** Per-channel coalescing buffers. Key = channel name. */
const coalesceBuffers = new Map<NotificationChannel, CoalesceBuffer>();

/**
 * Try to coalesce a failure notification. Returns true if coalesced
 * (caller should skip normal send), false if not coalescable.
 */
function tryCoalesce(ctx: NotifyContext, options: NotifyOptions): boolean {
  if (!COALESCABLE_EVENTS.has(options.event)) return false;

  const channels: NotificationChannel[] = [];
  const policy = NOTIFICATION_POLICY[options.event];
  if (policy.channels.telegram.enabled) channels.push("telegram");
  if (policy.channels["google-chat"].enabled && ctx.gchatSpaceName) channels.push("google-chat");

  for (const channel of channels) {
    const existing = coalesceBuffers.get(channel);
    const entry: CoalesceEntry = {
      workItemId: options.workItemId,
      telegramMessage: options.telegramMessage,
      gchatMessage: options.gchatMessage,
      event: options.event,
    };

    if (existing) {
      // Add to existing buffer
      existing.entries.push(entry);
      // Reset timer — extend window from original start but cap at COALESCE_WINDOW_MS
      clearTimeout(existing.timer);
      const elapsed = Date.now() - existing.startedAt;
      const remaining = Math.max(0, COALESCE_WINDOW_MS - elapsed);
      existing.timer = setTimeout(() => flushCoalesceBuffer(channel), remaining);
    } else {
      // Start new buffer — wait a short time to see if more arrive
      const buf: CoalesceBuffer = {
        entries: [entry],
        timer: setTimeout(() => flushCoalesceBuffer(channel), COALESCE_IMMEDIATE_MS),
        ctx,
        channel,
        startedAt: Date.now(),
      };
      coalesceBuffers.set(channel, buf);
    }
  }

  return channels.length > 0;
}

/** Flush a coalesce buffer — send individual or summary message. */
async function flushCoalesceBuffer(channel: NotificationChannel): Promise<void> {
  const buf = coalesceBuffers.get(channel);
  if (!buf || buf.entries.length === 0) {
    coalesceBuffers.delete(channel);
    return;
  }
  coalesceBuffers.delete(channel);

  const { ctx, entries } = buf;

  if (entries.length === 1) {
    // Single event — send as-is (no coalescing overhead)
    const e = entries[0];
    await sendDirect(ctx, e.event, channel, e.workItemId,
      channel === "telegram" ? e.telegramMessage : (e.gchatMessage || e.telegramMessage));
    return;
  }

  // Multiple events — build coalesced summary
  const byEvent = new Map<NotificationEvent, CoalesceEntry[]>();
  for (const e of entries) {
    let list = byEvent.get(e.event);
    if (!list) { list = []; byEvent.set(e.event, list); }
    list.push(e);
  }

  const lines: string[] = [];
  for (const [event, items] of byEvent) {
    const label = event === "run_failed" ? "failed" : event === "run_stale" ? "stalled" : "errored";
    const itemList = items.map(i => i.workItemId).join(", ");
    lines.push(`${items.length} ${label}: ${itemList}`);
  }

  const telegramSummary = `${entries.length} alerts in ${Math.round((Date.now() - buf.startedAt) / 1000)}s:\n${lines.join("\n")}`;
  const gchatSummary = `${entries.length} alerts coalesced:\n${lines.join("\n")}`;

  await sendDirect(ctx, "error", channel, "coalesced",
    channel === "telegram" ? telegramSummary : gchatSummary);

  console.log(`[notify] ${channel}/coalesced: ${entries.length} alerts combined`);
}

/** Low-level send to a specific channel (bypasses coalescing/throttle). */
async function sendDirect(
  ctx: NotifyContext,
  event: NotificationEvent,
  channel: NotificationChannel,
  workItemId: string,
  message: string,
): Promise<void> {
  markSent(event, channel, workItemId);
  try {
    if (channel === "telegram") {
      await ctx.bot.api.sendMessage(ctx.telegramUserId, message, { parse_mode: "Markdown" });
    } else if (channel === "google-chat" && ctx.gchatSpaceName) {
      await sendGoogleChatMessage(ctx.gchatSpaceName, message);
    }
    console.log(`[notify] ${channel}/${event}/${workItemId}: sent`);
  } catch (err: unknown) {
    logger.error(`${channel} send failed`, { channel, event, work_item_id: workItemId }, err);
  }
}

// ============================================================
// NOTIFICATION DISPATCH
// ============================================================

export interface NotifyContext {
  bot: Bot;
  telegramUserId: string;
  gchatSpaceName?: string;
}

export interface NotifyOptions {
  event: NotificationEvent;
  workItemId: string;
  /** Message for Telegram (brief, markdown-escaped) */
  telegramMessage: string;
  /** Message for Google Chat (detailed, plain text). Falls back to telegramMessage if not provided. */
  gchatMessage?: string;
}

/**
 * Send a notification through the policy engine.
 * Respects channel routing, throttling, batching, and coalescing rules.
 */
export async function notify(ctx: NotifyContext, options: NotifyOptions): Promise<void> {
  const { event, workItemId, telegramMessage, gchatMessage } = options;
  const policy = NOTIFICATION_POLICY[event];
  if (!policy) return;

  // ELLIE-397: Try coalescing for failure events
  if (tryCoalesce(ctx, options)) return;

  const sends: Promise<void>[] = [];

  // Telegram
  if (policy.channels.telegram.enabled) {
    if (!isThrottled(event, "telegram", workItemId)) {
      sends.push(sendDirect(ctx, event, "telegram", workItemId, telegramMessage));
    } else {
      scheduleBatchedSend(ctx, event, "telegram", workItemId, telegramMessage);
    }
  }

  // Google Chat
  if (policy.channels["google-chat"].enabled && ctx.gchatSpaceName) {
    const msg = gchatMessage || telegramMessage;
    if (!isThrottled(event, "google-chat", workItemId)) {
      sends.push(sendDirect(ctx, event, "google-chat", workItemId, msg));
    } else {
      scheduleBatchedSend(ctx, event, "google-chat", workItemId, msg);
    }
  }

  await Promise.allSettled(sends);
}

/**
 * Schedule a batched send — replaces any pending message with the latest one,
 * and fires when the throttle window expires.
 */
function scheduleBatchedSend(
  ctx: NotifyContext,
  event: NotificationEvent,
  channel: NotificationChannel,
  workItemId: string,
  message: string,
): void {
  const key = throttleKey(event, channel, workItemId);
  const policy = NOTIFICATION_POLICY[event].channels[channel];

  // Cancel existing timer if we're replacing the message
  const existing = pendingBatch.get(key);
  if (existing) {
    clearTimeout(existing.timer);
  }

  // Calculate delay until throttle window expires
  const last = lastSent.get(key) || 0;
  const elapsed = (Date.now() - last) / 1000;
  const delaySec = Math.max(0, policy.minIntervalSec - elapsed);

  const timer = setTimeout(async () => {
    pendingBatch.delete(key);
    markSent(event, channel, workItemId);

    try {
      if (channel === "telegram") {
        await ctx.bot.api.sendMessage(ctx.telegramUserId, message, { parse_mode: "Markdown" });
      } else if (channel === "google-chat" && ctx.gchatSpaceName) {
        await sendGoogleChatMessage(ctx.gchatSpaceName, message);
      }
      console.log(`[notify] ${channel}/${event}/${workItemId}: batched send`);
    } catch (err: unknown) {
      logger.error("Batched send failed", { channel, event, work_item_id: workItemId }, err);
    }
  }, delaySec * 1000);

  pendingBatch.set(key, { message, timer });
}

/**
 * Get enabled channels for an event type.
 * Useful for checking routing without sending.
 */
export function getEnabledChannels(event: NotificationEvent): NotificationChannel[] {
  const policy = NOTIFICATION_POLICY[event];
  if (!policy) return [];
  return (Object.entries(policy.channels) as [NotificationChannel, ChannelPolicy][])
    .filter(([, p]) => p.enabled)
    .map(([ch]) => ch);
}

/**
 * Reset throttle state — for testing only.
 */
export function resetThrottleState(): void {
  lastSent.clear();
  for (const { timer } of pendingBatch.values()) clearTimeout(timer);
  pendingBatch.clear();
  for (const { timer } of coalesceBuffers.values()) clearTimeout(timer);
  coalesceBuffers.clear();
}
