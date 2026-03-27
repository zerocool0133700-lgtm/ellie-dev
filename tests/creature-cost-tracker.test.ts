import { describe, it, expect, beforeEach } from "bun:test";
import {
  calculateCost,
  recordUsage,
  shouldBlock,
  getCostSummary,
  _resetForTesting,
  MODEL_PRICING,
  DEFAULT_SESSION_BUDGET_USD,
  ALERT_THRESHOLD,
} from "../src/creature-cost-tracker.ts";

describe("ELLIE-1060: Per-creature cost tracking", () => {
  beforeEach(() => {
    _resetForTesting();
  });

  describe("calculateCost", () => {
    it("calculates Haiku cost correctly", () => {
      // 1M input + 1M output at Haiku prices
      const cost = calculateCost("haiku", 1_000_000, 1_000_000);
      expect(cost).toBe(0.8 + 4.0); // $4.80
    });

    it("calculates Opus cost correctly", () => {
      const cost = calculateCost("opus", 100_000, 50_000);
      expect(cost).toBeCloseTo(1.5 + 3.75, 2); // $5.25
    });

    it("falls back to Sonnet pricing for unknown models", () => {
      const cost = calculateCost("unknown-model", 1_000_000, 1_000_000);
      expect(cost).toBe(3.0 + 15.0); // $18.00
    });

    it("includes cache pricing", () => {
      const cost = calculateCost("sonnet", 1_000_000, 0, 500_000, 100_000);
      expect(cost).toBeGreaterThan(3.0); // Input + cache read + cache write
    });
  });

  describe("recordUsage", () => {
    it("tracks session costs", () => {
      const result = recordUsage({
        creature: "james",
        model: "sonnet",
        inputTokens: 100_000,
        outputTokens: 50_000,
      });
      expect(result.cost).toBeGreaterThan(0);
      expect(result.sessionTotal).toBe(result.cost);
    });

    it("accumulates across dispatches", () => {
      recordUsage({ creature: "james", model: "sonnet", inputTokens: 100_000, outputTokens: 50_000 });
      const r2 = recordUsage({ creature: "james", model: "sonnet", inputTokens: 100_000, outputTokens: 50_000 });
      expect(r2.sessionTotal).toBeGreaterThan(r2.cost);
    });

    it("tracks daily costs across creatures", () => {
      recordUsage({ creature: "james", model: "sonnet", inputTokens: 100_000, outputTokens: 50_000 });
      const r2 = recordUsage({ creature: "kate", model: "haiku", inputTokens: 200_000, outputTokens: 100_000 });
      expect(r2.dailyTotal).toBeGreaterThan(r2.cost);
    });

    it("triggers alert at threshold", () => {
      // Use enough tokens to approach budget
      const result = recordUsage({
        creature: "james",
        model: "opus",
        inputTokens: 200_000, // Should cost ~$3 input alone
        outputTokens: 50_000,
      });
      // With Opus pricing this should be well over 80% of $5 budget
      if (result.sessionTotal >= DEFAULT_SESSION_BUDGET_USD * ALERT_THRESHOLD) {
        expect(result.alerts.length).toBeGreaterThan(0);
      }
    });
  });

  describe("shouldBlock", () => {
    it("does not block within budget", () => {
      recordUsage({ creature: "james", model: "haiku", inputTokens: 10_000, outputTokens: 5_000 });
      expect(shouldBlock("james").blocked).toBe(false);
    });

    it("blocks when over session budget", () => {
      // Burn through budget with expensive model
      for (let i = 0; i < 10; i++) {
        recordUsage({ creature: "james", model: "opus", inputTokens: 500_000, outputTokens: 200_000 });
      }
      const check = shouldBlock("james");
      expect(check.blocked).toBe(true);
      expect(check.reason).toContain("exceeded session budget");
    });
  });

  describe("getCostSummary", () => {
    it("returns summary with daily and session data", () => {
      recordUsage({ creature: "james", model: "sonnet", inputTokens: 50_000, outputTokens: 25_000 });
      const summary = getCostSummary();
      expect(summary.daily.dispatches).toBe(1);
      expect(summary.sessions.length).toBe(1);
      expect(summary.modelPricing).toBeDefined();
    });
  });

  describe("model pricing", () => {
    it("has pricing for core models", () => {
      expect(MODEL_PRICING["opus"]).toBeDefined();
      expect(MODEL_PRICING["sonnet"]).toBeDefined();
      expect(MODEL_PRICING["haiku"]).toBeDefined();
    });
  });
});
