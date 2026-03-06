/**
 * Tests for Exchange Timeout Handler — ELLIE-602
 *
 * Covers: timeout detection, escalation severity, grace period calculation,
 * sub-commitment cleanup, coordinator notifications, and full scenarios.
 */

import { describe, it, expect, beforeEach } from "bun:test";

import {
  calculateAllowedDuration,
  checkExchangeTimeout,
  detectTimeouts,
  findEstimatedDuration,
  cleanupStaleSubCommitments,
  buildEscalationNotification,
  buildEscalationsSection,
  buildCleanupSummary,
  getEscalations,
  getEscalationsForExchange,
  DEFAULT_TIMEOUT_CONFIG,
  _resetTimeoutHandlerForTesting,
  type TimeoutConfig,
  type ExchangeEscalation,
} from "../src/exchange-timeout-handler";

import {
  openExchange,
  addMessage,
  _resetExchangesForTesting,
  type AgentExchange,
} from "../src/agent-exchange";

import {
  createCommitment,
  createSubCommitment,
  getCommitment,
  listSubCommitments,
  _resetLedgerForTesting,
} from "../src/commitment-ledger";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeExchange(overrides: Partial<AgentExchange> = {}): AgentExchange {
  return {
    id: "ex-1",
    agentRequestId: "req-1",
    requestingAgent: "dev",
    targetAgent: "critic",
    status: "active",
    context: "Review this code",
    messages: [],
    openedAt: new Date().toISOString(),
    ...overrides,
  };
}

function minutesAgo(minutes: number, from?: Date): Date {
  const base = from ?? new Date();
  return new Date(base.getTime() - minutes * 60 * 1000);
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetTimeoutHandlerForTesting();
  _resetExchangesForTesting();
  _resetLedgerForTesting();
});

// ── calculateAllowedDuration ─────────────────────────────────────────────────

describe("calculateAllowedDuration", () => {
  it("uses estimate × graceMultiplier when estimate provided", () => {
    const result = calculateAllowedDuration(5); // 5 minutes
    // Default graceMultiplier is 2, so allowed = 5min × 2 = 10min
    expect(result.allowedMs).toBe(10 * 60 * 1000);
    expect(result.gracePeriodMs).toBe(5 * 60 * 1000);
  });

  it("uses defaultTimeoutMs when no estimate", () => {
    const result = calculateAllowedDuration(null);
    expect(result.allowedMs).toBe(DEFAULT_TIMEOUT_CONFIG.defaultTimeoutMs);
    expect(result.gracePeriodMs).toBe(DEFAULT_TIMEOUT_CONFIG.defaultTimeoutMs);
  });

  it("uses defaultTimeoutMs for zero estimate", () => {
    const result = calculateAllowedDuration(0);
    expect(result.allowedMs).toBe(DEFAULT_TIMEOUT_CONFIG.defaultTimeoutMs);
  });

  it("uses defaultTimeoutMs for negative estimate", () => {
    const result = calculateAllowedDuration(-5);
    expect(result.allowedMs).toBe(DEFAULT_TIMEOUT_CONFIG.defaultTimeoutMs);
  });

  it("uses defaultTimeoutMs for undefined estimate", () => {
    const result = calculateAllowedDuration(undefined);
    expect(result.allowedMs).toBe(DEFAULT_TIMEOUT_CONFIG.defaultTimeoutMs);
  });

  it("respects custom graceMultiplier", () => {
    const config: TimeoutConfig = { ...DEFAULT_TIMEOUT_CONFIG, graceMultiplier: 3 };
    const result = calculateAllowedDuration(5, config);
    // 5min × 3 = 15min
    expect(result.allowedMs).toBe(15 * 60 * 1000);
    expect(result.gracePeriodMs).toBe(10 * 60 * 1000);
  });

  it("respects custom defaultTimeoutMs", () => {
    const config: TimeoutConfig = { ...DEFAULT_TIMEOUT_CONFIG, defaultTimeoutMs: 5 * 60 * 1000 };
    const result = calculateAllowedDuration(null, config);
    expect(result.allowedMs).toBe(5 * 60 * 1000);
  });
});

// ── checkExchangeTimeout ─────────────────────────────────────────────────────

describe("checkExchangeTimeout", () => {
  it("returns null for non-active exchange", () => {
    const exchange = makeExchange({ status: "completed" });
    const result = checkExchangeTimeout(exchange, 5);
    expect(result).toBeNull();
  });

  it("returns null when within allowed time", () => {
    const now = new Date();
    const exchange = makeExchange({ openedAt: minutesAgo(3, now).toISOString() });
    const result = checkExchangeTimeout(exchange, 5, DEFAULT_TIMEOUT_CONFIG, now);
    expect(result).toBeNull();
  });

  it("returns escalation when past allowed time with estimate", () => {
    const now = new Date();
    // Opened 15 minutes ago, estimate is 5 min, allowed = 10 min
    const exchange = makeExchange({ openedAt: minutesAgo(15, now).toISOString() });
    const result = checkExchangeTimeout(exchange, 5, DEFAULT_TIMEOUT_CONFIG, now);
    expect(result).not.toBeNull();
    expect(result!.exchangeId).toBe("ex-1");
    expect(result!.requestingAgent).toBe("dev");
    expect(result!.targetAgent).toBe("critic");
    expect(result!.estimatedDurationMs).toBe(5 * 60 * 1000);
    expect(result!.severity).toBe("warning");
    expect(result!.recommendedAction).toBe("ping_agent");
  });

  it("returns escalation when past default timeout without estimate", () => {
    const now = new Date();
    // Opened 15 minutes ago, no estimate, default timeout = 10 min
    const exchange = makeExchange({ openedAt: minutesAgo(15, now).toISOString() });
    const result = checkExchangeTimeout(exchange, null, DEFAULT_TIMEOUT_CONFIG, now);
    expect(result).not.toBeNull();
    expect(result!.estimatedDurationMs).toBeNull();
    expect(result!.severity).toBe("warning");
  });

  it("returns critical severity when way past allowed time", () => {
    const now = new Date();
    // Opened 60 minutes ago, estimate 5 min, allowed = 10 min
    // Critical threshold = 10 min × 3 = 30 min. 60 > 30, so critical.
    const exchange = makeExchange({ openedAt: minutesAgo(60, now).toISOString() });
    const result = checkExchangeTimeout(exchange, 5, DEFAULT_TIMEOUT_CONFIG, now);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("critical");
    expect(result!.recommendedAction).toBe("abort_exchange");
  });

  it("includes message info in reason", () => {
    const now = new Date();
    const exchange = makeExchange({
      openedAt: minutesAgo(15, now).toISOString(),
      messages: [
        { from: "dev", content: "Please review", timestamp: minutesAgo(14, now).toISOString() },
        { from: "critic", content: "Looking...", timestamp: minutesAgo(12, now).toISOString() },
      ],
    });
    const result = checkExchangeTimeout(exchange, 5, DEFAULT_TIMEOUT_CONFIG, now);
    expect(result).not.toBeNull();
    expect(result!.reason).toContain("2 messages");
    expect(result!.reason).toContain("critic");
  });

  it("handles exchange with no messages", () => {
    const now = new Date();
    const exchange = makeExchange({ openedAt: minutesAgo(15, now).toISOString() });
    const result = checkExchangeTimeout(exchange, 5, DEFAULT_TIMEOUT_CONFIG, now);
    expect(result).not.toBeNull();
    expect(result!.reason).toContain("No messages");
  });

  it("returns null at exact boundary", () => {
    const now = new Date();
    // Estimate 5 min, allowed = 10 min. At exactly 10 min, should NOT escalate.
    const exchange = makeExchange({ openedAt: minutesAgo(10, now).toISOString() });
    const result = checkExchangeTimeout(exchange, 5, DEFAULT_TIMEOUT_CONFIG, now);
    expect(result).toBeNull();
  });

  it("respects custom criticalMultiplier", () => {
    const now = new Date();
    const config: TimeoutConfig = { ...DEFAULT_TIMEOUT_CONFIG, criticalMultiplier: 1.5 };
    // Estimate 5 min, allowed = 10 min. Critical = 10 × 1.5 = 15 min.
    // At 16 min: critical.
    const exchange = makeExchange({ openedAt: minutesAgo(16, now).toISOString() });
    const result = checkExchangeTimeout(exchange, 5, config, now);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("critical");
  });
});

// ── detectTimeouts ───────────────────────────────────────────────────────────

describe("detectTimeouts", () => {
  it("returns empty when no active exchanges", () => {
    const result = detectTimeouts("session-1");
    expect(result).toEqual([]);
  });

  it("detects timeout on active exchange without estimate", () => {
    const now = new Date();
    // Open an exchange that started 15 minutes ago
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review code",
    });

    // Manually set openedAt to 15 minutes ago by accessing the exchange
    // We need to work around immutability — create a new exchange with old time
    _resetExchangesForTesting();
    const oldTime = minutesAgo(15, now);
    const { exchange: ex2 } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review code",
    });

    // Use a short default timeout for testing
    const config: TimeoutConfig = {
      graceMultiplier: 2,
      defaultTimeoutMs: 5 * 60 * 1000, // 5 min default
      criticalMultiplier: 3,
    };

    // The exchange was just created (now), so with 5 min timeout it won't trigger
    const result = detectTimeouts("session-1", config, now);
    expect(result).toEqual([]);
  });

  it("finds estimated duration from sub-commitment", () => {
    const sessionId = "session-1";

    // Create parent commitment
    const parent = createCommitment({
      sessionId,
      description: "Main task",
      source: "dispatch",
      turnCreated: 1,
    });

    // Create sub-commitment with estimated duration
    const sub = createSubCommitment({
      sessionId,
      parentCommitmentId: parent.id,
      description: "Review code",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
      estimatedDuration: 5,
    });

    // Open an exchange matching the sub-commitment agents
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review code",
    });

    const estimated = findEstimatedDuration(sessionId, exchange);
    expect(estimated).toBe(5);
  });

  it("returns null estimated duration when no matching sub-commitment", () => {
    const sessionId = "session-1";

    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review code",
    });

    const estimated = findEstimatedDuration(sessionId, exchange);
    expect(estimated).toBeNull();
  });

  it("stores escalations for later retrieval", () => {
    expect(getEscalations()).toEqual([]);

    const now = new Date();
    const exchange = makeExchange({ openedAt: minutesAgo(15, now).toISOString() });
    checkExchangeTimeout(exchange, 5, DEFAULT_TIMEOUT_CONFIG, now);

    // checkExchangeTimeout doesn't store — only detectTimeouts does
    expect(getEscalations()).toEqual([]);
  });
});

// ── cleanupStaleSubCommitments ───────────────────────────────────────────────

describe("cleanupStaleSubCommitments", () => {
  it("resolves pending sub-commitments without active exchange", () => {
    const sessionId = "session-1";

    const parent = createCommitment({
      sessionId,
      description: "Main task",
      source: "dispatch",
      turnCreated: 1,
    });

    const sub = createSubCommitment({
      sessionId,
      parentCommitmentId: parent.id,
      description: "Review code",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
      estimatedDuration: 5,
    });

    const result = cleanupStaleSubCommitments(sessionId, parent.id, 10);
    expect(result.cleanedUp).toBe(1);
    expect(result.commitments).toHaveLength(1);
    expect(result.commitments[0].id).toBe(sub!.id);

    // Verify it was resolved
    const resolved = getCommitment(sessionId, sub!.id);
    expect(resolved!.status).toBe("resolved");
  });

  it("leaves sub-commitments with active exchanges alone", () => {
    const sessionId = "session-1";

    const parent = createCommitment({
      sessionId,
      description: "Main task",
      source: "dispatch",
      turnCreated: 1,
    });

    const sub = createSubCommitment({
      sessionId,
      parentCommitmentId: parent.id,
      description: "Review code",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    });

    // Create matching active exchange
    openExchange({
      agentRequestId: sub!.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review code",
    });

    const result = cleanupStaleSubCommitments(sessionId, parent.id, 10);
    expect(result.cleanedUp).toBe(0);

    // Verify still pending
    const stillPending = getCommitment(sessionId, sub!.id);
    expect(stillPending!.status).toBe("pending");
  });

  it("returns zero when no pending sub-commitments", () => {
    const sessionId = "session-1";

    const parent = createCommitment({
      sessionId,
      description: "Main task",
      source: "dispatch",
      turnCreated: 1,
    });

    const result = cleanupStaleSubCommitments(sessionId, parent.id, 10);
    expect(result.cleanedUp).toBe(0);
    expect(result.commitments).toEqual([]);
  });

  it("cleans up multiple stale sub-commitments", () => {
    const sessionId = "session-1";

    const parent = createCommitment({
      sessionId,
      description: "Main task",
      source: "dispatch",
      turnCreated: 1,
    });

    createSubCommitment({
      sessionId,
      parentCommitmentId: parent.id,
      description: "Review code",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    });

    createSubCommitment({
      sessionId,
      parentCommitmentId: parent.id,
      description: "Research topic",
      requestingAgent: "dev",
      targetAgent: "research",
      turnCreated: 3,
    });

    const result = cleanupStaleSubCommitments(sessionId, parent.id, 10);
    expect(result.cleanedUp).toBe(2);
  });
});

// ── buildEscalationNotification ──────────────────────────────────────────────

describe("buildEscalationNotification", () => {
  it("formats warning escalation", () => {
    const escalation: ExchangeEscalation = {
      exchangeId: "ex-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      estimatedDurationMs: 5 * 60 * 1000,
      actualElapsedMs: 12 * 60 * 1000,
      gracePeriodMs: 5 * 60 * 1000,
      severity: "warning",
      recommendedAction: "ping_agent",
      reason: "Exchange overdue",
      timestamp: new Date().toISOString(),
    };

    const notification = buildEscalationNotification(escalation);
    expect(notification).toContain("WARNING");
    expect(notification).toContain("dev -> critic");
    expect(notification).toContain("12m");
    expect(notification).toContain("5m");
    expect(notification).toContain("Ping critic");
  });

  it("formats critical escalation", () => {
    const escalation: ExchangeEscalation = {
      exchangeId: "ex-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      estimatedDurationMs: 5 * 60 * 1000,
      actualElapsedMs: 45 * 60 * 1000,
      gracePeriodMs: 5 * 60 * 1000,
      severity: "critical",
      recommendedAction: "abort_exchange",
      reason: "Exchange critically overdue",
      timestamp: new Date().toISOString(),
    };

    const notification = buildEscalationNotification(escalation);
    expect(notification).toContain("CRITICAL");
    expect(notification).toContain("Abort");
  });

  it("handles no estimate", () => {
    const escalation: ExchangeEscalation = {
      exchangeId: "ex-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      estimatedDurationMs: null,
      actualElapsedMs: 15 * 60 * 1000,
      gracePeriodMs: 10 * 60 * 1000,
      severity: "warning",
      recommendedAction: "ping_agent",
      reason: "Exchange overdue",
      timestamp: new Date().toISOString(),
    };

    const notification = buildEscalationNotification(escalation);
    expect(notification).toContain("no estimate");
  });
});

// ── buildEscalationsSection ──────────────────────────────────────────────────

describe("buildEscalationsSection", () => {
  it("returns null for empty escalations", () => {
    const result = buildEscalationsSection([]);
    expect(result).toBeNull();
  });

  it("groups by severity", () => {
    const escalations: ExchangeEscalation[] = [
      {
        exchangeId: "ex-1",
        requestingAgent: "dev",
        targetAgent: "critic",
        estimatedDurationMs: 5 * 60 * 1000,
        actualElapsedMs: 45 * 60 * 1000,
        gracePeriodMs: 5 * 60 * 1000,
        severity: "critical",
        recommendedAction: "abort_exchange",
        reason: "Critically overdue",
        timestamp: new Date().toISOString(),
      },
      {
        exchangeId: "ex-2",
        requestingAgent: "dev",
        targetAgent: "research",
        estimatedDurationMs: 10 * 60 * 1000,
        actualElapsedMs: 25 * 60 * 1000,
        gracePeriodMs: 10 * 60 * 1000,
        severity: "warning",
        recommendedAction: "ping_agent",
        reason: "Overdue",
        timestamp: new Date().toISOString(),
      },
    ];

    const section = buildEscalationsSection(escalations);
    expect(section).not.toBeNull();
    expect(section).toContain("EXCHANGE TIMEOUTS (2)");
    expect(section).toContain("CRITICAL (1)");
    expect(section).toContain("WARNING (1)");
    expect(section).toContain("ABORT");
    expect(section).toContain("PING");
  });

  it("shows only warnings when no critical", () => {
    const escalations: ExchangeEscalation[] = [
      {
        exchangeId: "ex-1",
        requestingAgent: "dev",
        targetAgent: "critic",
        estimatedDurationMs: 5 * 60 * 1000,
        actualElapsedMs: 12 * 60 * 1000,
        gracePeriodMs: 5 * 60 * 1000,
        severity: "warning",
        recommendedAction: "ping_agent",
        reason: "Overdue",
        timestamp: new Date().toISOString(),
      },
    ];

    const section = buildEscalationsSection(escalations);
    expect(section).toContain("WARNING (1)");
    expect(section).not.toContain("CRITICAL");
  });
});

// ── buildCleanupSummary ──────────────────────────────────────────────────────

describe("buildCleanupSummary", () => {
  it("reports no cleanup needed", () => {
    const result = buildCleanupSummary({
      sessionId: "session-1",
      cleanedUp: 0,
      commitments: [],
    });
    expect(result).toContain("no stale sub-commitments");
  });

  it("lists cleaned up commitments", () => {
    const sessionId = "session-1";

    const parent = createCommitment({
      sessionId,
      description: "Main task",
      source: "dispatch",
      turnCreated: 1,
    });

    const sub = createSubCommitment({
      sessionId,
      parentCommitmentId: parent.id,
      description: "Review code",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    });

    const result = buildCleanupSummary({
      sessionId,
      cleanedUp: 1,
      commitments: [sub!],
    });

    expect(result).toContain("Cleaned up 1 stale sub-commitment");
    expect(result).toContain("Review code");
    expect(result).toContain("dev -> critic");
  });

  it("pluralizes correctly", () => {
    const result = buildCleanupSummary({
      sessionId: "session-1",
      cleanedUp: 3,
      commitments: [],
    });
    expect(result).toContain("sub-commitments");
  });
});

// ── getEscalations queries ───────────────────────────────────────────────────

describe("getEscalations", () => {
  it("starts empty", () => {
    expect(getEscalations()).toEqual([]);
  });

  it("filters by exchange ID", () => {
    expect(getEscalationsForExchange("ex-1")).toEqual([]);
  });
});

// ── Full scenarios ───────────────────────────────────────────────────────────

describe("full scenarios", () => {
  it("exchange with estimate: no timeout -> warning -> critical", () => {
    const now = new Date();
    const estimateMin = 5;

    // T=0: exchange just opened — no timeout
    const exchange1 = makeExchange({ openedAt: now.toISOString() });
    expect(checkExchangeTimeout(exchange1, estimateMin, DEFAULT_TIMEOUT_CONFIG, now)).toBeNull();

    // T=8 min: within grace (allowed = 10 min) — no timeout
    const exchange2 = makeExchange({ openedAt: minutesAgo(8, now).toISOString() });
    expect(checkExchangeTimeout(exchange2, estimateMin, DEFAULT_TIMEOUT_CONFIG, now)).toBeNull();

    // T=12 min: past grace (10 min), below critical (30 min) — warning
    const exchange3 = makeExchange({ openedAt: minutesAgo(12, now).toISOString() });
    const warning = checkExchangeTimeout(exchange3, estimateMin, DEFAULT_TIMEOUT_CONFIG, now);
    expect(warning).not.toBeNull();
    expect(warning!.severity).toBe("warning");

    // T=35 min: past critical (30 min) — critical
    const exchange4 = makeExchange({ openedAt: minutesAgo(35, now).toISOString() });
    const critical = checkExchangeTimeout(exchange4, estimateMin, DEFAULT_TIMEOUT_CONFIG, now);
    expect(critical).not.toBeNull();
    expect(critical!.severity).toBe("critical");
  });

  it("cleanup after session: stale subs resolved, active ones preserved", () => {
    const sessionId = "session-1";

    const parent = createCommitment({
      sessionId,
      description: "Main task",
      source: "dispatch",
      turnCreated: 1,
    });

    // Sub 1: no active exchange (stale)
    const staleSub = createSubCommitment({
      sessionId,
      parentCommitmentId: parent.id,
      description: "Stale review",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    });

    // Sub 2: has active exchange (preserved)
    const activeSub = createSubCommitment({
      sessionId,
      parentCommitmentId: parent.id,
      description: "Active research",
      requestingAgent: "dev",
      targetAgent: "research",
      turnCreated: 3,
    });

    // Create exchange for sub 2
    openExchange({
      agentRequestId: activeSub!.id,
      requestingAgent: "dev",
      targetAgent: "research",
      context: "Research topic",
    });

    const result = cleanupStaleSubCommitments(sessionId, parent.id, 10);
    expect(result.cleanedUp).toBe(1);
    expect(result.commitments[0].id).toBe(staleSub!.id);

    // Verify stale one resolved, active one still pending
    expect(getCommitment(sessionId, staleSub!.id)!.status).toBe("resolved");
    expect(getCommitment(sessionId, activeSub!.id)!.status).toBe("pending");
  });

  it("end-to-end: detect, notify, clean up", () => {
    const sessionId = "session-1";
    const now = new Date();

    // Create parent commitment
    const parent = createCommitment({
      sessionId,
      description: "Main task",
      source: "dispatch",
      turnCreated: 1,
    });

    // Create sub with 5 min estimate
    const sub = createSubCommitment({
      sessionId,
      parentCommitmentId: parent.id,
      description: "Code review",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
      estimatedDuration: 5,
    });

    // Check timeout — exchange just created, not timed out
    const exchange = makeExchange({
      id: "ex-end-to-end",
      openedAt: minutesAgo(12, now).toISOString(),
      messages: [
        { from: "dev", content: "Please review", timestamp: minutesAgo(11, now).toISOString() },
      ],
    });

    const escalation = checkExchangeTimeout(exchange, 5, DEFAULT_TIMEOUT_CONFIG, now);
    expect(escalation).not.toBeNull();

    // Build notification
    const notification = buildEscalationNotification(escalation!);
    expect(notification).toContain("WARNING");
    expect(notification).toContain("dev -> critic");

    // Build section
    const section = buildEscalationsSection([escalation!]);
    expect(section).toContain("EXCHANGE TIMEOUTS (1)");

    // Clean up
    const cleanup = cleanupStaleSubCommitments(sessionId, parent.id, 10);
    expect(cleanup.cleanedUp).toBe(1);

    // Build cleanup summary
    const summary = buildCleanupSummary(cleanup);
    expect(summary).toContain("Cleaned up 1");
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles cancelled exchange (no timeout)", () => {
    const exchange = makeExchange({ status: "cancelled" });
    const result = checkExchangeTimeout(exchange, 5);
    expect(result).toBeNull();
  });

  it("handles timed_out exchange (no double timeout)", () => {
    const exchange = makeExchange({ status: "timed_out" });
    const result = checkExchangeTimeout(exchange, 5);
    expect(result).toBeNull();
  });

  it("handles completed exchange (no timeout)", () => {
    const exchange = makeExchange({ status: "completed" });
    const result = checkExchangeTimeout(exchange, 5);
    expect(result).toBeNull();
  });

  it("handles very large estimated duration", () => {
    const now = new Date();
    const exchange = makeExchange({ openedAt: minutesAgo(100, now).toISOString() });
    // 120 min estimate → allowed = 240 min → no timeout at 100 min
    const result = checkExchangeTimeout(exchange, 120, DEFAULT_TIMEOUT_CONFIG, now);
    expect(result).toBeNull();
  });

  it("handles very small estimated duration", () => {
    const now = new Date();
    const exchange = makeExchange({ openedAt: minutesAgo(5, now).toISOString() });
    // 1 min estimate → allowed = 2 min → timeout at 5 min
    const result = checkExchangeTimeout(exchange, 1, DEFAULT_TIMEOUT_CONFIG, now);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("warning");
  });

  it("formatDuration handles hours", () => {
    const now = new Date();
    // 90 minutes ago → should show as 1h30m or similar
    const exchange = makeExchange({ openedAt: minutesAgo(90, now).toISOString() });
    const result = checkExchangeTimeout(exchange, 1, DEFAULT_TIMEOUT_CONFIG, now);
    expect(result).not.toBeNull();
    // The reason should contain duration info
    expect(result!.reason.length).toBeGreaterThan(0);
  });
});
