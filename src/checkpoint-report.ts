/**
 * ELLIE-717: Checkpoint Progress Report Generator
 *
 * Produces done/next/blockers summaries at each checkpoint by extracting
 * status from working memory sections. Reports are concise and mobile-scannable.
 *
 * Pure functions — no I/O. Caller passes working memory sections and metadata.
 */

import type { CheckpointReport } from "./checkpoint-types.ts";
import type { WorkingMemorySections } from "./working-memory.ts";

// ── Extraction helpers (pure) ────────────────────────────────

/**
 * Extract "what's done" from working memory.
 * Sources: task_stack (completed items), conversation_thread (narrative), decision_log.
 */
export function extractDone(sections: WorkingMemorySections): string {
  const parts: string[] = [];

  // Pull completed tasks from task_stack
  if (sections.task_stack) {
    const completedLines = sections.task_stack
      .split("\n")
      .filter(line => {
        const lower = line.toLowerCase();
        return lower.includes("[x]") || lower.includes("✅") ||
          lower.includes("[done]") || lower.includes("completed") ||
          lower.includes("✓");
      })
      .map(line => line.replace(/^[\s\-*]*(\[x\]|\[done\]|✅|✓)\s*/i, "").trim())
      .filter(Boolean);
    if (completedLines.length) {
      parts.push(completedLines.join("; "));
    }
  }

  // Fall back to conversation_thread summary if no completed tasks found
  if (!parts.length && sections.conversation_thread) {
    const summary = truncate(sections.conversation_thread, 200);
    if (summary) parts.push(summary);
  }

  // Include key decisions
  if (sections.decision_log) {
    const decisions = extractRecentItems(sections.decision_log, 2);
    if (decisions) parts.push(`Decisions: ${decisions}`);
  }

  return parts.join(". ") || "Work in progress";
}

/**
 * Extract "what's next" from working memory.
 * Sources: task_stack (pending/in-progress items), resumption_prompt.
 */
export function extractNext(sections: WorkingMemorySections): string {
  // Look for in-progress or pending tasks
  if (sections.task_stack) {
    const pendingLines = sections.task_stack
      .split("\n")
      .filter(line => {
        const lower = line.toLowerCase();
        return (lower.includes("[ ]") || lower.includes("→") ||
          lower.includes("[in progress]") || lower.includes("🔄") ||
          lower.includes("pending") || lower.includes("next:")) &&
          !lower.includes("[x]") && !lower.includes("✅") &&
          !lower.includes("[done]") && !lower.includes("✓");
      })
      .map(line => line.replace(/^[\s\-*]*(\[ \]|→|🔄)\s*/i, "").trim())
      .filter(Boolean);
    if (pendingLines.length) {
      return pendingLines.slice(0, 3).join("; ");
    }
  }

  // Fall back to resumption_prompt
  if (sections.resumption_prompt) {
    return truncate(sections.resumption_prompt, 200);
  }

  return "Continuing current work";
}

/**
 * Extract blockers from working memory.
 * Sources: investigation_state (look for blocker/issue keywords), context_anchors (errors).
 */
export function extractBlockers(sections: WorkingMemorySections): string {
  const blockers: string[] = [];

  if (sections.investigation_state) {
    const blockerLines = sections.investigation_state
      .split("\n")
      .filter(line => {
        const lower = line.toLowerCase();
        return lower.includes("block") || lower.includes("stuck") ||
          lower.includes("error") || lower.includes("fail") ||
          lower.includes("issue") || lower.includes("waiting") ||
          lower.includes("⚠");
      })
      .map(line => line.replace(/^[\s\-*]*/, "").trim())
      .filter(Boolean);
    if (blockerLines.length) {
      blockers.push(...blockerLines.slice(0, 2));
    }
  }

  // Check context_anchors for error messages
  if (sections.context_anchors) {
    const errorLines = sections.context_anchors
      .split("\n")
      .filter(line => {
        const lower = line.toLowerCase();
        return lower.includes("error") || lower.includes("fail") || lower.includes("exception");
      })
      .map(line => line.replace(/^[\s\-*]*/, "").trim())
      .filter(Boolean);
    if (errorLines.length) {
      blockers.push(...errorLines.slice(0, 1));
    }
  }

  return blockers.join("; ") || "";
}

// ── Report generation ────────────────────────────────────────

/**
 * Generate a CheckpointReport from working memory and checkpoint metadata.
 * Pure function — no I/O.
 */
export function generateCheckpointReport(
  sections: WorkingMemorySections,
  percent: number,
  elapsedMinutes: number,
  estimatedTotalMinutes: number,
  turnCount?: number,
): CheckpointReport {
  return {
    percent,
    elapsed_minutes: elapsedMinutes,
    estimated_total_minutes: estimatedTotalMinutes,
    done: extractDone(sections),
    next: extractNext(sections),
    blockers: extractBlockers(sections),
    turn_count: turnCount,
  };
}

/**
 * Format a CheckpointReport as a human-readable message (for Telegram/chat).
 * Concise, mobile-scannable, no markdown bloat.
 */
export function formatCheckpointMessage(
  report: CheckpointReport,
  workItemId?: string,
): string {
  const header = workItemId
    ? `${workItemId} — ${report.percent}% checkpoint`
    : `${report.percent}% checkpoint`;

  const timeRemaining = Math.max(0, report.estimated_total_minutes - report.elapsed_minutes);
  const timeInfo = `${report.elapsed_minutes}min elapsed, ~${timeRemaining}min remaining`;

  const lines = [header, timeInfo, ""];

  lines.push(`Done: ${report.done}`);
  lines.push(`Next: ${report.next}`);

  if (report.blockers) {
    lines.push(`Blockers: ${report.blockers}`);
  }

  return lines.join("\n");
}

/**
 * Format a CheckpointReport as a compact single-line summary (for logs/queue).
 */
export function formatCheckpointCompact(
  report: CheckpointReport,
  workItemId?: string,
): string {
  const prefix = workItemId ? `[${workItemId}]` : "";
  const time = `${report.elapsed_minutes}/${report.estimated_total_minutes}min`;
  const blocker = report.blockers ? ` | BLOCKED: ${truncate(report.blockers, 80)}` : "";
  return `${prefix} ${report.percent}% (${time}): ${truncate(report.done, 100)}${blocker}`.trim();
}

// ── Internal helpers ─────────────────────────────────────────

function truncate(text: string, maxLen: number): string {
  const cleaned = text.replace(/\n+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1) + "…";
}

function extractRecentItems(text: string, count: number): string {
  const lines = text
    .split("\n")
    .map(l => l.replace(/^[\s\-*]*/, "").trim())
    .filter(Boolean);
  if (!lines.length) return "";
  return lines.slice(-count).join("; ");
}
