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
 */
export async function checkpointSessionToForest(opts: CheckpointOpts): Promise<void> {
  const { conversationId, agentName, mode, workItemId, pressure, sections, lastUserMessage } = opts;

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
}
