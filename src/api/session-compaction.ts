/**
 * Session Compaction — ELLIE-450
 *
 * Token usage monitoring and proactive checkpointing for long conversations.
 * Prevents context window compaction from destroying session state.
 *
 * Thresholds:
 *   60% → append a gentle warning to the response
 *   80% → warning + auto-checkpoint key session state to Forest
 */

import type { BuildMetrics } from "../prompt-builder.ts";
import { writeMemory } from "../../../ellie-forest/src/index";
import { log } from "../logger.ts";

const logger = log.child("session-compaction");

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Hash a string to a 32-bit signed integer for PostgreSQL advisory locks.
 * Uses a simple FNV-1a hash algorithm.
 */
function hashStringToInt32(str: string): number {
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619); // FNV prime
  }
  return hash | 0; // Convert to signed 32-bit int
}

const WARN_THRESHOLD     = 0.70;  // 70% → suggest wrapping up (ELLIE-628: raised from 60% for 100k window)
const CRITICAL_THRESHOLD = 0.85;  // 85% → auto-checkpoint + urgent notice (ELLIE-628: raised from 80%)

// ── Types ──────────────────────────────────────────────────────────────────

export type PressureLevel = "ok" | "warn" | "critical";

export interface ContextPressure {
  level: PressureLevel;
  pct: number;
  tokensUsed: number;
  budget: number;
}

export interface CheckpointOpts {
  conversationId: string;
  agentName: string;
  mode: string;
  workItemId?: string | null;
  pressure: ContextPressure;
  sections: BuildMetrics["sections"];
  lastUserMessage: string;
}

// ── Deduplication ─────────────────────────────────────────────────────────
// In-memory set — prevents warning on every message once a threshold is crossed.
// Keyed as `${conversationId}:${level}`. Clears on relay restart.

const _notified = new Set<string>();

/** Reset notification state — for unit tests only. */
export function _resetNotifiedForTesting(): void {
  _notified.clear();
}

/**
 * Returns true if Dave should be notified for this conversation + pressure level.
 * Each conversation is notified at most once per level per relay lifetime.
 */
export function shouldNotify(conversationId: string | undefined, level: PressureLevel): boolean {
  if (level === "ok" || !conversationId) return false;
  const key = `${conversationId}:${level}`;
  if (_notified.has(key)) return false;
  _notified.add(key);
  return true;
}

// ── Core ───────────────────────────────────────────────────────────────────

/** Compute context pressure from the current build metrics. */
export function checkContextPressure(metrics: BuildMetrics): ContextPressure {
  const { totalTokens, budget } = metrics;
  if (!budget) return { level: "ok", pct: 0, tokensUsed: totalTokens, budget: 0 };

  const pct = totalTokens / budget;
  const level: PressureLevel =
    pct >= CRITICAL_THRESHOLD ? "critical" :
    pct >= WARN_THRESHOLD     ? "warn"     : "ok";

  return { level, pct, tokensUsed: totalTokens, budget };
}

/**
 * A short notice appended to the Claude response when thresholds are crossed.
 * Inline — doesn't interrupt the flow, just informs.
 */
export function getCompactionNotice(pressure: ContextPressure): string {
  const pct = Math.round(pressure.pct * 100);
  if (pressure.level === "critical") {
    return (
      `\n\n---\n` +
      `⚠️ **Context at ${pct}%** — session state auto-checkpointed to Forest. ` +
      `Consider wrapping up this topic or starting a fresh session for the next task.`
    );
  }
  return (
    `\n\n---\n` +
    `💡 **Context at ${pct}%** — this session is getting long. ` +
    `Consider starting a fresh session for the next topic to stay sharp.`
  );
}

// ── Checkpoint ─────────────────────────────────────────────────────────────

/**
 * Write session state to Forest before compaction hits.
 * Non-blocking — caller should fire-and-forget with .catch().
 *
 * ELLIE-922 Phase 1: Integrated compaction safeguard verification and rollback.
 * ELLIE-922 Critical Issue #1: PostgreSQL advisory lock prevents concurrent checkpoints.
 * ELLIE-923 Phase 1: Includes pre-compaction working memory snapshot
 * to preserve full session state before context compression.
 */
export async function checkpointSessionToForest(opts: CheckpointOpts): Promise<void> {
  const { conversationId, agentName, mode, workItemId, pressure, sections, lastUserMessage } = opts;

  // ELLIE-922 Critical Issue #1: Acquire advisory lock to prevent concurrent checkpoints
  // Lock key = hash of (session_id + agent) to ensure per-session locking
  const { default: sql } = await import("../../../ellie-forest/src/db.ts");
  const lockKey = hashStringToInt32(`checkpoint:${conversationId}:${agentName}`);

  try {
    // Try to acquire advisory lock (non-blocking). Returns true if acquired, false if already held.
    const [lockResult] = await sql<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(${lockKey}) as acquired
    `;

    if (!lockResult?.acquired) {
      logger.warn("[compaction] Concurrent checkpoint already in progress, skipping", {
        conversationId,
        agentName,
      });
      return; // Another checkpoint is already running for this session
    }

    // Lock acquired — proceed with checkpoint (will be released in finally block)
  } catch (lockErr) {
    logger.error("[compaction] Failed to acquire advisory lock", { conversationId, agentName }, lockErr);
    return;
  }

  try {
    // ELLIE-923: Snapshot working memory to Forest before compaction
  // This preserves all 7 sections of working memory state
  let snapshotMemoryId: string | null = null;
  try {
    const { snapshotWorkingMemoryToForest } = await import("../working-memory.ts");
    snapshotMemoryId = await snapshotWorkingMemoryToForest({
      session_id: conversationId,
      agent: agentName,
      work_item_id: workItemId ?? undefined,
      scope_path: "2/1",
    });
  } catch (err) {
    logger.error("[compaction] Working memory snapshot failed (non-fatal)", { conversationId, agentName }, err);
    // Continue with regular checkpoint even if snapshot fails
  }

  const top5 = [...sections]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5)
    .map(s => `${s.label}: ${s.tokens}`)
    .join(", ");

  const lines = [
    `Session checkpoint — context at ${Math.round(pressure.pct * 100)}% of ${pressure.budget} token budget.`,
    `Agent: ${agentName} | Mode: ${mode}`,
    workItemId ? `Work item: ${workItemId}` : null,
    `Tokens used: ${pressure.tokensUsed} | Top sections: ${top5}`,
    `Last user message: ${lastUserMessage.slice(0, 400)}`,
    `Auto-saved before context compaction window.`,
  ].filter(Boolean);

  await writeMemory({
    content: lines.join("\n"),
    type: "finding",
    scope_path: "2/1",
    confidence: 0.7,
    tags: ["session-checkpoint", "compaction"],
    metadata: {
      work_item_id: workItemId ?? undefined,
      conversation_id: conversationId,
      checkpoint: true,
      pressure_pct: pressure.pct,
      tokens_used: pressure.tokensUsed,
      budget: pressure.budget,
    },
  });

  logger.info("[compaction] Checkpoint written", {
    conversationId,
    pct: Math.round(pressure.pct * 100),
    workItemId,
  });

  // ELLIE-922: Verify working memory survived and rollback if needed
  // This runs after checkpoint to ensure critical sections are preserved
  if (snapshotMemoryId) {
    try {
      const { verifyWorkingMemorySurvived, rollbackWorkingMemoryFromSnapshot } =
        await import("../compaction-safeguard.ts");
      const { unlockSafeguard } = await import("../working-memory.ts");

      // ELLIE-922 Critical Issue #2: Require snapshot to exist (fail verification if missing)
      const verification = await verifyWorkingMemorySurvived({
        session_id: conversationId,
        agent: agentName,
        pre_snapshot_memory_id: snapshotMemoryId,
        require_snapshot: true,
      });

      if (!verification.ok) {
        logger.warn("[compaction] Safeguard verification failed, initiating rollback", {
          conversationId,
          agentName,
          lost_sections: verification.lost_sections,
          lost_identifiers: verification.lost_identifiers,
        });

        // Rollback from snapshot
        const rollbackSuccess = await rollbackWorkingMemoryFromSnapshot({
          session_id: conversationId,
          agent: agentName,
          pre_snapshot: verification.pre_snapshot,
        });

        if (rollbackSuccess) {
          logger.info("[compaction] Rollback completed successfully", {
            conversationId,
            agentName,
            snapshot_id: snapshotMemoryId,
          });

          // ELLIE-922 Critical Issue #3: Unlock safeguard after rollback completes
          // Rollback has restored the snapshot state, now safe to allow updates again
          await unlockSafeguard({
            session_id: conversationId,
            agent: agentName,
          });

          // Append rollback event to working memory decision log
          const { readWorkingMemory, updateWorkingMemory } = await import("../working-memory.ts");
          const currentMemory = await readWorkingMemory({
            session_id: conversationId,
            agent: agentName,
          });

          const timestamp = new Date().toISOString();
          const rollbackNote =
            `[${timestamp}] Compaction safeguard triggered automatic rollback. ` +
            `Lost sections: ${verification.lost_sections?.join(", ") || "none"}. ` +
            `Lost identifiers: ${verification.lost_identifiers?.slice(0, 5).join(", ") || "none"}. ` +
            `Restored from snapshot ${snapshotMemoryId}.`;

          const existingLog = currentMemory?.sections.decision_log || "";
          const updatedLog = existingLog
            ? `${existingLog}\n\n${rollbackNote}`
            : rollbackNote;

          await updateWorkingMemory({
            session_id: conversationId,
            agent: agentName,
            sections: {
              decision_log: updatedLog,
            },
          });
        } else {
          logger.error("[compaction] Rollback failed", {
            conversationId,
            agentName,
          });
          // ELLIE-922 Critical Issue #3: Unlock even if rollback failed
          // Leave working memory in whatever state it's in, but restore update capability
          await unlockSafeguard({
            session_id: conversationId,
            agent: agentName,
          });
        }
      } else {
        logger.info("[compaction] Safeguard verification passed", {
          conversationId,
          agentName,
        });
        // ELLIE-922 Critical Issue #3: Unlock safeguard after successful verification
        await unlockSafeguard({
          session_id: conversationId,
          agent: agentName,
        });
      }
    } catch (err) {
      logger.error("[compaction] Safeguard verification/rollback failed (non-fatal)",
        { conversationId, agentName }, err);
      // ELLIE-922 Critical Issue #3: Always unlock on error to prevent permanent lock
      try {
        const { unlockSafeguard } = await import("../working-memory.ts");
        await unlockSafeguard({
          session_id: conversationId,
          agent: agentName,
        });
      } catch (unlockErr) {
        logger.error("[compaction] Failed to unlock safeguard after error", { conversationId, agentName }, unlockErr);
      }
    }
  }
  } finally {
    // ELLIE-922 Critical Issue #1: Always release advisory lock
    try {
      await sql`SELECT pg_advisory_unlock(${lockKey})`;
    } catch (unlockErr) {
      logger.error("[compaction] Failed to release advisory lock", { conversationId, agentName }, unlockErr);
    }
  }
}
