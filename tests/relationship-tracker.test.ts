import { describe, it, expect } from "bun:test";
import { calculateScore, LOSING_TOUCH_DAYS } from "../src/relationship-tracker.ts";

describe("ELLIE-1066: Relationship intelligence", () => {
  describe("calculateScore", () => {
    it("returns 0 for null last_seen", () => {
      expect(calculateScore(5, null, 3)).toBe(0);
    });

    it("returns higher score for recent contact", () => {
      const recent = calculateScore(5, new Date(), 3);
      const old = calculateScore(5, new Date(Date.now() - 60 * 24 * 60 * 60_000), 3);
      expect(recent).toBeGreaterThan(old);
    });

    it("returns higher score for more meetings", () => {
      const many = calculateScore(10, new Date(), 3);
      const few = calculateScore(2, new Date(), 3);
      expect(many).toBeGreaterThan(few);
    });

    it("returns higher score for more topics", () => {
      const deep = calculateScore(5, new Date(), 8);
      const shallow = calculateScore(5, new Date(), 1);
      expect(deep).toBeGreaterThan(shallow);
    });
  });

  describe("constants", () => {
    it("losing touch threshold is 21 days", () => {
      expect(LOSING_TOUCH_DAYS).toBe(21);
    });
  });

  describe("module exports", () => {
    it("exports required functions", async () => {
      const mod = await import("../src/relationship-tracker.ts");
      expect(typeof mod.recordInteraction).toBe("function");
      expect(typeof mod.detectLosingTouch).toBe("function");
      expect(typeof mod.getRelationships).toBe("function");
      expect(typeof mod.getPersonProfile).toBe("function");
    });
  });

  describe("alias detection", () => {
    it("normalizeName lowercases and trims", async () => {
      const { normalizeName } = await import("../src/relationship-tracker.ts");
      expect(normalizeName("  Alex Chen  ")).toBe("alex chen");
    });

    it("mightBeAlias detects partial matches", async () => {
      const { mightBeAlias } = await import("../src/relationship-tracker.ts");
      expect(mightBeAlias("Alex", "alex")).toBe(true);
      expect(mightBeAlias("Alex Chen", "Alex")).toBe(true);
      expect(mightBeAlias("Alex", "Bob")).toBe(false);
    });
  });
});
