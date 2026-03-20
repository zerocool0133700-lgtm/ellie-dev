/**
 * Memory System Export Tests — ELLIE-932 + all fixes
 */

import { describe, test, expect } from "bun:test";

describe("ELLIE-932: Forest library exports", () => {
  test("all new functions are exported", async () => {
    const mod = await import("../../ellie-forest/src/index.ts");
    const expected = [
      'classifyCategory', 'classifyCognitiveType', 'autoPromoteToCore',
      'backfillClassifications', 'getTierMultiplier', 'inferScopePath',
      'detectQueryIntent', 'getPreferences', 'detectArcsFromChains',
      'detectArcsFromClusters', 'inferDirection',
    ];
    for (const fn of expected) {
      expect(typeof (mod as any)[fn]).toBe("function");
    }
  });

  test("existing core exports still present", async () => {
    const mod = await import("../../ellie-forest/src/index.ts");
    const core = [
      'writeMemory', 'readMemories', 'getCoreMemories', 'getActiveGoals',
      'promoteToCore', 'demoteToExtended', 'createArc', 'listArcs',
    ];
    for (const fn of core) {
      expect(typeof (mod as any)[fn]).toBe("function");
    }
  });

  test("Fix #9: tier multiplier ordering — core > goals > extended", async () => {
    const { getTierMultiplier } = await import("../../ellie-forest/src/index.ts");
    expect(getTierMultiplier("core")).toBeGreaterThan(getTierMultiplier("goals"));
    expect(getTierMultiplier("goals")).toBeGreaterThan(getTierMultiplier("extended"));
  });
});
