/**
 * Channel Tests: Telegram Handlers — ELLIE-711
 *
 * Tests relay utility pure functions used by Telegram handlers:
 * trimSearchContext, getSpecialistAck, formatForestMetrics, estimateTokens.
 */

import { describe, test, expect, mock } from "bun:test";

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

import {
  trimSearchContext,
  getSpecialistAck,
  formatForestMetrics,
  estimateTokens,
} from "../src/relay-utils.ts";

describe("telegram handler utilities", () => {
  describe("trimSearchContext", () => {
    test("returns empty for empty sources", () => {
      expect(trimSearchContext([])).toBe("");
    });

    test("returns single source within budget", () => {
      expect(trimSearchContext(["hello"], 100)).toBe("hello");
    });

    test("respects max chars budget", () => {
      const result = trimSearchContext(["a".repeat(200), "b".repeat(200)], 300);
      expect(result.length).toBeLessThanOrEqual(300);
    });

    test("prioritizes earlier sources", () => {
      const result = trimSearchContext(["first".repeat(50), "second".repeat(50)], 300);
      expect(result).toContain("first");
    });

    test("truncates at last newline", () => {
      const source = "line1\nline2\nline3\nline4";
      const result = trimSearchContext([source], 15);
      expect(result).toContain("line1");
      // Should break at a newline boundary
      expect(result.endsWith("line1") || result.endsWith("line2")).toBe(true);
    });

    test("skips empty sources", () => {
      expect(trimSearchContext(["", "hello", ""], 100)).toBe("hello");
    });
  });

  describe("getSpecialistAck", () => {
    test("returns dev ack", () => {
      expect(getSpecialistAck("dev")).toContain("dev specialist");
    });

    test("returns research ack", () => {
      expect(getSpecialistAck("research")).toContain("look into");
    });

    test("returns strategy ack", () => {
      expect(getSpecialistAck("strategy")).toContain("strategically");
    });

    test("returns generic ack for unknown agent", () => {
      const ack = getSpecialistAck("custom-agent");
      expect(ack).toContain("custom-agent");
      expect(ack).toContain("specialist");
    });
  });

  describe("formatForestMetrics", () => {
    test("formats basic metrics", () => {
      const result = formatForestMetrics({
        creaturesByEntity: { ellie: 5, james: 3 },
        eventsByKind: { dispatched: 10, completed: 8 },
        treesByType: { work: 4 },
        creaturesByState: { active: 3, completed: 5 },
        failureRate: 0.05,
        totalEvents: 18,
        totalCreatures: 8,
        totalTrees: 4,
      });

      expect(result).toContain("Forest Metrics");
      expect(result).toContain("Events: 18");
      expect(result).toContain("Creatures: 8");
      expect(result).toContain("Trees: 4");
      expect(result).toContain("5.0%");
      expect(result).toContain("ellie: 5");
    });

    test("includes memory section when present", () => {
      const result = formatForestMetrics({
        creaturesByEntity: {},
        eventsByKind: {},
        treesByType: {},
        creaturesByState: {},
        memoriesByType: { fact: 10, decision: 5 },
        failureRate: 0,
        totalEvents: 0,
        totalCreatures: 0,
        totalTrees: 0,
        totalMemories: 15,
      });

      expect(result).toContain("Shared memories: 15");
      expect(result).toContain("Memories by type");
      expect(result).toContain("fact: 10");
      expect(result).toContain("decision: 5");
    });

    test("handles zero failure rate", () => {
      const result = formatForestMetrics({
        creaturesByEntity: {},
        eventsByKind: {},
        treesByType: {},
        creaturesByState: {},
        failureRate: 0,
        totalEvents: 0,
        totalCreatures: 0,
        totalTrees: 0,
      });
      expect(result).toContain("0.0%");
    });
  });

  describe("estimateTokens", () => {
    test("returns positive count for non-empty text", () => {
      expect(estimateTokens("Hello world")).toBeGreaterThan(0);
    });

    test("returns 0 for empty string", () => {
      expect(estimateTokens("")).toBe(0);
    });

    test("longer text produces more tokens", () => {
      const short = estimateTokens("Hello");
      const long = estimateTokens("Hello world, this is a much longer sentence with many tokens");
      expect(long).toBeGreaterThan(short);
    });

    test("accepts optional model parameter", () => {
      const count = estimateTokens("test text", "claude-opus-4-6");
      expect(count).toBeGreaterThan(0);
    });
  });
});
