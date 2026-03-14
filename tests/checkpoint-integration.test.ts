/**
 * ELLIE-719: Checkpoint System Integration Tests
 *
 * End-to-end tests verifying the full checkpoint flow:
 * timer fires → working memory read → report generated → notification delivered → update persisted
 *
 * Uses real timer (short durations) + mock deps to verify the full pipeline.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

import {
  startCheckpointTimer,
  stopCheckpointTimer,
  stopAllCheckpointTimers,
  getCheckpointTimerState,
  getActiveCheckpointSessions,
  calculateCheckpointOffsets,
  resolveConfig,
  _testing as timerTesting,
} from "../src/checkpoint-timer.ts";
import {
  generateCheckpointReport,
  extractDone,
  extractNext,
  extractBlockers,
  formatCheckpointMessage,
  formatCheckpointCompact,
} from "../src/checkpoint-report.ts";
import {
  deliverCheckpoint,
  buildCheckpointCallback,
  resolveDeliveryChannels,
  _makeMockDeliveryDeps,
} from "../src/checkpoint-delivery.ts";
import {
  DEFAULT_CHECKPOINT_CONFIG,
  DEFAULT_ESTIMATED_DURATION_MINUTES,
  type CheckpointReport,
} from "../src/checkpoint-types.ts";

beforeEach(() => { timerTesting.clearAllTimers(); });
afterEach(() => { timerTesting.clearAllTimers(); });

// ── End-to-end: timer → report → delivery ────────────────────

describe("end-to-end checkpoint flow", () => {
  test("timer fires, generates report from working memory, delivers notification", async () => {
    const { deps, notifications, updates } = _makeMockDeliveryDeps();

    const sections = {
      task_stack: "- [x] Schema migration\n- [x] Timer module\n- [ ] Report generator\n- [ ] Delivery wiring",
      investigation_state: "Exploring notification policy patterns",
      decision_log: "- Chose callback-based timer design for testability",
      resumption_prompt: "Wire up the delivery module next",
    };

    const getSections = mock(async () => sections);
    const callback = buildCheckpointCallback(deps, "telegram", getSections);

    // Start timer with very short duration so checkpoint fires quickly
    startCheckpointTimer("e2e-sess-1", "ELLIE-719", "dev", 0.01, { intervals: [50] }, callback);

    // Wait for timer to fire (50% of 600ms = 300ms + buffer)
    await new Promise(r => setTimeout(r, 600));

    // Verify working memory was read
    expect(getSections).toHaveBeenCalledTimes(1);
    expect(getSections.mock.calls[0][0]).toBe("e2e-sess-1");
    expect(getSections.mock.calls[0][1]).toBe("dev");

    // Verify notification was sent
    expect(notifications).toHaveLength(1);
    expect(notifications[0].event).toBe("session_checkpoint");
    expect(notifications[0].workItemId).toBe("ELLIE-719");
    expect(notifications[0].message).toContain("50%");
    expect(notifications[0].message).toContain("ELLIE-719");

    // Verify update was persisted
    expect(updates).toHaveLength(1);
    expect(updates[0].workItemId).toBe("ELLIE-719");
    expect(updates[0].details.percent).toBe(50);
    expect(updates[0].details.done).toContain("Schema migration");
    expect(updates[0].details.next).toContain("Report generator");
    expect(updates[0].details.blockers).toBe("");
  });

  test("multiple checkpoints fire in sequence", async () => {
    const { deps, notifications, updates } = _makeMockDeliveryDeps();
    const getSections = mock(async () => ({ task_stack: "- [x] Step 1\n- [ ] Step 2" }));
    const callback = buildCheckpointCallback(deps, "telegram", getSections);

    // 0.02 min = 1200ms, checkpoints at 25% (300ms) and 50% (600ms)
    startCheckpointTimer("e2e-sess-2", "ELLIE-719", "dev", 0.02, { intervals: [25, 50] }, callback);

    await new Promise(r => setTimeout(r, 1000));

    expect(notifications.length).toBeGreaterThanOrEqual(2);
    const percents = updates.map(u => u.details.percent);
    expect(percents).toContain(25);
    expect(percents).toContain(50);
  });

  test("stopping timer prevents future checkpoints", async () => {
    const { deps, notifications } = _makeMockDeliveryDeps();
    const getSections = mock(async () => ({}));
    const callback = buildCheckpointCallback(deps, "telegram", getSections);

    startCheckpointTimer("e2e-sess-3", "ELLIE-719", "dev", 0.05, { intervals: [50] }, callback);

    // Stop immediately
    stopCheckpointTimer("e2e-sess-3");

    await new Promise(r => setTimeout(r, 2000));

    expect(notifications).toHaveLength(0);
    expect(getSections).not.toHaveBeenCalled();
  });

  test("opt-out config prevents timer from starting", () => {
    const cb = mock(() => {});
    const state = startCheckpointTimer("e2e-sess-4", "ELLIE-719", "dev", 60, { enabled: false }, cb);
    expect(state).toBeNull();
    expect(getActiveCheckpointSessions()).not.toContain("e2e-sess-4");
  });

  test("report with blockers includes blocker in delivery", async () => {
    const { deps, updates } = _makeMockDeliveryDeps();

    const sections = {
      task_stack: "- [x] Started work",
      investigation_state: "- Blocked on missing API key for OAuth",
      context_anchors: "Error: ECONNREFUSED at auth-service:443",
    };

    const getSections = mock(async () => sections);
    const callback = buildCheckpointCallback(deps, "telegram", getSections);

    startCheckpointTimer("e2e-sess-5", "ELLIE-719", "dev", 0.01, { intervals: [50] }, callback);

    await new Promise(r => setTimeout(r, 600));

    expect(updates).toHaveLength(1);
    expect(updates[0].details.blockers).toContain("Blocked on missing API key");
  });
});

// ── Cross-module consistency ─────────────────────────────────

describe("cross-module consistency", () => {
  test("CheckpointReport from generateCheckpointReport formats correctly", () => {
    const report = generateCheckpointReport(
      { task_stack: "- [x] Done\n- [ ] Next" },
      75, 45, 60, 30,
    );

    const msg = formatCheckpointMessage(report, "ELLIE-719");
    expect(msg).toContain("75%");
    expect(msg).toContain("45min elapsed");
    expect(msg).toContain("~15min remaining");
    expect(msg).toContain("Done:");
    expect(msg).toContain("Next:");

    const compact = formatCheckpointCompact(report, "ELLIE-719");
    expect(compact).toContain("[ELLIE-719]");
    expect(compact).toContain("75%");
    expect(compact).toContain("45/60min");
  });

  test("timer offsets align with config intervals", () => {
    const config = resolveConfig({ intervals: [25, 50, 75] });
    const offsets = calculateCheckpointOffsets(config!.intervals, 60);

    expect(offsets).toHaveLength(3);
    expect(offsets[0].percent).toBe(25);
    expect(offsets[0].offsetMs).toBe(15 * 60_000);
    expect(offsets[2].percent).toBe(75);
    expect(offsets[2].offsetMs).toBe(45 * 60_000);
  });

  test("delivery channels match session origin expectations", () => {
    // Telegram session → should deliver to telegram
    const tg = resolveDeliveryChannels("telegram");
    expect(tg.telegram).toBe(true);

    // Google Chat session → should deliver to gchat
    const gc = resolveDeliveryChannels("google-chat");
    expect(gc.gchat).toBe(true);
    expect(gc.telegram).toBe(false);
  });

  test("defaults are consistent across modules", () => {
    expect(DEFAULT_CHECKPOINT_CONFIG.enabled).toBe(true);
    expect(DEFAULT_CHECKPOINT_CONFIG.intervals).toEqual([25, 50, 75]);
    expect(DEFAULT_ESTIMATED_DURATION_MINUTES).toBe(60);

    // resolveConfig with no args returns same defaults
    const resolved = resolveConfig();
    expect(resolved!.intervals).toEqual(DEFAULT_CHECKPOINT_CONFIG.intervals);
  });

  test("full report pipeline produces valid CheckpointReport shape", () => {
    const report = generateCheckpointReport({}, 50, 30, 60);
    expect(typeof report.percent).toBe("number");
    expect(typeof report.elapsed_minutes).toBe("number");
    expect(typeof report.estimated_total_minutes).toBe("number");
    expect(typeof report.done).toBe("string");
    expect(typeof report.next).toBe("string");
    expect(typeof report.blockers).toBe("string");
  });
});

// ── Edge cases across modules ────────────────────────────────

describe("edge cases", () => {
  test("deliverCheckpoint with report from empty working memory", async () => {
    const { deps, notifications, updates } = _makeMockDeliveryDeps();
    const report = generateCheckpointReport({}, 25, 15, 60);

    const result = await deliverCheckpoint(deps, report, "ELLIE-719", "telegram");

    expect(result.notified).toBe(true);
    expect(result.persisted).toBe(true);
    expect(notifications[0].message).toContain("Work in progress");
  });

  test("timer state tracks fired checkpoints correctly after callback", async () => {
    const { deps } = _makeMockDeliveryDeps();
    const getSections = mock(async () => ({}));
    const callback = buildCheckpointCallback(deps, "telegram", getSections);

    startCheckpointTimer("e2e-state", "ELLIE-719", "dev", 0.01, { intervals: [50] }, callback);

    await new Promise(r => setTimeout(r, 600));

    const state = getCheckpointTimerState("e2e-state");
    expect(state).not.toBeNull();
    expect(state!.fired).toContain(50);
    expect(state!.remaining).not.toContain(50);
  });

  test("stopAllCheckpointTimers cleans up after integration test", async () => {
    const cb = mock(() => {});
    startCheckpointTimer("cleanup-1", "ELLIE-1", "dev", 60, null, cb);
    startCheckpointTimer("cleanup-2", "ELLIE-2", "dev", 60, null, cb);

    expect(getActiveCheckpointSessions()).toHaveLength(2);

    const stopped = stopAllCheckpointTimers();
    expect(stopped).toBe(2);
    expect(getActiveCheckpointSessions()).toHaveLength(0);
  });
});
