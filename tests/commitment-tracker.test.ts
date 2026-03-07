/**
 * ELLIE-339 — Commitment tracker tests
 *
 * Tests for:
 *  - extractCommitments: pattern-based extraction from user messages
 *  - isSuppressed: filtering out conditional/hypothetical language
 *  - selectFollowUps: choosing which commitments to surface
 *  - formatFollowUpPrompt: generating gentle prompt hints
 *  - detectCompletion: recognizing when commitments are done
 *  - buildSnoozeUntil: snooze date calculation
 *  - shouldExpire: expiry logic
 */

import { describe, it, expect } from "bun:test";
import {
  extractCommitments,
  isSuppressed,
  selectFollowUps,
  formatFollowUpPrompt,
  detectCompletion,
  buildSnoozeUntil,
  shouldExpire,
  type StoredCommitment,
  type CommitmentFollowUp,
} from "../src/api/commitment-tracker.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

function commitment(
  overrides: Partial<StoredCommitment> & { content: string },
): StoredCommitment {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
    status: "active",
    surfaceCount: 0,
    source: "telegram",
    ...overrides,
  };
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

// ── extractCommitments ─────────────────────────────────────────────────────

describe("extractCommitments", () => {
  it("extracts 'I will' commitments", () => {
    const results = extractCommitments("I will finish the dashboard redesign tomorrow");
    expect(results).toHaveLength(1);
    expect(results[0].text).toContain("finish the dashboard redesign tomorrow");
    expect(results[0].pattern).toBe("i_will");
    expect(results[0].confidence).toBe(0.85);
  });

  it("extracts \"I'll\" contractions", () => {
    const results = extractCommitments("I'll update the deployment script this week");
    expect(results).toHaveLength(1);
    expect(results[0].text).toContain("update the deployment script");
  });

  it("extracts 'I need to' commitments", () => {
    const results = extractCommitments("I need to call the dentist about that appointment");
    expect(results).toHaveLength(1);
    expect(results[0].pattern).toBe("need_to");
    expect(results[0].confidence).toBe(0.7);
  });

  it("extracts 'I should' commitments", () => {
    const results = extractCommitments("I should probably clean up the backlog this weekend");
    expect(results).toHaveLength(1);
    expect(results[0].pattern).toBe("should");
  });

  it("extracts 'I have to' commitments", () => {
    const results = extractCommitments("I have to submit the tax forms before April");
    expect(results).toHaveLength(1);
    expect(results[0].pattern).toBe("have_to");
  });

  it("extracts 'remind me to' with high confidence", () => {
    const results = extractCommitments("Remind me to check the server logs after lunch");
    expect(results).toHaveLength(1);
    expect(results[0].confidence).toBe(0.95);
    expect(results[0].pattern).toBe("remind_me");
  });

  it("extracts 'don't let me forget' with high confidence", () => {
    const results = extractCommitments("Don't let me forget to order more coffee beans");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const best = results.sort((a, b) => b.confidence - a.confidence)[0];
    expect(best.confidence).toBe(0.95);
    expect(best.pattern).toBe("dont_forget");
  });

  it("extracts 'I'm going to' commitments", () => {
    const results = extractCommitments("I'm going to refactor the auth module next sprint");
    expect(results).toHaveLength(1);
    expect(results[0].pattern).toBe("going_to");
  });

  it("returns empty for short messages", () => {
    expect(extractCommitments("ok")).toHaveLength(0);
    expect(extractCommitments("yes please")).toHaveLength(0);
  });

  it("returns empty for messages without commitments", () => {
    expect(extractCommitments("What's the weather like today in Austin?")).toHaveLength(0);
    expect(extractCommitments("Can you show me the deployment status?")).toHaveLength(0);
  });

  it("filters out very short captured text", () => {
    // "I will do it" — captured "do it" is < 8 chars
    expect(extractCommitments("I will do it")).toHaveLength(0);
  });
});

// ── isSuppressed ───────────────────────────────────────────────────────────

describe("isSuppressed", () => {
  it("suppresses conditional language", () => {
    expect(isSuppressed("if I need to fix the bug")).toBe(true);
  });

  it("suppresses hypothetical language", () => {
    expect(isSuppressed("I would need to refactor that")).toBe(true);
    expect(isSuppressed("I could probably fix it")).toBe(true);
    expect(isSuppressed("I might update the docs")).toBe(true);
  });

  it("suppresses questions", () => {
    expect(isSuppressed("should I update the dashboard?")).toBe(true);
  });

  it("suppresses 'you' references (addressing bot)", () => {
    expect(isSuppressed("you need to check the logs")).toBe(true);
  });

  it("allows direct commitments", () => {
    expect(isSuppressed("I will finish the dashboard")).toBe(false);
    expect(isSuppressed("I need to call the dentist")).toBe(false);
  });
});

// ── selectFollowUps ────────────────────────────────────────────────────────

describe("selectFollowUps", () => {
  it("returns empty for no commitments", () => {
    expect(selectFollowUps([])).toHaveLength(0);
  });

  it("returns empty for only snoozed commitments", () => {
    const snoozed = commitment({
      content: "fix the login bug",
      status: "active",
      snoozedUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(selectFollowUps([snoozed])).toHaveLength(0);
  });

  it("returns empty for completed commitments", () => {
    const completed = commitment({
      content: "fix the login bug",
      status: "completed",
    });
    expect(selectFollowUps([completed])).toHaveLength(0);
  });

  it("surfaces active commitments", () => {
    const active = commitment({
      content: "clean up the backlog",
      createdAt: daysAgo(5),
    });
    const result = selectFollowUps([active]);
    expect(result).toHaveLength(1);
    expect(result[0].priority).toBe("due");
  });

  it("prioritizes due over fresh", () => {
    const fresh = commitment({ content: "fresh item", createdAt: daysAgo(1) });
    const due = commitment({ content: "due item", createdAt: daysAgo(5) });
    const result = selectFollowUps([fresh, due]);
    expect(result[0].commitment.content).toBe("due item");
  });

  it("limits to MAX_SURFACE_PER_SESSION (2)", () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      commitment({ content: `item ${i} with enough text`, createdAt: daysAgo(3 + i) }),
    );
    const result = selectFollowUps(items);
    expect(result).toHaveLength(2);
  });

  it("skips expired commitments that were never surfaced", () => {
    const expired = commitment({
      content: "very old commitment never surfaced",
      createdAt: daysAgo(35),
      surfaceCount: 0,
    });
    expect(selectFollowUps([expired])).toHaveLength(0);
  });

  it("classifies age correctly", () => {
    const now = new Date();
    const fresh = commitment({ content: "fresh commitment text", createdAt: daysAgo(1) });
    const due = commitment({ content: "due commitment text here", createdAt: daysAgo(5) });
    const stale = commitment({ content: "stale commitment that is old", createdAt: daysAgo(10) });
    const fading = commitment({ content: "fading commitment very old", createdAt: daysAgo(20) });

    const results = selectFollowUps([fresh, due, stale, fading], now);
    const priorities = results.map((r) => r.priority);
    // Due comes first, then stale
    expect(priorities[0]).toBe("due");
    expect(priorities[1]).toBe("stale");
  });

  it("includes expired snoozed items when snooze has passed", () => {
    const unSnoozed = commitment({
      content: "snoozed but now past the snooze date",
      snoozedUntil: daysAgo(1), // snooze expired yesterday
    });
    expect(selectFollowUps([unSnoozed])).toHaveLength(1);
  });
});

// ── formatFollowUpPrompt ───────────────────────────────────────────────────

describe("formatFollowUpPrompt", () => {
  it("returns empty string for no follow-ups", () => {
    expect(formatFollowUpPrompt([])).toBe("");
  });

  it("includes commitment content", () => {
    const followUp: CommitmentFollowUp = {
      commitment: commitment({ content: "clean up the backlog" }),
      ageDays: 5,
      priority: "due",
      suggestion: "You mentioned cleaning up the backlog — still on your radar?",
    };
    const prompt = formatFollowUpPrompt([followUp]);
    expect(prompt).toContain("clean up the backlog");
    expect(prompt).toContain("5 days ago");
  });

  it("includes gentle framing rules", () => {
    const followUp: CommitmentFollowUp = {
      commitment: commitment({ content: "call the dentist" }),
      ageDays: 3,
      priority: "due",
      suggestion: "Still on your radar?",
    };
    const prompt = formatFollowUpPrompt([followUp]);
    expect(prompt).toContain("never nag or shame");
    expect(prompt).toContain("still on your radar");
    expect(prompt).toContain("respect that");
  });

  it("shows 'today' for age 0", () => {
    const followUp: CommitmentFollowUp = {
      commitment: commitment({ content: "do something important today", createdAt: new Date().toISOString() }),
      ageDays: 0,
      priority: "fresh",
      suggestion: "Want to tackle that now?",
    };
    const prompt = formatFollowUpPrompt([followUp]);
    expect(prompt).toContain("today");
  });

  it("shows 'yesterday' for age 1", () => {
    const followUp: CommitmentFollowUp = {
      commitment: commitment({ content: "update the docs yesterday", createdAt: daysAgo(1) }),
      ageDays: 1,
      priority: "fresh",
      suggestion: "Still planning on that?",
    };
    const prompt = formatFollowUpPrompt([followUp]);
    expect(prompt).toContain("yesterday");
  });

  it("limits follow-ups to one per conversation", () => {
    const followUp: CommitmentFollowUp = {
      commitment: commitment({ content: "some task" }),
      ageDays: 5,
      priority: "due",
      suggestion: "Still on your radar?",
    };
    const prompt = formatFollowUpPrompt([followUp]);
    expect(prompt).toContain("Maximum one follow-up per conversation");
  });
});

// ── detectCompletion ───────────────────────────────────────────────────────

describe("detectCompletion", () => {
  it("detects 'done' + matching keywords", () => {
    expect(detectCompletion("I'm done with the backlog cleanup", "clean up the backlog")).toBe(true);
  });

  it("detects 'finished' + matching keywords", () => {
    expect(detectCompletion("finished the dashboard redesign", "redesign the dashboard")).toBe(true);
  });

  it("detects 'shipped' + matching keywords", () => {
    expect(detectCompletion("shipped the deployment script update", "update the deployment script")).toBe(true);
  });

  it("returns false without completion phrase", () => {
    expect(detectCompletion("working on the backlog cleanup", "clean up the backlog")).toBe(false);
  });

  it("returns false without matching keywords", () => {
    expect(detectCompletion("I'm done with lunch", "clean up the backlog")).toBe(false);
  });

  it("handles 'took care of' phrase", () => {
    expect(detectCompletion("I took care of the server restart", "restart the server")).toBe(true);
  });
});

// ── buildSnoozeUntil ───────────────────────────────────────────────────────

describe("buildSnoozeUntil", () => {
  it("returns a date 7 days from now", () => {
    const now = new Date("2026-03-07T12:00:00Z");
    const snooze = buildSnoozeUntil(now);
    const snoozeDate = new Date(snooze);
    const diffDays = Math.round((snoozeDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(7);
  });

  it("returns a valid ISO string", () => {
    const snooze = buildSnoozeUntil();
    expect(new Date(snooze).getTime()).toBeGreaterThan(Date.now());
  });
});

// ── shouldExpire ───────────────────────────────────────────────────────────

describe("shouldExpire", () => {
  it("returns true for commitments older than 30 days", () => {
    const old = commitment({ content: "ancient task", createdAt: daysAgo(35) });
    expect(shouldExpire(old)).toBe(true);
  });

  it("returns false for recent commitments", () => {
    const recent = commitment({ content: "recent task", createdAt: daysAgo(5) });
    expect(shouldExpire(recent)).toBe(false);
  });

  it("returns false for commitments exactly at 30 days", () => {
    const exact = commitment({ content: "exact boundary task", createdAt: daysAgo(30) });
    expect(shouldExpire(exact)).toBe(false);
  });
});
