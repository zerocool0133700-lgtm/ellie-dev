/**
 * Data Quality Engine — ELLIE-250 Phase 2
 *
 * Four capabilities:
 * 1. Verification trail logging — persists what sources were checked during verification
 * 2. Ground truth index — query API for user-stated facts (confidence 1.0)
 * 3. Decision accuracy tracking — links corrections back to original wrong memories
 * 4. Agent failure postmortem — structured analysis when an agent makes a factual error
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./logger.ts";

const logger = log.child("data-quality");

// ── Types ────────────────────────────────────────────────────

export interface VerificationEntry {
  claim: string;
  source: string;
  result: "confirmed" | "corrected" | "unverified" | "conflict";
  checked_value?: string;
  expected_value?: string;
  latency_ms?: number;
}

export interface VerificationTrail {
  channel: string;
  agent: string;
  conversation_id?: string;
  entries: VerificationEntry[];
  timestamp: string;
}

export interface PostmortemReport {
  what_was_claimed: string;
  what_was_correct: string;
  sources_consulted: string[];
  sources_available: string[];
  root_cause: string;
  channel: string;
  agent?: string;
  conversation_id?: string;
  correction_memory_id?: string;
  original_memory_id?: string;
}

export interface AccuracyStats {
  total_corrections: number;
  corrections_with_linked_source: number;
  top_error_categories: Array<{ category: string; count: number }>;
  accuracy_by_agent: Array<{ agent: string; corrections: number; total_claims: number }>;
}

// ── 1. Verification Trail Logging ────────────────────────────

/**
 * Persist a verification trail to the Forest.
 * Called after agents check factual claims during response generation.
 */
export async function logVerificationTrail(trail: VerificationTrail): Promise<string | null> {
  try {
    const { writeMemory } = await import("../../ellie-forest/src/shared-memory");

    const corrections = trail.entries.filter(e => e.result === "corrected");
    const conflicts = trail.entries.filter(e => e.result === "conflict");
    const confirmed = trail.entries.filter(e => e.result === "confirmed");

    const summary = [
      `Verification trail: ${trail.entries.length} claims checked`,
      `${confirmed.length} confirmed, ${corrections.length} corrected, ${conflicts.length} conflicts`,
      ...corrections.map(c => `  CORRECTED: ${c.claim} — was "${c.expected_value}", actually "${c.checked_value}"`),
      ...conflicts.map(c => `  CONFLICT: ${c.claim} — source "${c.source}" says "${c.checked_value}"`),
    ].join("\n");

    const memory = await writeMemory({
      content: summary,
      type: "finding",
      scope_path: "2/1",
      confidence: 0.9,
      tags: [
        "verification:trail",
        `channel:${trail.channel}`,
        `agent:${trail.agent}`,
        ...(corrections.length > 0 ? ["verification:had_corrections"] : []),
        ...(conflicts.length > 0 ? ["verification:had_conflicts"] : []),
      ],
      metadata: {
        source: "data_quality",
        work_item_id: "ELLIE-250",
        verification_entries: trail.entries,
        channel: trail.channel,
        agent: trail.agent,
        conversation_id: trail.conversation_id,
        counts: {
          total: trail.entries.length,
          confirmed: confirmed.length,
          corrected: corrections.length,
          conflicts: conflicts.length,
          unverified: trail.entries.filter(e => e.result === "unverified").length,
        },
      },
      category: "general",
    });

    logger.info("Verification trail logged", {
      memory_id: memory.id,
      total: trail.entries.length,
      corrected: corrections.length,
    });

    return memory.id;
  } catch (err) {
    logger.error("Failed to log verification trail", err);
    return null;
  }
}

// ── 2. Ground Truth Index ────────────────────────────────────

/**
 * Query the Forest for ground truth facts — user-stated corrections
 * that should override all other sources.
 *
 * Returns memories tagged with correction:ground_truth, ordered by recency.
 */
export async function queryGroundTruth(
  query: string,
  options: {
    scope_path?: string;
    limit?: number;
    channel?: string;
  } = {},
): Promise<Array<{
  id: string;
  content: string;
  what_was_wrong: string;
  created_at: string;
  channel: string;
  confidence: number;
  tags: string[];
}>> {
  try {
    const { readMemories } = await import("../../ellie-forest/src/shared-memory");

    const memories = await readMemories({
      query,
      scope_path: options.scope_path || "2",
      limit: options.limit || 20,
      type: "fact",
      min_confidence: 0.9,
    });

    // Filter to ground truth only
    const groundTruth = memories
      .filter(m => m.tags?.includes("correction:ground_truth"))
      .map(m => ({
        id: m.id,
        content: m.content,
        what_was_wrong: (m.metadata as Record<string, unknown>)?.what_was_wrong as string || "",
        created_at: m.created_at,
        channel: ((m.metadata as Record<string, unknown>)?.channel as string) || "unknown",
        confidence: m.confidence ?? 1.0,
        tags: m.tags || [],
      }));

    if (options.channel) {
      return groundTruth.filter(gt => gt.channel === options.channel);
    }

    return groundTruth;
  } catch (err) {
    logger.error("Failed to query ground truth", err);
    return [];
  }
}

/**
 * List all ground truth facts (no semantic search, just chronological).
 */
export async function listGroundTruth(
  supabase: SupabaseClient,
  options: { limit?: number; offset?: number } = {},
): Promise<Array<{
  id: string;
  content: string;
  what_was_wrong: string;
  created_at: string;
  channel: string;
}>> {
  try {
    const { data, error } = await supabase
      .from("shared_memories")
      .select("id, content, metadata, created_at, tags")
      .contains("tags", ["correction:ground_truth"])
      .eq("type", "fact")
      .order("created_at", { ascending: false })
      .range(
        options.offset || 0,
        (options.offset || 0) + (options.limit || 20) - 1,
      );

    if (error || !data) return [];

    return data.map(m => ({
      id: m.id,
      content: m.content,
      what_was_wrong: (m.metadata as Record<string, unknown>)?.what_was_wrong as string || "",
      created_at: m.created_at,
      channel: ((m.metadata as Record<string, unknown>)?.channel as string) || "unknown",
    }));
  } catch (err) {
    logger.error("Failed to list ground truth", err);
    return [];
  }
}

// ── 3. Decision Accuracy Tracking ────────────────────────────

/**
 * When a correction is detected, search for the original memory that was wrong
 * and link them via the supersedes chain.
 *
 * This creates a feedback loop: corrections point back to the original claims,
 * allowing us to track which types of claims agents get wrong most often.
 */
export async function trackDecisionAccuracy(
  correctionContent: string,
  whatWasWrong: string,
  correctionMemoryId: string,
  channel: string,
): Promise<{ linkedMemoryId: string | null; rootCause: string }> {
  try {
    const { readMemories, sql } = await import("../../ellie-forest/src/shared-memory");

    // Search for the original wrong memory using the incorrect claim text
    const candidates = await readMemories({
      query: whatWasWrong,
      limit: 5,
      min_confidence: 0.0,
    });

    // Find the most likely original wrong claim
    // Exclude the correction itself and other corrections
    const original = candidates.find(m =>
      m.id !== correctionMemoryId &&
      !m.tags?.includes("correction:ground_truth") &&
      !m.tags?.includes("verification:trail"),
    );

    if (original) {
      // Link via supersedes chain
      await sql`
        UPDATE shared_memories
        SET superseded_by_id = ${correctionMemoryId},
            status = 'superseded',
            updated_at = now()
        WHERE id = ${original.id}
          AND superseded_by_id IS NULL
      `;

      await sql`
        UPDATE shared_memories
        SET supersedes_id = ${original.id},
            updated_at = now()
        WHERE id = ${correctionMemoryId}
      `;

      logger.info("Decision accuracy linked", {
        correction_id: correctionMemoryId,
        original_id: original.id,
        original_type: original.type,
        original_confidence: original.confidence,
      });

      return {
        linkedMemoryId: original.id,
        rootCause: `Original ${original.type} (confidence ${original.confidence}) was superseded by user correction`,
      };
    }

    return {
      linkedMemoryId: null,
      rootCause: "No matching original memory found — correction may reference a session-only claim",
    };
  } catch (err) {
    logger.error("Decision accuracy tracking failed", err);
    return { linkedMemoryId: null, rootCause: "tracking_error" };
  }
}

// ── 4. Agent Failure Postmortem ──────────────────────────────

/**
 * Create a structured postmortem when a user corrects a factual claim.
 * Logs what was claimed, what was correct, what sources existed,
 * and performs root cause analysis.
 */
export async function logAgentPostmortem(
  report: PostmortemReport,
): Promise<string | null> {
  try {
    const { writeMemory } = await import("../../ellie-forest/src/shared-memory");

    const postmortemContent = [
      `Agent factual error postmortem`,
      ``,
      `Claimed: ${report.what_was_claimed}`,
      `Correct: ${report.what_was_correct}`,
      `Root cause: ${report.root_cause}`,
      ``,
      `Sources consulted: ${report.sources_consulted.length > 0 ? report.sources_consulted.join(", ") : "none identified"}`,
      `Sources available: ${report.sources_available.length > 0 ? report.sources_available.join(", ") : "none identified"}`,
      ...(report.sources_available.filter(s => !report.sources_consulted.includes(s)).length > 0
        ? [`Missed sources: ${report.sources_available.filter(s => !report.sources_consulted.includes(s)).join(", ")}`]
        : []),
    ].join("\n");

    const memory = await writeMemory({
      content: postmortemContent,
      type: "finding",
      scope_path: "2/1",
      confidence: 0.85,
      tags: [
        "postmortem:agent_error",
        `channel:${report.channel}`,
        ...(report.agent ? [`agent:${report.agent}`] : []),
        "source:correction_feedback",
      ],
      metadata: {
        source: "data_quality",
        work_item_id: "ELLIE-250",
        what_was_claimed: report.what_was_claimed,
        what_was_correct: report.what_was_correct,
        sources_consulted: report.sources_consulted,
        sources_available: report.sources_available,
        root_cause: report.root_cause,
        correction_memory_id: report.correction_memory_id,
        original_memory_id: report.original_memory_id,
        conversation_id: report.conversation_id,
        channel: report.channel,
        agent: report.agent,
      },
      category: "general",
    });

    logger.info("Agent postmortem logged", {
      memory_id: memory.id,
      root_cause: report.root_cause.substring(0, 60),
      channel: report.channel,
    });

    return memory.id;
  } catch (err) {
    logger.error("Failed to log agent postmortem", err);
    return null;
  }
}

// ── Accuracy Stats ───────────────────────────────────────────

/**
 * Get aggregate accuracy statistics from the Forest.
 * Useful for dashboards and periodic reviews.
 */
export async function getAccuracyStats(
  supabase: SupabaseClient,
): Promise<AccuracyStats> {
  try {
    // Count total corrections
    const { count: totalCorrections } = await supabase
      .from("shared_memories")
      .select("*", { count: "exact", head: true })
      .contains("tags", ["correction:ground_truth"]);

    // Count corrections with linked original
    const { count: linkedCorrections } = await supabase
      .from("shared_memories")
      .select("*", { count: "exact", head: true })
      .contains("tags", ["correction:ground_truth"])
      .not("supersedes_id", "is", null);

    // Count postmortems by channel
    const { data: postmortems } = await supabase
      .from("shared_memories")
      .select("metadata")
      .contains("tags", ["postmortem:agent_error"]);

    const channelCounts: Record<string, number> = {};
    const agentCounts: Record<string, number> = {};

    for (const pm of postmortems || []) {
      const meta = pm.metadata as Record<string, unknown>;
      const channel = (meta?.channel as string) || "unknown";
      const agent = (meta?.agent as string) || "unknown";
      channelCounts[channel] = (channelCounts[channel] || 0) + 1;
      agentCounts[agent] = (agentCounts[agent] || 0) + 1;
    }

    return {
      total_corrections: totalCorrections || 0,
      corrections_with_linked_source: linkedCorrections || 0,
      top_error_categories: Object.entries(channelCounts)
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count),
      accuracy_by_agent: Object.entries(agentCounts)
        .map(([agent, corrections]) => ({ agent, corrections, total_claims: 0 })),
    };
  } catch (err) {
    logger.error("Failed to get accuracy stats", err);
    return {
      total_corrections: 0,
      corrections_with_linked_source: 0,
      top_error_categories: [],
      accuracy_by_agent: [],
    };
  }
}
