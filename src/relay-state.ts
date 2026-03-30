/**
 * Relay shared state — maps, client sets, and broadcast helpers.
 *
 * Extracted from relay.ts — ELLIE-184 Phase 0.
 * All mutable shared state lives here so extracted modules can import it directly.
 */

import type { Bot } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import { WebSocket } from "ws";
import { ALLOWED_USER_ID, GCHAT_SPACE_NOTIFY } from "./relay-config.ts";
import { log } from "./logger.ts";

const logger = log.child("relay-state");
import type { NotifyContext } from "./notification-policy.ts";
import { getSlackSendFn } from "./channels/slack/index.ts";

// ── Dependency injection ───────────────────────────────────

export interface RelayDeps {
  bot: Bot;
  anthropic: Anthropic | null;
  supabase: SupabaseClient | null;
}

let _deps: RelayDeps | null = null;

export function setRelayDeps(deps: RelayDeps): void {
  _deps = deps;
}

export function getRelayDeps(): RelayDeps {
  if (!_deps) throw new Error("Relay deps not initialized — call setRelayDeps() first");
  return _deps;
}

// ── Active agent per channel ───────────────────────────────

export const activeAgentByChannel = new Map<string, string>();

export function getActiveAgent(channel = "telegram"): string {
  return activeAgentByChannel.get(channel) ?? "general";
}

export function setActiveAgent(channel: string, agentName: string): void {
  activeAgentByChannel.set(channel, agentName);
}

// ── WebSocket client sets ──────────────────────────────────

export const extensionClients = new Set<WebSocket>();
export const ellieChatClients = new Set<WebSocket>();

// ── App user tracking (phone app connections — ELLIE-176, ELLIE-196) ──

export interface WsAppUser {
  id: string;
  name: string | null;
  email: string | null;
  onboarding_state: string;
  anonymous_id: string | null;
  token?: string;
}

export const wsAppUserMap = new WeakMap<WebSocket, WsAppUser>();

// Per-user phone mode history (ELLIE-197) — keyed by user id or anonymous_id
export const ellieChatPhoneHistories = new Map<string, Array<{ role: string; content: string }>>();

// ELLIE-489: TTL tracker for phone histories — updated when a history is
// created or accessed. Entries unused for 24h are removed by sweepPhoneHistories().
const _phoneHistoryLastUsed = new Map<string, number>();

/** Mark a phone history key as recently used. Call on history create or access. */
export function touchPhoneHistory(key: string): void {
  _phoneHistoryLastUsed.set(key, Date.now());
}

/**
 * Remove phone histories that haven't been used within the TTL window.
 * Called periodically by the relay's housekeeping task (ELLIE-489).
 */
export function sweepPhoneHistories(ttlMs: number = 24 * 60 * 60_000): number {
  const cutoff = Date.now() - ttlMs;
  let removed = 0;
  for (const [key, lastUsed] of _phoneHistoryLastUsed) {
    if (lastUsed < cutoff) {
      ellieChatPhoneHistories.delete(key);
      _phoneHistoryLastUsed.delete(key);
      removed++;
    }
  }
  if (removed > 0) {
    logger.info(`Swept ${removed} stale phone history entries (TTL: ${ttlMs / 3_600_000}h)`);
  }
  return removed;
}

// ── Broadcast helpers ──────────────────────────────────────

/** Fire-and-forget broadcast to all connected extension clients. */
export function broadcastExtension(event: Record<string, unknown>): void {
  if (extensionClients.size === 0) return;
  const payload = JSON.stringify({ ...event, ts: Date.now() });
  logger.info(`Broadcasting ${event.type} to ${extensionClients.size} client(s)`);
  for (const ws of extensionClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    } else {
      logger.warn(`Client readyState=${ws.readyState}, skipping`);
    }
  }
}

/** Broadcast a JSON message to all connected ellie-chat clients (ELLIE-199). */
export function broadcastToEllieChatClients(event: Record<string, unknown>): void {
  if (ellieChatClients.size === 0) return;
  const payload = JSON.stringify(event);
  for (const ws of ellieChatClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

/** Broadcast a dispatch state-change event to all ellie-chat clients (ELLIE-1153). */
export function broadcastDispatchEvent(event: Record<string, unknown>): void {
  broadcastToEllieChatClients({ ...event, _dispatch: true });
}

// ── Notification context ───────────────────────────────────

export function getNotifyCtx(): NotifyContext {
  const { bot } = getRelayDeps();
  // ELLIE-443: Include Slack send function if SLACK_BOT_TOKEN + SLACK_NOTIFICATION_CHANNEL are set
  const slackSend = getSlackSendFn() ?? undefined;
  return { bot, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, slackSend };
}
