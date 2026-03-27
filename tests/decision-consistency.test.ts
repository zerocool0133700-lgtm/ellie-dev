import { describe, it, expect, beforeEach } from "bun:test";
import {
  recordDecision,
  checkContradictions,
  findStaleDecisions,
  generateConsistencyReport,
  getDecisionsByTopic,
  _resetForTesting,
  STALE_DECISION_DAYS,
} from "../src/decision-consistency.ts";

describe("ELLIE-1070: Decision consistency checking", () => {
  beforeEach(() => _resetForTesting());

  describe("recordDecision", () => {
    it("records and returns a decision", () => {
      const d = recordDecision({ text: "Go with monthly billing", topic: "pricing" });
      expect(d.text).toBe("Go with monthly billing");
      expect(d.topic).toBe("pricing");
      expect(d.id).toMatch(/^dec_/);
    });
  });

  describe("checkContradictions", () => {
    it("detects contradicting decisions on same topic", () => {
      recordDecision({ text: "Go with monthly billing cycles", topic: "pricing" });
      recordDecision({ text: "Switch to annual contracts instead", topic: "pricing" });
      const contradictions = checkContradictions();
      expect(contradictions.length).toBe(1);
      expect(contradictions[0].topic).toBe("pricing");
    });

    it("no contradiction for same text", () => {
      recordDecision({ text: "Use Claude", topic: "model" });
      recordDecision({ text: "Use Claude", topic: "model" });
      expect(checkContradictions().length).toBe(0);
    });

    it("no contradiction for different topics", () => {
      recordDecision({ text: "Go monthly", topic: "pricing" });
      recordDecision({ text: "Go annual", topic: "contracts" });
      expect(checkContradictions().length).toBe(0);
    });
  });

  describe("findStaleDecisions", () => {
    it("finds old decisions", () => {
      const d = recordDecision({ text: "Old decision", topic: "old" });
      // Hack: backdate
      (d as any).created_at = new Date(Date.now() - 100 * 24 * 60 * 60_000).toISOString();
      const stale = findStaleDecisions();
      expect(stale.length).toBe(1);
    });

    it("does not flag recent decisions", () => {
      recordDecision({ text: "Fresh decision", topic: "new" });
      expect(findStaleDecisions().length).toBe(0);
    });
  });

  describe("generateConsistencyReport", () => {
    it("reports healthy when no issues", () => {
      recordDecision({ text: "Decision A", topic: "alpha" });
      const report = generateConsistencyReport();
      expect(report.healthy).toBe(true);
      expect(report.totalDecisions).toBe(1);
    });

    it("reports unhealthy when contradictions exist", () => {
      recordDecision({ text: "Go left", topic: "direction" });
      recordDecision({ text: "Go right", topic: "direction" });
      const report = generateConsistencyReport();
      expect(report.healthy).toBe(false);
      expect(report.contradictions.length).toBe(1);
    });
  });

  describe("getDecisionsByTopic", () => {
    it("filters by topic", () => {
      recordDecision({ text: "A", topic: "pricing" });
      recordDecision({ text: "B", topic: "roadmap" });
      recordDecision({ text: "C", topic: "pricing" });
      expect(getDecisionsByTopic("pricing").length).toBe(2);
    });
  });

  describe("constants", () => {
    it("stale threshold is 90 days", () => {
      expect(STALE_DECISION_DAYS).toBe(90);
    });
  });

  describe("textSimilarity", () => {
    it("returns 1 for identical text", async () => {
      const { textSimilarity } = await import("../src/decision-consistency.ts");
      expect(textSimilarity("go with monthly", "go with monthly")).toBe(1);
    });

    it("returns high similarity for restatements", async () => {
      const { textSimilarity } = await import("../src/decision-consistency.ts");
      const sim = textSimilarity("go with monthly billing", "monthly billing approved");
      expect(sim).toBeGreaterThan(0.3);
    });

    it("returns low similarity for contradictions", async () => {
      const { textSimilarity } = await import("../src/decision-consistency.ts");
      const sim = textSimilarity("go with monthly billing", "switch to annual contracts");
      expect(sim).toBeLessThan(0.3);
    });
  });
});
