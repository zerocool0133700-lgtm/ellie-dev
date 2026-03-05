/**
 * ELLIE-543 — Check-in monitor tests
 *
 * Tests for the check-in protocol logic in src/check-in-monitor.ts.
 * All tests operate on pure functions with injectable `now` — no server needed.
 *
 * Coverage:
 *   - computeCheckInDecisions: threshold detection for all action tiers
 *   - Per-agent policy lookup (dev=30min, research=60min, default=30min)
 *   - State tracking: check-in and escalation sent flags
 *   - Idempotence: already-sent check-ins are not re-triggered
 *   - Non-running runs are skipped
 *   - Multiple runs with mixed states
 *   - getCheckInStatus: status summary fields
 *   - runCheckInMonitor: integration of decisions + notify + state mutation
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  computeCheckInDecisions,
  getCheckInPolicy,
  getCheckInStatus,
  runCheckInMonitor,
  markCheckInSent,
  markEscalationSent,
  clearCheckInState,
  AGENT_CHECK_IN_POLICIES,
  _resetCheckInStateForTesting,
  type CheckInInput,
} from "../src/check-in-monitor.ts";

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetCheckInStateForTesting();
});

const MIN = 60_000;

/** Build a minimal CheckInInput for testing. */
function run(
  agentType: string,
  startedAgoMs: number,
  overrides: Partial<CheckInInput> = {},
): CheckInInput {
  const now = Date.now();
  return {
    runId: crypto.randomUUID(),
    agentType,
    workItemId: `ELLIE-${Math.floor(Math.random() * 999)}`,
    startedAt: now - startedAgoMs,
    status: "running",
    ...overrides,
  };
}

// ── getCheckInPolicy ──────────────────────────────────────────────────────────

describe("getCheckInPolicy", () => {
  test("dev agent: 30-minute interval", () => {
    const p = getCheckInPolicy("dev");
    expect(p.intervalMs).toBe(30 * MIN);
  });

  test("research agent: 60-minute interval", () => {
    const p = getCheckInPolicy("research");
    expect(p.intervalMs).toBe(60 * MIN);
  });

  test("strategy agent: 45-minute interval", () => {
    const p = getCheckInPolicy("strategy");
    expect(p.intervalMs).toBe(45 * MIN);
  });

  test("unknown agent falls back to _default (30min)", () => {
    const p = getCheckInPolicy("some-unknown-agent");
    expect(p.intervalMs).toBe(AGENT_CHECK_IN_POLICIES._default.intervalMs);
  });

  test("escalation defaults to 2× intervalMs when not explicitly set", () => {
    const p = getCheckInPolicy("dev");
    const escalateMs = p.escalateAfterMs ?? p.intervalMs * 2;
    expect(escalateMs).toBe(60 * MIN);
  });
});

// ── computeCheckInDecisions — action: "none" ──────────────────────────────────

describe("computeCheckInDecisions — no action below threshold", () => {
  test("run under check-in threshold → action: none", () => {
    const r = run("dev", 20 * MIN); // 20min < 30min threshold
    const [d] = computeCheckInDecisions([r]);
    expect(d.action).toBe("none");
  });

  test("run just under threshold → action: none", () => {
    const r = run("dev", 29 * MIN + 59_000); // 1 second short
    const [d] = computeCheckInDecisions([r]);
    expect(d.action).toBe("none");
  });

  test("non-running run is excluded", () => {
    const completed = run("dev", 60 * MIN, { status: "completed" });
    const stale = run("dev", 90 * MIN, { status: "stale" });
    const failed = run("dev", 45 * MIN, { status: "failed" });
    const decisions = computeCheckInDecisions([completed, stale, failed]);
    expect(decisions).toHaveLength(0);
  });

  test("empty runs array → empty decisions", () => {
    expect(computeCheckInDecisions([])).toHaveLength(0);
  });
});

// ── computeCheckInDecisions — action: "check-in" ──────────────────────────────

describe("computeCheckInDecisions — check-in action", () => {
  test("dev run exactly at 30min threshold → check-in", () => {
    const r = run("dev", 30 * MIN);
    const [d] = computeCheckInDecisions([r]);
    expect(d.action).toBe("check-in");
  });

  test("dev run at 35min (past threshold, below escalation) → check-in", () => {
    const r = run("dev", 35 * MIN);
    const [d] = computeCheckInDecisions([r]);
    expect(d.action).toBe("check-in");
  });

  test("research run at 65min (past 60min threshold) → check-in", () => {
    const r = run("research", 65 * MIN);
    const [d] = computeCheckInDecisions([r]);
    expect(d.action).toBe("check-in");
  });

  test("unknown agent at 31min → check-in (uses 30min default)", () => {
    const r = run("general", 31 * MIN);
    const [d] = computeCheckInDecisions([r]);
    expect(d.action).toBe("check-in");
  });

  test("ageMs is set correctly", () => {
    const now = Date.now();
    const startedAt = now - 35 * MIN;
    const r: CheckInInput = { runId: "r1", agentType: "dev", workItemId: "ELLIE-1", startedAt, status: "running" };
    const [d] = computeCheckInDecisions([r], now);
    expect(d.ageMs).toBe(35 * MIN);
  });
});

// ── computeCheckInDecisions — action: "escalate" ──────────────────────────────

describe("computeCheckInDecisions — escalate action", () => {
  test("dev run at 60min (2× threshold) → escalate", () => {
    const r = run("dev", 60 * MIN);
    const [d] = computeCheckInDecisions([r]);
    expect(d.action).toBe("escalate");
  });

  test("dev run at 90min → escalate", () => {
    const r = run("dev", 90 * MIN);
    const [d] = computeCheckInDecisions([r]);
    expect(d.action).toBe("escalate");
  });

  test("research run at 125min (2× 60min threshold) → escalate", () => {
    const r = run("research", 125 * MIN);
    const [d] = computeCheckInDecisions([r]);
    expect(d.action).toBe("escalate");
  });
});

// ── idempotence: check-in already sent ────────────────────────────────────────

describe("computeCheckInDecisions — idempotence", () => {
  test("check-in already sent → action: none even past threshold", () => {
    const r = run("dev", 35 * MIN);
    markCheckInSent(r.runId);
    const [d] = computeCheckInDecisions([r]);
    expect(d.action).toBe("none");
  });

  test("escalation already sent → action: none even past escalation threshold", () => {
    const r = run("dev", 75 * MIN);
    markEscalationSent(r.runId);
    const [d] = computeCheckInDecisions([r]);
    expect(d.action).toBe("none");
  });

  test("check-in sent but not escalation: at escalation threshold → escalate", () => {
    const r = run("dev", 65 * MIN); // past 60min escalation
    markCheckInSent(r.runId);      // check-in already done
    const [d] = computeCheckInDecisions([r]);
    // escalation threshold not yet reached for check-in-already-sent case
    // 65min > 60min escalation threshold → escalate
    expect(d.action).toBe("escalate");
  });

  test("clearCheckInState resets run so check-in triggers again", () => {
    const r = run("dev", 35 * MIN);
    markCheckInSent(r.runId);
    clearCheckInState(r.runId);
    const [d] = computeCheckInDecisions([r]);
    expect(d.action).toBe("check-in");
  });
});

// ── multiple runs ─────────────────────────────────────────────────────────────

describe("computeCheckInDecisions — multiple runs", () => {
  test("each run is evaluated independently", () => {
    const young = run("dev", 10 * MIN);       // too young → none
    const ready = run("dev", 35 * MIN);       // at threshold → check-in
    const old   = run("research", 130 * MIN); // past escalation → escalate

    const decisions = computeCheckInDecisions([young, ready, old]);
    expect(decisions).toHaveLength(3);

    const byRunId = new Map(decisions.map(d => [d.runId, d]));
    expect(byRunId.get(young.runId)?.action).toBe("none");
    expect(byRunId.get(ready.runId)?.action).toBe("check-in");
    expect(byRunId.get(old.runId)?.action).toBe("escalate");
  });

  test("mixed running/completed: only running runs appear in output", () => {
    const active = run("dev", 35 * MIN);
    const done   = run("dev", 35 * MIN, { status: "completed" });

    const decisions = computeCheckInDecisions([active, done]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].runId).toBe(active.runId);
  });

  test("two runs for same agent type get same policy thresholds", () => {
    const r1 = run("dev", 35 * MIN);
    const r2 = run("dev", 65 * MIN);
    markCheckInSent(r2.runId); // r2 already had check-in

    const decisions = computeCheckInDecisions([r1, r2]);
    const byRunId = new Map(decisions.map(d => [d.runId, d]));

    expect(byRunId.get(r1.runId)?.action).toBe("check-in");
    expect(byRunId.get(r2.runId)?.action).toBe("escalate"); // check-in sent, but escalation not yet
  });
});

// ── injectable `now` ──────────────────────────────────────────────────────────

describe("computeCheckInDecisions — injectable now", () => {
  test("injecting now = startedAt makes run appear to have zero age → no action", () => {
    const r: CheckInInput = {
      runId: "fixed-run",
      agentType: "dev",
      workItemId: "ELLIE-X",
      startedAt: 1_000_000,
      status: "running",
    };
    const [d] = computeCheckInDecisions([r], 1_000_000); // zero age
    expect(d.action).toBe("none");
    expect(d.ageMs).toBe(0);
  });

  test("injecting now past threshold triggers check-in", () => {
    const startedAt = 1_000_000;
    const now = startedAt + 31 * MIN;
    const r: CheckInInput = {
      runId: "fixed-run-2",
      agentType: "dev",
      workItemId: "ELLIE-Y",
      startedAt,
      status: "running",
    };
    const [d] = computeCheckInDecisions([r], now);
    expect(d.action).toBe("check-in");
    expect(d.ageMs).toBe(31 * MIN);
  });
});

// ── getCheckInStatus ──────────────────────────────────────────────────────────

describe("getCheckInStatus", () => {
  test("returns status entries for running runs", () => {
    const r = run("dev", 20 * MIN);
    const statuses = getCheckInStatus([r]);
    expect(statuses).toHaveLength(1);
    const s = statuses[0];
    expect(s.runId).toBe(r.runId);
    expect(s.agentType).toBe("dev");
    expect(s.checkInSent).toBe(false);
    expect(s.escalationSent).toBe(false);
  });

  test("excludes non-running runs", () => {
    const active = run("dev", 20 * MIN);
    const done   = run("dev", 20 * MIN, { status: "completed" });
    const statuses = getCheckInStatus([active, done]);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].runId).toBe(active.runId);
  });

  test("reflects sent check-in state", () => {
    const r = run("dev", 35 * MIN);
    markCheckInSent(r.runId);
    const [s] = getCheckInStatus([r]);
    expect(s.checkInSent).toBe(true);
    expect(s.escalationSent).toBe(false);
  });

  test("reflects sent escalation state", () => {
    const r = run("dev", 70 * MIN);
    markEscalationSent(r.runId);
    const [s] = getCheckInStatus([r]);
    expect(s.escalationSent).toBe(true);
  });

  test("nextCheckInAt = startedAt + intervalMs", () => {
    const startedAt = 1_000_000;
    const r: CheckInInput = { runId: "s1", agentType: "dev", startedAt, status: "running" };
    const [s] = getCheckInStatus([r]);
    expect(s.nextCheckInAt).toBe(startedAt + 30 * MIN);
  });

  test("nextEscalationAt = startedAt + 2×intervalMs (when no custom escalateAfterMs)", () => {
    const startedAt = 1_000_000;
    const r: CheckInInput = { runId: "s2", agentType: "dev", startedAt, status: "running" };
    const [s] = getCheckInStatus([r]);
    expect(s.nextEscalationAt).toBe(startedAt + 60 * MIN);
  });

  test("policy is included in status entry", () => {
    const r = run("research", 10 * MIN);
    const [s] = getCheckInStatus([r]);
    expect(s.policy.intervalMs).toBe(60 * MIN);
  });

  test("ageMs matches elapsed time", () => {
    const now = Date.now();
    const startedAt = now - 25 * MIN;
    const r: CheckInInput = { runId: "s3", agentType: "dev", startedAt, status: "running" };
    const [s] = getCheckInStatus([r], now);
    expect(s.ageMs).toBe(25 * MIN);
  });
});

// ── runCheckInMonitor ─────────────────────────────────────────────────────────

describe("runCheckInMonitor", () => {
  test("no runs → returns 0 for both counters", async () => {
    const notified: string[] = [];
    const result = await runCheckInMonitor([], async (opts) => { notified.push(opts.event); });
    expect(result.checkedIn).toBe(0);
    expect(result.escalated).toBe(0);
    expect(notified).toHaveLength(0);
  });

  test("run below threshold → no notification", async () => {
    const r = run("dev", 10 * MIN);
    const notified: string[] = [];
    const result = await runCheckInMonitor([r], async (opts) => { notified.push(opts.event); });
    expect(result.checkedIn).toBe(0);
    expect(notified).toHaveLength(0);
  });

  test("run at check-in threshold → session_update notification + state marked", async () => {
    const r = run("dev", 31 * MIN);
    const notifications: Array<{ event: string; workItemId: string }> = [];
    const result = await runCheckInMonitor(
      [r],
      async (opts) => { notifications.push({ event: opts.event, workItemId: opts.workItemId }); },
    );

    expect(result.checkedIn).toBe(1);
    expect(result.escalated).toBe(0);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].event).toBe("session_update");
    expect(notifications[0].workItemId).toBe(r.workItemId);

    // State should be marked — running again should produce no action
    const [d] = computeCheckInDecisions([r]);
    expect(d.action).toBe("none");
  });

  test("run at escalation threshold → run_stale notification + state marked", async () => {
    const r = run("dev", 65 * MIN);
    const notifications: Array<{ event: string }> = [];
    const result = await runCheckInMonitor(
      [r],
      async (opts) => { notifications.push({ event: opts.event }); },
    );

    expect(result.escalated).toBe(1);
    expect(notifications[0].event).toBe("run_stale");

    // Escalation state marked — next pass should produce no action
    const [d] = computeCheckInDecisions([r]);
    expect(d.action).toBe("none");
  });

  test("notification failure does not throw — error is swallowed, state not marked", async () => {
    const r = run("dev", 31 * MIN);
    const result = await runCheckInMonitor(
      [r],
      async () => { throw new Error("notify failed"); },
    );
    // Should not throw and should return 0 (state not marked due to failure)
    expect(result.checkedIn).toBe(0);
  });

  test("multiple runs: each dispatches independently", async () => {
    const ready    = run("dev", 31 * MIN);       // check-in
    const old      = run("research", 130 * MIN); // escalate
    const young    = run("strategy", 10 * MIN);  // none

    const notifications: string[] = [];
    const result = await runCheckInMonitor(
      [ready, old, young],
      async (opts) => { notifications.push(opts.event); },
    );

    expect(result.checkedIn).toBe(1);
    expect(result.escalated).toBe(1);
    expect(notifications).toHaveLength(2);
  });

  test("notification message contains agent type and ticket", async () => {
    const r: CheckInInput = {
      runId: "msg-test",
      agentType: "dev",
      workItemId: "ELLIE-543",
      startedAt: Date.now() - 31 * MIN,
      status: "running",
    };
    const messages: string[] = [];
    await runCheckInMonitor([r], async (opts) => { messages.push(opts.telegramMessage); });

    expect(messages[0]).toContain("dev");
    expect(messages[0]).toContain("ELLIE-543");
  });
});
