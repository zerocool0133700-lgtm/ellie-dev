/**
 * Forest Module Tests: Temporal Decay — ELLIE-712
 *
 * Tests computeTemporalDecayScore, DEFAULT_DECAY_WEIGHTS pure functions
 * from shared-memory.ts. Based on Park et al. (2023) Generative Agents formula.
 */

// Force test database
process.env.DB_NAME = "ellie-forest-test";

import { describe, test, expect } from "bun:test";
import {
  computeTemporalDecayScore,
  DEFAULT_DECAY_WEIGHTS,
  type TemporalDecayWeights,
} from "../../ellie-forest/src/shared-memory.ts";

describe("temporal decay", () => {
  // ── DEFAULT_DECAY_WEIGHTS ────────────────────────────────

  describe("DEFAULT_DECAY_WEIGHTS", () => {
    test("has alpha = 1.0 (recency)", () => {
      expect(DEFAULT_DECAY_WEIGHTS.alpha).toBe(1.0);
    });

    test("has beta = 1.0 (relevance)", () => {
      expect(DEFAULT_DECAY_WEIGHTS.beta).toBe(1.0);
    });

    test("has gamma = 1.0 (importance)", () => {
      expect(DEFAULT_DECAY_WEIGHTS.gamma).toBe(1.0);
    });

    test("has lambda for 7-day half-life", () => {
      // lambda = ln(2) / (7 * 24 hours)
      const expected = 0.693 / (7 * 24);
      expect(Math.abs(DEFAULT_DECAY_WEIGHTS.lambda - expected)).toBeLessThan(0.0001);
    });
  });

  // ── computeTemporalDecayScore ────────────────────────────

  describe("computeTemporalDecayScore", () => {
    const NOW = Date.now();

    test("recently accessed memory gets high recency", () => {
      const justNow = new Date(NOW - 1000); // 1 second ago
      const score = computeTemporalDecayScore(
        0.8, 7, justNow, DEFAULT_DECAY_WEIGHTS, NOW,
      );
      // recency ~ 1.0, relevance 0.8, importance 0.7 → score ~ 2.5
      expect(score).toBeGreaterThan(2.0);
    });

    test("old memory gets lower recency", () => {
      const weekAgo = new Date(NOW - 7 * 24 * 60 * 60 * 1000);
      const scoreOld = computeTemporalDecayScore(
        0.8, 7, weekAgo, DEFAULT_DECAY_WEIGHTS, NOW,
      );
      const scoreNew = computeTemporalDecayScore(
        0.8, 7, new Date(NOW - 1000), DEFAULT_DECAY_WEIGHTS, NOW,
      );
      expect(scoreOld).toBeLessThan(scoreNew);
    });

    test("higher relevance increases score", () => {
      const time = new Date(NOW - 3600 * 1000); // 1 hour ago
      const lowRelevance = computeTemporalDecayScore(
        0.2, 5, time, DEFAULT_DECAY_WEIGHTS, NOW,
      );
      const highRelevance = computeTemporalDecayScore(
        0.9, 5, time, DEFAULT_DECAY_WEIGHTS, NOW,
      );
      expect(highRelevance).toBeGreaterThan(lowRelevance);
    });

    test("higher importance increases score", () => {
      const time = new Date(NOW - 3600 * 1000);
      const lowImportance = computeTemporalDecayScore(
        0.5, 2, time, DEFAULT_DECAY_WEIGHTS, NOW,
      );
      const highImportance = computeTemporalDecayScore(
        0.5, 9, time, DEFAULT_DECAY_WEIGHTS, NOW,
      );
      expect(highImportance).toBeGreaterThan(lowImportance);
    });

    test("null lastAccessedAt uses now (full recency)", () => {
      const score = computeTemporalDecayScore(
        0.5, 5, null, DEFAULT_DECAY_WEIGHTS, NOW,
      );
      // recency = 1.0, relevance = 0.5, importance = 0.5 → score = 2.0
      expect(score).toBeCloseTo(2.0, 1);
    });

    test("score components are additive", () => {
      // With all weights = 1.0:
      // recency + relevance + importance/10
      const justNow = new Date(NOW);
      const score = computeTemporalDecayScore(
        0.5, 5, justNow, DEFAULT_DECAY_WEIGHTS, NOW,
      );
      // recency ~ 1.0, relevance = 0.5, importance = 5/10 = 0.5
      // total ~ 2.0
      expect(score).toBeCloseTo(2.0, 1);
    });

    test("custom weights scale components", () => {
      const customWeights: TemporalDecayWeights = {
        alpha: 0.0,  // ignore recency
        beta: 2.0,   // double relevance
        gamma: 0.0,  // ignore importance
        lambda: DEFAULT_DECAY_WEIGHTS.lambda,
      };
      const score = computeTemporalDecayScore(
        0.8, 10, new Date(NOW), customWeights, NOW,
      );
      // Only beta*relevance matters: 2.0 * 0.8 = 1.6
      expect(score).toBeCloseTo(1.6, 1);
    });

    test("zero relevance and importance still has recency", () => {
      const score = computeTemporalDecayScore(
        0, 0, new Date(NOW), DEFAULT_DECAY_WEIGHTS, NOW,
      );
      // Only recency: ~1.0
      expect(score).toBeCloseTo(1.0, 1);
    });

    test("exponential decay halves at half-life", () => {
      // With 7-day half-life, score at 7 days should have recency ~ 0.5
      const sevenDaysAgo = new Date(NOW - 7 * 24 * 3600 * 1000);
      const score = computeTemporalDecayScore(
        0, 0, sevenDaysAgo, DEFAULT_DECAY_WEIGHTS, NOW,
      );
      // Only recency component: alpha * exp(-lambda * 168h) ~ 0.5
      expect(score).toBeCloseTo(0.5, 1);
    });
  });
});
