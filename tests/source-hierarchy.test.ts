/**
 * ELLIE-559 — source-hierarchy.ts tests
 *
 * Tests conflict resolution and source hierarchy instruction building.
 */

import { describe, test, expect } from "bun:test";
import {
  resolveConflict,
  buildSourceHierarchyInstruction,
  SOURCE_TIERS,
} from "../src/source-hierarchy.ts";

// ── SOURCE_TIERS ────────────────────────────────────────────

describe("SOURCE_TIERS", () => {
  test("has 5 tiers", () => {
    expect(SOURCE_TIERS.length).toBe(5);
  });

  test("tier 1 is user-correction", () => {
    expect(SOURCE_TIERS[0].label).toBe("user-correction");
  });

  test("tiers are ordered 1–5", () => {
    const tiers = SOURCE_TIERS.map(t => t.tier);
    expect(tiers).toEqual([1, 2, 3, 4, 5]);
  });
});

// ── resolveConflict ─────────────────────────────────────────

describe("resolveConflict", () => {
  test("user correction wins over forest memory", () => {
    const result = resolveConflict("correction:ground_truth", "forest-awareness");
    expect(result.winner).toBe("correction:ground_truth");
    expect(result.loser).toBe("forest-awareness");
    expect(result.winnerTier).toBe("user-correction");
    expect(result.loserTier).toBe("forest-memory");
  });

  test("recent conversation wins over live API", () => {
    const result = resolveConflict("recent-messages", "work-item");
    expect(result.winner).toBe("recent-messages");
    expect(result.winnerTier).toBe("recent-conversation");
  });

  test("live API wins over stale context", () => {
    const result = resolveConflict("context-docket", "calendar");
    expect(result.winner).toBe("calendar");
    expect(result.winnerTier).toBe("live-api");
  });

  test("same tier: first argument wins (tiebreak)", () => {
    const result = resolveConflict("forest-awareness", "agent-memory");
    expect(result.winner).toBe("forest-awareness");
  });

  test("unknown sources default to stale-context tier", () => {
    const result = resolveConflict("unknown-source", "recent-messages");
    expect(result.winner).toBe("recent-messages");
    expect(result.loserTier).toBe("stale-context");
  });
});

// ── buildSourceHierarchyInstruction ─────────────────────────

describe("buildSourceHierarchyInstruction", () => {
  test("returns non-empty string", () => {
    const result = buildSourceHierarchyInstruction();
    expect(result.length).toBeGreaterThan(0);
  });

  test("includes SOURCE TRUST HIERARCHY header", () => {
    expect(buildSourceHierarchyInstruction()).toContain("SOURCE TRUST HIERARCHY");
  });

  test("mentions user corrections as highest", () => {
    const result = buildSourceHierarchyInstruction();
    expect(result).toContain("1. User corrections");
  });

  test("mentions all 5 tiers", () => {
    const result = buildSourceHierarchyInstruction();
    expect(result).toContain("1.");
    expect(result).toContain("2.");
    expect(result).toContain("3.");
    expect(result).toContain("4.");
    expect(result).toContain("5.");
  });
});
