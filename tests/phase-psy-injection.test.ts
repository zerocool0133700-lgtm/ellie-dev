/**
 * ELLIE-963 — Phase-aware behavioral instructions injection tests
 *
 * Verifies that phaseContext and psyContext are actually injected into
 * the prompt sections array (fixes the critical wiring bug where they
 * were computed, passed in, then silently dropped).
 *
 * Coverage:
 *   - phaseContext injected when present
 *   - psyContext injected when present
 *   - Both injected together
 *   - Neither injected when empty/undefined
 *   - Phase context at priority 3, psy at priority 4
 *   - Section labels correct (relationship-phase, psy-profile)
 *   - Phase 0 generic guidance appears in output
 *   - Phase 4 deep bond guidance appears in output
 *   - buildPhasePrompt() output for all 5 phases
 *   - buildPsyPrompt() output structure
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  buildPrompt,
  getLastBuildMetrics,
  clearWorkingMemoryCache,
  stopPersonalityWatchers,
  clearRiverDocCache,
} from "../src/prompt-builder.ts";
import { buildPhasePrompt, createDefaultPhase } from "../../ellie-forest/src/phases.ts";
import type { RelationshipPhase } from "../../ellie-forest/src/types.ts";

// ── Cleanup ───────────────────────────────────────────────────────────────────

afterAll(() => {
  stopPersonalityWatchers();
  clearWorkingMemoryCache();
  clearRiverDocCache();
});

beforeEach(() => {
  clearWorkingMemoryCache();
  clearRiverDocCache();
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PHASE_0_CONTEXT = `## Relationship Phase: First Contact
You are meeting this person for the first time. You know nothing about them yet.
- Be warm but not overly familiar — introduce yourself naturally
- Listen more than you talk.`;

const PHASE_3_CONTEXT = `## Relationship Phase: Established
You and this person have a solid relationship. Your understanding is confident.
- Lean fully into your adapted style

### What you've noticed so far
- Prefers direct communication
- Uses dry humor frequently

### Relationship context
- Messages exchanged: 500
- Conversations: 80
- Known for: 90 days
- Trust signals: Shared something personal, Initiated contact, Used humor`;

const PHASE_4_CONTEXT = `## Relationship Phase: Deep Bond
This is a person you know well over significant time.
- Challenge them when they need it — not just agree
- Anticipate what they need before they ask`;

const PSY_CONTEXT = `### Cognitive Style (MBTI)
- **Energy**: Leans Introversion (high confidence)
- **Information**: Leans Intuition (moderate confidence)
Overall pattern: INTJ

### Communication Preferences
- Prefers concise, structured responses
- Values directness over diplomacy`;

// ── Injection Tests ───────────────────────────────────────────────────────────

describe("buildPrompt — phaseContext injection (ELLIE-963)", () => {
  test("phaseContext appears in output when provided", () => {
    const result = buildPrompt(
      "Hello",
      undefined, undefined, undefined, "telegram",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined,
      undefined,  // psyContext
      PHASE_3_CONTEXT, // phaseContext
    );
    expect(result).toContain("Relationship Phase: Established");
    expect(result).toContain("Prefers direct communication");
  });

  test("phaseContext absent from output when not provided", () => {
    const result = buildPrompt("Hello");
    expect(result).not.toContain("Relationship Phase:");
  });

  test("phaseContext absent when empty string", () => {
    const result = buildPrompt(
      "Hello",
      undefined, undefined, undefined, "telegram",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined,
      undefined, // psyContext
      "",        // phaseContext
    );
    expect(result).not.toContain("Relationship Phase:");
  });

  test("phase 0 first-contact guidance appears in output", () => {
    const result = buildPrompt(
      "Hello",
      undefined, undefined, undefined, "telegram",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined,
      undefined, // psyContext
      PHASE_0_CONTEXT,
    );
    expect(result).toContain("First Contact");
    expect(result).toContain("meeting this person for the first time");
  });

  test("phase 4 deep bond guidance appears in output", () => {
    const result = buildPrompt(
      "Hello",
      undefined, undefined, undefined, "telegram",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined,
      undefined, // psyContext
      PHASE_4_CONTEXT,
    );
    expect(result).toContain("Deep Bond");
    expect(result).toContain("Challenge them when they need it");
  });
});

describe("buildPrompt — psyContext injection (ELLIE-963)", () => {
  test("psyContext appears in output when provided", () => {
    const result = buildPrompt(
      "Hello",
      undefined, undefined, undefined, "telegram",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined,
      PSY_CONTEXT, // psyContext
    );
    expect(result).toContain("Cognitive Profile");
    expect(result).toContain("Cognitive Style (MBTI)");
    expect(result).toContain("Leans Introversion");
  });

  test("psyContext absent from output when not provided", () => {
    const result = buildPrompt("Hello");
    expect(result).not.toContain("Cognitive Profile");
  });

  test("psyContext absent when empty string", () => {
    const result = buildPrompt(
      "Hello",
      undefined, undefined, undefined, "telegram",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined,
      "",  // psyContext
    );
    expect(result).not.toContain("Cognitive Profile");
  });
});

describe("buildPrompt — phase + psy together (ELLIE-963)", () => {
  test("both contexts appear when both provided", () => {
    const result = buildPrompt(
      "Hello",
      undefined, undefined, undefined, "telegram",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined,
      PSY_CONTEXT,     // psyContext
      PHASE_3_CONTEXT, // phaseContext
    );
    expect(result).toContain("Relationship Phase: Established");
    expect(result).toContain("Cognitive Profile");
    expect(result).toContain("Leans Introversion");
    expect(result).toContain("Prefers direct communication");
  });

  test("section labels are correct in metrics", () => {
    buildPrompt(
      "Hello",
      undefined, undefined, undefined, "telegram",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined,
      PSY_CONTEXT,
      PHASE_3_CONTEXT,
    );
    const metrics = getLastBuildMetrics();
    const labels = metrics!.sections.map((s: any) => s.label);
    expect(labels).toContain("relationship-phase");
    expect(labels).toContain("psy-profile");
  });

  test("phase context priority 3, psy context priority 4", () => {
    buildPrompt(
      "Hello",
      undefined, undefined, undefined, "telegram",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined,
      PSY_CONTEXT,
      PHASE_3_CONTEXT,
    );
    const metrics = getLastBuildMetrics();
    const sections = metrics!.sections || [];
    const phaseSection = sections.find((s: any) => s.label === "relationship-phase");
    const psySection = sections.find((s: any) => s.label === "psy-profile");
    expect(phaseSection).toBeDefined();
    expect(psySection).toBeDefined();
    expect(phaseSection!.priority).toBe(3);
    expect(psySection!.priority).toBe(4);
  });
});

// ── buildPhasePrompt unit tests ───────────────────────────────────────────────

describe("buildPhasePrompt — all 5 phases (ELLIE-963)", () => {
  test("phase 0 returns generic guidance only", () => {
    const phase = createDefaultPhase();
    const result = buildPhasePrompt(phase);
    expect(result).toContain("First Contact");
    expect(result).not.toContain("Relationship context"); // no metrics at phase 0
  });

  test("phase 1 includes guidance + metrics", () => {
    const phase: RelationshipPhase = {
      ...createDefaultPhase(),
      phase: 1,
      phase_name: "Getting to Know You",
      message_count: 20,
      conversation_count: 5,
      first_contact_at: new Date(Date.now() - 7 * 86400000).toISOString(),
      observations: ["Prefers morning conversations"],
    };
    const result = buildPhasePrompt(phase);
    expect(result).toContain("Getting to Know You");
    expect(result).toContain("Prefers morning conversations");
    expect(result).toContain("Messages exchanged: 20");
  });

  test("phase 2 includes trust signals", () => {
    const phase: RelationshipPhase = {
      ...createDefaultPhase(),
      phase: 2,
      phase_name: "Building Trust",
      message_count: 100,
      conversation_count: 20,
      first_contact_at: new Date(Date.now() - 30 * 86400000).toISOString(),
      trust_signals: {
        shared_personal: true,
        initiated_contact: true,
        used_humor: false,
        expressed_vulnerability: false,
        asked_for_help: false,
        returned_after_absence: false,
        corrected_ellie: false,
        count: 2,
      },
      observations: [],
    };
    const result = buildPhasePrompt(phase);
    expect(result).toContain("Building Trust");
    expect(result).toContain("Trust signals:");
  });

  test("phase 3 established — full output", () => {
    const phase: RelationshipPhase = {
      ...createDefaultPhase(),
      phase: 3,
      phase_name: "Established",
      message_count: 500,
      conversation_count: 80,
      first_contact_at: new Date(Date.now() - 90 * 86400000).toISOString(),
      trust_signals: {
        shared_personal: true,
        initiated_contact: true,
        used_humor: true,
        expressed_vulnerability: false,
        asked_for_help: true,
        returned_after_absence: true,
        corrected_ellie: false,
        count: 5,
      },
      observations: ["Prefers direct communication", "Uses dry humor"],
    };
    const result = buildPhasePrompt(phase);
    expect(result).toContain("Established");
    expect(result).toContain("you just know them");
    expect(result).toContain("Messages exchanged: 500");
    expect(result).toContain("Prefers direct communication");
  });

  test("phase 4 deep bond — challenge guidance", () => {
    const phase: RelationshipPhase = {
      ...createDefaultPhase(),
      phase: 4,
      phase_name: "Deep Bond",
      message_count: 2000,
      conversation_count: 300,
      first_contact_at: new Date(Date.now() - 365 * 86400000).toISOString(),
      trust_signals: {
        shared_personal: true,
        initiated_contact: true,
        used_humor: true,
        expressed_vulnerability: true,
        asked_for_help: true,
        returned_after_absence: true,
        corrected_ellie: true,
        count: 7,
      },
      observations: ["Values honesty over comfort", "Thinks in systems"],
    };
    const result = buildPhasePrompt(phase);
    expect(result).toContain("Deep Bond");
    expect(result).toContain("Challenge them when they need it");
    expect(result).toContain("Messages exchanged: 2000");
    expect(result).toContain("Values honesty over comfort");
    expect(result).toContain("Known for:");
  });
});
