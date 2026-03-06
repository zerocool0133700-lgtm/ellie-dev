/**
 * Tests for Session Metric Hooks — ELLIE-622
 *
 * Covers: scoreCommitMessage, scoreCommitMessages, computeBlockerSpeed,
 *         collectSessionCompleteMetrics, collectSessionPauseMetrics
 */

import { describe, it, expect, beforeEach } from "bun:test";

import {
  scoreCommitMessage,
  scoreCommitMessages,
  computeBlockerSpeed,
  recordTaskCompletion,
  recordBlockerSpeed,
  recordCommitQuality,
  collectSessionCompleteMetrics,
  collectSessionPauseMetrics,
  METRIC_TASK_COMPLETION,
  METRIC_BLOCKER_SPEED,
  METRIC_COMMIT_QUALITY,
} from "../src/session-metric-hooks";

import {
  _resetMetricsForTesting,
  getSessionDataPoints,
  getAgentDataPoints,
} from "../src/growth-metrics-collector";

beforeEach(() => {
  _resetMetricsForTesting();
});

// ── scoreCommitMessage ──────────────────────────────────────────────────────

describe("scoreCommitMessage", () => {
  it("scores 0 for empty message", () => {
    expect(scoreCommitMessage("")).toBe(0);
  });

  it("scores 0.4 for [ELLIE-XXX] prefix only", () => {
    expect(scoreCommitMessage("[ELLIE-123] fix")).toBe(0.4);
  });

  it("scores 0.7 for prefix + descriptive message (>= 20 chars)", () => {
    expect(scoreCommitMessage("[ELLIE-123] Add user registration flow")).toBe(0.7);
  });

  it("scores 1.0 for prefix + detailed message (>= 50 chars)", () => {
    const msg = "[ELLIE-123] Add user registration flow with email validation and password strength checks";
    expect(scoreCommitMessage(msg)).toBe(1.0);
  });

  it("gives partial credit for mentioning work item without brackets", () => {
    const score = scoreCommitMessage("Fix bug related to ELLIE-123 issue", "ELLIE-123");
    expect(score).toBe(0.5); // 0.2 (partial ticket ref) + 0.3 (>= 20 chars)
  });

  it("scores 0.3 for descriptive message without prefix (>= 20 chars)", () => {
    expect(scoreCommitMessage("Fix authentication bug in login flow")).toBe(0.3);
  });

  it("scores 0.6 for detailed message without prefix (>= 50 chars)", () => {
    const msg = "Fix authentication bug in login flow by adding proper token validation checks";
    expect(scoreCommitMessage(msg)).toBe(0.6);
  });

  it("caps score at 1.0", () => {
    const msg = "[ELLIE-123] " + "A".repeat(100);
    expect(scoreCommitMessage(msg)).toBeLessThanOrEqual(1.0);
  });
});

// ── scoreCommitMessages ─────────────────────────────────────────────────────

describe("scoreCommitMessages", () => {
  it("returns 0 for empty array", () => {
    expect(scoreCommitMessages([])).toBe(0);
  });

  it("returns single message score for one-element array", () => {
    const score = scoreCommitMessages(["[ELLIE-5] fix bug"]);
    expect(score).toBe(scoreCommitMessage("[ELLIE-5] fix bug"));
  });

  it("averages scores across multiple messages", () => {
    const msgs = [
      "[ELLIE-5] fix",     // 0.4 (prefix only)
      "no prefix at all",  // 0 (no prefix, < 20 chars)
    ];
    const avg = scoreCommitMessages(msgs);
    expect(avg).toBe(0.2); // (0.4 + 0) / 2
  });
});

// ── computeBlockerSpeed ─────────────────────────────────────────────────────

describe("computeBlockerSpeed", () => {
  it("computes seconds between start and blocker time", () => {
    const start = new Date("2026-03-06T10:00:00Z");
    const blocker = new Date("2026-03-06T10:05:00Z");
    expect(computeBlockerSpeed(start, blocker)).toBe(300);
  });

  it("returns 0 if blocker is before start", () => {
    const start = new Date("2026-03-06T10:05:00Z");
    const blocker = new Date("2026-03-06T10:00:00Z");
    expect(computeBlockerSpeed(start, blocker)).toBe(0);
  });

  it("accepts ISO string inputs", () => {
    const seconds = computeBlockerSpeed("2026-03-06T10:00:00Z", "2026-03-06T10:01:30Z");
    expect(seconds).toBe(90);
  });

  it("uses current time when no blocker time provided", () => {
    const start = new Date(Date.now() - 60_000);
    const seconds = computeBlockerSpeed(start);
    expect(seconds).toBeGreaterThanOrEqual(59);
    expect(seconds).toBeLessThanOrEqual(62);
  });
});

// ── recordTaskCompletion ────────────────────────────────────────────────────

describe("recordTaskCompletion", () => {
  it("records value 1 for completed task", () => {
    recordTaskCompletion("dev", "session-1", true, 30);
    const points = getSessionDataPoints("session-1");
    expect(points).toHaveLength(1);
    expect(points[0].metricName).toBe(METRIC_TASK_COMPLETION);
    expect(points[0].value).toBe(1);
    expect(points[0].metadata?.durationMinutes).toBe(30);
  });

  it("records value 0 for incomplete task", () => {
    recordTaskCompletion("dev", "session-1", false);
    const points = getSessionDataPoints("session-1");
    expect(points).toHaveLength(1);
    expect(points[0].value).toBe(0);
  });
});

// ── recordBlockerSpeed ──────────────────────────────────────────────────────

describe("recordBlockerSpeed", () => {
  it("records blocker speed metric with reason", () => {
    const fiveMinAgo = new Date(Date.now() - 300_000).toISOString();
    recordBlockerSpeed("dev", "session-1", fiveMinAgo, "API not available");
    const points = getSessionDataPoints("session-1");
    expect(points).toHaveLength(1);
    expect(points[0].metricName).toBe(METRIC_BLOCKER_SPEED);
    expect(points[0].value).toBeGreaterThanOrEqual(299);
    expect(points[0].value).toBeLessThanOrEqual(302);
    expect(points[0].metadata?.reason).toBe("API not available");
  });
});

// ── recordCommitQuality ─────────────────────────────────────────────────────

describe("recordCommitQuality", () => {
  it("records commit quality metric", () => {
    recordCommitQuality("dev", "session-1", ["[ELLIE-5] Fix bug"], "ELLIE-5");
    const points = getSessionDataPoints("session-1");
    expect(points).toHaveLength(1);
    expect(points[0].metricName).toBe(METRIC_COMMIT_QUALITY);
    expect(points[0].value).toBe(0.4); // prefix only, short message
    expect(points[0].metadata?.commitCount).toBe(1);
  });

  it("skips recording when no commit messages", () => {
    recordCommitQuality("dev", "session-1", []);
    const points = getSessionDataPoints("session-1");
    expect(points).toHaveLength(0);
  });
});

// ── collectSessionCompleteMetrics ───────────────────────────────────────────

describe("collectSessionCompleteMetrics", () => {
  it("records task completion metric", () => {
    collectSessionCompleteMetrics({
      agentName: "dev",
      sessionId: "session-complete-1",
      durationMinutes: 45,
    });
    const points = getSessionDataPoints("session-complete-1");
    expect(points).toHaveLength(1);
    expect(points[0].metricName).toBe(METRIC_TASK_COMPLETION);
    expect(points[0].value).toBe(1);
  });

  it("records both task completion and commit quality when commits provided", () => {
    collectSessionCompleteMetrics({
      agentName: "dev",
      sessionId: "session-complete-2",
      durationMinutes: 30,
      commitMessages: ["[ELLIE-5] Add endpoint", "[ELLIE-5] Fix tests"],
      workItemId: "ELLIE-5",
    });
    const points = getSessionDataPoints("session-complete-2");
    expect(points).toHaveLength(2);
    const names = points.map((p) => p.metricName).sort();
    expect(names).toEqual([METRIC_COMMIT_QUALITY, METRIC_TASK_COMPLETION]);
  });

  it("skips commit quality when empty commit messages", () => {
    collectSessionCompleteMetrics({
      agentName: "dev",
      sessionId: "session-complete-3",
      durationMinutes: 10,
      commitMessages: [],
    });
    const points = getSessionDataPoints("session-complete-3");
    expect(points).toHaveLength(1);
    expect(points[0].metricName).toBe(METRIC_TASK_COMPLETION);
  });
});

// ── collectSessionPauseMetrics ──────────────────────────────────────────────

describe("collectSessionPauseMetrics", () => {
  it("records task non-completion metric", () => {
    collectSessionPauseMetrics({
      agentName: "dev",
      sessionId: "session-pause-1",
      sessionStartedAt: "2026-03-06T10:00:00Z",
    });
    const points = getSessionDataPoints("session-pause-1");
    expect(points).toHaveLength(1);
    expect(points[0].metricName).toBe(METRIC_TASK_COMPLETION);
    expect(points[0].value).toBe(0);
  });

  it("records both non-completion and blocker speed when reason provided", () => {
    collectSessionPauseMetrics({
      agentName: "dev",
      sessionId: "session-pause-2",
      sessionStartedAt: "2026-03-06T10:00:00Z",
      reason: "Waiting on API access",
    });
    const points = getSessionDataPoints("session-pause-2");
    expect(points).toHaveLength(2);
    const names = points.map((p) => p.metricName).sort();
    expect(names).toEqual([METRIC_BLOCKER_SPEED, METRIC_TASK_COMPLETION]);
  });

  it("skips blocker speed when no reason", () => {
    collectSessionPauseMetrics({
      agentName: "dev",
      sessionId: "session-pause-3",
      sessionStartedAt: "2026-03-06T10:00:00Z",
    });
    const points = getSessionDataPoints("session-pause-3");
    expect(points).toHaveLength(1);
  });
});

// ── Metric name constants ───────────────────────────────────────────────────

describe("metric name constants", () => {
  it("exports expected metric names", () => {
    expect(METRIC_TASK_COMPLETION).toBe("task_completion_rate");
    expect(METRIC_BLOCKER_SPEED).toBe("blocker_identification_speed");
    expect(METRIC_COMMIT_QUALITY).toBe("commit_quality");
  });
});
