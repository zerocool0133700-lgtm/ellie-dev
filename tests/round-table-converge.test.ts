/**
 * Round Table: Converge Phase Tests — ELLIE-699
 *
 * Tests cover:
 *   - Prompt building (includes contributions, criteria, instructions)
 *   - Criteria checking (formation count, dimensions, consensus)
 *   - Gap detection (missing dimensions, failed formations, insufficient count)
 *   - Synthesis execution (agent call, fallback on failure)
 *   - Agreement/conflict extraction
 *   - Summary formatting
 *   - Mock helpers
 *   - E2E scenarios (full convergence, partial data, all fail)
 */

import { describe, it, expect } from "bun:test";

import {
  // Prompt building
  buildConvergePrompt,
  // Criteria
  checkCriteria,
  type CriteriaStatus,
  // Gap detection
  detectGaps,
  type Gap,
  // Phase execution
  executeConverge,
  type ConvergeOutput,
  // Mock helpers
  _makeMockConvergeDeps,
  _makeMockConvergeOutput,
} from "../src/round-table/converge.ts";

import { _makeMockConveneOutput, type ConveneOutput } from "../src/round-table/convene.ts";
import { _makeMockDiscussOutput, type DiscussOutput } from "../src/round-table/discuss.ts";

// ── Prompt Building ─────────────────────────────────────────────

describe("converge — buildConvergePrompt", () => {
  const convene = _makeMockConveneOutput();
  const discuss = _makeMockDiscussOutput();

  it("includes the original query", () => {
    const prompt = buildConvergePrompt("Q2 strategy?", convene, discuss);
    expect(prompt).toContain("Q2 strategy?");
    expect(prompt).toContain('phase="converge"');
  });

  it("includes convene summary", () => {
    const prompt = buildConvergePrompt("test", convene, discuss);
    expect(prompt).toContain(convene.summary);
  });

  it("includes successful formation contributions", () => {
    const prompt = buildConvergePrompt("test", convene, discuss);
    expect(prompt).toContain('formation="boardroom"');
    expect(prompt).toContain('status="success"');
    expect(prompt).toContain("Strategic analysis: recommend expansion.");
  });

  it("includes failed formation references", () => {
    const discussWithFailure = _makeMockDiscussOutput({
      results: [
        { slug: "good", success: true, output: "Analysis", durationMs: 100, timedOut: false },
        { slug: "bad", success: false, output: "", error: "Crashed", durationMs: 50, timedOut: false },
      ],
      succeeded: ["good"],
      failed: ["bad"],
    });
    const prompt = buildConvergePrompt("test", convene, discussWithFailure);
    expect(prompt).toContain('formation="bad"');
    expect(prompt).toContain('status="failed"');
  });

  it("includes success criteria", () => {
    const prompt = buildConvergePrompt("test", convene, discuss);
    expect(prompt).toContain("<success-criteria>");
    expect(prompt).toContain("<expected-output>");
    expect(prompt).toContain("<key-questions>");
    expect(prompt).toContain("<consensus-required>");
  });

  it("includes synthesis instructions", () => {
    const prompt = buildConvergePrompt("test", convene, discuss);
    expect(prompt).toContain("AGREEMENT");
    expect(prompt).toContain("CONFLICTS");
    expect(prompt).toContain("GAPS");
    expect(prompt).toContain("ESCALATIONS");
    expect(prompt).toContain("PRIORITIZED");
  });
});

// ── Criteria Checking ───────────────────────────────────────────

describe("converge — checkCriteria", () => {
  it("passes when all criteria met", () => {
    const convene = _makeMockConveneOutput({
      successCriteria: {
        expectedOutput: "A plan",
        keyQuestions: ["Strategic direction?"],
        minFormations: 1,
        requiresConsensus: false,
        requiredDimensions: ["strategic"],
      },
    });
    const discuss = _makeMockDiscussOutput({
      results: [
        { slug: "boardroom", success: true, output: "Strategic recommendation: expand market.", durationMs: 100, timedOut: false },
      ],
      succeeded: ["boardroom"],
    });

    const status = checkCriteria(convene, discuss);
    expect(status.allMet).toBe(true);
    expect(status.formationCountMet).toBe(true);
    expect(status.dimensionsAddressed).toContain("strategic");
    expect(status.dimensionsMissing).toHaveLength(0);
  });

  it("fails when formation count not met", () => {
    const convene = _makeMockConveneOutput({
      successCriteria: {
        expectedOutput: "A plan",
        keyQuestions: [],
        minFormations: 3,
        requiresConsensus: false,
        requiredDimensions: [],
      },
    });
    const discuss = _makeMockDiscussOutput({
      succeeded: ["boardroom"],
    });

    const status = checkCriteria(convene, discuss);
    expect(status.formationCountMet).toBe(false);
    expect(status.allMet).toBe(false);
  });

  it("detects missing dimensions", () => {
    const convene = _makeMockConveneOutput({
      successCriteria: {
        expectedOutput: "A plan",
        keyQuestions: [],
        minFormations: 1,
        requiresConsensus: false,
        requiredDimensions: ["financial", "technical"],
      },
    });
    const discuss = _makeMockDiscussOutput({
      results: [
        { slug: "boardroom", success: true, output: "Budget and cost analysis shows positive ROI.", durationMs: 100, timedOut: false },
      ],
      succeeded: ["boardroom"],
    });

    const status = checkCriteria(convene, discuss);
    expect(status.dimensionsAddressed).toContain("financial");
    expect(status.dimensionsMissing).toContain("technical");
    expect(status.allMet).toBe(false);
  });

  it("checks consensus when required", () => {
    const convene = _makeMockConveneOutput({
      successCriteria: {
        expectedOutput: "A decision",
        keyQuestions: [],
        minFormations: 2,
        requiresConsensus: true,
        requiredDimensions: [],
      },
    });

    // Two formations — consensus reached
    const discuss2 = _makeMockDiscussOutput({ succeeded: ["a", "b"] });
    const status2 = checkCriteria(convene, discuss2);
    expect(status2.consensusReached).toBe(true);

    // One formation — consensus not reached
    const discuss1 = _makeMockDiscussOutput({ succeeded: ["a"] });
    const status1 = checkCriteria(convene, discuss1);
    expect(status1.consensusReached).toBe(false);
  });

  it("skips consensus check when not required", () => {
    const convene = _makeMockConveneOutput({
      successCriteria: {
        expectedOutput: "Analysis",
        keyQuestions: [],
        minFormations: 1,
        requiresConsensus: false,
        requiredDimensions: [],
      },
    });
    const discuss = _makeMockDiscussOutput({ succeeded: ["a"] });

    const status = checkCriteria(convene, discuss);
    expect(status.consensusReached).toBeNull();
  });
});

// ── Gap Detection ───────────────────────────────────────────────

describe("converge — detectGaps", () => {
  it("detects missing dimension gaps", () => {
    const convene = _makeMockConveneOutput();
    const discuss = _makeMockDiscussOutput();
    const criteria: CriteriaStatus = {
      formationCountMet: true,
      dimensionsAddressed: ["strategic"],
      dimensionsMissing: ["financial"],
      consensusReached: null,
      allMet: false,
    };

    const gaps = detectGaps(convene, discuss, criteria);
    expect(gaps.some(g => g.description.includes("financial"))).toBe(true);
  });

  it("detects critical gap when high-score formation fails", () => {
    const convene = _makeMockConveneOutput({
      selectedFormations: [
        { slug: "important", reason: "key", context: "strategic", score: 6 },
      ],
    });
    const discuss = _makeMockDiscussOutput({
      succeeded: [],
      failed: ["important"],
    });
    const criteria: CriteriaStatus = {
      formationCountMet: false,
      dimensionsAddressed: [],
      dimensionsMissing: [],
      consensusReached: null,
      allMet: false,
    };

    const gaps = detectGaps(convene, discuss, criteria);
    const importantGap = gaps.find(g => g.description.includes("important"));
    expect(importantGap).toBeDefined();
    expect(importantGap!.severity).toBe("critical");
    expect(importantGap!.suggestedFormations).toContain("important");
  });

  it("detects insufficient formation count gap", () => {
    const convene = _makeMockConveneOutput({
      successCriteria: {
        expectedOutput: "Analysis",
        keyQuestions: [],
        minFormations: 3,
        requiresConsensus: false,
        requiredDimensions: [],
      },
    });
    const discuss = _makeMockDiscussOutput({
      succeeded: ["a"],
      failed: ["b", "c"],
    });
    const criteria: CriteriaStatus = {
      formationCountMet: false,
      dimensionsAddressed: [],
      dimensionsMissing: [],
      consensusReached: null,
      allMet: false,
    };

    const gaps = detectGaps(convene, discuss, criteria);
    const countGap = gaps.find(g => g.description.includes("below the minimum"));
    expect(countGap).toBeDefined();
    expect(countGap!.severity).toBe("critical");
  });

  it("returns empty when no gaps detected", () => {
    const convene = _makeMockConveneOutput();
    const discuss = _makeMockDiscussOutput();
    const criteria: CriteriaStatus = {
      formationCountMet: true,
      dimensionsAddressed: ["strategic", "financial"],
      dimensionsMissing: [],
      consensusReached: null,
      allMet: true,
    };

    const gaps = detectGaps(convene, discuss, criteria);
    expect(gaps).toHaveLength(0);
  });
});

// ── Phase Execution ─────────────────────────────────────────────

describe("converge — executeConverge", () => {
  it("returns complete ConvergeOutput on success", async () => {
    const convene = _makeMockConveneOutput();
    const discuss = _makeMockDiscussOutput();
    const deps = _makeMockConvergeDeps();

    const result = await executeConverge(deps, "Q2 strategy?", convene, discuss);

    expect(result.success).toBe(true);
    expect(result.synthesis.length).toBeGreaterThan(0);
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.criteriaStatus).toBeDefined();
  });

  it("includes agreements extracted from discuss output", async () => {
    const convene = _makeMockConveneOutput();
    const discuss = _makeMockDiscussOutput({
      results: [
        { slug: "a", success: true, output: "We recommend expanding and investing in growth.", durationMs: 100, timedOut: false },
        { slug: "b", success: true, output: "Priority: invest in expansion and recommend new market entry.", durationMs: 100, timedOut: false },
      ],
      succeeded: ["a", "b"],
    });
    const deps = _makeMockConvergeDeps();

    const result = await executeConverge(deps, "test", convene, discuss);

    expect(result.agreements.length).toBeGreaterThan(0);
    expect(result.agreements.some(a => a.supporters.length >= 2)).toBe(true);
  });

  it("detects conflicts from formation outputs", async () => {
    const convene = _makeMockConveneOutput();
    const discuss = _makeMockDiscussOutput({
      results: [
        { slug: "optimist", success: true, output: "Full speed ahead, great opportunity.", durationMs: 100, timedOut: false },
        { slug: "pessimist", success: true, output: "However, the risk of failure is high and we disagree with aggressive expansion.", durationMs: 100, timedOut: false },
      ],
      succeeded: ["optimist", "pessimist"],
    });
    const deps = _makeMockConvergeDeps();

    const result = await executeConverge(deps, "test", convene, discuss);

    expect(result.conflicts.length).toBeGreaterThan(0);
  });

  it("falls back to concatenation when synthesis agent fails", async () => {
    const convene = _makeMockConveneOutput();
    const discuss = _makeMockDiscussOutput({
      results: [
        { slug: "boardroom", success: true, output: "Boardroom analysis here.", durationMs: 100, timedOut: false },
      ],
      succeeded: ["boardroom"],
    });
    const deps = {
      callAgent: async () => { throw new Error("Agent down"); },
    };

    const result = await executeConverge(deps, "test", convene, discuss);

    expect(result.success).toBe(true);
    expect(result.synthesis).toContain("Boardroom analysis here.");
  });

  it("fails when synthesis agent fails and no successful formations", async () => {
    const convene = _makeMockConveneOutput();
    const discuss = _makeMockDiscussOutput({
      results: [
        { slug: "bad", success: false, output: "", error: "Crashed", durationMs: 50, timedOut: false },
      ],
      succeeded: [],
      failed: ["bad"],
    });
    const deps = {
      callAgent: async () => { throw new Error("Agent down"); },
    };

    const result = await executeConverge(deps, "test", convene, discuss);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Agent down");
  });

  it("populates escalations from critical gaps and conflicts", async () => {
    const convene = _makeMockConveneOutput({
      successCriteria: {
        expectedOutput: "Decision",
        keyQuestions: [],
        minFormations: 3,
        requiresConsensus: false,
        requiredDimensions: [],
      },
      selectedFormations: [
        { slug: "good", reason: "test", context: "test", score: 5 },
        { slug: "bad", reason: "test", context: "test", score: 6 },
        { slug: "ugly", reason: "test", context: "test", score: 4 },
      ],
    });
    const discuss = _makeMockDiscussOutput({
      results: [
        { slug: "good", success: true, output: "Analysis done.", durationMs: 100, timedOut: false },
      ],
      succeeded: ["good"],
      failed: ["bad", "ugly"],
    });
    const deps = _makeMockConvergeDeps();

    const result = await executeConverge(deps, "test", convene, discuss);

    // Should have escalations from critical gaps
    expect(result.escalations.length).toBeGreaterThan(0);
    expect(result.gaps.some(g => g.severity === "critical")).toBe(true);
  });
});

// ── Summary Formatting ──────────────────────────────────────────

describe("converge — summary formatting", () => {
  it("summary includes synthesis", async () => {
    const deps = _makeMockConvergeDeps("Custom synthesis: do X then Y.");
    const result = await executeConverge(deps, "test", _makeMockConveneOutput(), _makeMockDiscussOutput());

    expect(result.summary).toContain("Custom synthesis: do X then Y.");
    expect(result.summary).toContain("Convergence Synthesis");
  });

  it("summary includes criteria status", async () => {
    const deps = _makeMockConvergeDeps();
    const result = await executeConverge(deps, "test", _makeMockConveneOutput(), _makeMockDiscussOutput());

    expect(result.summary).toContain("Criteria Status");
    expect(result.summary).toContain("Formation count:");
  });

  it("summary includes gaps when present", async () => {
    const convene = _makeMockConveneOutput({
      successCriteria: {
        expectedOutput: "Plan",
        keyQuestions: [],
        minFormations: 1,
        requiresConsensus: false,
        requiredDimensions: ["technical"],
      },
    });
    const discuss = _makeMockDiscussOutput({
      results: [
        { slug: "boardroom", success: true, output: "Strategic stuff only.", durationMs: 100, timedOut: false },
      ],
      succeeded: ["boardroom"],
    });
    const deps = _makeMockConvergeDeps();

    const result = await executeConverge(deps, "test", convene, discuss);

    expect(result.summary).toContain("Gaps");
    expect(result.summary).toContain("technical");
  });
});

// ── Mock Helpers ────────────────────────────────────────────────

describe("converge — mock helpers", () => {
  it("_makeMockConvergeDeps returns callable deps", async () => {
    const deps = _makeMockConvergeDeps();
    const response = await deps.callAgent("strategy", "test");
    expect(response.length).toBeGreaterThan(0);
  });

  it("_makeMockConvergeDeps accepts custom response", async () => {
    const deps = _makeMockConvergeDeps("Custom synthesis");
    const response = await deps.callAgent("strategy", "test");
    expect(response).toBe("Custom synthesis");
  });

  it("_makeMockConvergeOutput creates valid output", () => {
    const output = _makeMockConvergeOutput();
    expect(output.success).toBe(true);
    expect(output.synthesis.length).toBeGreaterThan(0);
    expect(output.criteriaStatus.allMet).toBe(true);
  });

  it("_makeMockConvergeOutput accepts overrides", () => {
    const output = _makeMockConvergeOutput({
      success: false,
      error: "test error",
      gaps: [{ description: "missing", suggestedFormations: [], severity: "critical" }],
    });
    expect(output.success).toBe(false);
    expect(output.error).toBe("test error");
    expect(output.gaps).toHaveLength(1);
  });
});

// ── E2E Scenarios ───────────────────────────────────────────────

describe("converge — E2E scenarios", () => {
  it("full convergence with all criteria met", async () => {
    const convene = _makeMockConveneOutput({
      successCriteria: {
        expectedOutput: "A structured plan",
        keyQuestions: ["What is the strategic recommendation?", "What are the financial implications?"],
        minFormations: 2,
        requiresConsensus: false,
        requiredDimensions: ["strategic", "financial"],
      },
    });
    const discuss = _makeMockDiscussOutput({
      results: [
        {
          slug: "boardroom",
          success: true,
          output: "Strategic recommendation: expand into adjacent vertical. Priority: high. ROI estimate: 3.2x over 18 months.",
          durationMs: 150,
          timedOut: false,
        },
        {
          slug: "think-tank",
          success: true,
          output: "Financial analysis: budget of $2.5M required. Revenue projection: $8M over 18 months. Recommend phased investment approach.",
          durationMs: 120,
          timedOut: false,
        },
      ],
      succeeded: ["boardroom", "think-tank"],
      failed: [],
    });
    const deps = _makeMockConvergeDeps(
      "Synthesis: Both formations agree on expansion. Boardroom provides strategic direction while think-tank validates the financial model. Recommend proceeding with $2.5M phased investment targeting $8M return. Priority: Q2 kickoff.",
    );

    const result = await executeConverge(deps, "What should our Q2 strategy be?", convene, discuss);

    expect(result.success).toBe(true);
    expect(result.criteriaStatus.allMet).toBe(true);
    expect(result.criteriaStatus.formationCountMet).toBe(true);
    expect(result.criteriaStatus.dimensionsAddressed).toContain("strategic");
    expect(result.criteriaStatus.dimensionsAddressed).toContain("financial");
    expect(result.gaps).toHaveLength(0);
    expect(result.synthesis).toContain("$2.5M");
    expect(result.summary).toContain("ALL CRITERIA MET");
  });

  it("partial convergence with gaps and escalations", async () => {
    const convene = _makeMockConveneOutput({
      successCriteria: {
        expectedOutput: "Decision",
        keyQuestions: ["What approach?"],
        minFormations: 3,
        requiresConsensus: true,
        requiredDimensions: ["strategic", "financial", "technical"],
      },
      selectedFormations: [
        { slug: "boardroom", reason: "Strategy", context: "strategic", score: 6 },
        { slug: "think-tank", reason: "Ideas", context: "creative", score: 4 },
        { slug: "software-development", reason: "Technical", context: "technical", score: 5 },
      ],
    });
    const discuss = _makeMockDiscussOutput({
      results: [
        { slug: "boardroom", success: true, output: "Strategic plan: expand. Budget: $3M.", durationMs: 100, timedOut: false },
        { slug: "think-tank", success: false, output: "", error: "Crashed", durationMs: 50, timedOut: false },
        { slug: "software-development", success: false, output: "", error: "Timed out", durationMs: 120000, timedOut: true },
      ],
      succeeded: ["boardroom"],
      failed: ["think-tank", "software-development"],
    });
    const deps = _makeMockConvergeDeps();

    const result = await executeConverge(deps, "What approach?", convene, discuss);

    expect(result.success).toBe(true);
    expect(result.criteriaStatus.allMet).toBe(false);
    expect(result.criteriaStatus.formationCountMet).toBe(false);
    expect(result.criteriaStatus.dimensionsMissing).toContain("technical");
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(result.escalations.length).toBeGreaterThan(0);
    expect(result.summary).toContain("CRITERIA NOT FULLY MET");
    expect(result.summary).toContain("Gaps");
  });

  it("convergence with conflicts detected", async () => {
    const convene = _makeMockConveneOutput();
    const discuss = _makeMockDiscussOutput({
      results: [
        {
          slug: "optimist",
          success: true,
          output: "Opportunity is massive. We recommend aggressive expansion into all markets immediately. Invest heavily.",
          durationMs: 100,
          timedOut: false,
        },
        {
          slug: "critic",
          success: true,
          output: "However, the risk of overextension is real. We disagree with aggressive expansion. Recommend cautious, phased approach.",
          durationMs: 100,
          timedOut: false,
        },
      ],
      succeeded: ["optimist", "critic"],
      failed: [],
    });
    const deps = _makeMockConvergeDeps("Synthesis: Tension between aggressive and cautious approaches. Recommend phased expansion as compromise.");

    const result = await executeConverge(deps, "Expansion strategy?", convene, discuss);

    expect(result.success).toBe(true);
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts[0].positions.length).toBe(2);
    expect(result.summary).toContain("Conflicts");
  });
});
