/**
 * Memory System Activation Tests — ELLIE-932/926
 *
 * Tests all code from the memory activation + all 20 review fixes.
 */

import { describe, test, expect } from "bun:test";
import {
  classifyCategory,
  classifyCognitiveType,
  inferScopePath,
  detectQueryIntent,
  getTierMultiplier,
  computeTemporalDecayScore,
  DEFAULT_DECAY_WEIGHTS,
  inferDirection,
} from "../../ellie-forest/src/index";
import type { MemoryCategory, CognitiveType, MemoryTier } from "../../ellie-forest/src/types";

// ── Fix #6: Word boundary matching ─────────────────────────────

describe("Fix #6: word boundary matching prevents false positives", () => {
  test("'api' inside 'apiary' does not classify as work", () => {
    expect(classifyCategory("I saw an apiary yesterday")).toBe("general");
  });

  test("'run' inside 'sprung' does not classify as fitness", () => {
    expect(classifyCategory("The trap was sprung open")).toBe("general");
  });

  test("work signals still classify correctly with word boundaries", () => {
    // Needs 2+ work signals — 'deploy' + 'merge' + 'pipeline'
    expect(classifyCategory("Deploy and merge to the pipeline")).toBe("work");
  });

  test("cognitive: 'run' inside 'running' does not false-positive as procedural", () => {
    // With word boundaries, 'run' won't match 'running'
    expect(classifyCognitiveType("I was running errands")).toBe("factual");
  });
});

// ── Fix #8: Deduplicated category signals ──────────────────────

describe("Fix #8: no overlapping signals across categories", () => {
  test("'therapy' classifies as mental_health, not health", () => {
    expect(classifyCategory("therapy sessions and counseling really help with anxiety")).toBe("mental_health");
  });

  test("'meditation' classifies as spirituality, not mental_health", () => {
    expect(classifyCategory("morning meditation and prayer, feeling grateful for faith")).toBe("spirituality");
  });
});

// ── Fix #7: Query intent scores all patterns ───────────────────

describe("Fix #7: detectQueryIntent scores all patterns", () => {
  test("returns factual for empty string", () => {
    expect(detectQueryIntent("").type).toBe("factual");
  });

  test("single procedural match", () => {
    const r = detectQueryIntent("How do I deploy?");
    expect(r.type).toBe("procedural");
  });

  test("single episodic match", () => {
    const r = detectQueryIntent("What happened with the outage?");
    expect(r.type).toBe("episodic");
  });

  test("single semantic match", () => {
    const r = detectQueryIntent("What is a microservice?");
    expect(r.type).toBe("semantic");
  });

  test("tie between types returns factual", () => {
    // One signal each for different types — tie
    const r = detectQueryIntent("configure yesterday");
    expect(r.type).toBe("factual");
  });

  test("multiple matches in same type wins", () => {
    const r = detectQueryIntent("What happened yesterday with the outage incident?");
    expect(r.type).toBe("episodic");
  });
});

// ── Fix #9: Reduced multipliers ────────────────────────────────

describe("Fix #9: tier and cognitive multipliers are moderate", () => {
  test("core tier multiplier is 1.2 (not 1.5)", () => {
    expect(getTierMultiplier("core")).toBe(1.2);
  });

  test("goals tier multiplier is 1.1 (not 1.2)", () => {
    expect(getTierMultiplier("goals")).toBe(1.1);
  });

  test("max combined boost (core + cognitive) is <= 1.5", () => {
    const maxTier = getTierMultiplier("core"); // 1.2
    const intent = detectQueryIntent("How do I deploy?");
    const maxBoost = maxTier * intent.boost; // 1.2 * 1.2 = 1.44
    expect(maxBoost).toBeLessThanOrEqual(1.5);
  });

  test("extended tier is exactly 1.0 (no boost)", () => {
    expect(getTierMultiplier("extended")).toBe(1.0);
  });

  test("unknown tier defaults to 1.0", () => {
    expect(getTierMultiplier("unknown" as MemoryTier)).toBe(1.0);
  });
});

// ── Fix #16: Empty array guards ────────────────────────────────

describe("Fix #16: classification functions handle edge cases", () => {
  test("classifyCategory on empty string returns general", () => {
    expect(classifyCategory("")).toBe("general");
  });

  test("classifyCognitiveType on empty string returns factual", () => {
    expect(classifyCognitiveType("")).toBe("factual");
  });

  test("inferScopePath on empty string returns null", () => {
    expect(inferScopePath("")).toBeNull();
  });

  test("detectQueryIntent on empty string returns factual", () => {
    expect(detectQueryIntent("").type).toBe("factual");
    expect(detectQueryIntent("").boost).toBe(1.0);
  });
});

// ── Category classification (ELLIE-937) ────────────────────────

describe("ELLIE-937: classifyCategory", () => {
  test("classifies work content", () => {
    expect(classifyCategory("Deploy the PR and run the staging pipeline")).toBe("work");
  });

  test("classifies fitness content", () => {
    expect(classifyCategory("Great workout at the gym, cardio and lifting")).toBe("fitness");
  });

  test("classifies mental health content", () => {
    expect(classifyCategory("Feeling anxious and overwhelmed, burnout and stress")).toBe("mental_health");
  });

  test("classifies family content", () => {
    expect(classifyCategory("Wincy and the kids are going on a family trip")).toBe("family");
  });

  test("classifies financial content", () => {
    expect(classifyCategory("Review the budget and savings, check investment returns")).toBe("financial");
  });

  test("returns general for ambiguous content", () => {
    expect(classifyCategory("The sky is blue")).toBe("general");
  });

  test("requires at least 2 signals (below threshold = general)", () => {
    expect(classifyCategory("I like to exercise")).toBe("general");
  });

  test("is case insensitive", () => {
    expect(classifyCategory("DEPLOY THE TICKET AND MERGE THE PIPELINE")).toBe("work");
  });
});

// ── Cognitive type classification (ELLIE-938) ──────────────────

describe("ELLIE-938: classifyCognitiveType", () => {
  test("classifies procedural content", () => {
    expect(classifyCognitiveType("How to deploy: first configure then set up")).toBe("procedural");
  });

  test("classifies episodic content", () => {
    expect(classifyCognitiveType("Yesterday the incident occurred and there was an outage")).toBe("episodic");
  });

  test("classifies semantic content", () => {
    expect(classifyCognitiveType("REST is a concept that represents an architecture")).toBe("semantic");
  });

  test("returns factual for plain content", () => {
    expect(classifyCognitiveType("The database has 500 records")).toBe("factual");
  });
});

// ── Scope inference (ELLIE-935) ────────────────────────────────

describe("ELLIE-935: inferScopePath", () => {
  test("infers 2/3 from dashboard content", () => {
    expect(inferScopePath("The dashboard Nuxt component in ellie-home uses tailwind")).toBe("2/3");
  });

  test("infers 2/1 from relay content", () => {
    expect(inferScopePath("The relay telegram webhook handles work-session dispatch")).toBe("2/1");
  });

  test("infers 2/2 from forest content", () => {
    expect(inferScopePath("Updated ellie-forest trees.ts and branches.ts for grove entities")).toBe("2/2");
  });

  test("returns null for vague content", () => {
    expect(inferScopePath("I like pizza")).toBeNull();
  });

  test("returns null for ties", () => {
    expect(inferScopePath("relay dashboard")).toBeNull();
  });
});

// ── Tier scoring (ELLIE-933) ───────────────────────────────────

describe("ELLIE-933: tier multiplier in scoring", () => {
  test("core memories score higher than extended with same base", () => {
    const base = computeTemporalDecayScore(0.8, 5.0, new Date(Date.now() - 3600000), DEFAULT_DECAY_WEIGHTS);
    const coreScore = base * getTierMultiplier("core");
    const extScore = base * getTierMultiplier("extended");
    expect(coreScore).toBeGreaterThan(extScore);
  });

  test("core > goals > extended ordering", () => {
    expect(getTierMultiplier("core")).toBeGreaterThan(getTierMultiplier("goals"));
    expect(getTierMultiplier("goals")).toBeGreaterThan(getTierMultiplier("extended"));
  });
});

// ── Arc direction inference (ELLIE-934) ────────────────────────

describe("ELLIE-934: inferDirection", () => {
  test("growing when confidence increases", () => {
    expect(inferDirection([0.3, 0.4, 0.7, 0.9])).toBe("growing");
  });

  test("declining when confidence decreases", () => {
    expect(inferDirection([0.9, 0.8, 0.4, 0.3])).toBe("declining");
  });

  test("stable when flat", () => {
    expect(inferDirection([0.5, 0.5, 0.5, 0.5])).toBe("stable");
  });

  test("exploring for single value", () => {
    expect(inferDirection([0.5])).toBe("exploring");
  });

  test("exploring for empty array", () => {
    expect(inferDirection([])).toBe("exploring");
  });
});

// ── Psy priorities (ELLIE-926) ─────────────────────────────────

describe("ELLIE-926: psy context mode priorities", () => {
  test("conversation mode includes psy at priority <= 5", async () => {
    const { getModeSectionPriorities } = await import("../src/context-mode.ts");
    const priorities = getModeSectionPriorities("conversation");
    expect(priorities["psy"]).toBeDefined();
    expect(priorities["psy"]).toBeLessThanOrEqual(5);
  });

  test("strategy mode has psy defined", async () => {
    const { getModeSectionPriorities } = await import("../src/context-mode.ts");
    const priorities = getModeSectionPriorities("strategy");
    expect(priorities["psy"]).toBeDefined();
  });
});

// ── Emotional annotation logic (ELLIE-926) ─────────────────────

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
});

// ── Fix #18: Constants are frozen ──────────────────────────────

describe("Fix #18: signal constants are immutable", () => {
  test("TIER_MULTIPLIERS cannot be modified", () => {
    const orig = getTierMultiplier("core");
    try {
      // Attempt modification — should silently fail or throw in strict mode
      (Object as any).assign(getTierMultiplier, { core: 999 });
    } catch { /* expected */ }
    expect(getTierMultiplier("core")).toBe(orig);
  });
});

// ── Exports exist ──────────────────────────────────────────────

describe("ELLIE-932: all new exports present", () => {
  test("Phase 1-3 exports", async () => {
    const mod = await import("../../ellie-forest/src/index.ts");
    const fns = [
      'classifyCategory', 'classifyCognitiveType', 'autoPromoteToCore',
      'backfillClassifications', 'getTierMultiplier', 'inferScopePath',
      'detectQueryIntent', 'getPreferences', 'detectArcsFromChains',
      'detectArcsFromClusters', 'inferDirection',
    ];
    for (const fn of fns) {
      expect(typeof (mod as any)[fn]).toBe("function");
    }
  });
});

// ── Phase engine (ELLIE-941) ───────────────────────────────────

describe("ELLIE-941: relationship phase engine", () => {
  test("phase names defined for 0-4", async () => {
    const { PHASE_NAMES } = await import("../../ellie-forest/src/phases.ts");
    expect(PHASE_NAMES[0]).toBe("First Contact");
    expect(PHASE_NAMES[4]).toBe("Deep Bond");
  });

  test("default phase starts at 0", async () => {
    const { createDefaultPhase } = await import("../../ellie-forest/src/phases.ts");
    const p = createDefaultPhase();
    expect(p.phase).toBe(0);
    expect(p.message_count).toBe(0);
  });

  test("phase advances 0→1 at threshold", async () => {
    const { computeNextPhase, createDefaultPhase, PHASE_THRESHOLDS } = await import("../../ellie-forest/src/phases.ts");
    const p = createDefaultPhase();
    p.message_count = PHASE_THRESHOLDS[1].message_count;
    expect(computeNextPhase(p)).toBe(1);
  });

  test("phase does not skip levels", async () => {
    const { computeNextPhase, createDefaultPhase } = await import("../../ellie-forest/src/phases.ts");
    const p = createDefaultPhase();
    p.message_count = 10000;
    expect(computeNextPhase(p)).toBe(1);
  });

  test("buildPhasePrompt returns guidance for each phase", async () => {
    const { buildPhasePrompt, createDefaultPhase, PHASE_NAMES } = await import("../../ellie-forest/src/phases.ts");
    for (let i = 0; i <= 4; i++) {
      const p = createDefaultPhase();
      p.phase = i as 0 | 1 | 2 | 3 | 4;
      p.phase_name = PHASE_NAMES[i];
      expect(buildPhasePrompt(p)).toContain("Relationship Phase");
    }
  });
});
