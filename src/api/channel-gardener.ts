/**
 * Channel Gardener — ELLIE-335
 *
 * Nightly job that analyzes channel usage patterns and surfaces
 * suggestions for tree improvements: archives, splits, new channels.
 *
 * Pattern: collect snapshots → detect patterns → deduplicate → store suggestions
 * Delivery: suggestions surface in morning briefing + GET /api/gardener/suggestions
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getChannelTree, archiveChannel, type ChatChannel, type ChatChannelTreeNode } from "../chat-channels.ts";
import { isPlaneConfigured, isWorkItemDone } from "../plane.ts";
import { log } from "../logger.ts";

const logger = log.child("gardener");

// ── Types ────────────────────────────────────────────────────

interface RawSuggestion {
  channelId: string;
  channelName: string;
  type: "archive" | "split" | "new_channel" | "reclassify" | "merge";
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  confidence: number;
}

export interface GardenerSuggestion {
  id: string;
  channel_id: string;
  suggestion_type: string;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  confidence: number;
  status: string;
  dismissed_until: string | null;
  created_at: string;
  actioned_at: string | null;
}

// ── Thresholds ───────────────────────────────────────────────

const DEAD_CHANNEL_DAYS = 14;
const OVERLOADED_MESSAGES_PER_DAY = 50;
const OVERLOADED_WINDOW_DAYS = 7;
const DISMISS_COOLDOWN_DAYS = 14;

// ── Usage Snapshot Collection ────────────────────────────────

/**
 * Collect daily usage metrics for each active channel.
 * Queries conversations table for message counts and activity.
 */
export async function collectUsageSnapshots(supabase: SupabaseClient): Promise<number> {
  const tree = await getChannelTree(supabase);
  const allChannels = flattenTree(tree);

  if (!allChannels.length) {
    logger.debug("No channels found for snapshot collection");
    return 0;
  }

  const today = new Date().toISOString().split("T")[0];
  const yesterday = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  let snapshotCount = 0;

  for (const channel of allChannels) {
    // Count conversations and messages for this channel in the last 24h
    const { data: convos } = await supabase
      .from("conversations")
      .select("id, message_count, last_message_at")
      .eq("channel_id", channel.id)
      .gte("last_message_at", yesterday);

    const messageCount = (convos || []).reduce((sum, c) => sum + (c.message_count || 0), 0);
    const conversationCount = (convos || []).length;
    const lastActivity = (convos || [])
      .map(c => c.last_message_at)
      .filter(Boolean)
      .sort()
      .pop() || null;

    // Also check for older conversations if no recent activity
    let overallLastActivity = lastActivity;
    if (!lastActivity) {
      const { data: latest } = await supabase
        .from("conversations")
        .select("last_message_at")
        .eq("channel_id", channel.id)
        .order("last_message_at", { ascending: false })
        .limit(1);
      overallLastActivity = latest?.[0]?.last_message_at || null;
    }

    const { error } = await supabase
      .from("channel_usage_snapshots")
      .upsert({
        channel_id: channel.id,
        snapshot_date: today,
        message_count: messageCount,
        conversation_count: conversationCount,
        last_activity_at: overallLastActivity,
      }, { onConflict: "channel_id,snapshot_date" });

    if (error) {
      logger.warn(`Snapshot upsert failed for ${channel.name}`, error);
    } else {
      snapshotCount++;
    }
  }

  logger.info(`Collected ${snapshotCount} usage snapshots`);
  return snapshotCount;
}

// ── Pattern Detection ────────────────────────────────────────

/**
 * Detect dead channels — no messages in DEAD_CHANNEL_DAYS, not ephemeral.
 */
async function detectDeadChannels(
  supabase: SupabaseClient,
  channels: ChatChannel[],
): Promise<RawSuggestion[]> {
  const suggestions: RawSuggestion[] = [];
  const cutoff = new Date(Date.now() - DEAD_CHANNEL_DAYS * 24 * 60 * 60_000).toISOString();

  for (const ch of channels) {
    if (ch.is_ephemeral) continue; // ephemeral channels handled separately

    // Check if any conversations exist with recent activity
    const { data: recent } = await supabase
      .from("conversations")
      .select("id")
      .eq("channel_id", ch.id)
      .gte("last_message_at", cutoff)
      .limit(1);

    if (!recent?.length) {
      // Also check the snapshots for any message activity
      const { data: snapshots } = await supabase
        .from("channel_usage_snapshots")
        .select("message_count")
        .eq("channel_id", ch.id)
        .gte("snapshot_date", new Date(Date.now() - DEAD_CHANNEL_DAYS * 24 * 60 * 60_000).toISOString().split("T")[0])
        .gt("message_count", 0)
        .limit(1);

      if (!snapshots?.length) {
        suggestions.push({
          channelId: ch.id,
          channelName: ch.name,
          type: "archive",
          title: `Archive inactive channel: ${ch.name}`,
          description: `No messages in ${DEAD_CHANNEL_DAYS}+ days. Consider archiving to reduce clutter.`,
          evidence: { daysSinceActivity: DEAD_CHANNEL_DAYS, channelSlug: ch.slug },
          confidence: 0.7,
        });
      }
    }
  }

  return suggestions;
}

/**
 * Detect stale ephemeral channels — ticket is Done but channel not archived.
 */
async function detectStaleEphemeral(
  channels: ChatChannel[],
): Promise<RawSuggestion[]> {
  if (!isPlaneConfigured()) return [];

  const suggestions: RawSuggestion[] = [];

  for (const ch of channels) {
    if (!ch.is_ephemeral || !ch.work_item_id) continue;

    try {
      const done = await isWorkItemDone(ch.work_item_id);
      if (done) {
        suggestions.push({
          channelId: ch.id,
          channelName: ch.name,
          type: "archive",
          title: `Archive completed work channel: ${ch.name}`,
          description: `Work item ${ch.work_item_id} is Done. This ephemeral channel can be archived.`,
          evidence: { workItemId: ch.work_item_id, status: "done" },
          confidence: 0.9,
        });
      }
    } catch {
      // Skip if Plane check fails
    }
  }

  return suggestions;
}

/**
 * Detect overloaded channels — high message volume suggesting a split.
 */
async function detectOverloaded(
  supabase: SupabaseClient,
  channels: ChatChannel[],
): Promise<RawSuggestion[]> {
  const suggestions: RawSuggestion[] = [];
  const windowStart = new Date(Date.now() - OVERLOADED_WINDOW_DAYS * 24 * 60 * 60_000)
    .toISOString().split("T")[0];

  for (const ch of channels) {
    const { data: snapshots } = await supabase
      .from("channel_usage_snapshots")
      .select("message_count, snapshot_date")
      .eq("channel_id", ch.id)
      .gte("snapshot_date", windowStart);

    if (!snapshots?.length) continue;

    const totalMessages = snapshots.reduce((sum, s) => sum + (s.message_count || 0), 0);
    const avgPerDay = totalMessages / snapshots.length;

    if (avgPerDay >= OVERLOADED_MESSAGES_PER_DAY) {
      suggestions.push({
        channelId: ch.id,
        channelName: ch.name,
        type: "split",
        title: `Consider splitting: ${ch.name}`,
        description: `Averaging ${Math.round(avgPerDay)} messages/day over ${snapshots.length} days. High volume may benefit from sub-channels.`,
        evidence: {
          avgMessagesPerDay: Math.round(avgPerDay),
          totalMessages,
          windowDays: snapshots.length,
        },
        confidence: avgPerDay >= OVERLOADED_MESSAGES_PER_DAY * 2 ? 0.85 : 0.6,
      });
    }
  }

  return suggestions;
}

// ── Orchestration ────────────────────────────────────────────

/**
 * Run all pattern detectors and deduplicate against existing suggestions.
 */
export async function generateSuggestions(supabase: SupabaseClient): Promise<number> {
  const tree = await getChannelTree(supabase);
  const allChannels = flattenTree(tree);

  // Run detectors in parallel
  const [dead, stale, overloaded] = await Promise.all([
    detectDeadChannels(supabase, allChannels),
    detectStaleEphemeral(allChannels),
    detectOverloaded(supabase, allChannels),
  ]);

  const rawSuggestions = [...dead, ...stale, ...overloaded];

  if (!rawSuggestions.length) {
    logger.info("No new suggestions detected");
    return 0;
  }

  // Fetch existing pending/dismissed suggestions for dedup
  const { data: existing } = await supabase
    .from("channel_gardener_suggestions")
    .select("channel_id, suggestion_type, status, dismissed_until")
    .in("status", ["pending", "dismissed"]);

  const existingSet = new Set(
    (existing || [])
      .filter(e => {
        if (e.status === "dismissed" && e.dismissed_until) {
          return new Date(e.dismissed_until) > new Date(); // still in cooldown
        }
        return e.status === "pending";
      })
      .map(e => `${e.channel_id}:${e.suggestion_type}`),
  );

  // Filter out duplicates
  const newSuggestions = rawSuggestions.filter(
    s => !existingSet.has(`${s.channelId}:${s.type}`),
  );

  if (!newSuggestions.length) {
    logger.info(`All ${rawSuggestions.length} suggestions already exist — skipping`);
    return 0;
  }

  // Insert new suggestions
  const { error } = await supabase
    .from("channel_gardener_suggestions")
    .insert(newSuggestions.map(s => ({
      channel_id: s.channelId,
      suggestion_type: s.type,
      title: s.title,
      description: s.description,
      evidence: s.evidence,
      confidence: s.confidence,
    })));

  if (error) {
    logger.error("Failed to insert suggestions", error);
    return 0;
  }

  logger.info(`Created ${newSuggestions.length} new suggestions (${dead.length} dead, ${stale.length} stale, ${overloaded.length} overloaded)`);
  return newSuggestions.length;
}

/**
 * Main entry point — called nightly from relay scheduler.
 */
export async function runNightlyGardener(supabase: SupabaseClient): Promise<{ snapshots: number; suggestions: number }> {
  logger.info("Starting nightly gardener run");
  const start = Date.now();

  try {
    const snapshots = await collectUsageSnapshots(supabase);
    const suggestions = await generateSuggestions(supabase);

    const elapsed = Date.now() - start;
    logger.info(`Gardener complete in ${elapsed}ms: ${snapshots} snapshots, ${suggestions} new suggestions`);
    return { snapshots, suggestions };
  } catch (err) {
    logger.error("Gardener run failed", err);
    return { snapshots: 0, suggestions: 0 };
  }
}

// ── Suggestion Management ────────────────────────────────────

/**
 * Get pending suggestions.
 */
export async function getPendingSuggestions(supabase: SupabaseClient): Promise<GardenerSuggestion[]> {
  const { data, error } = await supabase
    .from("channel_gardener_suggestions")
    .select("*")
    .eq("status", "pending")
    .order("confidence", { ascending: false });

  if (error) {
    logger.error("Failed to fetch suggestions", error);
    return [];
  }
  return (data || []) as GardenerSuggestion[];
}

/**
 * Approve a suggestion — apply the action if possible.
 */
export async function approveSuggestion(
  supabase: SupabaseClient,
  suggestionId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("channel_gardener_suggestions")
    .update({ status: "approved", actioned_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", suggestionId)
    .select()
    .single();

  if (error || !data) {
    logger.error("Failed to approve suggestion", error);
    return false;
  }

  const suggestion = data as GardenerSuggestion;

  // Auto-apply archive suggestions
  if (suggestion.suggestion_type === "archive" && suggestion.channel_id) {
    const archived = await archiveChannel(supabase, suggestion.channel_id);
    if (archived) {
      await supabase
        .from("channel_gardener_suggestions")
        .update({ status: "applied", updated_at: new Date().toISOString() })
        .eq("id", suggestionId);
      logger.info(`Applied archive suggestion for channel ${suggestion.channel_id}`);
    }
  }

  return true;
}

/**
 * Dismiss a suggestion with a cooldown period.
 */
export async function dismissSuggestion(
  supabase: SupabaseClient,
  suggestionId: string,
): Promise<boolean> {
  const dismissedUntil = new Date(Date.now() + DISMISS_COOLDOWN_DAYS * 24 * 60 * 60_000).toISOString();

  const { error } = await supabase
    .from("channel_gardener_suggestions")
    .update({
      status: "dismissed",
      dismissed_until: dismissedUntil,
      actioned_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", suggestionId);

  if (error) {
    logger.error("Failed to dismiss suggestion", error);
    return false;
  }

  logger.info(`Dismissed suggestion ${suggestionId} until ${dismissedUntil}`);
  return true;
}

// ── Helpers ──────────────────────────────────────────────────

function flattenTree(nodes: ChatChannelTreeNode[]): ChatChannel[] {
  const result: ChatChannel[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.children?.length) {
      result.push(...flattenTree(node.children));
    }
  }
  return result;
}
