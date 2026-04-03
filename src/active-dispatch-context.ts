/**
 * Active Dispatch Context — ELLIE-1316
 *
 * Builds a summary of currently active dispatches for injection into
 * Max's coordinator prompt. Only included when dispatches are running.
 */

import { log } from "./logger.ts";
import { getActiveRunStates, type RunState } from "./orchestration-tracker.ts";
import { getRecentEvents, type OrchestrationEvent } from "./orchestration-ledger.ts";

const logger = log.child("active-dispatch-context");

/**
 * Build a markdown summary of active dispatches for the coordinator prompt.
 * Returns null if no dispatches are running (caller should skip injection).
 */
export async function buildActiveDispatchContext(threadId?: string): Promise<string | null> {
  let runs = getActiveRunStates().filter(r => r.status === "running");

  // ELLIE-1374 Phase 3: Filter by thread if provided
  if (threadId) {
    runs = runs.filter(r => (r as any).thread_id === threadId);
  }
  if (runs.length === 0) return null;

  // Get recent events to enrich with progress lines and titles
  let events: OrchestrationEvent[] = [];
  try {
    events = await getRecentEvents(100);
  } catch {
    // If ledger is unavailable, build context from tracker state only
  }

  // Build a map of run_id → latest event info
  const eventsByRun = new Map<string, { agent: string; title: string; progress_line: string | null }>();
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    const existing = eventsByRun.get(event.run_id);
    // Keep the most recent event's data (events are DESC ordered)
    if (!existing) {
      eventsByRun.set(event.run_id, {
        agent: (payload.agent as string) || event.agent_type || "unknown",
        title: (payload.title as string) || "Unknown task",
        progress_line: (payload.progress_line as string) || null,
      });
    }
  }

  const lines: string[] = [];
  for (const run of runs) {
    const info = eventsByRun.get(run.runId);
    const agent = info?.agent || run.agentType || "unknown";
    const title = info?.title || run.message || "Unknown task";
    const progress = info?.progress_line ? `, last progress: "${info.progress_line}"` : "";
    const elapsedMin = Math.round((Date.now() - run.startedAt) / 60000);
    const workItem = run.workItemId ? ` on ${run.workItemId}` : "";

    lines.push(`- **${agent}** is working${workItem}: "${title}" (${elapsedMin} min elapsed${progress})`);
  }

  return `## Active Dispatches
${lines.join("\n")}

When Dave's message relates to active work:
- Queue the context for that agent and tell Dave it's queued
When it's new work:
- Dispatch normally
When it's general conversation:
- Dispatch to Ellie`;
}
