/**
 * Tests for ELLIE-614: Dev-Critic Review
 *
 * Covers: buildReviewBrief, parseCriticFeedback, formatFeedback,
 * requestCriticReview, completeCriticReview.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  buildReviewBrief,
  parseCriticFeedback,
  formatFeedback,
  ensureCriticRegistered,
  requestCriticReview,
  completeCriticReview,
  type ReviewContext,
  type CriticFeedback,
} from "../src/dev-critic-review.ts";
import { _resetExchangesForTesting } from "../src/agent-exchange.ts";
import { _resetRegistryForTesting } from "../src/agent-registry.ts";
import { _resetLedgerForTesting } from "../src/commitment-ledger.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetExchangesForTesting();
  _resetRegistryForTesting();
  _resetLedgerForTesting();
});

// ── buildReviewBrief ─────────────────────────────────────────────────────────

describe("buildReviewBrief", () => {
  it("includes work item ID and summary", () => {
    const brief = buildReviewBrief({
      workItemId: "ELLIE-100",
      summary: "Implemented the widget system",
    });
    expect(brief).toContain("## Review Request — ELLIE-100");
    expect(brief).toContain("**Summary**: Implemented the widget system");
  });

  it("includes agent when provided", () => {
    const brief = buildReviewBrief({
      workItemId: "ELLIE-100",
      summary: "Test",
      agent: "dev",
    });
    expect(brief).toContain("**Agent**: dev");
  });

  it("omits agent when not provided", () => {
    const brief = buildReviewBrief({
      workItemId: "ELLIE-100",
      summary: "Test",
    });
    expect(brief).not.toContain("**Agent**");
  });

  it("includes files changed", () => {
    const brief = buildReviewBrief({
      workItemId: "ELLIE-100",
      summary: "Test",
      filesChanged: ["src/foo.ts", "src/bar.ts"],
    });
    expect(brief).toContain("**Files Changed**:");
    expect(brief).toContain("- src/foo.ts");
    expect(brief).toContain("- src/bar.ts");
  });

  it("includes test status when passing", () => {
    const brief = buildReviewBrief({
      workItemId: "ELLIE-100",
      summary: "Test",
      testsPassed: true,
    });
    expect(brief).toContain("**Tests**: passing");
  });

  it("includes test status when failing", () => {
    const brief = buildReviewBrief({
      workItemId: "ELLIE-100",
      summary: "Test",
      testsPassed: false,
    });
    expect(brief).toContain("**Tests**: FAILING");
  });

  it("includes review instructions", () => {
    const brief = buildReviewBrief({
      workItemId: "ELLIE-100",
      summary: "Test",
    });
    expect(brief).toContain("## Review Instructions");
    expect(brief).toContain("ship/no-ship/conditional");
  });
});

// ── parseCriticFeedback ──────────────────────────────────────────────────────

describe("parseCriticFeedback", () => {
  it("parses valid JSON feedback", () => {
    const json = JSON.stringify({
      recommendation: "ship",
      issues: [{ severity: "note", description: "Minor style issue" }],
      positives: ["Clean architecture"],
      summary: "Looks good to ship.",
    });

    const feedback = parseCriticFeedback(json);
    expect(feedback.recommendation).toBe("ship");
    expect(feedback.issues).toHaveLength(1);
    expect(feedback.issues[0].severity).toBe("note");
    expect(feedback.positives).toHaveLength(1);
    expect(feedback.summary).toBe("Looks good to ship.");
  });

  it("handles JSON wrapped in markdown code fences", () => {
    const wrapped = "```json\n" + JSON.stringify({
      recommendation: "no-ship",
      issues: [{ severity: "critical", description: "Missing validation" }],
      positives: [],
      summary: "Needs work.",
    }) + "\n```";

    const feedback = parseCriticFeedback(wrapped);
    expect(feedback.recommendation).toBe("no-ship");
    expect(feedback.issues[0].severity).toBe("critical");
  });

  it("falls back to text summary for invalid JSON", () => {
    const feedback = parseCriticFeedback("This is just plain text feedback.");
    expect(feedback.recommendation).toBe("conditional");
    expect(feedback.issues).toHaveLength(0);
    expect(feedback.positives).toHaveLength(0);
    expect(feedback.summary).toContain("This is just plain text feedback.");
  });

  it("handles missing fields gracefully", () => {
    const json = JSON.stringify({ recommendation: "ship" });
    const feedback = parseCriticFeedback(json);
    expect(feedback.recommendation).toBe("ship");
    expect(feedback.issues).toHaveLength(0);
    expect(feedback.positives).toHaveLength(0);
  });

  it("defaults recommendation to conditional when missing", () => {
    const json = JSON.stringify({ summary: "Some review" });
    const feedback = parseCriticFeedback(json);
    expect(feedback.recommendation).toBe("conditional");
  });
});

// ── formatFeedback ───────────────────────────────────────────────────────────

describe("formatFeedback", () => {
  it("formats ship recommendation", () => {
    const result = formatFeedback({
      recommendation: "ship",
      issues: [],
      positives: ["Clean code"],
      summary: "All good.",
    });
    expect(result).toContain("**Critic Review: SHIP**");
    expect(result).toContain("All good.");
    expect(result).toContain("**What works well:**");
    expect(result).toContain("- Clean code");
  });

  it("formats no-ship with issues", () => {
    const result = formatFeedback({
      recommendation: "no-ship",
      issues: [
        { severity: "critical", description: "SQL injection", location: "src/db.ts:42", suggestion: "Use parameterized queries" },
        { severity: "warning", description: "Missing error handling" },
      ],
      positives: [],
      summary: "Critical issues found.",
    });
    expect(result).toContain("**Critic Review: NO-SHIP**");
    expect(result).toContain("[CRITICAL] (src/db.ts:42) SQL injection");
    expect(result).toContain("Fix: Use parameterized queries");
    expect(result).toContain("[WARNING] Missing error handling");
  });

  it("formats conditional recommendation", () => {
    const result = formatFeedback({
      recommendation: "conditional",
      issues: [{ severity: "note", description: "Consider adding docs" }],
      positives: [],
      summary: "Minor improvements needed.",
    });
    expect(result).toContain("**Critic Review: CONDITIONAL**");
    expect(result).toContain("[NOTE] Consider adding docs");
  });

  it("omits issues section when empty", () => {
    const result = formatFeedback({
      recommendation: "ship",
      issues: [],
      positives: [],
      summary: "Perfect.",
    });
    expect(result).not.toContain("**Issues:**");
  });

  it("omits positives section when empty", () => {
    const result = formatFeedback({
      recommendation: "ship",
      issues: [],
      positives: [],
      summary: "Minimal.",
    });
    expect(result).not.toContain("**What works well:**");
  });
});

// ── ensureCriticRegistered ───────────────────────────────────────────────────

describe("ensureCriticRegistered", () => {
  it("registers critic agent with code-review capability", () => {
    const agent = ensureCriticRegistered();
    expect(agent.agentName).toBe("critic");
    expect(agent.agentType).toBe("specialist");
    expect(agent.capabilities).toHaveLength(2);
    expect(agent.capabilities[0].name).toBe("code-review");
  });

  it("is idempotent — safe to call multiple times", () => {
    const first = ensureCriticRegistered();
    const second = ensureCriticRegistered();
    expect(first.agentName).toBe(second.agentName);
  });
});

// ── requestCriticReview ──────────────────────────────────────────────────────

describe("requestCriticReview", () => {
  it("returns success with requestId and exchangeId", () => {
    const result = requestCriticReview("session-1", {
      workItemId: "ELLIE-100",
      summary: "Implemented feature X",
      agent: "dev",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.requestId).toBeTruthy();
      expect(result.exchangeId).toBeTruthy();
    }
  });

  it("auto-approves the request", () => {
    const result = requestCriticReview("session-1", {
      workItemId: "ELLIE-100",
      summary: "Test",
    });
    // If it got to opening an exchange, approval succeeded
    expect(result.success).toBe(true);
  });

  it("uses dev as default agent when not specified", () => {
    const result = requestCriticReview("session-1", {
      workItemId: "ELLIE-100",
      summary: "Test",
    });
    expect(result.success).toBe(true);
  });

  it("works with files changed and test status", () => {
    const result = requestCriticReview("session-1", {
      workItemId: "ELLIE-200",
      summary: "Refactored auth module",
      agent: "dev",
      filesChanged: ["src/auth.ts", "tests/auth.test.ts"],
      testsPassed: true,
    });
    expect(result.success).toBe(true);
  });

  it("works with custom turn number", () => {
    const result = requestCriticReview("session-1", {
      workItemId: "ELLIE-100",
      summary: "Test",
    }, 5);
    expect(result.success).toBe(true);
  });
});

// ── completeCriticReview ─────────────────────────────────────────────────────

describe("completeCriticReview", () => {
  it("parses feedback and closes exchange", () => {
    // First request a review to get IDs
    const reviewResult = requestCriticReview("session-1", {
      workItemId: "ELLIE-100",
      summary: "Test feature",
      agent: "dev",
    });
    expect(reviewResult.success).toBe(true);
    if (!reviewResult.success) return;

    const criticResponse = JSON.stringify({
      recommendation: "ship",
      issues: [],
      positives: ["Well structured"],
      summary: "Ready to ship.",
    });

    const result = completeCriticReview(
      reviewResult.exchangeId,
      reviewResult.requestId,
      criticResponse,
    );

    expect("feedback" in result).toBe(true);
    if ("feedback" in result) {
      expect(result.feedback.recommendation).toBe("ship");
      expect(result.feedback.positives).toContain("Well structured");
      expect(result.formatted).toContain("**Critic Review: SHIP**");
    }
  });

  it("handles plain text critic response", () => {
    const reviewResult = requestCriticReview("session-1", {
      workItemId: "ELLIE-100",
      summary: "Test",
    });
    expect(reviewResult.success).toBe(true);
    if (!reviewResult.success) return;

    const result = completeCriticReview(
      reviewResult.exchangeId,
      reviewResult.requestId,
      "The code looks fine but consider adding error handling.",
    );

    expect("feedback" in result).toBe(true);
    if ("feedback" in result) {
      expect(result.feedback.recommendation).toBe("conditional");
      expect(result.feedback.summary).toContain("code looks fine");
    }
  });

  it("returns error for invalid exchange ID", () => {
    const result = completeCriticReview("nonexistent", "req-1", "feedback");
    expect("error" in result).toBe(true);
  });

  it("handles no-ship response with issues", () => {
    const reviewResult = requestCriticReview("session-1", {
      workItemId: "ELLIE-300",
      summary: "Security update",
      agent: "dev",
    });
    expect(reviewResult.success).toBe(true);
    if (!reviewResult.success) return;

    const criticResponse = JSON.stringify({
      recommendation: "no-ship",
      issues: [
        { severity: "critical", description: "XSS vulnerability", location: "src/render.ts:15" },
      ],
      positives: [],
      summary: "Critical security issue found.",
    });

    const result = completeCriticReview(
      reviewResult.exchangeId,
      reviewResult.requestId,
      criticResponse,
    );

    expect("feedback" in result).toBe(true);
    if ("feedback" in result) {
      expect(result.feedback.recommendation).toBe("no-ship");
      expect(result.feedback.issues).toHaveLength(1);
      expect(result.feedback.issues[0].severity).toBe("critical");
      expect(result.formatted).toContain("[CRITICAL]");
    }
  });
});

// ── Full flow integration ────────────────────────────────────────────────────

describe("full review flow", () => {
  it("request → respond → complete", () => {
    // 1. Request review
    const review = requestCriticReview("session-42", {
      workItemId: "ELLIE-500",
      summary: "Added pagination to API",
      agent: "dev",
      filesChanged: ["src/api/list.ts"],
      testsPassed: true,
    });
    expect(review.success).toBe(true);
    if (!review.success) return;

    // 2. Critic responds
    const criticJson = JSON.stringify({
      recommendation: "conditional",
      issues: [
        { severity: "warning", description: "No limit cap on page size", suggestion: "Add max 100 limit" },
      ],
      positives: ["Good test coverage", "Clean API design"],
      summary: "Mostly good, one concern about unbounded page size.",
    });

    // 3. Complete review
    const result = completeCriticReview(review.exchangeId, review.requestId, criticJson);
    expect("feedback" in result).toBe(true);
    if ("feedback" in result) {
      expect(result.feedback.recommendation).toBe("conditional");
      expect(result.feedback.issues).toHaveLength(1);
      expect(result.feedback.positives).toHaveLength(2);
      expect(result.formatted).toContain("CONDITIONAL");
      expect(result.formatted).toContain("No limit cap on page size");
      expect(result.formatted).toContain("Add max 100 limit");
      expect(result.formatted).toContain("Good test coverage");
    }
  });
});
