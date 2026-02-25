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
import type { NotifyContext } from "./notification-policy.ts";

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

// ── Broadcast helpers ──────────────────────────────────────

/** Fire-and-forget broadcast to all connected extension clients. */
export function broadcastExtension(event: Record<string, any>): void {
  if (extensionClients.size === 0) return;
  const payload = JSON.stringify({ ...event, ts: Date.now() });
  console.log(`[extension] Broadcasting ${event.type} to ${extensionClients.size} client(s)`);
  for (const ws of extensionClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    } else {
      console.log(`[extension] Client readyState=${ws.readyState}, skipping`);
    }
  }
}

/** Broadcast a JSON message to all connected ellie-chat clients (ELLIE-199). */
export function broadcastToEllieChatClients(event: Record<string, any>): void {
  if (ellieChatClients.size === 0) return;
  const payload = JSON.stringify(event);
  for (const ws of ellieChatClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

// ── Notification context ───────────────────────────────────

export function getNotifyCtx(): NotifyContext {
  const { bot } = getRelayDeps();
  return { bot, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY };
}
