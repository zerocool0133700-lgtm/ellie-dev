import { describe, it, expect } from "bun:test";
import {
  calculateDecayedConfidence,
  DECAY_RATE_PER_30_DAYS,
  MIN_CONFIDENCE,
} from "../src/ums/stale-fact-detector.ts";

describe("ELLIE-1036: Stale fact detection", () => {
  describe("calculateDecayedConfidence", () => {
    const DAY_MS = 24 * 60 * 60_000;

    it("returns original confidence for young facts", () => {
      expect(calculateDecayedConfidence(0.8, 15 * DAY_MS)).toBe(0.8);
    });

    it("decays by 0.1 after 30 days", () => {
      expect(calculateDecayedConfidence(0.8, 35 * DAY_MS)).toBe(0.7);
    });

    it("decays by 0.2 after 60 days", () => {
      expect(calculateDecayedConfidence(0.8, 65 * DAY_MS)).toBe(0.6);
    });

    it("floors at MIN_CONFIDENCE", () => {
      expect(calculateDecayedConfidence(0.3, 365 * DAY_MS)).toBe(MIN_CONFIDENCE);
    });

    it("handles zero-age facts", () => {
      expect(calculateDecayedConfidence(0.9, 0)).toBe(0.9);
    });

    it("handles high-confidence facts gracefully", () => {
      expect(calculateDecayedConfidence(1.0, 90 * DAY_MS)).toBe(0.7);
    });
  });
});
