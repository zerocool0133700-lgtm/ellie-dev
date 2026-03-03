/**
 * Discord Thread Binding System — ELLIE-472
 *
 * Persists subagent→thread associations in Supabase so they survive relay restarts.
 * Fixes OpenClaw's key weakness: their bindings are in-memory only.
 *
 * Lifecycle:
 *   1. Specialist spawns from a Discord message
 *   2. bindThread() — create Discord thread, store binding in DB
 *   3. Specialist posts updates → sendViaWebhook() targets the bound thread
 *   4. Specialist ends → unbindThread() clears the binding
 *   5. periodicTask cleanExpiredBindings() runs hourly to prune TTL-expired rows
 */

import { log } from "../../logger.ts";

const logger = log.child("discord-bindings");

const BINDING_TTL_MS = 24 * 60 * 60_000; // 24h — matches conversation history window

export interface ThreadBinding {
  sessionKey: string;
  threadId: string;
  channelId: string;
  guildId: string;
  webhookId: string;
  webhookToken: string;
  agentLabel: string;
  createdAt: number;
  expiresAt: number;
}

let _supabase: any = null;

export function initThreadBindings(supabase: any): void {
  _supabase = supabase;
}

// ── CRUD ──────────────────────────────────────────────────────

export async function bindThread(
  sessionKey: string,
  threadId: string,
  channelId: string,
  guildId: string,
  webhookId: string,
  webhookToken: string,
  agentLabel: string,
): Promise<void> {
  if (!_supabase) return;
  const now = Date.now();
  const { error } = await _supabase.from("discord_thread_bindings").upsert({
    session_key: sessionKey,
    thread_id: threadId,
    channel_id: channelId,
    guild_id: guildId,
    webhook_id: webhookId,
    webhook_token: webhookToken,
    agent_label: agentLabel,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + BINDING_TTL_MS).toISOString(),
  }, { onConflict: "session_key" });

  if (error) {
    logger.error("bindThread failed", { sessionKey, threadId, error: error.message });
  } else {
    logger.info("Thread bound", { sessionKey, threadId, agentLabel });
  }
}

export async function getBinding(sessionKey: string): Promise<ThreadBinding | null> {
  if (!_supabase) return null;
  const { data, error } = await _supabase
    .from("discord_thread_bindings")
    .select("*")
    .eq("session_key", sessionKey)
    .gt("expires_at", new Date().toISOString())
    .single();

  if (error || !data) return null;
  return {
    sessionKey: data.session_key,
    threadId: data.thread_id,
    channelId: data.channel_id,
    guildId: data.guild_id,
    webhookId: data.webhook_id,
    webhookToken: data.webhook_token,
    agentLabel: data.agent_label,
    createdAt: new Date(data.created_at).getTime(),
    expiresAt: new Date(data.expires_at).getTime(),
  };
}

export async function unbindThread(sessionKey: string): Promise<void> {
  if (!_supabase) return;
  const { error } = await _supabase
    .from("discord_thread_bindings")
    .delete()
    .eq("session_key", sessionKey);

  if (error) {
    logger.warn("unbindThread failed", { sessionKey, error: error.message });
  } else {
    logger.info("Thread unbound", { sessionKey });
  }
}

/** Prune expired bindings. Called hourly by periodicTask in relay.ts. */
export async function cleanExpiredBindings(): Promise<void> {
  if (!_supabase) return;
  const { error, count } = await _supabase
    .from("discord_thread_bindings")
    .delete({ count: "exact" })
    .lt("expires_at", new Date().toISOString());

  if (error) {
    logger.warn("cleanExpiredBindings failed", { error: error.message });
  } else if (count && count > 0) {
    logger.info("Expired thread bindings cleaned", { count });
  }
}
