/**
 * Relationship Intelligence — ELLIE-1066
 * Track person profiles, contact frequency, and losing-touch alerts.
 * Inspired by Minutes crates/core/src/graph.rs
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./logger.ts";

const logger = log.child("relationships");

const LOSING_TOUCH_DAYS = 21;  // Flag after 3 weeks without contact
const SCORE_DECAY_RATE = 0.693 / (7 * 24 * 60 * 60_000); // 7-day half-life

export interface PersonRelationship {
  id: string;
  person_name: string;
  aliases: string[];
  meeting_count: number;
  last_seen_at: string | null;
  channels: string[];
  top_topics: string[];
  relationship_score: number;
  status: "active" | "losing_touch" | "inactive";
}

/**
 * Calculate relationship score: meeting_count * recency_weight * topic_depth
 */
export function calculateScore(meetingCount: number, lastSeenAt: Date | null, topicCount: number): number {
  if (!lastSeenAt) return 0;
  const daysSince = (Date.now() - lastSeenAt.getTime()) / (24 * 60 * 60_000);
  const recencyWeight = 1.0 / (1.0 + daysSince / 30.0);
  const topicDepth = Math.max(1, topicCount);
  return Math.round(meetingCount * recencyWeight * topicDepth * 100) / 100;
}

/**
 * Record an interaction with a person.
 */
export async function recordInteraction(
  supabase: SupabaseClient,
  opts: {
    personName: string;
    channel: string;
    topics?: string[];
  }
): Promise<void> {
  const { personName, channel, topics = [] } = opts;
  const now = new Date().toISOString();

  // Upsert person
  const { data: existing } = await supabase
    .from("person_relationships")
    .select("*")
    .eq("person_name", personName)
    .maybeSingle();

  if (existing) {
    const channels = [...new Set([...existing.channels, channel])];
    const allTopics = [...new Set([...existing.top_topics, ...topics])].slice(0, 10);
    const meetingCount = existing.meeting_count + 1;
    const score = calculateScore(meetingCount, new Date(), allTopics.length);

    await supabase
      .from("person_relationships")
      .update({
        meeting_count: meetingCount,
        last_seen_at: now,
        channels,
        top_topics: allTopics,
        previous_score: existing.relationship_score,
        relationship_score: score,
        score_updated_at: now,
        status: "active",
        updated_at: now,
      })
      .eq("id", existing.id);
  } else {
    const score = calculateScore(1, new Date(), topics.length);
    await supabase
      .from("person_relationships")
      .insert({
        person_name: personName,
        meeting_count: 1,
        last_seen_at: now,
        first_seen_at: now,
        channels: [channel],
        top_topics: topics.slice(0, 10),
        relationship_score: score,
        score_updated_at: now,
        status: "active",
      });
  }

  logger.info("Recorded interaction", { personName, channel, topics });
}

/**
 * Detect people losing touch — no contact for 3+ weeks.
 */
export async function detectLosingTouch(supabase: SupabaseClient): Promise<PersonRelationship[]> {
  const threshold = new Date(Date.now() - LOSING_TOUCH_DAYS * 24 * 60 * 60_000).toISOString();

  // Update status for stale relationships
  await supabase
    .from("person_relationships")
    .update({ status: "losing_touch", updated_at: new Date().toISOString() })
    .eq("status", "active")
    .lt("last_seen_at", threshold);

  // Fetch all losing-touch people
  const { data } = await supabase
    .from("person_relationships")
    .select("*")
    .eq("status", "losing_touch")
    .order("last_seen_at", { ascending: true });

  return (data ?? []) as PersonRelationship[];
}

/**
 * Get all relationships sorted by score.
 */
export async function getRelationships(
  supabase: SupabaseClient,
  opts?: { status?: string; limit?: number }
): Promise<PersonRelationship[]> {
  let query = supabase
    .from("person_relationships")
    .select("*")
    .order("relationship_score", { ascending: false });

  if (opts?.status) query = query.eq("status", opts.status);
  if (opts?.limit) query = query.limit(opts.limit);

  const { data } = await query;
  return (data ?? []) as PersonRelationship[];
}

/**
 * Get profile for a specific person.
 */
export async function getPersonProfile(
  supabase: SupabaseClient,
  personName: string
): Promise<PersonRelationship | null> {
  const { data } = await supabase
    .from("person_relationships")
    .select("*")
    .eq("person_name", personName)
    .maybeSingle();
  return data as PersonRelationship | null;
}

/**
 * Normalize a person name for matching.
 * Lowercase, trim, collapse whitespace.
 */
export function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Check if two names might be the same person.
 * Simple heuristic: one name contains the other, or first names match.
 */
export function mightBeAlias(nameA: string, nameB: string): boolean {
  const a = normalizeName(nameA);
  const b = normalizeName(nameB);
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  // First name match
  const firstA = a.split(" ")[0];
  const firstB = b.split(" ")[0];
  if (firstA.length >= 3 && firstA === firstB) return true;
  return false;
}

/**
 * Find potential aliases for a person across all relationships.
 */
export async function findPotentialAliases(
  supabase: SupabaseClient,
  personName: string
): Promise<Array<{ id: string; person_name: string; similarity: string }>> {
  const { data } = await supabase
    .from("person_relationships")
    .select("id, person_name")
    .neq("person_name", personName);

  if (!data) return [];

  return data
    .filter(p => mightBeAlias(p.person_name, personName))
    .map(p => ({
      id: p.id,
      person_name: p.person_name,
      similarity: normalizeName(p.person_name) === normalizeName(personName) ? "exact" : "partial",
    }));
}

/**
 * Merge two person records (combine stats, keep canonical name).
 */
export async function mergePersonRecords(
  supabase: SupabaseClient,
  canonicalId: string,
  mergeId: string
): Promise<void> {
  const { data: canonical } = await supabase.from("person_relationships").select("*").eq("id", canonicalId).single();
  const { data: merge } = await supabase.from("person_relationships").select("*").eq("id", mergeId).single();

  if (!canonical || !merge) return;

  await supabase
    .from("person_relationships")
    .update({
      aliases: [...new Set([...(canonical.aliases || []), merge.person_name, ...(merge.aliases || [])])],
      meeting_count: canonical.meeting_count + merge.meeting_count,
      channels: [...new Set([...(canonical.channels || []), ...(merge.channels || [])])],
      top_topics: [...new Set([...(canonical.top_topics || []), ...(merge.top_topics || [])])].slice(0, 10),
      updated_at: new Date().toISOString(),
    })
    .eq("id", canonicalId);

  await supabase.from("person_relationships").delete().eq("id", mergeId);
  logger.info("Merged person records", { canonical: canonical.person_name, merged: merge.person_name });
}

// Export for testing
export { LOSING_TOUCH_DAYS, SCORE_DECAY_RATE };
