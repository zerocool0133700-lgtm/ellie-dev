/**
 * GTD Recovery — Context Compaction Recovery (ELLIE-1273)
 *
 * After context compaction, the coordinator can lose track of active agent
 * dispatches and pending questions. This module rebuilds that state by querying
 * GTD and writing a structured summary to working memory.
 *
 * Formatting functions (formatDispatchSummary, formatPendingAnswers) are pure
 * and used directly in tests. rebuildDispatchStateFromGTD is the main integration
 * point, called fire-and-forget from the coordinator loop after compaction.
 */

import { log } from "./logger.ts";

const logger = log.child("gtd-recovery");

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Local node type for the 3-level dispatch tree:
 *   Level 1 — coordinator parent (the original request)
 *   Level 2 — dispatch children (one per agent task)
 *   Level 3 — question grandchildren (agent questions for Dave)
 *
 * Defined locally to avoid coupling with gtd-orchestration.ts internals.
 * The fields here are a strict subset of DispatchTree plus item_type.
 */
export interface DispatchTreeNode {
  id: string;
  content: string;
  status: string;
  item_type?: string;
  assigned_agent?: string | null;
  metadata?: Record<string, unknown>;
  children: DispatchTreeNode[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + "...";
}

// ── Formatting — pure functions ───────────────────────────────────────────────

/**
 * Format active dispatch children as a structured summary string.
 *
 * Example output:
 *   ACTIVE DISPATCHES (recovered from GTD):
 *   - james: "Implement auth middleware" — waiting (question pending)
 *   - kate: "Research query optimization" — working
 */
export function formatDispatchSummary(tree: DispatchTreeNode): string {
  const lines: string[] = ["ACTIVE DISPATCHES (recovered from GTD):"];

  for (const child of tree.children) {
    if (child.item_type === "agent_dispatch" || child.assigned_agent) {
      const agent = child.assigned_agent ?? "unknown";
      const hasQuestion = child.children.some(
        (gc) => gc.item_type === "agent_question" && gc.status !== "done"
      );
      const statusText =
        hasQuestion
          ? "waiting (question pending)"
          : child.status === "done"
          ? "completed"
          : "working";
      lines.push(`- ${agent}: "${truncate(child.content, 60)}" — ${statusText}`);
    }
  }

  return lines.join("\n");
}

/**
 * Extract all unanswered question grandchildren as a formatted anchor string.
 *
 * Returns an empty string when there are no pending questions.
 *
 * Example output:
 *   PENDING QUESTIONS:
 *   q-7f3a2b1c (james): "JWT or session cookies?" — Need: Pick one
 */
export function formatPendingAnswers(tree: DispatchTreeNode): string {
  const pending: string[] = [];

  for (const child of tree.children) {
    for (const gc of child.children) {
      if (gc.item_type === "agent_question" && gc.status !== "done") {
        const qId = (gc.metadata?.question_id as string) ?? "unknown";
        const agent = child.assigned_agent ?? "unknown";
        const need = (gc.metadata?.what_i_need as string) ?? "";
        pending.push(
          `${qId} (${agent}): "${truncate(gc.content, 80)}" — Need: ${need}`
        );
      }
    }
  }

  if (pending.length === 0) return "";
  return "PENDING QUESTIONS:\n" + pending.join("\n");
}

// ── Main recovery function ────────────────────────────────────────────────────

/**
 * Query GTD for active orchestration trees and write a structured summary to
 * working memory so the coordinator can continue without amnesia after compaction.
 *
 * This function is non-fatal — it wraps all I/O in try/catch and never throws.
 * The caller should invoke it fire-and-forget (no await needed) but it is safe
 * to await if the caller wants to ensure the write completes.
 *
 * @param sessionId             — coordinator session ID
 * @param coordinatorParentId   — GTD parent item ID for this coordinator session (may be null)
 * @param updateWorkingMemory   — the deps.updateWorkingMemory callback from the coordinator
 * @param logger_               — optional logger override (defaults to module logger)
 */
export async function rebuildDispatchStateFromGTD(
  sessionId: string,
  coordinatorParentId: string | null,
  updateWorkingMemory: (sections: Record<string, string>) => Promise<void>,
  logger_?: { warn: (msg: string, meta?: Record<string, unknown>) => void; info: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<void> {
  const log_ = logger_ ?? logger;

  try {
    const gtdMod = await import("./gtd-orchestration.ts");
    const trees = await gtdMod.getActiveOrchestrationTrees();

    if (trees.length === 0) {
      log_.info("GTD recovery: no active trees found", { sessionId, coordinatorParentId });
      return;
    }

    // If we have a specific parent ID, prefer that tree; otherwise use all trees
    const targetTrees = coordinatorParentId
      ? trees.filter((t) => t.id === coordinatorParentId)
      : trees;

    if (targetTrees.length === 0) {
      log_.info("GTD recovery: parent tree not found, using all active trees", {
        sessionId,
        coordinatorParentId,
        totalTrees: trees.length,
      });
    }

    const treesToUse = targetTrees.length > 0 ? targetTrees : trees;

    // Build formatted sections from all relevant trees
    const summaryParts: string[] = [];
    const answerParts: string[] = [];

    for (const tree of treesToUse) {
      summaryParts.push(formatDispatchSummary(tree as DispatchTreeNode));
      const answers = formatPendingAnswers(tree as DispatchTreeNode);
      if (answers) answerParts.push(answers);
    }

    const taskStackSection = summaryParts.join("\n\n");
    const contextAnchorsSection = answerParts.join("\n\n");

    const sections: Record<string, string> = {
      task_stack: taskStackSection,
    };

    if (contextAnchorsSection) {
      sections.context_anchors = contextAnchorsSection;
    }

    await updateWorkingMemory(sections);

    log_.info("GTD recovery complete", {
      sessionId,
      coordinatorParentId,
      treesRecovered: treesToUse.length,
      hasPendingQuestions: answerParts.length > 0,
    });
  } catch (err: unknown) {
    log_.warn("GTD recovery failed", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
