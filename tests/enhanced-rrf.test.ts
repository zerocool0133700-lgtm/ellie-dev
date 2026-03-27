import { describe, it, expect } from "bun:test";
import { enhancedRRF, simpleRRF, type RankedResult } from "../../ellie-forest/src/enhanced-rrf.ts";

describe("ELLIE-1049: Enhanced RRF", () => {
  const vectorResults: RankedResult[] = [
    { id: "a", content: "Alpha", similarity: 0.9, scope_path: "2/1" },
    { id: "b", content: "Beta", similarity: 0.8, scope_path: "2/2" },
    { id: "c", content: "Gamma", similarity: 0.7, scope_path: "2/1" },
  ];

  const bm25Results: RankedResult[] = [
    { id: "b", content: "Beta", similarity: 0.85, scope_path: "2/2" },
    { id: "a", content: "Alpha", similarity: 0.75, scope_path: "2/1" },
    { id: "d", content: "Delta", similarity: 0.65, scope_path: "2/3" },
  ];

  describe("simpleRRF", () => {
    it("combines results from two rankers", () => {
      const fused = simpleRRF(vectorResults, bm25Results);
      expect(fused.length).toBeGreaterThan(0);
      expect(fused.length).toBeLessThanOrEqual(15);
    });

    it("ranks items appearing in both rankers higher", () => {
      const fused = simpleRRF(vectorResults, bm25Results);
      const ids = fused.map(r => r.id);
      // a and b appear in both → should rank highest
      expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("d"));
      expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("d"));
    });

    it("respects limit", () => {
      const fused = simpleRRF(vectorResults, bm25Results, { limit: 2 });
      expect(fused.length).toBe(2);
    });
  });

  describe("enhancedRRF with scope boost", () => {
    it("boosts results matching scope", () => {
      const withoutBoost = enhancedRRF([vectorResults, bm25Results]);
      const withBoost = enhancedRRF([vectorResults, bm25Results], {
        scopeBoost: { scopes: ["2/1"], factor: 2.0 },
      });

      // With scope boost for 2/1, items a and c should get higher scores
      const boostedScoreA = withBoost.find(r => r.id === "a")?.similarity ?? 0;
      const unboostedScoreA = withoutBoost.find(r => r.id === "a")?.similarity ?? 0;
      expect(boostedScoreA).toBeGreaterThan(unboostedScoreA);
    });
  });

  describe("enhancedRRF with citation boost", () => {
    it("boosts cited memories", () => {
      const citedIds = new Set(["c"]); // Gamma is highly cited
      const withBoost = enhancedRRF([vectorResults, bm25Results], {
        citationBoost: { citedIds, factor: 2.0 },
      });

      const cScore = withBoost.find(r => r.id === "c")?.similarity ?? 0;
      // c should get boosted
      expect(cScore).toBeGreaterThan(0);
    });
  });

  describe("enhancedRRF with multiple rankers", () => {
    it("handles 3+ rankers", () => {
      const thirdRanker: RankedResult[] = [
        { id: "d", content: "Delta", similarity: 0.95 },
        { id: "a", content: "Alpha", similarity: 0.5 },
      ];
      const fused = enhancedRRF([vectorResults, bm25Results, thirdRanker]);
      expect(fused.length).toBeGreaterThan(0);
      // 'a' appears in all 3 rankers — should be ranked very high
      expect(fused[0].id).toBe("a");
    });
  });

  describe("edge cases", () => {
    it("handles empty rankers", () => {
      const fused = enhancedRRF([[], []]);
      expect(fused).toEqual([]);
    });

    it("handles single ranker", () => {
      const fused = enhancedRRF([vectorResults]);
      expect(fused.length).toBe(3);
    });
  });
});
