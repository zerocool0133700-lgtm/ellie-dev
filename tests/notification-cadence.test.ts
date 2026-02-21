/**
 * ELLIE-80 — Notification Cadence Policy Tests
 *
 * Tests:
 * - Policy config has all 14 event types
 * - dispatch_confirm routes to both channels
 * - error event is critical priority with 0 throttle
 * - session_update only goes to google-chat (telegram disabled)
 * - getEnabledChannels returns correct channels
 * - notify() sends to both channels for dispatch_confirm
 * - notify() throttles session_update on google-chat (60s)
 * - notify() sends error events immediately to both channels
 * - Mock sprint scenario: 10+ tasks, verify message count is bounded
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";

// Mock sendGoogleChatMessage before importing notification-policy
const gchatSendSpy = mock(() => Promise.resolve({ externalId: "mock", threadName: null }));
mock.module("../src/google-chat.ts", () => ({
  sendGoogleChatMessage: gchatSendSpy,
}));

import {
  NOTIFICATION_POLICY,
  getEnabledChannels,
  notify,
  resetThrottleState,
  type NotifyContext,
  type NotificationEvent,
} from "../src/notification-policy.ts";

// ── Mock Bot ────────────────────────────────────────────

const telegramSendSpy = mock(() => Promise.resolve({}));

function makeMockCtx(): NotifyContext {
  return {
    bot: {
      api: {
        sendMessage: telegramSendSpy,
      },
    } as any,
    telegramUserId: "123456",
    gchatSpaceName: "spaces/test-space",
  };
}

beforeEach(() => {
  telegramSendSpy.mockClear();
  gchatSendSpy.mockClear();
  resetThrottleState();
});

// ── Policy Config ───────────────────────────────────────

describe("NOTIFICATION_POLICY config", () => {
  const ALL_EVENTS: NotificationEvent[] = [
    "session_start", "session_update", "session_decision", "session_complete",
    "session_pause", "session_resume",
    "incident_raised", "incident_update", "incident_resolved",
    "memory_contradiction",
    "dispatch_confirm", "error",
    "rollup", "weekly_review",
  ];

  test("defines all 14 event types", () => {
    for (const event of ALL_EVENTS) {
      expect(NOTIFICATION_POLICY[event]).toBeDefined();
      expect(NOTIFICATION_POLICY[event].channels.telegram).toBeDefined();
      expect(NOTIFICATION_POLICY[event].channels["google-chat"]).toBeDefined();
    }
    expect(Object.keys(NOTIFICATION_POLICY).length).toBe(14);
  });

  test("dispatch_confirm routes to both channels with 0 throttle", () => {
    const policy = NOTIFICATION_POLICY.dispatch_confirm;
    expect(policy.channels.telegram.enabled).toBe(true);
    expect(policy.channels.telegram.minIntervalSec).toBe(0);
    expect(policy.channels["google-chat"].enabled).toBe(true);
    expect(policy.channels["google-chat"].minIntervalSec).toBe(0);
  });

  test("error event is critical priority with 0 throttle", () => {
    const policy = NOTIFICATION_POLICY.error;
    expect(policy.priority).toBe("critical");
    expect(policy.channels.telegram.enabled).toBe(true);
    expect(policy.channels.telegram.minIntervalSec).toBe(0);
    expect(policy.channels["google-chat"].enabled).toBe(true);
    expect(policy.channels["google-chat"].minIntervalSec).toBe(0);
  });

  test("session_update disabled on telegram, 60s throttle on google-chat", () => {
    const policy = NOTIFICATION_POLICY.session_update;
    expect(policy.channels.telegram.enabled).toBe(false);
    expect(policy.channels["google-chat"].enabled).toBe(true);
    expect(policy.channels["google-chat"].minIntervalSec).toBe(60);
  });

  test("incident_raised is critical and goes to both channels", () => {
    const policy = NOTIFICATION_POLICY.incident_raised;
    expect(policy.priority).toBe("critical");
    expect(policy.channels.telegram.enabled).toBe(true);
    expect(policy.channels["google-chat"].enabled).toBe(true);
  });
});

// ── getEnabledChannels ──────────────────────────────────

describe("getEnabledChannels", () => {
  test("dispatch_confirm returns both channels", () => {
    const channels = getEnabledChannels("dispatch_confirm");
    expect(channels).toContain("telegram");
    expect(channels).toContain("google-chat");
  });

  test("session_update returns only google-chat", () => {
    const channels = getEnabledChannels("session_update");
    expect(channels).toEqual(["google-chat"]);
  });

  test("incident_update returns only google-chat (telegram disabled)", () => {
    const channels = getEnabledChannels("incident_update");
    expect(channels).toEqual(["google-chat"]);
  });

  test("returns empty for unknown event", () => {
    const channels = getEnabledChannels("nonexistent" as any);
    expect(channels).toEqual([]);
  });
});

// ── notify() dispatch ───────────────────────────────────

describe("notify dispatch_confirm", () => {
  test("sends to both telegram and google-chat", async () => {
    const ctx = makeMockCtx();
    await notify(ctx, {
      event: "dispatch_confirm",
      workItemId: "test-agent-1",
      telegramMessage: "🤖 test-agent-1 agent",
      gchatMessage: "🤖 test-agent-1 agent dispatched",
    });

    expect(telegramSendSpy).toHaveBeenCalledTimes(1);
    expect(gchatSendSpy).toHaveBeenCalledTimes(1);

    // Verify telegram message content
    const [userId, message] = telegramSendSpy.mock.calls[0] as any[];
    expect(userId).toBe("123456");
    expect(message).toContain("test-agent-1");

    // Verify gchat message content
    const [space, gchatMsg] = gchatSendSpy.mock.calls[0] as any[];
    expect(space).toBe("spaces/test-space");
    expect(gchatMsg).toContain("dispatched");
  });

  test("5 rapid dispatches with different agents all send (no throttle)", async () => {
    const ctx = makeMockCtx();
    const agents = ["code", "research", "ops", "security", "design"];

    await Promise.all(
      agents.map((agent) =>
        notify(ctx, {
          event: "dispatch_confirm",
          workItemId: agent,
          telegramMessage: `🤖 ${agent} agent`,
          gchatMessage: `🤖 ${agent} agent dispatched`,
        })
      )
    );

    // 5 agents × 2 channels = 10 messages (no throttle, 0 minIntervalSec)
    expect(telegramSendSpy).toHaveBeenCalledTimes(5);
    expect(gchatSendSpy).toHaveBeenCalledTimes(5);
  });
});

// ── notify() error events ───────────────────────────────

describe("notify error events", () => {
  test("error sends immediately to both channels", async () => {
    const ctx = makeMockCtx();
    await notify(ctx, {
      event: "error",
      workItemId: "timeout",
      telegramMessage: "⚠️ Task timed out after 420s",
      gchatMessage: "⚠️ Task timed out after 420s. The process was terminated.",
    });

    expect(telegramSendSpy).toHaveBeenCalledTimes(1);
    expect(gchatSendSpy).toHaveBeenCalledTimes(1);
  });

  test("multiple rapid errors all send (0 throttle)", async () => {
    const ctx = makeMockCtx();

    await notify(ctx, {
      event: "error",
      workItemId: "timeout-1",
      telegramMessage: "⚠️ Timeout 1",
    });
    await notify(ctx, {
      event: "error",
      workItemId: "sigterm-1",
      telegramMessage: "⚠️ SIGTERM 1",
    });

    expect(telegramSendSpy).toHaveBeenCalledTimes(2);
    expect(gchatSendSpy).toHaveBeenCalledTimes(2);
  });
});

// ── notify() throttle behavior ──────────────────────────

describe("notify throttle behavior", () => {
  test("session_update skips telegram (disabled) and throttles google-chat", async () => {
    const ctx = makeMockCtx();
    const workItem = "ELLIE-80-throttle-test";

    // First send — should go through on gchat
    await notify(ctx, {
      event: "session_update",
      workItemId: workItem,
      telegramMessage: "Update 1",
      gchatMessage: "Update 1 (detailed)",
    });

    expect(telegramSendSpy).toHaveBeenCalledTimes(0); // telegram disabled for session_update
    expect(gchatSendSpy).toHaveBeenCalledTimes(1);

    // Second rapid send — should be throttled on gchat (60s window)
    await notify(ctx, {
      event: "session_update",
      workItemId: workItem,
      telegramMessage: "Update 2",
      gchatMessage: "Update 2 (detailed)",
    });

    // Still only 1 gchat send (second was throttled/batched)
    expect(gchatSendSpy).toHaveBeenCalledTimes(1);
  });

  test("session_update with different workItemIds are not throttled against each other", async () => {
    const ctx = makeMockCtx();

    await notify(ctx, {
      event: "session_update",
      workItemId: "ELLIE-A",
      telegramMessage: "Update A",
      gchatMessage: "Update A",
    });

    await notify(ctx, {
      event: "session_update",
      workItemId: "ELLIE-B",
      telegramMessage: "Update B",
      gchatMessage: "Update B",
    });

    // Different workItemIds → each gets its own throttle window
    expect(gchatSendSpy).toHaveBeenCalledTimes(2);
  });

  test("no gchat messages when gchatSpaceName is not set", async () => {
    const ctx: NotifyContext = {
      bot: { api: { sendMessage: telegramSendSpy } } as any,
      telegramUserId: "123456",
      // no gchatSpaceName
    };

    await notify(ctx, {
      event: "dispatch_confirm",
      workItemId: "test-no-gchat",
      telegramMessage: "🤖 agent",
      gchatMessage: "🤖 agent dispatched",
    });

    expect(telegramSendSpy).toHaveBeenCalledTimes(1);
    expect(gchatSendSpy).toHaveBeenCalledTimes(0);
  });
});

// ── Mock Sprint Scenario (AC6) ──────────────────────────

describe("mock sprint scenario: 10+ tasks in 30 min", () => {
  test("notification count is bounded by policy", async () => {
    const ctx = makeMockCtx();

    // Simulate 10 agent dispatches (different agents)
    const agents = [
      "code-1", "code-2", "research-1", "ops-1", "security-1",
      "design-1", "code-3", "research-2", "ops-2", "code-4",
    ];

    for (const agent of agents) {
      await notify(ctx, {
        event: "dispatch_confirm",
        workItemId: agent,
        telegramMessage: `🤖 ${agent}`,
        gchatMessage: `🤖 ${agent} dispatched`,
      });
    }

    // All 10 dispatch_confirms sent to both channels (0 throttle)
    expect(telegramSendSpy).toHaveBeenCalledTimes(10);
    expect(gchatSendSpy).toHaveBeenCalledTimes(10);

    telegramSendSpy.mockClear();
    gchatSendSpy.mockClear();

    // Simulate 15 session_update events for a single work item (rapid progress updates)
    for (let i = 0; i < 15; i++) {
      await notify(ctx, {
        event: "session_update",
        workItemId: "ELLIE-sprint-main",
        telegramMessage: `Progress ${i + 1}/15`,
        gchatMessage: `Progress update ${i + 1}/15 — details here`,
      });
    }

    // telegram: 0 (session_update disabled)
    // google-chat: 1 (first goes through, remaining 14 throttled at 60s)
    expect(telegramSendSpy).toHaveBeenCalledTimes(0);
    expect(gchatSendSpy).toHaveBeenCalledTimes(1);

    telegramSendSpy.mockClear();
    gchatSendSpy.mockClear();

    // Simulate 2 error events (timeout + SIGTERM)
    await notify(ctx, {
      event: "error",
      workItemId: "timeout-sprint",
      telegramMessage: "⚠️ Timeout",
      gchatMessage: "⚠️ Task timed out",
    });
    await notify(ctx, {
      event: "error",
      workItemId: "sigterm-sprint",
      telegramMessage: "⚠️ SIGTERM",
      gchatMessage: "⚠️ Process interrupted",
    });

    // Both error events sent to both channels (0 throttle, critical)
    expect(telegramSendSpy).toHaveBeenCalledTimes(2);
    expect(gchatSendSpy).toHaveBeenCalledTimes(2);

    // Total: 10+0+2 = 12 telegram, 10+1+2 = 13 gchat
    // vs. naive: 10+15+2 = 27 per channel = 54 total
    // Policy reduces 54 → 25 messages (53% reduction)
  });

  test("memory_contradiction throttled at 5 min on telegram", async () => {
    const ctx = makeMockCtx();

    await notify(ctx, {
      event: "memory_contradiction",
      workItemId: "mem-1",
      telegramMessage: "Contradiction 1",
      gchatMessage: "Contradiction 1 (details)",
    });

    await notify(ctx, {
      event: "memory_contradiction",
      workItemId: "mem-1",
      telegramMessage: "Contradiction 2",
      gchatMessage: "Contradiction 2 (details)",
    });

    // Telegram: 1 (second throttled at 300s)
    // GChat: 1 (second throttled at 60s)
    expect(telegramSendSpy).toHaveBeenCalledTimes(1);
    expect(gchatSendSpy).toHaveBeenCalledTimes(1);
  });
});
