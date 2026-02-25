/**
 * Relay idle detection — conversation end timers and consolidation.
 *
 * Extracted from relay.ts — ELLIE-184 Phase 1 (partial), expanded in Phase 2.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { clearContextCache } from "./relay-config.ts";
import { getRelayDeps } from "./relay-state.ts";
import { closeActiveConversation, closeConversation } from "./conversations.ts";
import { consolidateNow } from "./consolidate-inline.ts";
import { getPlanningMode } from "./prompt-builder.ts";

// ── Idle timing constants ──────────────────────────────────

const IDLE_MS_DEFAULT = 10 * 60_000;     // 10 minutes of silence = conversation over
const IDLE_MS_PLANNING = 60 * 60_000;   // 60 minutes in planning mode

export function getIdleMs(): number {
  return getPlanningMode() ? IDLE_MS_PLANNING : IDLE_MS_DEFAULT;
}

// ── Idle timers ────────────────────────────────────────────

let telegramIdleTimer: ReturnType<typeof setTimeout> | null = null;
let gchatIdleTimer: ReturnType<typeof setTimeout> | null = null;
let ellieChatIdleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Close the active conversation for a channel, extract memories,
 * then invalidate the context cache so the next interaction gets fresh data.
 * Falls back to legacy consolidation if conversation tracking isn't active.
 */
export async function triggerConsolidation(channel?: string): Promise<void> {
  const { supabase } = getRelayDeps();
  if (!supabase) return;
  try {
    if (channel) {
      const closed = await closeActiveConversation(supabase, channel);
      if (closed) {
        clearContextCache();
        console.log(`[conversation] Conversation closed (${channel}) — context cache cleared`);
        return;
      }
    }

    const created = await consolidateNow(supabase, {
      channel,
      onComplete: () => {
        clearContextCache();
      },
    });
    if (created) {
      console.log(`[consolidate] Conversation ended (${channel || "all"}) — context cache cleared`);
    }
  } catch (err) {
    console.error("[consolidate] Consolidation error:", err);
  }
}

/**
 * Reset the Telegram idle timer. Called after every Telegram message.
 * When the timer fires, it means no messages for 10 minutes = conversation over.
 */
export function resetTelegramIdleTimer(): void {
  if (telegramIdleTimer) clearTimeout(telegramIdleTimer);
  const ms = getIdleMs();
  telegramIdleTimer = setTimeout(() => {
    console.log(`[consolidate] Telegram idle for ${ms / 60_000} minutes — consolidating...`);
    triggerConsolidation("telegram");
  }, ms);
}

export function resetGchatIdleTimer(): void {
  if (gchatIdleTimer) clearTimeout(gchatIdleTimer);
  const ms = getIdleMs();
  gchatIdleTimer = setTimeout(() => {
    console.log(`[consolidate] Google Chat idle for ${ms / 60_000} minutes — consolidating...`);
    triggerConsolidation("google-chat");
  }, ms);
}

export function resetEllieChatIdleTimer(): void {
  if (ellieChatIdleTimer) clearTimeout(ellieChatIdleTimer);
  const ms = getIdleMs();
  ellieChatIdleTimer = setTimeout(() => {
    console.log(`[consolidate] Ellie Chat idle for ${ms / 60_000} minutes — consolidating...`);
    triggerConsolidation("ellie-chat");
  }, ms);
}
