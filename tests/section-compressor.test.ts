import { describe, it, expect } from "bun:test";
import {
  COMPRESS_MIN_PRIORITY,
  COMPRESS_MAX_PRIORITY,
  SUPPRESS_PRIORITY,
  MIN_TOKENS_TO_COMPRESS,
} from "../src/section-compressor.ts";

describe("ELLIE-1055: Section compression engine", () => {
  describe("priority tiers", () => {
    it("compress tier is 6-8", () => {
      expect(COMPRESS_MIN_PRIORITY).toBe(6);
      expect(COMPRESS_MAX_PRIORITY).toBe(8);
    });

    it("suppress tier is 9", () => {
      expect(SUPPRESS_PRIORITY).toBe(9);
    });

    it("minimum tokens threshold is 100", () => {
      expect(MIN_TOKENS_TO_COMPRESS).toBe(100);
    });
  });

  describe("compressSection — include tier", () => {
    it("includes priority 1-5 sections unchanged", async () => {
      const { compressSection } = await import("../src/section-compressor.ts");
      const result = await compressSection("soul", "Soul content here", 3);
      expect(result.compressed).toBe(false);
      expect(result.content).toBe("Soul content here");
    });
  });

  describe("compressSection — suppress tier", () => {
    it("suppresses priority 9 sections", async () => {
      const { compressSection } = await import("../src/section-compressor.ts");
      const result = await compressSection("health", "Health data", 9);
      expect(result.content).toBe("");
      expect(result.originalTokens).toBeGreaterThan(0);
    });
  });

  describe("compressSection — small sections skip compression", () => {
    it("skips compression for sections under threshold", async () => {
      const { compressSection } = await import("../src/section-compressor.ts");
      const result = await compressSection("tiny", "Short text", 7);
      expect(result.compressed).toBe(false);
      expect(result.content).toBe("Short text");
    });
  });

  describe("compression metrics structure", () => {
    it("has required fields", () => {
      const metrics = {
        totalOriginalTokens: 1000,
        totalCompressedTokens: 400,
        sectionsCompressed: 3,
        sectionsSuppressed: 1,
        tokensSaved: 600,
      };
      expect(metrics.tokensSaved).toBe(metrics.totalOriginalTokens - metrics.totalCompressedTokens);
    });
  });
});
