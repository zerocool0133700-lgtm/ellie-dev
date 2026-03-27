import { describe, it, expect } from "bun:test";
import { SIMILARITY_THRESHOLD, MAX_EDGES_PER_MEMORY } from "../../ellie-forest/src/semantic-edges.ts";

describe("ELLIE-1044: Semantic edges", () => {
  describe("constants", () => {
    it("similarity threshold is 0.5", () => {
      expect(SIMILARITY_THRESHOLD).toBe(0.5);
    });

    it("max edges per memory is 15", () => {
      expect(MAX_EDGES_PER_MEMORY).toBe(15);
    });
  });

  describe("module exports", () => {
    it("exports required functions", async () => {
      const mod = await import("../../ellie-forest/src/semantic-edges.ts");
      expect(typeof mod.computeEdgesForMemory).toBe("function");
      expect(typeof mod.getEdgesForMemory).toBe("function");
      expect(typeof mod.getRelatedMemories).toBe("function");
      expect(typeof mod.removeEdgesForMemory).toBe("function");
      expect(typeof mod.recomputeAllEdges).toBe("function");
    });
  });
});
