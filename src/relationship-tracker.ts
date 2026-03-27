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

// Export for testing
export { LOSING_TOUCH_DAYS, SCORE_DECAY_RATE };
