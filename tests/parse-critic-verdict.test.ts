/**
 * ELLIE-62 — Unit tests for parseCriticVerdict
 *
 * Covers: critic structured output, JSON parsing, markdown fences,
 * score clamping, feedback/issues truncation, parse failure behavior.
 */
import { describe, test, expect } from "bun:test";
import { parseCriticVerdict } from "../src/orchestrator.ts";

describe("parseCriticVerdict", () => {
  // ── Valid JSON ────────────────────────────────────────────────

  test("parses valid JSON with accepted=true", () => {
    const output = JSON.stringify({
      accepted: true,
      score: 8,
      feedback: "Looks great!",
      issues: [],
    });
    const verdict = parseCriticVerdict(output, 0);
    expect(verdict.accepted).toBe(true);
    expect(verdict.score).toBe(8);
    expect(verdict.feedback).toBe("Looks great!");
    expect(verdict.issues).toEqual([]);
  });

  test("parses valid JSON with accepted=false and issues", () => {
    const output = JSON.stringify({
      accepted: false,
      score: 4,
      feedback: "Needs work",
      issues: ["Too vague", "Missing detail"],
    });
    const verdict = parseCriticVerdict(output, 0);
    expect(verdict.accepted).toBe(false);
    expect(verdict.score).toBe(4);
    expect(verdict.issues).toEqual(["Too vague", "Missing detail"]);
    // Feedback should combine base feedback + numbered issues
    expect(verdict.feedback).toContain("Needs work");
    expect(verdict.feedback).toContain("1. Too vague");
    expect(verdict.feedback).toContain("2. Missing detail");
  });

  // ── Markdown Fence Stripping ──────────────────────────────────

  test("strips ```json fences", () => {
    const json = JSON.stringify({ accepted: true, score: 9, feedback: "Excellent", issues: [] });
    const output = "```json\n" + json + "\n```";
    const verdict = parseCriticVerdict(output, 0);
    expect(verdict.accepted).toBe(true);
    expect(verdict.score).toBe(9);
  });

  test("strips plain ``` fences", () => {
    const json = JSON.stringify({ accepted: false, score: 3, feedback: "Poor", issues: ["Bad structure"] });
    const output = "```\n" + json + "\n```";
    const verdict = parseCriticVerdict(output, 0);
    expect(verdict.accepted).toBe(false);
    expect(verdict.score).toBe(3);
  });

  // ── Score Clamping ────────────────────────────────────────────

  test("clamps score below 1 to 1", () => {
    const output = JSON.stringify({ accepted: false, score: -5, feedback: "Terrible", issues: [] });
    const verdict = parseCriticVerdict(output, 0);
    expect(verdict.score).toBe(1);
  });

  test("clamps score above 10 to 10", () => {
    const output = JSON.stringify({ accepted: true, score: 15, feedback: "Amazing", issues: [] });
    const verdict = parseCriticVerdict(output, 0);
    expect(verdict.score).toBe(10);
  });

  test("defaults score to 5 when not a number", () => {
    const output = JSON.stringify({ accepted: true, feedback: "OK", score: "high", issues: [] });
    const verdict = parseCriticVerdict(output, 0);
    expect(verdict.score).toBe(5);
  });

  // ── Truncation Limits ─────────────────────────────────────────

  test("truncates feedback exceeding 2000 chars", () => {
    const longFeedback = "A".repeat(3000);
    const output = JSON.stringify({ accepted: false, score: 5, feedback: longFeedback, issues: [] });
    const verdict = parseCriticVerdict(output, 0);
    expect(verdict.feedback.length).toBeLessThanOrEqual(2000);
  });

  test("limits issues array to 10 items", () => {
    const issues = Array.from({ length: 15 }, (_, i) => `Issue ${i + 1}`);
    const output = JSON.stringify({ accepted: false, score: 3, feedback: "Many issues", issues });
    const verdict = parseCriticVerdict(output, 0);
    expect(verdict.issues.length).toBeLessThanOrEqual(10);
  });

  test("truncates individual issues to 500 chars", () => {
    const longIssue = "B".repeat(600);
    const output = JSON.stringify({ accepted: false, score: 3, feedback: "Long issue", issues: [longIssue] });
    const verdict = parseCriticVerdict(output, 0);
    expect(verdict.issues[0].length).toBeLessThanOrEqual(500);
  });

  // ── Missing / Default Fields ──────────────────────────────────

  test("provides default feedback when missing", () => {
    const output = JSON.stringify({ accepted: false, score: 4 });
    const verdict = parseCriticVerdict(output, 0);
    expect(verdict.feedback).toContain("No specific feedback provided");
  });

  test("treats missing issues as empty array", () => {
    const output = JSON.stringify({ accepted: true, score: 8, feedback: "Good" });
    const verdict = parseCriticVerdict(output, 0);
    expect(verdict.issues).toEqual([]);
  });

  // ── Parse Failure Behavior ────────────────────────────────────

  test("rejects on invalid JSON for non-final round (round 0)", () => {
    const verdict = parseCriticVerdict("Not valid JSON at all!", 0);
    expect(verdict.accepted).toBe(false);
    expect(verdict.score).toBe(3);
    expect(verdict.feedback).toContain("Unable to parse");
  });

  test("rejects on invalid JSON for non-final round (round 1)", () => {
    const verdict = parseCriticVerdict("{{broken json}}", 1);
    expect(verdict.accepted).toBe(false);
    expect(verdict.score).toBe(3);
  });

  test("accepts on invalid JSON for final round (round 2, MAX_CRITIC_ROUNDS-1)", () => {
    const verdict = parseCriticVerdict("Not valid JSON!", 2);
    expect(verdict.accepted).toBe(true);
    expect(verdict.score).toBe(5);
    expect(verdict.feedback).toContain("final round");
  });

  // ── Combined Feedback Formatting ──────────────────────────────

  test("formats feedback with numbered issues", () => {
    const output = JSON.stringify({
      accepted: false,
      score: 5,
      feedback: "General assessment",
      issues: ["First problem", "Second problem", "Third problem"],
    });
    const verdict = parseCriticVerdict(output, 0);
    expect(verdict.feedback).toContain("General assessment");
    expect(verdict.feedback).toContain("Specific issues:");
    expect(verdict.feedback).toContain("1. First problem");
    expect(verdict.feedback).toContain("2. Second problem");
    expect(verdict.feedback).toContain("3. Third problem");
  });
});
