/**
 * Formation Outcome Typing Tests — ELLIE-696
 *
 * Tests cover:
 *   - Outcome type shapes for each formation
 *   - Parsing and validation
 *   - Formation chaining (chain context, prompt building)
 *   - Outcome highlights extraction
 *   - Serialization/deserialization
 *   - Mock helpers
 *   - Migration SQL
 *   - E2E chaining scenarios
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  // Types
  type FormationOutcome,
  type ThinkTankOutcome,
  type BoardroomOutcome,
  type VrboOpsOutcome,
  type SoftwareDevOutcome,
  type BillingOpsOutcome,
  type ChainContext,
  // Constants
  TYPED_FORMATION_NAMES,
  // Type guards
  isTypedFormation,
  // Parsing
  parseOutcome,
  parseOutcomeAs,
  // Validation
  validateOutcome,
  // Chaining
  buildChainContextPrompt,
  extractOutcomeHighlights,
  createChain,
  // Serialization
  serializeOutcome,
  deserializeOutcome,
  // Mocks
  _makeMockThinkTankOutcome,
  _makeMockBoardroomOutcome,
  _makeMockVrboOpsOutcome,
  _makeMockSoftwareDevOutcome,
  _makeMockBillingOpsOutcome,
} from "../src/types/formation-outcomes.ts";

// ── Constants & Type Guards ─────────────────────────────────────

describe("formation outcomes — constants", () => {
  it("has 5 typed formation names", () => {
    expect(TYPED_FORMATION_NAMES).toHaveLength(5);
    expect(TYPED_FORMATION_NAMES).toContain("think-tank");
    expect(TYPED_FORMATION_NAMES).toContain("boardroom");
    expect(TYPED_FORMATION_NAMES).toContain("vrbo-ops");
    expect(TYPED_FORMATION_NAMES).toContain("software-development");
    expect(TYPED_FORMATION_NAMES).toContain("billing-ops");
  });

  it("isTypedFormation accepts valid names", () => {
    for (const name of TYPED_FORMATION_NAMES) {
      expect(isTypedFormation(name)).toBe(true);
    }
  });

  it("isTypedFormation rejects invalid names", () => {
    expect(isTypedFormation("unknown")).toBe(false);
    expect(isTypedFormation("")).toBe(false);
    expect(isTypedFormation("BOARDROOM")).toBe(false);
  });
});

// ── Mock Helpers ────────────────────────────────────────────────

describe("formation outcomes — mock helpers", () => {
  it("_makeMockThinkTankOutcome creates valid outcome", () => {
    const outcome = _makeMockThinkTankOutcome();
    expect(outcome.formationName).toBe("think-tank");
    expect(outcome.success).toBe(true);
    expect(outcome.ideas.length).toBeGreaterThan(0);
    expect(outcome.themes.length).toBeGreaterThan(0);
    expect(outcome.nextSteps.length).toBeGreaterThan(0);
  });

  it("_makeMockBoardroomOutcome creates valid outcome", () => {
    const outcome = _makeMockBoardroomOutcome();
    expect(outcome.formationName).toBe("boardroom");
    expect(outcome.recommendations.length).toBeGreaterThan(0);
    expect(outcome.decisions.length).toBeGreaterThan(0);
    expect(outcome.risks.length).toBeGreaterThan(0);
  });

  it("_makeMockVrboOpsOutcome creates valid outcome", () => {
    const outcome = _makeMockVrboOpsOutcome();
    expect(outcome.formationName).toBe("vrbo-ops");
    expect(outcome.metrics.occupancyRate).toBeDefined();
    expect(outcome.actionItems.length).toBeGreaterThan(0);
  });

  it("_makeMockSoftwareDevOutcome creates valid outcome", () => {
    const outcome = _makeMockSoftwareDevOutcome();
    expect(outcome.formationName).toBe("software-development");
    expect(outcome.approach).toBeDefined();
    expect(outcome.filesChanged.length).toBeGreaterThan(0);
    expect(outcome.testStatus).not.toBeNull();
  });

  it("_makeMockBillingOpsOutcome creates valid outcome", () => {
    const outcome = _makeMockBillingOpsOutcome();
    expect(outcome.formationName).toBe("billing-ops");
    expect(outcome.dashboard.length).toBeGreaterThan(0);
    expect(outcome.complianceStatus).toBeDefined();
  });

  it("mock helpers accept overrides", () => {
    const outcome = _makeMockBoardroomOutcome({
      summary: "Custom summary",
      success: false,
    });
    expect(outcome.summary).toBe("Custom summary");
    expect(outcome.success).toBe(false);
    expect(outcome.formationName).toBe("boardroom"); // base preserved
  });
});

// ── Parsing ─────────────────────────────────────────────────────

describe("formation outcomes — parseOutcome", () => {
  it("parses a valid think-tank outcome", () => {
    const raw = _makeMockThinkTankOutcome();
    const parsed = parseOutcome(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.formationName).toBe("think-tank");
  });

  it("parses a valid boardroom outcome", () => {
    const parsed = parseOutcome(_makeMockBoardroomOutcome());
    expect(parsed).not.toBeNull();
    expect(parsed!.formationName).toBe("boardroom");
  });

  it("returns null for null/undefined", () => {
    expect(parseOutcome(null)).toBeNull();
    expect(parseOutcome(undefined)).toBeNull();
  });

  it("returns null for non-object", () => {
    expect(parseOutcome("string")).toBeNull();
    expect(parseOutcome(42)).toBeNull();
  });

  it("returns null for missing formationName", () => {
    expect(parseOutcome({ summary: "test", success: true })).toBeNull();
  });

  it("returns null for unknown formation name", () => {
    expect(parseOutcome({
      formationName: "unknown-formation",
      summary: "test",
      success: true,
    })).toBeNull();
  });

  it("returns null for missing required base fields", () => {
    expect(parseOutcome({
      formationName: "boardroom",
      // missing summary and success
    })).toBeNull();
  });
});

describe("formation outcomes — parseOutcomeAs", () => {
  it("parses as specific formation type", () => {
    const raw = _makeMockBoardroomOutcome();
    const parsed = parseOutcomeAs(raw, "boardroom");
    expect(parsed).not.toBeNull();
    expect(parsed!.recommendations).toBeDefined();
  });

  it("returns null when formation name doesn't match", () => {
    const raw = _makeMockBoardroomOutcome();
    const parsed = parseOutcomeAs(raw, "think-tank");
    expect(parsed).toBeNull();
  });

  it("returns null for invalid data", () => {
    expect(parseOutcomeAs(null, "boardroom")).toBeNull();
  });
});

// ── Validation ──────────────────────────────────────────────────

describe("formation outcomes — validateOutcome", () => {
  it("validates a complete think-tank outcome", () => {
    const result = validateOutcome(_makeMockThinkTankOutcome());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("validates a complete boardroom outcome", () => {
    const result = validateOutcome(_makeMockBoardroomOutcome());
    expect(result.valid).toBe(true);
  });

  it("validates a complete vrbo-ops outcome", () => {
    const result = validateOutcome(_makeMockVrboOpsOutcome());
    expect(result.valid).toBe(true);
  });

  it("validates a complete software-development outcome", () => {
    const result = validateOutcome(_makeMockSoftwareDevOutcome());
    expect(result.valid).toBe(true);
  });

  it("validates a complete billing-ops outcome", () => {
    const result = validateOutcome(_makeMockBillingOpsOutcome());
    expect(result.valid).toBe(true);
  });

  it("rejects null", () => {
    const result = validateOutcome(null);
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe("outcome");
  });

  it("rejects missing base fields", () => {
    const result = validateOutcome({ formationName: "boardroom" });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "completedAt")).toBe(true);
    expect(result.errors.some(e => e.field === "success")).toBe(true);
    expect(result.errors.some(e => e.field === "summary")).toBe(true);
  });

  it("rejects missing formation-specific fields", () => {
    const result = validateOutcome({
      formationName: "think-tank",
      completedAt: new Date().toISOString(),
      query: "test",
      success: true,
      summary: "test",
      // missing ideas and themes
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "ideas")).toBe(true);
    expect(result.errors.some(e => e.field === "themes")).toBe(true);
  });

  it("rejects missing boardroom-specific fields", () => {
    const result = validateOutcome({
      formationName: "boardroom",
      completedAt: new Date().toISOString(),
      query: "test",
      success: true,
      summary: "test",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "recommendations")).toBe(true);
    expect(result.errors.some(e => e.field === "decisions")).toBe(true);
  });

  it("rejects missing software-development-specific fields", () => {
    const result = validateOutcome({
      formationName: "software-development",
      completedAt: new Date().toISOString(),
      query: "test",
      success: true,
      summary: "test",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "approach")).toBe(true);
    expect(result.errors.some(e => e.field === "filesChanged")).toBe(true);
  });

  it("rejects missing billing-ops-specific fields", () => {
    const result = validateOutcome({
      formationName: "billing-ops",
      completedAt: new Date().toISOString(),
      query: "test",
      success: true,
      summary: "test",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "dashboard")).toBe(true);
    expect(result.errors.some(e => e.field === "complianceStatus")).toBe(true);
  });
});

// ── Outcome Highlights ──────────────────────────────────────────

describe("formation outcomes — extractOutcomeHighlights", () => {
  it("extracts think-tank highlights (ideas + themes)", () => {
    const outcome = _makeMockThinkTankOutcome();
    const highlights = extractOutcomeHighlights(outcome);
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights.some(h => h.startsWith("Idea:"))).toBe(true);
    expect(highlights.some(h => h.startsWith("Theme:"))).toBe(true);
  });

  it("extracts boardroom highlights (P0 recs + decisions + escalations)", () => {
    const outcome = _makeMockBoardroomOutcome();
    const highlights = extractOutcomeHighlights(outcome);
    expect(highlights.some(h => h.includes("[P0]"))).toBe(true);
    expect(highlights.some(h => h.startsWith("Decision:"))).toBe(true);
    expect(highlights.some(h => h.startsWith("Escalation:"))).toBe(true);
  });

  it("extracts vrbo-ops highlights (metrics + P0 actions)", () => {
    const outcome = _makeMockVrboOpsOutcome();
    const highlights = extractOutcomeHighlights(outcome);
    expect(highlights.some(h => h.includes("Occupancy"))).toBe(true);
    expect(highlights.some(h => h.includes("[P0]"))).toBe(true);
  });

  it("extracts software-dev highlights (approach + tests + blockers)", () => {
    const outcome = _makeMockSoftwareDevOutcome();
    const highlights = extractOutcomeHighlights(outcome);
    expect(highlights.some(h => h.startsWith("Approach:"))).toBe(true);
    expect(highlights.some(h => h.includes("Tests:"))).toBe(true);
  });

  it("extracts billing-ops highlights (compliance + P0 items + escalations)", () => {
    const outcome = _makeMockBillingOpsOutcome();
    const highlights = extractOutcomeHighlights(outcome);
    expect(highlights.some(h => h.includes("Compliance:"))).toBe(true);
    expect(highlights.some(h => h.includes("[P0]"))).toBe(true);
    expect(highlights.some(h => h.startsWith("Escalation:"))).toBe(true);
  });

  it("limits highlights (no more than 5 ideas, 3 themes)", () => {
    const outcome = _makeMockThinkTankOutcome({
      ideas: Array.from({ length: 10 }, (_, i) => ({
        title: `Idea ${i}`, description: `Desc ${i}`, champion: "agent",
      })),
      themes: Array.from({ length: 10 }, (_, i) => `Theme ${i}`),
    });
    const highlights = extractOutcomeHighlights(outcome);
    const ideaCount = highlights.filter(h => h.startsWith("Idea:")).length;
    const themeCount = highlights.filter(h => h.startsWith("Theme:")).length;
    expect(ideaCount).toBeLessThanOrEqual(5);
    expect(themeCount).toBeLessThanOrEqual(3);
  });
});

// ── Formation Chaining ──────────────────────────────────────────

describe("formation outcomes — createChain", () => {
  it("creates a chain context from a prior outcome", () => {
    const prior = _makeMockThinkTankOutcome();
    const chain = createChain(prior);
    expect(chain.priorFormation).toBe("think-tank");
    expect(chain.priorOutcome).toBe(prior);
    expect(chain.chainInstructions).toContain("prior formation");
  });

  it("accepts custom chain instructions", () => {
    const prior = _makeMockBoardroomOutcome();
    const chain = createChain(prior, "Focus on the P0 recommendations only.");
    expect(chain.chainInstructions).toBe("Focus on the P0 recommendations only.");
  });
});

describe("formation outcomes — buildChainContextPrompt", () => {
  it("produces XML-structured prompt with prior formation data", () => {
    const prior = _makeMockBoardroomOutcome();
    const chain = createChain(prior);
    const prompt = buildChainContextPrompt(chain);

    expect(prompt).toContain('name="boardroom"');
    expect(prompt).toContain("<summary>");
    expect(prompt).toContain(prior.summary);
    expect(prompt).toContain("<chain-instructions>");
    expect(prompt).toContain("<key-findings>");
  });

  it("includes highlights in key-findings", () => {
    const prior = _makeMockBillingOpsOutcome();
    const chain = createChain(prior);
    const prompt = buildChainContextPrompt(chain);

    expect(prompt).toContain("<finding>");
    expect(prompt).toContain("Compliance:");
  });

  it("handles outcome with no highlights gracefully", () => {
    const prior = _makeMockBoardroomOutcome({
      recommendations: [],
      decisions: [],
      escalations: [],
    });
    const chain = createChain(prior);
    const prompt = buildChainContextPrompt(chain);

    expect(prompt).toContain('name="boardroom"');
    expect(prompt).toContain("<summary>");
    // No key-findings section when highlights are empty
    expect(prompt).not.toContain("<key-findings>");
  });
});

// ── Serialization ───────────────────────────────────────────────

describe("formation outcomes — serialization", () => {
  it("serializeOutcome produces plain JSON", () => {
    const outcome = _makeMockBoardroomOutcome();
    const serialized = serializeOutcome(outcome);
    expect(typeof serialized).toBe("object");
    expect(serialized.formationName).toBe("boardroom");
    // Should be a new object, not the same reference
    expect(serialized).not.toBe(outcome);
  });

  it("deserializeOutcome round-trips correctly", () => {
    const original = _makeMockSoftwareDevOutcome();
    const serialized = serializeOutcome(original);
    const deserialized = deserializeOutcome(serialized);
    expect(deserialized).not.toBeNull();
    expect(deserialized!.formationName).toBe("software-development");
    expect((deserialized as SoftwareDevOutcome).approach).toBe(original.approach);
  });

  it("deserializeOutcome returns null for invalid data", () => {
    expect(deserializeOutcome(null)).toBeNull();
    expect(deserializeOutcome("string")).toBeNull();
    expect(deserializeOutcome({ foo: "bar" })).toBeNull();
  });

  it("all mock outcomes round-trip through serialize/deserialize", () => {
    const outcomes: FormationOutcome[] = [
      _makeMockThinkTankOutcome(),
      _makeMockBoardroomOutcome(),
      _makeMockVrboOpsOutcome(),
      _makeMockSoftwareDevOutcome(),
      _makeMockBillingOpsOutcome(),
    ];

    for (const outcome of outcomes) {
      const serialized = serializeOutcome(outcome);
      const deserialized = deserializeOutcome(serialized);
      expect(deserialized).not.toBeNull();
      expect(deserialized!.formationName).toBe(outcome.formationName);
      expect(deserialized!.summary).toBe(outcome.summary);
    }
  });
});

// ── Migration SQL ───────────────────────────────────────────────

describe("formation outcomes — migration SQL", () => {
  const sql = readFileSync(
    join(import.meta.dir, "../migrations/supabase/20260313_formation_outcome_column.sql"),
    "utf-8",
  );

  it("adds outcome JSONB column to formation_sessions", () => {
    expect(sql).toContain("ALTER TABLE formation_sessions");
    expect(sql).toContain("outcome JSONB");
  });

  it("creates index for querying by formation name with outcome", () => {
    expect(sql).toContain("idx_formation_sessions_has_outcome");
    expect(sql).toContain("WHERE outcome IS NOT NULL");
  });

  it("creates GIN index for querying within outcome", () => {
    expect(sql).toContain("idx_formation_sessions_outcome_gin");
    expect(sql).toContain("USING GIN");
  });
});

// ── E2E Chaining Scenarios ──────────────────────────────────────

describe("formation outcomes — E2E chaining", () => {
  it("think-tank → boardroom chain", () => {
    // Think tank produces ideas
    const thinkTankOutcome = _makeMockThinkTankOutcome({
      ideas: [
        { title: "AI-powered billing", description: "Use AI to auto-code claims", champion: "research" },
        { title: "Patient portal", description: "Self-service billing portal", champion: "dev" },
      ],
      themes: ["automation", "patient experience"],
      nextSteps: ["Evaluate AI coding accuracy", "Survey patient preferences"],
    });

    // Chain to boardroom
    const chain = createChain(thinkTankOutcome, "Evaluate these ideas strategically and recommend which to pursue.");
    const prompt = buildChainContextPrompt(chain);

    expect(prompt).toContain("think-tank");
    expect(prompt).toContain("AI-powered billing");
    expect(prompt).toContain("Evaluate these ideas strategically");

    // Boardroom produces recommendations based on think-tank ideas
    const boardroomOutcome = _makeMockBoardroomOutcome({
      recommendations: [
        { priority: "P0", title: "AI-powered billing", rationale: "High ROI, addresses coding accuracy pain point" },
        { priority: "P2", title: "Patient portal", rationale: "Nice to have, lower urgency" },
      ],
      decisions: [
        { decision: "Pursue AI billing first", reasoning: "Based on think-tank champion research agent's analysis" },
      ],
    });

    // Validate the chain
    const v1 = validateOutcome(thinkTankOutcome);
    const v2 = validateOutcome(boardroomOutcome);
    expect(v1.valid).toBe(true);
    expect(v2.valid).toBe(true);
  });

  it("boardroom → software-development chain", () => {
    const boardroomOutcome = _makeMockBoardroomOutcome({
      recommendations: [
        { priority: "P0", title: "Implement JWT auth", rationale: "Security requirement from audit" },
      ],
      decisions: [
        { decision: "Use httpOnly cookies for token storage", reasoning: "More secure than alternatives" },
      ],
    });

    const chain = createChain(boardroomOutcome, "Implement the P0 recommendation using the specified approach.");
    const prompt = buildChainContextPrompt(chain);

    expect(prompt).toContain("boardroom");
    expect(prompt).toContain("JWT auth");
    expect(prompt).toContain("Implement the P0 recommendation");

    const devOutcome = _makeMockSoftwareDevOutcome({
      approach: "JWT + httpOnly cookies per boardroom decision",
      technicalDecisions: [
        { decision: "httpOnly cookies", reasoning: "Per boardroom decision — more secure", alternatives: ["localStorage"] },
      ],
    });

    expect(validateOutcome(devOutcome).valid).toBe(true);
  });

  it("billing-ops → boardroom escalation chain", () => {
    const billingOutcome = _makeMockBillingOpsOutcome({
      complianceStatus: "flagged",
      complianceFlags: ["Unbundling risk in batch 2024-0312", "Timely filing deadline approaching"],
      escalations: ["$41K write-off requires board approval", "Regulatory audit scheduled Q2"],
    });

    const chain = createChain(billingOutcome, "Review billing escalations and compliance flags for board-level decision.");
    const prompt = buildChainContextPrompt(chain);

    expect(prompt).toContain("billing-ops");
    expect(prompt).toContain("Compliance: flagged");
    expect(prompt).toContain("Escalation:");
    expect(prompt).toContain("board-level decision");

    // Highlights should include all P0 items and escalations
    const highlights = extractOutcomeHighlights(billingOutcome);
    expect(highlights.some(h => h.includes("$41K write-off"))).toBe(true);
    expect(highlights.some(h => h.includes("flagged"))).toBe(true);
  });

  it("three-formation chain: think-tank → boardroom → software-dev", () => {
    // Stage 1: Think tank
    const ttOutcome = _makeMockThinkTankOutcome();
    const ttSerialized = serializeOutcome(ttOutcome);
    const ttDeserialized = deserializeOutcome(ttSerialized);
    expect(ttDeserialized).not.toBeNull();

    // Stage 2: Boardroom receives think-tank outcome
    const chain1 = createChain(ttDeserialized!, "Evaluate and prioritize ideas.");
    const prompt1 = buildChainContextPrompt(chain1);
    expect(prompt1).toContain("think-tank");

    const brOutcome = _makeMockBoardroomOutcome();
    const brSerialized = serializeOutcome(brOutcome);
    const brDeserialized = deserializeOutcome(brSerialized);
    expect(brDeserialized).not.toBeNull();

    // Stage 3: Software dev receives boardroom outcome
    const chain2 = createChain(brDeserialized!, "Implement the approved recommendation.");
    const prompt2 = buildChainContextPrompt(chain2);
    expect(prompt2).toContain("boardroom");

    const devOutcome = _makeMockSoftwareDevOutcome();
    expect(validateOutcome(devOutcome).valid).toBe(true);
  });
});
