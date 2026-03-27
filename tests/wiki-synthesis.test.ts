import { describe, it, expect } from "bun:test";
import { computeCentroid, rankByCentroid, cosineSimilarity } from "../../ellie-forest/src/wiki-synthesis.ts";

describe("ELLIE-1047: Wiki synthesis", () => {
  describe("computeCentroid", () => {
    it("computes mean of embeddings", () => {
      const embeddings = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ];
      const centroid = computeCentroid(embeddings);
      expect(centroid[0]).toBeCloseTo(1/3, 5);
      expect(centroid[1]).toBeCloseTo(1/3, 5);
      expect(centroid[2]).toBeCloseTo(1/3, 5);
    });

    it("returns empty for no embeddings", () => {
      expect(computeCentroid([])).toEqual([]);
    });

    it("returns same vector for single embedding", () => {
      const centroid = computeCentroid([[0.5, 0.5]]);
      expect(centroid).toEqual([0.5, 0.5]);
    });
  });

  describe("cosineSimilarity", () => {
    it("returns 1 for identical vectors", () => {
      expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    });

    it("returns 0 for orthogonal vectors", () => {
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    });

    it("returns -1 for opposite vectors", () => {
      expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
    });
  });

  describe("rankByCentroid", () => {
    it("ranks memories by similarity to centroid", () => {
      const memories = [
        { id: "a", content: "Far", embedding: [0, 1, 0] },
        { id: "b", content: "Close", embedding: [1, 0, 0] },
        { id: "c", content: "Medium", embedding: [0.7, 0.7, 0] },
      ];
      const centroid = [1, 0, 0];
      const ranked = rankByCentroid(memories, centroid);
      expect(ranked[0].id).toBe("b"); // Most similar to [1,0,0]
    });

    it("handles empty centroid", () => {
      const memories = [{ id: "a", content: "Test", embedding: [1, 0] }];
      const ranked = rankByCentroid(memories, []);
      expect(ranked[0].similarity).toBe(0.5);
    });

    it("filters memories without embeddings", () => {
      const memories = [
        { id: "a", content: "Has embedding", embedding: [1, 0] },
        { id: "b", content: "No embedding", embedding: null },
      ];
      const ranked = rankByCentroid(memories, [1, 0]);
      expect(ranked.length).toBe(1);
    });
  });

  describe("module exports", () => {
    it("exports synthesizeArticle", async () => {
      const mod = await import("../../ellie-forest/src/wiki-synthesis.ts");
      expect(typeof mod.synthesizeArticle).toBe("function");
      expect(typeof mod.getMemoriesForWiki).toBe("function");
    });
  });
});
