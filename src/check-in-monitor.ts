/**
 * Check-in monitor — ELLIE-543
 *
 * Proactive check-in protocol for active agent runs. Monitors wall-clock
 * run duration and decides when to send check-in notifications or
 * escalation alerts, independent of the heartbeat-stale watchdog in
 * orchestration-tracker.ts.
 *
 * The watchdog detects process liveness (heartbeat gap → stale).
 * This module detects long-running sessions (wall-clock age → check-in/escalate).
 *
 * Design:
 *   - Per-agent check-in thresholds (dev: 30min, research: 60min, default: 30min)
 *   - Two tiers: check-in (once at threshold), escalation (once at 2× threshold)
 *   - State tracked per runId — clears when run ends
 *   - `computeCheckInDecisions()` is pure (injectable `now`) — easy to unit test
 *   - Periodic task in periodic-tasks.ts calls this every 5 minutes
 */

import { log } from "./logger.ts";

const logger = log.child("check-in-monitor");

// ── Policy types ──────────────────────────────────────────────────────────────

export interface CheckInPolicy {
  /** How long before the first check-in notification is sent (ms). */
  intervalMs: number;
  /**
   * How long before an escalation alert is sent (ms).
   * Defaults to 2× intervalMs if not specified.
   */
  escalateAfterMs?: number;
}

/**
 * Per-agent check-in policies.
 * dev and research agents run longer tasks and get proportionally longer thresholds.
 * All other agents fall back to _default.
 */
export const AGENT_CHECK_IN_POLICIES: Record<string, CheckInPolicy> = {
  dev:         { intervalMs: 30 * 60_000 },               // 30min / 60min
  research:    { intervalMs: 60 * 60_000 },               // 60min / 120min
  strategy:    { intervalMs: 45 * 60_000 },               // 45min / 90min
  orchestrator: { intervalMs: 30 * 60_000 },              // 30min / 60min
  _default:    { intervalMs: 30 * 60_000 },               // 30min / 60min
};

export function getCheckInPolicy(agentType: string): CheckInPolicy {
  return AGENT_CHECK_IN_POLICIES[agentType] ?? AGENT_CHECK_IN_POLICIES._default;
}

// ── Per-run check-in state ────────────────────────────────────────────────────

interface RunCheckInState {
  checkedInAt?: number;
  escalatedAt?: number;
}

const _sentState = new Map<string, RunCheckInState>();

export function markCheckInSent(runId: string): void {
  const s = _sentState.get(runId) ?? {};
  _sentState.set(runId, { ...s, checkedInAt: Date.now() });
}

export function markEscalationSent(runId: string): void {
  const s = _sentState.get(runId) ?? {};
  _sentState.set(runId, { ...s, escalatedAt: Date.now() });
}

/**
 * Clear check-in state for a run that has ended.
 * Should be called from endRun() or the periodic task when runs are no longer active.
 */
export function clearCheckInState(runId: string): void {
  _sentState.delete(runId);
}

/** Reset all state — for unit tests only. */
export function _resetCheckInStateForTesting(): void {
  _sentState.clear();
}

// ── Decision engine ───────────────────────────────────────────────────────────

export interface CheckInInput {
  runId: string;
  agentType: string;
  workItemId?: string;
  startedAt: number;
  status: string;
}

export type CheckInAction = "none" | "check-in" | "escalate";

export interface CheckInDecision {
  runId: string;
  agentType: string;
  workItemId?: string;
  ageMs: number;
  action: CheckInAction;
}

/**
 * Compute which runs need a check-in or escalation notification.
 *
 * Pure function — `now` is injectable for testing.
 * Only considers runs with status "running".
 */
export function computeCheckInDecisions(
  runs: CheckInInput[],
  now: number = Date.now(),
): CheckInDecision[] {
  const decisions: CheckInDecision[] = [];

  for (const run of runs) {
    if (run.status !== "running") continue;

    const ageMs = now - run.startedAt;
    const policy = getCheckInPolicy(run.agentType);
    const escalateMs = policy.escalateAfterMs ?? policy.intervalMs * 2;
    const state = _sentState.get(run.runId);

    let action: CheckInAction = "none";

    if (ageMs >= escalateMs && !state?.escalatedAt) {
      action = "escalate";
    } else if (ageMs >= policy.intervalMs && !state?.checkedInAt && !state?.escalatedAt) {
      // Suppress check-in if escalation was already sent (escalation is a superset)
      action = "check-in";
    }

    decisions.push({
      runId: run.runId,
      agentType: run.agentType,
      workItemId: run.workItemId,
      ageMs,
      action,
    });
  }

  return decisions;
}

// ── Status summary ────────────────────────────────────────────────────────────

export interface CheckInStatusEntry {
  runId: string;
  agentType: string;
  workItemId?: string;
  startedAt: number;
  ageMs: number;
  policy: CheckInPolicy;
  checkInSent: boolean;
  escalationSent: boolean;
  nextCheckInAt: number;
  nextEscalationAt: number;
}

/**
 * Return check-in status for a set of active runs.
 * Used by /api/orchestration/status and /health endpoint enrichment.
 */
export function getCheckInStatus(
  runs: CheckInInput[],
  now: number = Date.now(),
): CheckInStatusEntry[] {
  return runs
    .filter(r => r.status === "running")
    .map(run => {
      const policy = getCheckInPolicy(run.agentType);
      const escalateMs = policy.escalateAfterMs ?? policy.intervalMs * 2;
      const state = _sentState.get(run.runId);
      return {
        runId: run.runId,
        agentType: run.agentType,
        workItemId: run.workItemId,
        startedAt: run.startedAt,
        ageMs: now - run.startedAt,
        policy,
        checkInSent: !!state?.checkedInAt,
        escalationSent: !!state?.escalatedAt,
        nextCheckInAt: run.startedAt + policy.intervalMs,
        nextEscalationAt: run.startedAt + escalateMs,
      };
    });
}

// ── Periodic runner ───────────────────────────────────────────────────────────

/**
 * Execute check-in decisions for a set of active runs.
 * Called by the periodic task in periodic-tasks.ts.
 *
 * Separated from the periodic task registration so it can be called
 * directly in integration tests without a live bot.
 */
export async function runCheckInMonitor(
  runs: CheckInInput[],
  notify: (opts: { event: string; workItemId: string; telegramMessage: string; gchatMessage?: string }) => Promise<void>,
  now: number = Date.now(),
): Promise<{ checkedIn: number; escalated: number }> {
  const decisions = computeCheckInDecisions(runs, now);
  let checkedIn = 0;
  let escalated = 0;

  for (const d of decisions) {
    const mins = Math.round(d.ageMs / 60_000);
    const ticket = d.workItemId ?? "?";

    if (d.action === "check-in") {
      try {
        await notify({
          event: "session_update",
          workItemId: ticket,
          telegramMessage: `⏰ Check-in: ${d.agentType} has been working on ${ticket} for ${mins}min`,
          gchatMessage: `Check-in: ${d.agentType} active on ${ticket} (${mins}min)`,
        });
        markCheckInSent(d.runId);
        checkedIn++;
        logger.info(`[check-in-monitor] Check-in sent for ${d.agentType} on ${ticket} (${mins}min)`);
      } catch (err) {
        logger.warn(`[check-in-monitor] Failed to send check-in for ${ticket}`, { error: err instanceof Error ? err.message : String(err) });
      }
    } else if (d.action === "escalate") {
      try {
        await notify({
          event: "run_stale",
          workItemId: ticket,
          telegramMessage: `⚠️ Long-running: ${d.agentType} on ${ticket} for ${mins}min — consider escalating`,
          gchatMessage: `Long-running: ${d.agentType} on ${ticket} for ${mins}min — consider escalating`,
        });
        markEscalationSent(d.runId);
        escalated++;
        logger.info(`[check-in-monitor] Escalation sent for ${d.agentType} on ${ticket} (${mins}min)`);
      } catch (err) {
        logger.warn(`[check-in-monitor] Failed to send escalation for ${ticket}`, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return { checkedIn, escalated };
}
