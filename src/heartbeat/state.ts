/**
 * Heartbeat State Manager — ELLIE-1164
 * Reads/writes heartbeat_state singleton. Atomic tick guard.
 */

import { log } from "../logger.ts";
import { getRelayDeps } from "../relay-state.ts";
import type { HeartbeatState, HeartbeatSnapshot, TickRecord, HeartbeatSource } from "./types.ts";

const logger = log.child("heartbeat-state");

// ── Pure helpers ──────────────────────────────────────────────

/**
 * Check if the current time (in America/Chicago / CST) falls within [start, end).
 * @param start - "HH:MM" 24-hour string
 * @param end   - "HH:MM" 24-hour string
 * @param now   - Optional Date override (defaults to current time)
 */
export function isInActiveHours(start: string, end: string, now: Date = new Date()): boolean {
  const [startH, startM] = start.split(":").map(Number);
  const [endH, endM] = end.split(":").map(Number);
  const cst = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const currentMinutes = cst.getHours() * 60 + cst.getMinutes();
  const startMinutes = startH * 60 + (startM || 0);
  const endMinutes = endH * 60 + (endM || 0);
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

/**
 * Check if a source is still within its cooldown window.
 * @param source         - Source name to look up in cooldowns map
 * @param cooldowns      - Map of source → last Phase 2 ISO timestamp
 * @param minIntervalMs  - Cooldown duration in milliseconds
 */
export function isSourceOnCooldown(
  source: string,
  cooldowns: Record<string, string>,
  minIntervalMs: number,
): boolean {
  const lastPhase2 = cooldowns[source];
  if (!lastPhase2) return false;
  return Date.now() - new Date(lastPhase2).getTime() < minIntervalMs;
}

// ── Supabase CRUD ─────────────────────────────────────────────

/**
 * Read the heartbeat_state singleton row.
 */
export async function getHeartbeatState(): Promise<HeartbeatState | null> {
  const { supabase } = getRelayDeps();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("heartbeat_state")
    .select("*")
    .eq("id", "singleton")
    .single();
  if (error) {
    logger.warn("getHeartbeatState failed", { error: error.message });
    return null;
  }
  return data as HeartbeatState | null;
}

/**
 * Atomic check-and-set tick guard.
 * Only succeeds if last_tick_at IS NULL or < beforeTimestamp.
 * Returns the updated row, or null if another tick already claimed this slot.
 */
export async function atomicClaimTick(beforeTimestamp: string): Promise<HeartbeatState | null> {
  const { supabase } = getRelayDeps();
  if (!supabase) return null;
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("heartbeat_state")
    .update({ last_tick_at: now, updated_at: now })
    .eq("id", "singleton")
    .or(`last_tick_at.is.null,last_tick_at.lt.${beforeTimestamp}`)
    .select("*")
    .single();
  if (error || !data) {
    logger.debug("atomicClaimTick: no row claimed (race or error)", { error: error?.message });
    return null;
  }
  return data as HeartbeatState;
}

/**
 * Persist the latest source snapshot to heartbeat_state.
 */
export async function saveSnapshot(snapshot: HeartbeatSnapshot): Promise<void> {
  const { supabase } = getRelayDeps();
  if (!supabase) return;
  const { error } = await supabase
    .from("heartbeat_state")
    .update({ last_snapshot: snapshot, updated_at: new Date().toISOString() })
    .eq("id", "singleton");
  if (error) logger.warn("saveSnapshot failed", { error: error.message });
}

/**
 * Update per-source cooldown timestamp and last_phase2_at after a Phase 2 run.
 */
export async function updateCooldown(
  source: HeartbeatSource,
  cooldowns: Record<string, string>,
): Promise<void> {
  const { supabase } = getRelayDeps();
  if (!supabase) return;
  const now = new Date().toISOString();
  const updated = { ...cooldowns, [source]: now };
  const { error } = await supabase
    .from("heartbeat_state")
    .update({ source_cooldowns: updated, last_phase2_at: now, updated_at: now })
    .eq("id", "singleton");
  if (error) logger.warn("updateCooldown failed", { source, error: error.message });
}

/**
 * Append a tick record to the heartbeat_ticks log.
 */
export async function logTick(record: TickRecord): Promise<void> {
  const { supabase } = getRelayDeps();
  if (!supabase) return;
  const { error } = await supabase.from("heartbeat_ticks").insert({
    phase_reached: record.phase_reached,
    deltas: record.deltas,
    actions_taken: record.actions_taken ?? null,
    cost_usd: record.cost_usd,
    duration_ms: record.duration_ms,
    foundation: record.foundation,
    skipped_reason: record.skipped_reason ?? null,
  });
  if (error) logger.warn("logTick failed", { error: error.message });
}

/**
 * Count today's Phase 2 ticks for daily cap enforcement.
 */
export async function getTodayPhase2Count(): Promise<number> {
  const { supabase } = getRelayDeps();
  if (!supabase) return 0;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const { count } = await supabase
    .from("heartbeat_ticks")
    .select("*", { count: "exact", head: true })
    .eq("phase_reached", 2)
    .gte("tick_at", todayStart.toISOString());
  return count ?? 0;
}

/**
 * Partial update of heartbeat_state config fields (enabled, interval_ms, active_start, etc.).
 */
export async function updateConfig(updates: Partial<HeartbeatState>): Promise<void> {
  const { supabase } = getRelayDeps();
  if (!supabase) return;
  const { error } = await supabase
    .from("heartbeat_state")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", "singleton");
  if (error) logger.warn("updateConfig failed", { error: error.message });
}
