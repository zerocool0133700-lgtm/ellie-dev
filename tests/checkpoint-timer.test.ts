/**
 * ELLIE-716: Checkpoint Timer Tests
 *
 * Tests pure calculation functions, timer lifecycle, config resolution,
 * and cleanup behavior.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

import {
  calculateCheckpointOffsets,
  resolveConfig,
  getElapsedMinutes,
  startCheckpointTimer,
  stopCheckpointTimer,
  getCheckpointTimerState,
  getActiveCheckpointSessions,
  stopAllCheckpointTimers,
  _testing,
} from "../src/checkpoint-timer.ts";
import { DEFAULT_CHECKPOINT_CONFIG, DEFAULT_ESTIMATED_DURATION_MINUTES } from "../src/checkpoint-types.ts";

beforeEach(() => {
  _testing.clearAllTimers();
});

afterEach(() => {
  _testing.clearAllTimers();
});

// ── calculateCheckpointOffsets ───────────────────────────────

describe("calculateCheckpointOffsets", () => {
  test("calculates offsets for default intervals (25/50/75) at 60 min", () => {
    const offsets = calculateCheckpointOffsets([25, 50, 75], 60);
    expect(offsets).toHaveLength(3);
    expect(offsets[0]).toEqual({ percent: 25, offsetMs: 15 * 60 * 1000 });
    expect(offsets[1]).toEqual({ percent: 50, offsetMs: 30 * 60 * 1000 });
    expect(offsets[2]).toEqual({ percent: 75, offsetMs: 45 * 60 * 1000 });
  });

  test("calculates for custom intervals", () => {
    const offsets = calculateCheckpointOffsets([10, 50, 90], 120);
    expect(offsets).toHaveLength(3);
    expect(offsets[0]).toEqual({ percent: 10, offsetMs: 12 * 60 * 1000 });
    expect(offsets[1]).toEqual({ percent: 50, offsetMs: 60 * 60 * 1000 });
    expect(offsets[2]).toEqual({ percent: 90, offsetMs: 108 * 60 * 1000 });
  });

  test("sorts intervals ascending", () => {
    const offsets = calculateCheckpointOffsets([75, 25, 50], 60);
    expect(offsets.map(o => o.percent)).toEqual([25, 50, 75]);
  });

  test("filters out 0 and 100", () => {
    const offsets = calculateCheckpointOffsets([0, 25, 50, 100], 60);
    expect(offsets).toHaveLength(2);
    expect(offsets.map(o => o.percent)).toEqual([25, 50]);
  });

  test("filters out negative values", () => {
    const offsets = calculateCheckpointOffsets([-10, 25, 50], 60);
    expect(offsets).toHaveLength(2);
  });

  test("returns empty for empty intervals", () => {
    expect(calculateCheckpointOffsets([], 60)).toHaveLength(0);
  });

  test("handles short duration (10 min)", () => {
    const offsets = calculateCheckpointOffsets([50], 10);
    expect(offsets[0].offsetMs).toBe(5 * 60 * 1000);
  });

  test("single interval works", () => {
    const offsets = calculateCheckpointOffsets([50], 60);
    expect(offsets).toHaveLength(1);
    expect(offsets[0].percent).toBe(50);
  });
});

// ── resolveConfig ────────────────────────────────────────────

describe("resolveConfig", () => {
  test("returns default config when no config provided", () => {
    const config = resolveConfig();
    expect(config).not.toBeNull();
    expect(config!.enabled).toBe(true);
    expect(config!.intervals).toEqual([25, 50, 75]);
  });

  test("returns default config for null", () => {
    const config = resolveConfig(null);
    expect(config).not.toBeNull();
    expect(config!.intervals).toEqual([25, 50, 75]);
  });

  test("returns default config for empty object", () => {
    const config = resolveConfig({});
    expect(config).not.toBeNull();
    expect(config!.intervals).toEqual([25, 50, 75]);
  });

  test("returns null when enabled=false (opt-out)", () => {
    expect(resolveConfig({ enabled: false })).toBeNull();
  });

  test("uses custom intervals when provided", () => {
    const config = resolveConfig({ intervals: [20, 40, 60, 80] });
    expect(config!.intervals).toEqual([20, 40, 60, 80]);
  });

  test("filters invalid interval values", () => {
    const config = resolveConfig({ intervals: [0, 25, -5, 100, 50] });
    expect(config!.intervals).toEqual([25, 50]);
  });

  test("falls back to default if all intervals invalid", () => {
    const config = resolveConfig({ intervals: [0, 100, -1] });
    expect(config!.intervals).toEqual([25, 50, 75]);
  });

  test("respects enabled=true with custom intervals", () => {
    const config = resolveConfig({ enabled: true, intervals: [33, 66] });
    expect(config!.enabled).toBe(true);
    expect(config!.intervals).toEqual([33, 66]);
  });
});

// ── getElapsedMinutes ────────────────────────────────────────

describe("getElapsedMinutes", () => {
  test("returns 0 for just-started session", () => {
    const now = Date.now();
    expect(getElapsedMinutes(new Date(now), now)).toBe(0);
  });

  test("returns correct minutes", () => {
    const now = Date.now();
    const thirtyMinAgo = new Date(now - 30 * 60 * 1000);
    expect(getElapsedMinutes(thirtyMinAgo, now)).toBe(30);
  });

  test("rounds to nearest minute", () => {
    const now = Date.now();
    const almostFiveMin = new Date(now - 4.7 * 60 * 1000);
    expect(getElapsedMinutes(almostFiveMin, now)).toBe(5);
  });

  test("handles large elapsed times", () => {
    const now = Date.now();
    const twoHoursAgo = new Date(now - 120 * 60 * 1000);
    expect(getElapsedMinutes(twoHoursAgo, now)).toBe(120);
  });
});

// ── startCheckpointTimer ─────────────────────────────────────

describe("startCheckpointTimer", () => {
  test("starts timer and returns state", () => {
    const cb = mock(() => {});
    const state = startCheckpointTimer("sess-1", "ELLIE-716", "dev", 60, null, cb);

    expect(state).not.toBeNull();
    expect(state!.session_id).toBe("sess-1");
    expect(state!.work_item_id).toBe("ELLIE-716");
    expect(state!.agent).toBe("dev");
    expect(state!.estimated_duration_minutes).toBe(60);
    expect(state!.fired).toEqual([]);
    expect(state!.remaining).toEqual([25, 50, 75]);
    expect(state!.timer_ids).toHaveLength(3);
  });

  test("uses default duration when null", () => {
    const cb = mock(() => {});
    const state = startCheckpointTimer("sess-2", "ELLIE-716", "dev", null, null, cb);
    expect(state!.estimated_duration_minutes).toBe(DEFAULT_ESTIMATED_DURATION_MINUTES);
  });

  test("returns null when disabled", () => {
    const cb = mock(() => {});
    const state = startCheckpointTimer("sess-3", "ELLIE-716", "dev", 60, { enabled: false }, cb);
    expect(state).toBeNull();
  });

  test("uses custom intervals", () => {
    const cb = mock(() => {});
    const state = startCheckpointTimer("sess-4", "ELLIE-716", "dev", 60, { intervals: [33, 66] }, cb);
    expect(state!.remaining).toEqual([33, 66]);
    expect(state!.timer_ids).toHaveLength(2);
  });

  test("replaces existing timer for same session", () => {
    const cb = mock(() => {});
    startCheckpointTimer("sess-5", "ELLIE-716", "dev", 60, null, cb);
    const state2 = startCheckpointTimer("sess-5", "ELLIE-716", "dev", 30, null, cb);
    expect(state2!.estimated_duration_minutes).toBe(30);
    expect(getActiveCheckpointSessions()).toHaveLength(1);
  });

  test("callback fires when timer elapses", async () => {
    const cb = mock(() => {});
    // Use very short duration (0.01 min = 600ms) so timer fires quickly
    startCheckpointTimer("sess-6", "ELLIE-716", "dev", 0.01, { intervals: [50] }, cb);

    // Wait for the timer to fire (50% of 600ms = 300ms + buffer)
    await new Promise(r => setTimeout(r, 500));

    expect(cb).toHaveBeenCalledTimes(1);
    const [sessionId, workItemId, agent, percent] = cb.mock.calls[0];
    expect(sessionId).toBe("sess-6");
    expect(workItemId).toBe("ELLIE-716");
    expect(agent).toBe("dev");
    expect(percent).toBe(50);
  });

  test("tracks fired/remaining state after callback", async () => {
    const cb = mock(() => {});
    startCheckpointTimer("sess-7", "ELLIE-716", "dev", 0.01, { intervals: [50] }, cb);

    await new Promise(r => setTimeout(r, 500));

    const state = getCheckpointTimerState("sess-7");
    expect(state!.fired).toContain(50);
    expect(state!.remaining).not.toContain(50);
  });

  test("falls back to defaults when all intervals invalid", () => {
    const cb = mock(() => {});
    const state = startCheckpointTimer("sess-8", "ELLIE-716", "dev", 60, { intervals: [0, 100] }, cb);
    // Invalid intervals fall back to defaults [25, 50, 75]
    expect(state).not.toBeNull();
    expect(state!.remaining).toEqual([25, 50, 75]);
  });
});

// ── stopCheckpointTimer ──────────────────────────────────────

describe("stopCheckpointTimer", () => {
  test("stops and removes timer", () => {
    const cb = mock(() => {});
    startCheckpointTimer("sess-stop-1", "ELLIE-716", "dev", 60, null, cb);
    expect(getCheckpointTimerState("sess-stop-1")).not.toBeNull();

    const stopped = stopCheckpointTimer("sess-stop-1");
    expect(stopped).toBe(true);
    expect(getCheckpointTimerState("sess-stop-1")).toBeNull();
  });

  test("returns false for nonexistent session", () => {
    expect(stopCheckpointTimer("nonexistent")).toBe(false);
  });

  test("prevents future callbacks from firing", async () => {
    const cb = mock(() => {});
    startCheckpointTimer("sess-stop-2", "ELLIE-716", "dev", 0.02, { intervals: [50] }, cb);

    // Stop immediately before timer fires
    stopCheckpointTimer("sess-stop-2");

    await new Promise(r => setTimeout(r, 800));
    expect(cb).not.toHaveBeenCalled();
  });
});

// ── getCheckpointTimerState ──────────────────────────────────

describe("getCheckpointTimerState", () => {
  test("returns state for active session", () => {
    const cb = mock(() => {});
    startCheckpointTimer("sess-state-1", "ELLIE-716", "dev", 45, null, cb);
    const state = getCheckpointTimerState("sess-state-1");
    expect(state).not.toBeNull();
    expect(state!.estimated_duration_minutes).toBe(45);
  });

  test("returns null for inactive session", () => {
    expect(getCheckpointTimerState("nonexistent")).toBeNull();
  });
});

// ── getActiveCheckpointSessions ──────────────────────────────

describe("getActiveCheckpointSessions", () => {
  test("returns empty when no timers", () => {
    expect(getActiveCheckpointSessions()).toEqual([]);
  });

  test("returns session IDs", () => {
    const cb = mock(() => {});
    startCheckpointTimer("sess-a", "ELLIE-1", "dev", 60, null, cb);
    startCheckpointTimer("sess-b", "ELLIE-2", "research", 60, null, cb);

    const sessions = getActiveCheckpointSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions).toContain("sess-a");
    expect(sessions).toContain("sess-b");
  });
});

// ── stopAllCheckpointTimers ──────────────────────────────────

describe("stopAllCheckpointTimers", () => {
  test("stops all and returns count", () => {
    const cb = mock(() => {});
    startCheckpointTimer("sess-all-1", "ELLIE-1", "dev", 60, null, cb);
    startCheckpointTimer("sess-all-2", "ELLIE-2", "dev", 60, null, cb);

    const count = stopAllCheckpointTimers();
    expect(count).toBe(2);
    expect(getActiveCheckpointSessions()).toEqual([]);
  });

  test("returns 0 when none active", () => {
    expect(stopAllCheckpointTimers()).toBe(0);
  });
});

// ── DEFAULT_CHECKPOINT_CONFIG ────────────────────────────────

describe("DEFAULT_CHECKPOINT_CONFIG", () => {
  test("is enabled by default", () => {
    expect(DEFAULT_CHECKPOINT_CONFIG.enabled).toBe(true);
  });

  test("has 25/50/75 intervals", () => {
    expect(DEFAULT_CHECKPOINT_CONFIG.intervals).toEqual([25, 50, 75]);
  });
});

// ── DEFAULT_ESTIMATED_DURATION_MINUTES ───────────────────────

describe("DEFAULT_ESTIMATED_DURATION_MINUTES", () => {
  test("is 60 minutes", () => {
    expect(DEFAULT_ESTIMATED_DURATION_MINUTES).toBe(60);
  });
});
