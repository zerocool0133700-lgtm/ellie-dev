import { describe, it, expect } from "bun:test";
import { detectMode } from "../src/context-mode.ts";
import { getStrategyPreset, getStrategyTokenBudget, getStrategyExcludedSections } from "../src/context-sources.ts";

describe("ELLIE-1024: Fast context mode", () => {
  describe("detectMode — fast signals", () => {
    it("detects 'fast mode' as fast", () => {
      const result = detectMode("fast mode");
      expect(result).not.toBeNull();
      expect(result!.mode).toBe("fast");
      expect(result!.confidence).toBe("high");
    });

    it("detects 'quick answer' as fast", () => {
      const result = detectMode("quick answer");
      expect(result).not.toBeNull();
      expect(result!.mode).toBe("fast");
    });

    it("detects 'just the answer' as fast", () => {
      const result = detectMode("just the answer");
      expect(result).not.toBeNull();
      expect(result!.mode).toBe("fast");
    });

    it("detects 'be brief' as fast", () => {
      const result = detectMode("be brief");
      expect(result).not.toBeNull();
      expect(result!.mode).toBe("fast");
    });

    it("does not detect 'fast car' as fast mode", () => {
      const result = detectMode("I bought a fast car");
      // Should not match — no fast mode signal
      expect(result?.mode).not.toBe("fast");
    });
  });

  describe("fast strategy preset", () => {
    it("returns a valid preset for 'fast'", () => {
      const preset = getStrategyPreset("fast");
      expect(preset).toBeDefined();
      expect(preset.sources).toEqual([]);
      expect(preset.budget).toBe("fast");
    });

    it("excludes heavy sections", () => {
      const excluded = getStrategyExcludedSections("fast");
      expect(excluded.has("soul")).toBe(true);
      expect(excluded.has("psy")).toBe(true);
      expect(excluded.has("memory-protocol")).toBe(true);
      expect(excluded.has("structured-context")).toBe(true);
    });

    it("does not exclude archetype or conversation", () => {
      const excluded = getStrategyExcludedSections("fast");
      expect(excluded.has("archetype")).toBe(false);
      expect(excluded.has("conversation")).toBe(false);
    });
  });

  describe("fast token budget", () => {
    it("returns 30k for fast strategy", () => {
      const budget = getStrategyTokenBudget("fast");
      expect(budget).toBe(30_000);
    });
  });
});
