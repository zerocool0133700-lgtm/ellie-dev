/**
 * ELLIE-559 — notification-policy.ts tests
 *
 * Tests policy config structure, channel routing, and throttle state.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  NOTIFICATION_POLICY,
  getEnabledChannels,
  resetThrottleState,
  type NotificationEvent,
} from "../src/notification-policy.ts";

// ── NOTIFICATION_POLICY config ───────────────────────────────

describe("NOTIFICATION_POLICY", () => {
  test("all expected events are defined", () => {
    const expected: NotificationEvent[] = [
      "session_start", "session_update", "session_decision", "session_complete",
      "session_pause", "session_resume",
      "incident_raised", "incident_update", "incident_resolved",
      "memory_contradiction", "dispatch_confirm",
      "run_stale", "run_failed", "error", "rollup", "weekly_review",
    ];
    for (const event of expected) {
      expect(NOTIFICATION_POLICY[event]).toBeDefined();
    }
  });

  test("every event has a priority", () => {
    for (const [, policy] of Object.entries(NOTIFICATION_POLICY)) {
      expect(["critical", "high", "normal", "low"]).toContain(policy.priority);
    }
  });

  test("every event has telegram, google-chat, and slack channels", () => {
    for (const [, policy] of Object.entries(NOTIFICATION_POLICY)) {
      expect(policy.channels.telegram).toBeDefined();
      expect(policy.channels["google-chat"]).toBeDefined();
      expect(policy.channels.slack).toBeDefined();
    }
  });

  test("incident_raised is critical priority", () => {
    expect(NOTIFICATION_POLICY.incident_raised.priority).toBe("critical");
  });

  test("session_update has telegram disabled (too noisy)", () => {
    expect(NOTIFICATION_POLICY.session_update.channels.telegram.enabled).toBe(false);
  });

  test("session_start has all channels enabled", () => {
    const ch = NOTIFICATION_POLICY.session_start.channels;
    expect(ch.telegram.enabled).toBe(true);
    expect(ch["google-chat"].enabled).toBe(true);
    expect(ch.slack.enabled).toBe(true);
  });
});

// ── getEnabledChannels ───────────────────────────────────────

describe("getEnabledChannels", () => {
  test("session_start returns all three channels", () => {
    const channels = getEnabledChannels("session_start");
    expect(channels).toContain("telegram");
    expect(channels).toContain("google-chat");
    expect(channels).toContain("slack");
  });

  test("session_update excludes telegram", () => {
    const channels = getEnabledChannels("session_update");
    expect(channels).not.toContain("telegram");
    expect(channels).toContain("google-chat");
  });

  test("incident_update excludes telegram", () => {
    const channels = getEnabledChannels("incident_update");
    expect(channels).not.toContain("telegram");
  });

  test("unknown event returns empty array", () => {
    expect(getEnabledChannels("nonexistent" as NotificationEvent)).toEqual([]);
  });

  test("dispatch_confirm excludes slack", () => {
    const channels = getEnabledChannels("dispatch_confirm");
    expect(channels).not.toContain("slack");
    expect(channels).toContain("telegram");
  });
});

// ── resetThrottleState ───────────────────────────────────────

describe("resetThrottleState", () => {
  test("does not throw when called with no pending state", () => {
    expect(() => resetThrottleState()).not.toThrow();
  });

  test("can be called multiple times safely", () => {
    resetThrottleState();
    resetThrottleState();
    expect(true).toBe(true);
  });
});
