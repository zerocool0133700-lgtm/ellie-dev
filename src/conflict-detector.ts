/**
 * Conflict Detector — ELLIE-1325
 *
 * Detects file path overlap between dispatches. Uses known data only:
 * - dispatch_outcomes.files_changed from completed dispatches
 * - File paths extracted from active dispatch progress events
 *
 * Does NOT predict file paths for not-yet-started dispatches.
 */

import { log } from "./logger.ts";
import { getRecentOutcomes, type DispatchOutcomeRow } from "./dispatch-outcomes.ts";
import { getActiveRunStates } from "./orchestration-tracker.ts";
import { getRecentEvents } from "./orchestration-ledger.ts";

const logger = log.child("conflict-detector");

export interface FileConflict {
  activeRunId: string;
  activeAgent: string;
  activeWorkItem: string | null;
  overlappingFiles: string[];
}

/**
 * Detect file conflicts between a work item's known files and active dispatches.
 * @param workItemId - The work item to check against
 * @param knownFiles - Files this dispatch will touch (from outcomes or explicit list)
 */
export async function detectFileConflicts(
  workItemId: string,
  knownFiles?: string[],
): Promise<FileConflict[]> {
  const activeRuns = getActiveRunStates().filter(r => r.status === "running");
  if (activeRuns.length === 0) return [];

  // Gather known files for this work item from historical outcomes
  let filesToCheck = new Set(knownFiles ?? []);
  if (filesToCheck.size === 0) {
    try {
      const outcomes = await getRecentOutcomes(168, 100);
      for (const o of outcomes) {
        if (o.work_item_id === workItemId && o.files_changed) {
          for (const f of o.files_changed) filesToCheck.add(f);
        }
      }
    } catch {
      // Outcomes unavailable
    }
  }

  if (filesToCheck.size === 0) return [];

  // Get files being touched by active dispatches from progress events
  const activeFiles = new Map<string, Set<string>>();
  try {
    const events = await getRecentEvents(200);
    for (const event of events) {
      if (event.event_type !== "progress") continue;
      const payload = event.payload as Record<string, unknown>;
      const progressLine = payload.progress_line as string;
      if (!progressLine) continue;

      const pathMatches = progressLine.match(/(?:[\w-]+\/)+[\w.-]+\.\w+/g);
      if (pathMatches) {
        if (!activeFiles.has(event.run_id)) activeFiles.set(event.run_id, new Set());
        for (const p of pathMatches) activeFiles.get(event.run_id)!.add(p);
      }
    }
  } catch { /* Events unavailable */ }

  // Also check completed outcomes for active runs' work items
  try {
    const outcomes = await getRecentOutcomes(24, 50);
    for (const run of activeRuns) {
      for (const o of outcomes) {
        if (o.run_id === run.runId && o.files_changed) {
          if (!activeFiles.has(run.runId)) activeFiles.set(run.runId, new Set());
          for (const f of o.files_changed) activeFiles.get(run.runId)!.add(f);
        }
      }
    }
  } catch { /* Outcomes unavailable */ }

  // Find overlaps
  const conflicts: FileConflict[] = [];
  for (const run of activeRuns) {
    if (run.workItemId === workItemId) continue; // Don't conflict with self

    const runFiles = activeFiles.get(run.runId);
    if (!runFiles || runFiles.size === 0) continue;

    const overlap = [...filesToCheck].filter(f => runFiles.has(f));
    if (overlap.length > 0) {
      conflicts.push({
        activeRunId: run.runId,
        activeAgent: run.agentType || "unknown",
        activeWorkItem: run.workItemId || null,
        overlappingFiles: overlap,
      });
      logger.info("File conflict detected", { workItemId, activeRunId: run.runId, agent: run.agentType, files: overlap });
    }
  }

  return conflicts;
}
