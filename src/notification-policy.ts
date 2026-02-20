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
  | "dispatch_confirm"
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
  dispatch_confirm: {
    priority: "normal",
    channels: {
      telegram: { enabled: true, minIntervalSec: 0 },
      "google-chat": { enabled: true, minIntervalSec: 0 },
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
 * Respects channel routing, throttling, and batching rules.
 */
export async function notify(ctx: NotifyContext, options: NotifyOptions): Promise<void> {
  const { event, workItemId, telegramMessage, gchatMessage } = options;
  const policy = NOTIFICATION_POLICY[event];
  if (!policy) return;

  const sends: Promise<void>[] = [];

  // Telegram
  if (policy.channels.telegram.enabled) {
    if (!isThrottled(event, "telegram", workItemId)) {
      markSent(event, "telegram", workItemId);
      sends.push(
        ctx.bot.api.sendMessage(ctx.telegramUserId, telegramMessage, { parse_mode: "Markdown" })
          .then(() => { console.log(`[notify] telegram/${event}/${workItemId}: sent`); })
          .catch((err) => { console.error(`[notify] telegram/${event}/${workItemId}: failed:`, err.message); }),
      );
    } else {
      // Schedule a batched send when the throttle window expires
      scheduleBatchedSend(ctx, event, "telegram", workItemId, telegramMessage);
    }
  }

  // Google Chat
  if (policy.channels["google-chat"].enabled && ctx.gchatSpaceName) {
    const msg = gchatMessage || telegramMessage;
    if (!isThrottled(event, "google-chat", workItemId)) {
      markSent(event, "google-chat", workItemId);
      sends.push(
        sendGoogleChatMessage(ctx.gchatSpaceName, msg)
          .then(() => { console.log(`[notify] gchat/${event}/${workItemId}: sent`); })
          .catch((err) => { console.error(`[notify] gchat/${event}/${workItemId}: failed:`, err.message); }),
      );
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
    } catch (err: any) {
      console.error(`[notify] ${channel}/${event}/${workItemId}: batched send failed:`, err.message);
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
