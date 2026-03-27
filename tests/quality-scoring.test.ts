import { describe, it, expect } from "bun:test";
import {
  calculateScores,
  applyGate,
  buildReview,
  formatReviewMarkdown,
  getReviewPromptSection,
  REVIEW_DIMENSIONS,
  SCORE_RUBRIC,
  SEVERITY_DEFINITIONS,
  type DimensionScore,
  type Finding,
} from "../src/quality-scoring.ts";

describe("ELLIE-1073: Quality scoring framework", () => {
  const goodDimensions: DimensionScore[] = [
    { dimension: "correctness", score: 4, notes: "All logic correct" },
    { dimension: "security", score: 3, notes: "Good input validation" },
    { dimension: "maintainability", score: 3, notes: "Clean code" },
    { dimension: "test_coverage", score: 3, notes: "Good coverage" },
    { dimension: "performance", score: 3, notes: "No issues" },
    { dimension: "error_handling", score: 3, notes: "Proper error paths" },
    { dimension: "architecture", score: 4, notes: "Fits well" },
  ];

  const poorDimensions: DimensionScore[] = [
    { dimension: "correctness", score: 1, notes: "Logic errors" },
    { dimension: "security", score: 0, notes: "No validation" },
    { dimension: "maintainability", score: 2, notes: "Messy" },
    { dimension: "test_coverage", score: 0, notes: "No tests" },
    { dimension: "performance", score: 2, notes: "N+1 queries" },
    { dimension: "error_handling", score: 1, notes: "Silent failures" },
    { dimension: "architecture", score: 1, notes: "Doesn't fit" },
  ];

  describe("REVIEW_DIMENSIONS", () => {
    it("has 7 dimensions", () => {
      expect(REVIEW_DIMENSIONS.length).toBe(7);
    });

    it("correctness and security have highest weight", () => {
      const correctness = REVIEW_DIMENSIONS.find(d => d.id === "correctness");
      const security = REVIEW_DIMENSIONS.find(d => d.id === "security");
      expect(correctness!.weight).toBe(1.5);
      expect(security!.weight).toBe(1.5);
    });
  });

  describe("calculateScores", () => {
    it("calculates correct total for perfect scores", () => {
      const perfect: DimensionScore[] = REVIEW_DIMENSIONS.map(d => ({
        dimension: d.id, score: 4, notes: "Perfect",
      }));
      const scores = calculateScores(perfect);
      expect(scores.totalScore).toBe(28); // 7 * 4
      expect(scores.maxScore).toBe(28);
      expect(scores.percentage).toBe(100);
    });

    it("calculates correct percentage for mixed scores", () => {
      const scores = calculateScores(goodDimensions);
      expect(scores.percentage).toBeGreaterThan(75);
      expect(scores.percentage).toBeLessThanOrEqual(100);
    });

    it("weighs correctness and security higher", () => {
      const highCorrectness: DimensionScore[] = [
        { dimension: "correctness", score: 4, notes: "" }, // weight 1.5
        { dimension: "architecture", score: 0, notes: "" }, // weight 0.7
      ];
      const highArch: DimensionScore[] = [
        { dimension: "correctness", score: 0, notes: "" },
        { dimension: "architecture", score: 4, notes: "" },
      ];
      const sc1 = calculateScores(highCorrectness);
      const sc2 = calculateScores(highArch);
      expect(sc1.weightedScore).toBeGreaterThan(sc2.weightedScore);
    });
  });

  describe("applyGate", () => {
    it("passes good reviews", () => {
      const scores = calculateScores(goodDimensions);
      const gate = applyGate({ dimensions: goodDimensions, findings: [], percentage: scores.percentage });
      expect(gate.verdict).toBe("pass");
      expect(gate.reasons).toEqual([]);
    });

    it("fails on P0 finding", () => {
      const findings: Finding[] = [
        { severity: "P0", title: "SQL injection", description: "Unescaped input" },
      ];
      const scores = calculateScores(goodDimensions);
      const gate = applyGate({ dimensions: goodDimensions, findings, percentage: scores.percentage });
      expect(gate.verdict).toBe("fail");
      expect(gate.reasons[0]).toContain("P0");
    });

    it("fails when below percentage threshold", () => {
      const scores = calculateScores(poorDimensions);
      const gate = applyGate({ dimensions: poorDimensions, findings: [], percentage: scores.percentage });
      expect(gate.verdict).toBe("fail");
      expect(gate.reasons.some(r => r.includes("below"))).toBe(true);
    });

    it("conditional on excess P1 findings", () => {
      const findings: Finding[] = Array.from({ length: 4 }, (_, i) => ({
        severity: "P1" as const,
        title: `Issue ${i}`,
        description: "Major issue",
      }));
      const scores = calculateScores(goodDimensions);
      const gate = applyGate({ dimensions: goodDimensions, findings, percentage: scores.percentage });
      expect(gate.verdict).toBe("conditional");
    });

    it("fails when any dimension below minimum", () => {
      const scores = calculateScores(poorDimensions);
      const gate = applyGate({ dimensions: poorDimensions, findings: [], percentage: scores.percentage });
      expect(gate.reasons.some(r => r.includes("scored 0/4"))).toBe(true);
    });
  });

  describe("buildReview", () => {
    it("produces complete review with verdict", () => {
      const review = buildReview({
        target: "src/agent-router.ts",
        dimensions: goodDimensions,
        findings: [],
      });
      expect(review.verdict).toBe("pass");
      expect(review.agent).toBe("brian");
      expect(review.reviewId).toMatch(/^review_/);
      expect(review.percentage).toBeGreaterThan(60);
    });

    it("includes work item ID when provided", () => {
      const review = buildReview({
        workItemId: "ELLIE-1073",
        target: "quality-scoring.ts",
        dimensions: goodDimensions,
        findings: [],
      });
      expect(review.workItemId).toBe("ELLIE-1073");
    });
  });

  describe("formatReviewMarkdown", () => {
    it("produces readable markdown", () => {
      const review = buildReview({
        target: "test.ts",
        dimensions: goodDimensions,
        findings: [
          { severity: "P2", title: "Missing type annotation", description: "Function returns any" },
        ],
      });
      const md = formatReviewMarkdown(review);
      expect(md).toContain("## Quality Review");
      expect(md).toContain("Dimension Scores");
      expect(md).toContain("Findings");
      expect(md).toContain("P2");
      expect(md).toContain("\u2588"); // Score bar
    });
  });

  describe("getReviewPromptSection", () => {
    it("returns non-empty prompt text", () => {
      const prompt = getReviewPromptSection();
      expect(prompt.length).toBeGreaterThan(500);
      expect(prompt).toContain("Quality Scoring Framework");
      expect(prompt).toContain("correctness");
      expect(prompt).toContain("P0");
    });
  });

  describe("SEVERITY_DEFINITIONS", () => {
    it("has all 4 severities", () => {
      expect(Object.keys(SEVERITY_DEFINITIONS)).toEqual(["P0", "P1", "P2", "P3"]);
    });

    it("P0 is blocking", () => {
      expect(SEVERITY_DEFINITIONS.P0.name).toBe("Blocking");
    });
  });

  describe("SCORE_RUBRIC", () => {
    it("has scores 0-4", () => {
      expect(Object.keys(SCORE_RUBRIC).length).toBe(5);
      expect(SCORE_RUBRIC[0]).toContain("Missing");
      expect(SCORE_RUBRIC[4]).toContain("Excellent");
    });
  });
});
