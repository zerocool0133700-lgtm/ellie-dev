/**
 * Psy Reconnection Tests — ELLIE-926 + Fix #10, #13, #14
 */

import { describe, test, expect } from "bun:test";

describe("ELLIE-926: psy priority in context modes", () => {
  test("conversation mode includes psy", async () => {
    const { getModeSectionPriorities } = await import("../src/context-mode.ts");
    const p = getModeSectionPriorities("conversation");
    expect(p["psy"]).toBeDefined();
    expect(p["psy"]).toBeLessThanOrEqual(5);
  });

  test("strategy mode has psy", async () => {
    const { getModeSectionPriorities } = await import("../src/context-mode.ts");
    const p = getModeSectionPriorities("strategy");
    expect(p["psy"]).toBeDefined();
  });

  test("all modes have soul and archetype", async () => {
    const { getModeSectionPriorities } = await import("../src/context-mode.ts");
    for (const mode of ["conversation", "strategy", "workflow", "deep-work", "skill-only"] as const) {
      const p = getModeSectionPriorities(mode);
      expect(p["soul"]).toBeDefined();
      expect(p["archetype"]).toBeDefined();
    }
  });
});

describe("ELLIE-926: emotional annotation logic", () => {
  function annotate(intensity: number | null, valence: number | null): string {
    return intensity && intensity > 0.5
      ? ` [emotionally significant${valence != null ? (valence < -0.3 ? ' — negative' : valence > 0.3 ? ' — positive' : '') : ''}]`
      : '';
  }

  test("high intensity positive", () => {
    expect(annotate(0.8, 0.6)).toBe(" [emotionally significant — positive]");
  });

  test("high intensity negative", () => {
    expect(annotate(0.9, -0.5)).toBe(" [emotionally significant — negative]");
  });

  test("high intensity neutral", () => {
    expect(annotate(0.7, 0.1)).toBe(" [emotionally significant]");
  });

  test("low intensity = no annotation", () => {
    expect(annotate(0.3, 0.9)).toBe("");
  });

  test("null intensity = no annotation", () => {
    expect(annotate(null, 0.9)).toBe("");
  });

  test("null valence with high intensity", () => {
    expect(annotate(0.8, null)).toBe(" [emotionally significant]");
  });
});

describe("Fix #10: getAgentContext includes emotional fields", () => {
  test("getAgentContext SELECT includes emotional_valence and emotional_intensity", async () => {
    // Verify by reading the source — the fields must be in the SELECT list
    const fs = await import("fs");
    const src = fs.readFileSync("/home/ellie/ellie-forest/src/shared-memory.ts", "utf-8");

    // Both getAgentContext paths (branch and tree-level) should have emotional fields
    const selectBlocks = src.split("getAgentContext")[1] || "";
    const emotionalCount = (selectBlocks.match(/emotional_valence, emotional_intensity/g) || []).length;
    expect(emotionalCount).toBeGreaterThanOrEqual(2); // branch path + tree path
  });
});

describe("ELLIE-941: relationship phase engine", () => {
  test("phase names 0-4", async () => {
    const { PHASE_NAMES } = await import("../../ellie-forest/src/phases.ts");
    expect(Object.keys(PHASE_NAMES)).toHaveLength(5);
    expect(PHASE_NAMES[0]).toBe("First Contact");
    expect(PHASE_NAMES[4]).toBe("Deep Bond");
  });

  test("default phase starts at 0", async () => {
    const { createDefaultPhase } = await import("../../ellie-forest/src/phases.ts");
    const p = createDefaultPhase();
    expect(p.phase).toBe(0);
  });

  test("advances 0→1 at threshold", async () => {
    const { computeNextPhase, createDefaultPhase, PHASE_THRESHOLDS } = await import("../../ellie-forest/src/phases.ts");
    const p = createDefaultPhase();
    p.message_count = PHASE_THRESHOLDS[1].message_count;
    expect(computeNextPhase(p)).toBe(1);
  });

  test("does not skip levels", async () => {
    const { computeNextPhase, createDefaultPhase } = await import("../../ellie-forest/src/phases.ts");
    const p = createDefaultPhase();
    p.message_count = 10000;
    expect(computeNextPhase(p)).toBe(1); // only 0→1, not 0→4
  });
});
