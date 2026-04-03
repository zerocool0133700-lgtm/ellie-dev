/**
 * Progress Reporter — ELLIE-1311
 *
 * Emits progress events for running dispatches. The coordinator calls
 * reportProgress() after reading a specialist's working memory.
 */

import { log } from "./logger.ts";
import { emitDispatchEvent } from "./dispatch-events.ts";

const logger = log.child("progress-reporter");

const MAX_PROGRESS_LINE_LENGTH = 100;

export function reportProgress(
  runId: string,
  agent: string,
  title: string,
  progressLine: string,
  workItemId?: string | null,
): void {
  const truncated = progressLine.length > MAX_PROGRESS_LINE_LENGTH
    ? progressLine.slice(0, MAX_PROGRESS_LINE_LENGTH) + "..."
    : progressLine;

  emitDispatchEvent(runId, "progress", {
    agent,
    title,
    progress_line: truncated,
    work_item_id: workItemId,
    dispatch_type: "single",
  });

  logger.debug("Progress reported", { runId: runId.slice(0, 8), agent, line: truncated });
}

export function extractProgressLine(investigationState: string): string | null {
  if (!investigationState) return null;

  const lines = investigationState
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("---"));

  if (lines.length === 0) return null;
  return lines[lines.length - 1];
}
