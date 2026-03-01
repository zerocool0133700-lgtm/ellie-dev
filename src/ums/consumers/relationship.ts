/**
 * UMS Consumer: Relationship Tracker
 *
 * ELLIE-310: Pull consumer — analyzes contact interaction patterns
 * ELLIE-320: DB-backed push consumer — real-time profile updates, health scoring,
 *            interaction logging, follow-up detection
 *
 * Listens to: all messages from all providers
 * Action: maintains DB-backed contact profiles with health scoring
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UnifiedMessage } from "../types.ts";
import { subscribe } from "../events.ts";
import { queryMessages } from "../events.ts";
import { log } from "../../logger.ts";

const logger = log.child("ums-consumer-relationship");

// ── Types ────────────────────────────────────────────────────

export interface RelationshipProfile {
  id: string;
  identifier: string;
  display_name: string | null;
  emails: string[];
  usernames: string[];
  names: string[];
  provider_ids: Record<string, string>;
  channels: string[];
  importance: number;
  tags: string[];
  notes: string | null;
  suppressed: boolean;
  health_score: number;
  health_status: string;
  recency_score: number;
  frequency_score: number;
  consistency_score: number;
  quality_score: number;
  message_count: number;
  last_interaction_at: string | null;
  first_interaction_at: string | null;
  avg_gap_hours: number | null;
  typical_gap_hours: number | null;
  needs_follow_up: boolean;
  follow_up_reason: string | null;
  follow_up_since: string | null;
  person_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContactStats {
  identifier: string;
  display_name: string | null;
  message_count: number;
  last_contact: string;
  first_contact: string;
  channels: string[];
  avg_messages_per_day: number;
  days_since_last_contact: number;
}

export interface RelationshipReport {
  generated_at: string;
  period_days: number;
  contacts: ContactStats[];
  total_unique_contacts: number;
  most_active: ContactStats | null;
  dormant: ContactStats[];
}

// ── State ────────────────────────────────────────────────────

let supabaseRef: SupabaseClient | null = null;

/** In-memory cache of active profiles. */
const profileCache = new Map<string, RelationshipProfile>();

/** Configurable preferences. */
let prefs = {
  dormantThresholdDays: 90,
  decliningThresholdDays: 30,
  vipNeglectDays: 30,
  silenceMultiplier: 2,
  autoSuppressPatterns: ["noreply", "no-reply", "notification", "mailer-daemon", "bounce"],
  healthWeights: { recency: 0.3, frequency: 0.3, consistency: 0.2, quality: 0.2 },
};

// ── Initialization ───────────────────────────────────────────

export function initRelationshipConsumer(supabase: SupabaseClient): void {
  supabaseRef = supabase;

  loadPreferences().catch(err => logger.error("Preferences load failed", err));
  refreshCache().catch(err => logger.error("Initial cache load failed", err));

  subscribe("consumer:relationship", {}, async (message) => {
    try {
      await handleMessage(message);
    } catch (err) {
      logger.error("Relationship consumer failed", { messageId: message.id, err });
    }
  });

  // Periodic cache refresh
  setInterval(() => {
    refreshCache().catch(err => logger.error("Cache refresh failed", err));
  }, 60_000);

  // Gap hours computation + health scoring recalculation (every 30 min)
  setInterval(() => {
    computeGapHours()
      .then(() => recalculateAllHealth())
      .catch(err => logger.error("Health recalc failed", err));
  }, 30 * 60_000);

  // Follow-up detection (every 15 min)
  setInterval(() => {
    detectFollowUps().catch(err => logger.error("Follow-up detection failed", err));
  }, 15 * 60_000);

  logger.info("Relationship consumer initialized (ELLIE-320, DB-backed)");
}

// ── Cache Management ─────────────────────────────────────────

async function refreshCache(): Promise<void> {
  if (!supabaseRef) return;
  const { data, error } = await supabaseRef
    .from("relationship_profiles")
    .select("*")
    .eq("suppressed", false)
    .order("last_interaction_at", { ascending: false, nullsFirst: false })
    .limit(300);

  if (error) {
    logger.error("Failed to load profiles from DB", error);
    return;
  }

  profileCache.clear();
  for (const row of (data || []) as RelationshipProfile[]) {
    profileCache.set(row.identifier, row);
  }
}

async function loadPreferences(): Promise<void> {
  if (!supabaseRef) return;
  try {
    const { data } = await supabaseRef
      .from("relationship_preferences")
      .select("key, value");

    if (!data) return;
    for (const row of data) {
      const val = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
      switch (row.key) {
        case "dormant_threshold_days":
          prefs.dormantThresholdDays = Number(val) || 90;
          break;
        case "declining_threshold_days":
          prefs.decliningThresholdDays = Number(val) || 30;
          break;
        case "vip_neglect_days":
          prefs.vipNeglectDays = Number(val) || 30;
          break;
        case "silence_multiplier":
          prefs.silenceMultiplier = Number(val) || 2;
          break;
        case "auto_suppress_patterns":
          if (Array.isArray(val)) prefs.autoSuppressPatterns = val;
          break;
        case "health_weights":
          if (typeof val === "object") prefs.healthWeights = { ...prefs.healthWeights, ...val };
          break;
      }
    }
  } catch {
    // Use defaults
  }
}

// ── Message Handler ──────────────────────────────────────────

async function handleMessage(message: UnifiedMessage): Promise<void> {
  if (!supabaseRef) return;
  const sender = message.sender;
  if (!sender) return;

  // Resolve canonical identifier
  const identifier = resolveIdentifier(sender);
  if (!identifier) return;

  // Auto-suppress known non-human senders
  if (shouldAutoSuppress(identifier, sender)) return;

  const now = new Date().toISOString();
  const interactionAt = message.provider_timestamp || message.received_at || now;

  // Upsert profile
  const existing = profileCache.get(identifier);
  if (existing) {
    await updateProfile(existing, message, interactionAt);
  } else {
    await createProfile(identifier, sender, message, interactionAt);
  }

  // Log interaction
  await logInteraction(identifier, message, interactionAt);
}

async function createProfile(
  identifier: string,
  sender: { name?: string; email?: string; username?: string; id?: string },
  message: UnifiedMessage,
  interactionAt: string,
): Promise<void> {
  if (!supabaseRef) return;

  const emails = sender.email ? [sender.email.toLowerCase()] : [];
  const usernames = sender.username ? [sender.username.toLowerCase()] : [];
  const names = sender.name ? [sender.name] : [];
  const providerIds: Record<string, string> = {};
  if (sender.id) providerIds[message.provider] = sender.id;

  const profile = {
    identifier,
    display_name: sender.name || sender.email || sender.username || null,
    emails,
    usernames,
    names,
    provider_ids: providerIds,
    channels: [message.provider],
    message_count: 1,
    first_interaction_at: interactionAt,
    last_interaction_at: interactionAt,
    health_status: "new",
    health_score: 0.5,
    recency_score: 0.3,
    updated_at: new Date().toISOString(),
  };

  const { data: inserted } = await supabaseRef
    .from("relationship_profiles")
    .upsert(profile, { onConflict: "identifier" })
    .select()
    .single();

  if (inserted) {
    profileCache.set(identifier, inserted as RelationshipProfile);
  }
}

async function updateProfile(
  existing: RelationshipProfile,
  message: UnifiedMessage,
  interactionAt: string,
): Promise<void> {
  if (!supabaseRef) return;

  const sender = message.sender!;
  const updates: Record<string, unknown> = {
    message_count: existing.message_count + 1,
    last_interaction_at: interactionAt,
    updated_at: new Date().toISOString(),
  };

  // Add new email/username/name if not already known
  if (sender.email) {
    const lower = sender.email.toLowerCase();
    if (!existing.emails.includes(lower)) {
      updates.emails = [...existing.emails, lower];
    }
  }
  if (sender.username) {
    const lower = sender.username.toLowerCase();
    if (!existing.usernames.includes(lower)) {
      updates.usernames = [...existing.usernames, lower];
    }
  }
  if (sender.name && !existing.names.includes(sender.name)) {
    updates.names = [...existing.names, sender.name];
    if (!existing.display_name) updates.display_name = sender.name;
  }

  // Add new channel
  if (!existing.channels.includes(message.provider)) {
    updates.channels = [...existing.channels, message.provider];
  }

  // Add provider ID
  if (sender.id && !(existing.provider_ids as Record<string, string>)[message.provider]) {
    updates.provider_ids = { ...existing.provider_ids, [message.provider]: sender.id };
  }

  // Clear follow-up if they've messaged
  if (existing.needs_follow_up) {
    updates.needs_follow_up = false;
    updates.follow_up_reason = null;
    updates.follow_up_since = null;
  }

  await supabaseRef
    .from("relationship_profiles")
    .update(updates)
    .eq("identifier", existing.identifier);

  // Update cache
  Object.assign(existing, updates);
}

async function logInteraction(
  identifier: string,
  message: UnifiedMessage,
  interactionAt: string,
): Promise<void> {
  if (!supabaseRef) return;

  const profile = profileCache.get(identifier);
  if (!profile) return;

  const summary = message.content?.slice(0, 100) || null;

  await supabaseRef.from("interaction_log").insert({
    profile_id: profile.id,
    message_id: message.id || null,
    provider: message.provider,
    direction: "inbound",
    content_type: message.content_type || "text",
    channel: message.channel || null,
    summary,
    interaction_at: interactionAt,
  });
}

// ── Gap Hour Computation ─────────────────────────────────────

/**
 * Compute avg_gap_hours and typical_gap_hours (median) for each profile
 * by querying interaction_log timestamps. Only processes profiles with
 * >= 3 interactions (need at least 2 gaps to be meaningful).
 */
async function computeGapHours(): Promise<void> {
  if (!supabaseRef) return;

  const profiles = Array.from(profileCache.values()).filter(
    p => !p.suppressed && p.message_count >= 3,
  );
  if (profiles.length === 0) return;

  let updated = 0;

  for (const profile of profiles) {
    // Fetch interaction timestamps (most recent 200 — enough for gap stats)
    const { data: interactions, error } = await supabaseRef
      .from("interaction_log")
      .select("interaction_at")
      .eq("profile_id", profile.id)
      .order("interaction_at", { ascending: true })
      .limit(200);

    if (error || !interactions || interactions.length < 3) continue;

    // Compute gaps in hours between consecutive interactions
    const gaps: number[] = [];
    for (let i = 1; i < interactions.length; i++) {
      const prev = new Date(interactions[i - 1].interaction_at).getTime();
      const curr = new Date(interactions[i].interaction_at).getTime();
      const gapHours = (curr - prev) / (1000 * 60 * 60);
      if (gapHours > 0) gaps.push(gapHours);
    }

    if (gaps.length === 0) continue;

    // Average gap
    const avgGap = gaps.reduce((sum, g) => sum + g, 0) / gaps.length;

    // Median gap (typical)
    const sorted = [...gaps].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const medianGap = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];

    const newAvg = Math.round(avgGap * 10) / 10;
    const newMedian = Math.round(medianGap * 10) / 10;

    // Only write if changed
    if (profile.avg_gap_hours !== newAvg || profile.typical_gap_hours !== newMedian) {
      await supabaseRef
        .from("relationship_profiles")
        .update({
          avg_gap_hours: newAvg,
          typical_gap_hours: newMedian,
          updated_at: new Date().toISOString(),
        })
        .eq("id", profile.id);

      profile.avg_gap_hours = newAvg;
      profile.typical_gap_hours = newMedian;
      updated++;
    }
  }

  if (updated > 0) {
    logger.info("Gap hours computed", { updated, eligible: profiles.length });
  }
}

// ── Health Scoring ───────────────────────────────────────────

async function recalculateAllHealth(): Promise<void> {
  if (!supabaseRef) return;

  const profiles = Array.from(profileCache.values());
  const now = Date.now();
  let updated = 0;

  for (const profile of profiles) {
    if (profile.suppressed) continue;

    const scores = calculateHealthScores(profile, now);
    const healthScore = scores.recency * prefs.healthWeights.recency
      + scores.frequency * prefs.healthWeights.frequency
      + scores.consistency * prefs.healthWeights.consistency
      + scores.quality * prefs.healthWeights.quality;

    const healthStatus = deriveHealthStatus(healthScore, profile, now);

    if (
      Math.abs(profile.health_score - healthScore) > 0.01 ||
      profile.health_status !== healthStatus
    ) {
      await supabaseRef
        .from("relationship_profiles")
        .update({
          health_score: Math.round(healthScore * 1000) / 1000,
          health_status: healthStatus,
          recency_score: Math.round(scores.recency * 1000) / 1000,
          frequency_score: Math.round(scores.frequency * 1000) / 1000,
          consistency_score: Math.round(scores.consistency * 1000) / 1000,
          quality_score: Math.round(scores.quality * 1000) / 1000,
          updated_at: new Date().toISOString(),
        })
        .eq("identifier", profile.identifier);

      profile.health_score = healthScore;
      profile.health_status = healthStatus;
      profile.recency_score = scores.recency;
      profile.frequency_score = scores.frequency;
      profile.consistency_score = scores.consistency;
      profile.quality_score = scores.quality;
      updated++;
    }
  }

  if (updated > 0) {
    logger.info("Health scores recalculated", { updated, total: profiles.length });
  }
}

function calculateHealthScores(profile: RelationshipProfile, now: number) {
  // Recency: how recently did they communicate? (0-1)
  let recency = 0;
  if (profile.last_interaction_at) {
    const daysSince = (now - new Date(profile.last_interaction_at).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < 1) recency = 1;
    else if (daysSince < 7) recency = 0.8;
    else if (daysSince < 14) recency = 0.6;
    else if (daysSince < 30) recency = 0.4;
    else if (daysSince < 60) recency = 0.2;
    else recency = 0.1;
  }

  // Frequency: how often do they communicate? (0-1)
  let frequency = 0;
  if (profile.first_interaction_at && profile.message_count > 0) {
    const totalDays = Math.max(1, (now - new Date(profile.first_interaction_at).getTime()) / (1000 * 60 * 60 * 24));
    const msgsPerDay = profile.message_count / totalDays;
    if (msgsPerDay >= 5) frequency = 1;
    else if (msgsPerDay >= 1) frequency = 0.8;
    else if (msgsPerDay >= 0.2) frequency = 0.6;
    else if (msgsPerDay >= 0.05) frequency = 0.4;
    else frequency = 0.2;
  }

  // Consistency: how regular is the communication? (0-1)
  // Based on avg_gap vs typical_gap — lower variance = more consistent
  let consistency = 0.5; // default if no data
  if (profile.avg_gap_hours && profile.typical_gap_hours) {
    const ratio = profile.avg_gap_hours / Math.max(1, profile.typical_gap_hours);
    if (ratio < 1.5) consistency = 1;
    else if (ratio < 2) consistency = 0.7;
    else if (ratio < 3) consistency = 0.4;
    else consistency = 0.2;
  }

  // Quality: multi-channel + message count (0-1)
  let quality = 0.3;
  if (profile.channels.length >= 3) quality += 0.3;
  else if (profile.channels.length >= 2) quality += 0.15;
  if (profile.message_count >= 50) quality += 0.4;
  else if (profile.message_count >= 20) quality += 0.2;
  else if (profile.message_count >= 5) quality += 0.1;
  quality = Math.min(1, quality);

  return { recency, frequency, consistency, quality };
}

function deriveHealthStatus(score: number, profile: RelationshipProfile, now: number): string {
  if (!profile.last_interaction_at) return "new";

  const daysSince = (now - new Date(profile.last_interaction_at).getTime()) / (1000 * 60 * 60 * 24);

  if (daysSince > prefs.dormantThresholdDays) return "dormant";
  if (profile.importance >= 4 && daysSince > prefs.vipNeglectDays) return "at_risk";
  if (score >= 0.7) return "healthy";
  if (score >= 0.4) return "active";
  if (daysSince > prefs.decliningThresholdDays) return "declining";
  return "active";
}

// ── Follow-up Detection ──────────────────────────────────────

async function detectFollowUps(): Promise<void> {
  if (!supabaseRef) return;

  const now = Date.now();
  let flagged = 0;

  for (const profile of profileCache.values()) {
    if (profile.suppressed || profile.needs_follow_up) continue;
    if (!profile.last_interaction_at) continue;

    const daysSince = (now - new Date(profile.last_interaction_at).getTime()) / (1000 * 60 * 60 * 24);
    let reason: string | null = null;

    // VIP neglect: importance >= 4 and silent > vipNeglectDays
    if (profile.importance >= 4 && daysSince > prefs.vipNeglectDays) {
      reason = `VIP contact silent for ${Math.round(daysSince)} days`;
    }

    // Silence too long: > silenceMultiplier * typical gap
    if (!reason && profile.typical_gap_hours) {
      const typicalDays = profile.typical_gap_hours / 24;
      if (daysSince > typicalDays * prefs.silenceMultiplier && daysSince > 7) {
        reason = `Unusual silence — typically every ${Math.round(typicalDays)}d, now ${Math.round(daysSince)}d`;
      }
    }

    // Declining health
    if (!reason && profile.health_status === "declining" && profile.message_count >= 5) {
      reason = `Relationship declining — health score ${Math.round(profile.health_score * 100)}%`;
    }

    if (reason) {
      await supabaseRef
        .from("relationship_profiles")
        .update({
          needs_follow_up: true,
          follow_up_reason: reason,
          follow_up_since: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("identifier", profile.identifier);

      profile.needs_follow_up = true;
      profile.follow_up_reason = reason;
      flagged++;
    }
  }

  if (flagged > 0) {
    logger.info("Follow-ups detected", { flagged });
  }
}

// ── Helpers ──────────────────────────────────────────────────

function resolveIdentifier(sender: { name?: string; email?: string; username?: string; id?: string }): string | null {
  // Prefer email > username > name for stable identity
  if (sender.email) return sender.email.toLowerCase();
  if (sender.username) return sender.username.toLowerCase();
  if (sender.name) return sender.name.toLowerCase();
  return null;
}

function shouldAutoSuppress(identifier: string, sender: { name?: string; email?: string; username?: string }): boolean {
  const lower = identifier.toLowerCase();
  return prefs.autoSuppressPatterns.some(pattern => lower.includes(pattern));
}

// ── Exports for Summary Bar & API ────────────────────────────

export function getProfileCount(): number {
  return profileCache.size;
}

export function getFollowUpProfiles(): RelationshipProfile[] {
  return Array.from(profileCache.values()).filter(p => p.needs_follow_up && !p.suppressed);
}

export function getHealthBreakdown(): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const p of profileCache.values()) {
    if (p.suppressed) continue;
    breakdown[p.health_status] = (breakdown[p.health_status] || 0) + 1;
  }
  return breakdown;
}

export function getTopContacts(limit = 10): RelationshipProfile[] {
  return Array.from(profileCache.values())
    .filter(p => !p.suppressed)
    .sort((a, b) => b.health_score - a.health_score)
    .slice(0, limit);
}

export async function invalidateRelationshipCache(): Promise<void> {
  await refreshCache();
}

/** Backwards-compatible report generation (ELLIE-310). */
export async function generateRelationshipReport(
  supabase: SupabaseClient,
  daysBack = 30,
  dormantThresholdDays = 14,
): Promise<RelationshipReport> {
  const now = new Date();
  const since = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);

  const messages = await queryMessages(supabase, {
    since: since.toISOString(),
    limit: 500,
  });

  const contacts = aggregateContacts(messages, daysBack);
  contacts.sort((a, b) => b.message_count - a.message_count);
  const dormant = contacts.filter(c => c.days_since_last_contact > dormantThresholdDays);

  return {
    generated_at: now.toISOString(),
    period_days: daysBack,
    contacts,
    total_unique_contacts: contacts.length,
    most_active: contacts[0] || null,
    dormant,
  };
}

function aggregateContacts(messages: UnifiedMessage[], periodDays: number): ContactStats[] {
  const contactMap = new Map<string, {
    display_name: string | null;
    messages: number;
    first: Date;
    last: Date;
    channels: Set<string>;
  }>();

  const now = new Date();

  for (const msg of messages) {
    const sender = msg.sender;
    if (!sender) continue;
    const id = sender.email || sender.username || sender.name || sender.id;
    if (!id) continue;

    const key = id.toLowerCase();
    const timestamp = new Date(msg.provider_timestamp || msg.received_at);

    const existing = contactMap.get(key);
    if (existing) {
      existing.messages++;
      if (timestamp < existing.first) existing.first = timestamp;
      if (timestamp > existing.last) existing.last = timestamp;
      existing.channels.add(msg.provider);
      if (!existing.display_name && sender.name) existing.display_name = sender.name;
    } else {
      contactMap.set(key, {
        display_name: sender.name || null,
        messages: 1,
        first: timestamp,
        last: timestamp,
        channels: new Set([msg.provider]),
      });
    }
  }

  const stats: ContactStats[] = [];
  for (const [id, data] of contactMap) {
    const daysSinceLast = Math.floor((now.getTime() - data.last.getTime()) / (1000 * 60 * 60 * 24));
    stats.push({
      identifier: id,
      display_name: data.display_name,
      message_count: data.messages,
      last_contact: data.last.toISOString(),
      first_contact: data.first.toISOString(),
      channels: Array.from(data.channels),
      avg_messages_per_day: Math.round((data.messages / periodDays) * 100) / 100,
      days_since_last_contact: daysSinceLast,
    });
  }

  return stats;
}
