/**
 * Orchestration Context — ELLIE-351
 *
 * Generates prompt text from active orchestration runs for injection
 * into Ellie's context. Gives her awareness of what agents are doing.
 */

import { getActiveRunStates, type RunState } from "../orchestration-tracker.ts";
import { getRecentEvents, type OrchestrationEvent } from "../orchestration-ledger.ts";

/**
 * Build orchestration status text for prompt injection.
 * Returns empty string if nothing is active or recent.
 */
export async function getOrchestrationContext(): Promise<string> {
  const runs = getActiveRunStates();
  const sections: string[] = [];

  if (runs.length > 0) {
    sections.push("ACTIVE AGENT RUNS:");
    for (const run of runs) {
      const elapsed = formatElapsed(Date.now() - run.startedAt);
      const hbAgo = formatElapsed(Date.now() - run.lastHeartbeat);
      const status = run.status === "stale" ? " [STALE]" : "";
      const workItem = run.workItemId ? ` on ${run.workItemId}` : "";
      sections.push(`- ${run.agentType} agent${workItem} (running ${elapsed}, last heartbeat ${hbAgo} ago)${status}`);
    }
  }

  // Include recent completions for awareness
  try {
    const recent = await getRecentEvents(5);
    const completions = recent.filter(
      (e) => e.event_type === "completed" || e.event_type === "failed"
    );
    if (completions.length > 0) {
      sections.push("");
      sections.push("RECENT COMPLETIONS:");
      for (const evt of completions) {
        const time = new Date(evt.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const workItem = evt.work_item_id ? ` (${evt.work_item_id})` : "";
        const duration = evt.payload?.duration_ms
          ? ` in ${formatElapsed(evt.payload.duration_ms as number)}`
          : "";
        sections.push(`- ${evt.agent_type || "agent"} ${evt.event_type}${workItem}${duration} at ${time}`);
      }
    }
  } catch {
    // Non-fatal
  }

  return sections.length > 0 ? sections.join("\n") : "";
}

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}
