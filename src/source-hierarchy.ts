/**
 * Source Hierarchy & Proactive Conflict Detection — ELLIE-250 Phase 3
 *
 * Three capabilities:
 * 1. Source hierarchy rules — clear precedence for resolving conflicting claims
 * 2. Proactive conflict detection — check sources against each other before responding
 * 3. Cross-channel propagation — surface corrections from other channels
 *
 * Hierarchy (highest to lowest):
 *   user corrections (ground truth, confidence 1.0)
 *   > recent conversations (last 3 days)
 *   > live API data (Plane, Calendar, systemctl)
 *   > Forest memories (confidence-weighted)
 *   > stale context (context-docket, old structured-context)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./logger.ts";

const logger = log.child("source-hierarchy");

// ── Source Hierarchy ─────────────────────────────────────────

/** Source tiers from highest to lowest trust. */
export const SOURCE_TIERS = [
  { tier: 1, label: "user-correction", description: "User-stated ground truth (confidence 1.0)" },
  { tier: 2, label: "recent-conversation", description: "Recent conversation context (last 3 days)" },
  { tier: 3, label: "live-api", description: "Live API data (Plane, Calendar, systemctl)" },
  { tier: 4, label: "forest-memory", description: "Forest memories (confidence-weighted)" },
  { tier: 5, label: "stale-context", description: "Stale or cached context" },
] as const;

export type SourceTier = typeof SOURCE_TIERS[number]["label"];

/** Map context source names to their trust tier. */
const SOURCE_TIER_MAP: Record<string, SourceTier> = {
  // Tier 1 — ground truth
  "correction:ground_truth": "user-correction",
  "source:user_correction": "user-correction",

  // Tier 2 — recent conversation
  "recent-messages": "recent-conversation",

  // Tier 3 — live API
  "work-item": "live-api",
  "calendar": "live-api",
  "queue": "live-api",
  "health": "live-api",

  // Tier 4 — Forest
  "forest-awareness": "forest-memory",
  "agent-memory": "forest-memory",
  "search": "forest-memory",

  // Tier 5 — stale/cached
  "context-docket": "stale-context",
  "structured-context": "stale-context",
  "goals": "stale-context",
};

function getTierRank(tier: SourceTier): number {
  return SOURCE_TIERS.find(t => t.label === tier)?.tier ?? 5;
}

/**
 * Resolve which source to trust when two sources conflict.
 * Returns the higher-ranked source label.
 */
export function resolveConflict(sourceA: string, sourceB: string): {
  winner: string;
  loser: string;
  winnerTier: SourceTier;
  loserTier: SourceTier;
} {
  const tierA = SOURCE_TIER_MAP[sourceA] ?? "stale-context";
  const tierB = SOURCE_TIER_MAP[sourceB] ?? "stale-context";
  const rankA = getTierRank(tierA);
  const rankB = getTierRank(tierB);

  if (rankA <= rankB) {
    return { winner: sourceA, loser: sourceB, winnerTier: tierA, loserTier: tierB };
  }
  return { winner: sourceB, loser: sourceA, winnerTier: tierB, loserTier: tierA };
}

// ── Proactive Conflict Detection ─────────────────────────────

export interface ContentConflict {
  topic: string;
  sourceA: { name: string; tier: SourceTier; claim: string };
  sourceB: { name: string; tier: SourceTier; claim: string };
  resolution: string;
}

/**
 * Check for ground truth corrections that contradict current context.
 * Run before response generation to catch known-wrong claims.
 *
 * Returns a prompt warning section if conflicts are found.
 */
export async function checkGroundTruthConflicts(
  userMessage: string,
  contextSections: { label: string; content: string }[],
): Promise<string> {
  try {
    const { queryGroundTruth } = await import("./data-quality.ts");

    // Query ground truth relevant to the current user message
    const groundTruth = await queryGroundTruth(userMessage, { limit: 10 });
    if (!groundTruth.length) return "";

    const conflicts: string[] = [];

    for (const gt of groundTruth) {
      // Check if any context section mentions the thing that was corrected
      for (const section of contextSections) {
        if (!section.content) continue;

        // Check if the wrong claim appears in current context
        const wrongWords = gt.what_was_wrong
          .toLowerCase()
          .split(/\s+/)
          .filter(w => w.length > 3);

        // If >60% of distinctive words from the wrong claim appear in context,
        // flag it — the context may still contain the corrected information
        const matchCount = wrongWords.filter(w =>
          section.content.toLowerCase().includes(w),
        ).length;

        if (wrongWords.length >= 2 && matchCount / wrongWords.length > 0.6) {
          conflicts.push(
            `- Context "${section.label}" may contain outdated info. ` +
            `User previously corrected: "${gt.what_was_wrong}" → correct: "${gt.content}"`,
          );
          break; // One match per ground truth entry is enough
        }
      }
    }

    if (!conflicts.length) return "";

    return (
      "⚠ GROUND TRUTH CONFLICTS DETECTED:\n" +
      "The following user corrections override context data:\n" +
      conflicts.join("\n") +
      "\nAlways prefer user corrections over other sources."
    );
  } catch (err) {
    logger.warn("Ground truth conflict check failed", err);
    return "";
  }
}

// ── Cross-Channel Propagation ────────────────────────────────

/**
 * Fetch recent corrections from OTHER channels that should be
 * propagated to the current channel's context.
 *
 * Returns corrections from the last 3 days from channels other
 * than the requesting channel.
 */
export async function getCrossChannelCorrections(
  supabase: SupabaseClient,
  currentChannel: string,
  limit: number = 10,
): Promise<Array<{
  content: string;
  what_was_wrong: string;
  source_channel: string;
  created_at: string;
}>> {
  try {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400_000).toISOString();

    const { data, error } = await supabase
      .from("shared_memories")
      .select("id, content, metadata, created_at, tags")
      .contains("tags", ["correction:ground_truth"])
      .eq("type", "fact")
      .gte("created_at", threeDaysAgo)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error || !data) return [];

    // Filter to corrections from OTHER channels
    return data
      .filter(m => {
        const meta = m.metadata as Record<string, unknown>;
        const channel = (meta?.channel as string) || "";
        return channel && channel !== currentChannel;
      })
      .map(m => {
        const meta = m.metadata as Record<string, unknown>;
        return {
          content: m.content,
          what_was_wrong: (meta?.what_was_wrong as string) || "",
          source_channel: (meta?.channel as string) || "unknown",
          created_at: m.created_at,
        };
      });
  } catch (err) {
    logger.warn("Cross-channel correction fetch failed", err);
    return [];
  }
}

/**
 * Build a prompt section with cross-channel corrections.
 * Returns empty string if no relevant corrections from other channels.
 */
export async function buildCrossChannelSection(
  supabase: SupabaseClient | null,
  currentChannel: string,
): Promise<string> {
  if (!supabase) return "";

  const corrections = await getCrossChannelCorrections(supabase, currentChannel);
  if (!corrections.length) return "";

  const lines = corrections.map(c =>
    `- [from ${c.source_channel}] "${c.what_was_wrong}" → correct: "${c.content}"`,
  );

  return (
    "CROSS-CHANNEL CORRECTIONS (recent user corrections from other channels):\n" +
    lines.join("\n") +
    "\nThese corrections apply across all channels."
  );
}

// ── Source Hierarchy Prompt ──────────────────────────────────

/**
 * Build the source hierarchy instruction for the prompt.
 * This is a static instruction that tells the agent how to
 * prioritize conflicting information.
 */
export function buildSourceHierarchyInstruction(): string {
  return (
    "SOURCE TRUST HIERARCHY (when sources conflict, prefer higher-ranked):\n" +
    "1. User corrections — if the user previously corrected a fact, that correction is ALWAYS right\n" +
    "2. Recent conversation — what was said in the last few messages overrides older context\n" +
    "3. Live API data — current Plane ticket state, calendar events, service health\n" +
    "4. Forest memories — knowledge base entries, weighted by confidence\n" +
    "5. Stale context — context docket, cached structured data\n" +
    "When you detect a conflict, state both claims and which source you're trusting."
  );
}
