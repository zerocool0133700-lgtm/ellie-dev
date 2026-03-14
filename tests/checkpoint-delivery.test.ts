/**
 * ELLIE-718: Checkpoint Delivery Tests
 *
 * Tests channel routing, notification delivery, persistence,
 * callback integration, and error handling.
 */

import { describe, test, expect, mock } from "bun:test";

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

import {
  resolveDeliveryChannels,
  deliverCheckpoint,
  buildCheckpointCallback,
  _makeMockDeliveryDeps,
  type SessionChannel,
  type CheckpointDeliveryDeps,
} from "../src/checkpoint-delivery.ts";
import type { CheckpointReport } from "../src/checkpoint-types.ts";

// ── resolveDeliveryChannels ──────────────────────────────────

describe("resolveDeliveryChannels", () => {
  test("telegram origin → telegram + gchat", () => {
    const ch = resolveDeliveryChannels("telegram");
    expect(ch.telegram).toBe(true);
    expect(ch.gchat).toBe(true);
    expect(ch.slack).toBe(false);
  });

  test("google-chat origin → gchat only", () => {
    const ch = resolveDeliveryChannels("google-chat");
    expect(ch.telegram).toBe(false);
    expect(ch.gchat).toBe(true);
    expect(ch.slack).toBe(false);
  });

  test("slack origin → slack only", () => {
    const ch = resolveDeliveryChannels("slack");
    expect(ch.telegram).toBe(false);
    expect(ch.gchat).toBe(false);
    expect(ch.slack).toBe(true);
  });

  test("ellie-chat origin → telegram + gchat", () => {
    const ch = resolveDeliveryChannels("ellie-chat");
    expect(ch.telegram).toBe(true);
    expect(ch.gchat).toBe(true);
    expect(ch.slack).toBe(false);
  });

  test("unknown origin → all channels", () => {
    const ch = resolveDeliveryChannels("unknown");
    expect(ch.telegram).toBe(true);
    expect(ch.gchat).toBe(true);
    expect(ch.slack).toBe(true);
  });
});

// ── _makeMockDeliveryDeps ────────────────────────────────────

describe("_makeMockDeliveryDeps", () => {
  test("creates deps with empty arrays", () => {
    const { deps, notifications, updates } = _makeMockDeliveryDeps();
    expect(notifications).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(deps.notify).toBeDefined();
    expect(deps.persistUpdate).toBeDefined();
  });

  test("notify records calls", async () => {
    const { deps, notifications } = _makeMockDeliveryDeps();
    await deps.notify({
      event: "session_checkpoint",
      workItemId: "ELLIE-718",
      telegramMessage: "Test message",
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].workItemId).toBe("ELLIE-718");
  });

  test("persistUpdate records calls", async () => {
    const { deps, updates } = _makeMockDeliveryDeps();
    const report: CheckpointReport = {
      percent: 50,
      elapsed_minutes: 30,
      estimated_total_minutes: 60,
      done: "Half done",
      next: "Other half",
      blockers: "",
    };
    await deps.persistUpdate("ELLIE-718", "compact msg", report);
    expect(updates).toHaveLength(1);
    expect(updates[0].details.percent).toBe(50);
  });
});

// ── deliverCheckpoint ────────────────────────────────────────

describe("deliverCheckpoint", () => {
  const report: CheckpointReport = {
    percent: 25,
    elapsed_minutes: 15,
    estimated_total_minutes: 60,
    done: "Schema design complete",
    next: "Implement timer",
    blockers: "",
  };

  test("delivers notification and persists update", async () => {
    const { deps, notifications, updates } = _makeMockDeliveryDeps();

    const result = await deliverCheckpoint(deps, report, "ELLIE-718", "telegram");

    expect(result.notified).toBe(true);
    expect(result.persisted).toBe(true);
    expect(notifications).toHaveLength(1);
    expect(updates).toHaveLength(1);
  });

  test("notification contains work item ID", async () => {
    const { deps, notifications } = _makeMockDeliveryDeps();
    await deliverCheckpoint(deps, report, "ELLIE-718", "telegram");

    expect(notifications[0].workItemId).toBe("ELLIE-718");
    expect(notifications[0].event).toBe("session_checkpoint");
    expect(notifications[0].message).toContain("ELLIE-718");
    expect(notifications[0].message).toContain("25%");
  });

  test("persisted update contains report details", async () => {
    const { deps, updates } = _makeMockDeliveryDeps();
    await deliverCheckpoint(deps, report, "ELLIE-718", "telegram");

    expect(updates[0].workItemId).toBe("ELLIE-718");
    expect(updates[0].details.percent).toBe(25);
    expect(updates[0].details.done).toBe("Schema design complete");
  });

  test("handles notify failure gracefully", async () => {
    const deps: CheckpointDeliveryDeps = {
      notify: async () => { throw new Error("Network error"); },
      persistUpdate: async () => {},
    };

    const result = await deliverCheckpoint(deps, report, "ELLIE-718", "telegram");
    expect(result.notified).toBe(false);
    expect(result.persisted).toBe(true); // persist still succeeds
  });

  test("handles persist failure gracefully", async () => {
    const deps: CheckpointDeliveryDeps = {
      notify: async () => {},
      persistUpdate: async () => { throw new Error("DB error"); },
    };

    const result = await deliverCheckpoint(deps, report, "ELLIE-718", "telegram");
    expect(result.notified).toBe(true);
    expect(result.persisted).toBe(false);
  });

  test("handles both failures gracefully", async () => {
    const deps: CheckpointDeliveryDeps = {
      notify: async () => { throw new Error("Net"); },
      persistUpdate: async () => { throw new Error("DB"); },
    };

    const result = await deliverCheckpoint(deps, report, "ELLIE-718", "telegram");
    expect(result.notified).toBe(false);
    expect(result.persisted).toBe(false);
  });
});

// ── buildCheckpointCallback ──────────────────────────────────

describe("buildCheckpointCallback", () => {
  test("returns a function", () => {
    const { deps } = _makeMockDeliveryDeps();
    const cb = buildCheckpointCallback(deps, "telegram", async () => ({}));
    expect(typeof cb).toBe("function");
  });

  test("callback fetches sections and delivers", async () => {
    const { deps, notifications, updates } = _makeMockDeliveryDeps();
    const getSections = mock(async () => ({
      task_stack: "- [x] Done thing\n- [ ] Next thing",
    }));

    const cb = buildCheckpointCallback(deps, "telegram", getSections);
    await cb("sess-1", "ELLIE-718", "dev", 50, 30, 60);

    expect(getSections).toHaveBeenCalledTimes(1);
    expect(notifications).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].details.percent).toBe(50);
    expect(updates[0].details.done).toContain("Done thing");
  });

  test("callback handles getSections failure", async () => {
    const { deps, notifications } = _makeMockDeliveryDeps();
    const getSections = mock(async () => { throw new Error("WM unavailable"); });

    const cb = buildCheckpointCallback(deps, "telegram", getSections);
    // Should not throw
    await cb("sess-1", "ELLIE-718", "dev", 25, 15, 60);

    // Still delivers with empty sections (fallback text)
    expect(notifications).toHaveLength(1);
  });
});
