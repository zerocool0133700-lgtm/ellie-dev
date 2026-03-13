/**
 * Round Table: Convene Phase Tests — ELLIE-697
 *
 * Tests cover:
 *   - Query analysis (intent, domains, complexity, dimensions, keywords)
 *   - Formation selection (scoring, ranking, force-include, max limit)
 *   - Success criteria definition
 *   - Enhanced convene prompt building
 *   - Convene phase execution (with and without agent refinement)
 *   - Formation registry
 *   - Per-formation context
 *   - Mock helpers
 *   - E2E scenarios (strategic, technical, multi-domain)
 */

import { describe, it, expect } from "bun:test";

import {
  // Query analysis
  analyzeQuery,
  type QueryAnalysis,
  // Formation selection
  selectFormations,
  type SelectedFormation,
  // Success criteria
  defineSuccessCriteria,
  type SuccessCriteria,
  // Prompt building
  buildEnhancedConvenePrompt,
  // Phase execution
  executeConvene,
  type ConveneOutput,
  // Registry
  FORMATION_REGISTRY,
  type FormationEntry,
  // Mock helpers
  _makeMockConveneDeps,
  _makeMockConveneOutput,
} from "../src/round-table/convene.ts";

// ── Formation Registry ──────────────────────────────────────────

describe("convene — formation registry", () => {
  it("has 5 formations", () => {
    expect(FORMATION_REGISTRY).toHaveLength(5);
  });

  it("contains all expected formations", () => {
    const slugs = FORMATION_REGISTRY.map(f => f.slug);
    expect(slugs).toContain("think-tank");
    expect(slugs).toContain("boardroom");
    expect(slugs).toContain("vrbo-ops");
    expect(slugs).toContain("software-development");
    expect(slugs).toContain("billing-ops");
  });

  it("each formation has non-empty fields", () => {
    for (const f of FORMATION_REGISTRY) {
      expect(f.slug.length).toBeGreaterThan(0);
      expect(f.description.length).toBeGreaterThan(0);
      expect(f.triggers.length).toBeGreaterThan(0);
      expect(f.agents.length).toBeGreaterThan(0);
      expect(f.pattern.length).toBeGreaterThan(0);
    }
  });

  it("each formation has unique slug", () => {
    const slugs = FORMATION_REGISTRY.map(f => f.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

// ── Query Analysis ──────────────────────────────────────────────

describe("convene — analyzeQuery", () => {
  it("detects strategic intent", () => {
    const analysis = analyzeQuery("What should our Q2 strategy be?");
    expect(analysis.intent).toBe("Create a plan");
    expect(analysis.dimensions).toContain("strategic");
  });

  it("detects decision-making intent", () => {
    const analysis = analyzeQuery("Should we expand into the EU market?");
    expect(analysis.intent).toBe("Make a decision");
  });

  it("detects review intent", () => {
    const analysis = analyzeQuery("Review our billing compliance audit results");
    expect(analysis.intent).toBe("Review and analyze");
    expect(analysis.dimensions).toContain("risk");
  });

  it("detects implementation intent", () => {
    const analysis = analyzeQuery("Implement the new authentication system");
    expect(analysis.intent).toBe("Implementation guidance");
    expect(analysis.dimensions).toContain("technical");
  });

  it("detects financial dimensions", () => {
    const analysis = analyzeQuery("What is the cost of expanding our team and revenue impact?");
    expect(analysis.dimensions).toContain("financial");
  });

  it("detects user-impact dimensions", () => {
    const analysis = analyzeQuery("How will this affect our customers?");
    expect(analysis.dimensions).toContain("user-impact");
  });

  it("detects operational dimensions", () => {
    const analysis = analyzeQuery("Do we need to hire more staff for the team?");
    expect(analysis.dimensions).toContain("operational");
  });

  it("matches boardroom domain for strategy queries", () => {
    const analysis = analyzeQuery("Strategic planning for Q2 roadmap priorities");
    expect(analysis.domains).toContain("boardroom");
  });

  it("matches software-development domain for code queries", () => {
    const analysis = analyzeQuery("Implement and deploy the new feature with tests");
    expect(analysis.domains).toContain("software-development");
  });

  it("matches billing-ops domain for billing queries", () => {
    const analysis = analyzeQuery("Review denial management and claims compliance for Office Practicum");
    expect(analysis.domains).toContain("billing-ops");
  });

  it("matches vrbo-ops domain for property queries", () => {
    const analysis = analyzeQuery("Review vacation rental property pricing and guest occupancy");
    expect(analysis.domains).toContain("vrbo-ops");
  });

  it("matches think-tank domain for ideation queries", () => {
    const analysis = analyzeQuery("Brainstorm creative ideas for innovation");
    expect(analysis.domains).toContain("think-tank");
  });

  it("detects multi-word triggers (higher score)", () => {
    const analysis = analyzeQuery("Run the medical billing revenue cycle review");
    expect(analysis.domains).toContain("billing-ops");
    // "medical billing" and "revenue cycle" are multi-word triggers
  });

  it("estimates simple complexity for single-domain queries", () => {
    const analysis = analyzeQuery("Review our billing");
    expect(analysis.complexity).toBe("simple");
  });

  it("estimates moderate complexity for multi-domain queries", () => {
    const analysis = analyzeQuery("Strategic planning with budget and code review");
    expect(["moderate", "complex"]).toContain(analysis.complexity);
  });

  it("estimates complex complexity for many-keyword queries", () => {
    const analysis = analyzeQuery(
      "Strategic roadmap for medical billing revenue cycle with risk compliance audit and code deployment and customer impact analysis",
    );
    expect(analysis.complexity).toBe("complex");
  });

  it("extracts keywords (no stopwords)", () => {
    const analysis = analyzeQuery("What is the strategy for growth?");
    expect(analysis.keywords).toContain("strategy");
    expect(analysis.keywords).toContain("growth");
    expect(analysis.keywords).not.toContain("the");
    expect(analysis.keywords).not.toContain("for");
  });

  it("preserves original query", () => {
    const q = "Test query here";
    expect(analyzeQuery(q).query).toBe(q);
  });
});

// ── Formation Selection ─────────────────────────────────────────

describe("convene — selectFormations", () => {
  it("selects formations matching the query domain", () => {
    const analysis = analyzeQuery("Strategic planning for Q2 roadmap");
    const selected = selectFormations(analysis);
    expect(selected.length).toBeGreaterThan(0);
    expect(selected[0].slug).toBe("boardroom"); // highest domain match
  });

  it("returns formations sorted by score descending", () => {
    const analysis = analyzeQuery("Strategy and billing compliance review");
    const selected = selectFormations(analysis);
    for (let i = 1; i < selected.length; i++) {
      expect(selected[i].score).toBeLessThanOrEqual(selected[i - 1].score);
    }
  });

  it("limits to maxFormations", () => {
    const analysis = analyzeQuery(
      "Strategic billing code review with rental property analysis and brainstorm ideas",
    );
    const selected = selectFormations(analysis, { maxFormations: 2 });
    expect(selected.length).toBeLessThanOrEqual(2);
  });

  it("respects minScore threshold", () => {
    const analysis = analyzeQuery("Strategic planning");
    const selected = selectFormations(analysis, { minScore: 5 });
    for (const f of selected) {
      expect(f.score).toBeGreaterThanOrEqual(5);
    }
  });

  it("force-includes specified formations", () => {
    const analysis = analyzeQuery("Simple question");
    const selected = selectFormations(analysis, {
      forceInclude: ["billing-ops"],
    });
    const slugs = selected.map(f => f.slug);
    expect(slugs).toContain("billing-ops");
  });

  it("each selected formation has a reason", () => {
    const analysis = analyzeQuery("Strategic planning for Q2");
    const selected = selectFormations(analysis);
    for (const f of selected) {
      expect(f.reason.length).toBeGreaterThan(0);
    }
  });

  it("each selected formation has context", () => {
    const analysis = analyzeQuery("Strategic planning for Q2");
    const selected = selectFormations(analysis);
    for (const f of selected) {
      expect(f.context).toContain("Focus area:");
      expect(f.context).toContain("Query intent:");
    }
  });

  it("returns empty array when no formations match", () => {
    const analysis = analyzeQuery("xyz abc 123");
    const selected = selectFormations(analysis);
    expect(selected).toHaveLength(0);
  });

  it("context includes relevant dimensions when applicable", () => {
    const analysis = analyzeQuery("Review the budget and risk strategy");
    const selected = selectFormations(analysis);
    const boardroom = selected.find(f => f.slug === "boardroom");
    if (boardroom) {
      expect(boardroom.context).toContain("Relevant dimensions:");
    }
  });
});

// ── Success Criteria ────────────────────────────────────────────

describe("convene — defineSuccessCriteria", () => {
  it("sets decision output for decision intent", () => {
    const analysis = analyzeQuery("Should we expand into EU?");
    const formations = selectFormations(analysis);
    const criteria = defineSuccessCriteria(analysis, formations);
    expect(criteria.expectedOutput).toContain("decision");
    expect(criteria.requiresConsensus).toBe(true);
  });

  it("sets plan output for plan intent", () => {
    const analysis = analyzeQuery("Create a strategic plan for Q2");
    const formations = selectFormations(analysis);
    const criteria = defineSuccessCriteria(analysis, formations);
    expect(criteria.expectedOutput).toContain("plan");
  });

  it("sets implementation output for build intent", () => {
    const analysis = analyzeQuery("Implement the new feature");
    const formations = selectFormations(analysis);
    const criteria = defineSuccessCriteria(analysis, formations);
    expect(criteria.expectedOutput).toContain("Technical");
  });

  it("sets analysis output for review intent", () => {
    const analysis = analyzeQuery("Analyze our billing compliance");
    const formations = selectFormations(analysis);
    const criteria = defineSuccessCriteria(analysis, formations);
    expect(criteria.expectedOutput).toContain("analysis");
  });

  it("generates key questions from dimensions", () => {
    const analysis = analyzeQuery("Review the budget risk and strategy");
    const formations = selectFormations(analysis);
    const criteria = defineSuccessCriteria(analysis, formations);
    expect(criteria.keyQuestions.length).toBeGreaterThan(0);
    expect(criteria.keyQuestions.some(q => q.toLowerCase().includes("financial"))).toBe(true);
    expect(criteria.keyQuestions.some(q => q.toLowerCase().includes("risk"))).toBe(true);
  });

  it("generates fallback key question when no dimensions", () => {
    const analysis: QueryAnalysis = {
      query: "test",
      intent: "General analysis",
      domains: [],
      complexity: "simple",
      dimensions: [],
      keywords: ["test"],
    };
    const criteria = defineSuccessCriteria(analysis, []);
    expect(criteria.keyQuestions).toHaveLength(1);
    expect(criteria.keyQuestions[0]).toContain("address the original query");
  });

  it("requires consensus for decision intent", () => {
    const analysis = analyzeQuery("Should we choose option A or B?");
    const formations = selectFormations(analysis);
    const criteria = defineSuccessCriteria(analysis, formations);
    expect(criteria.requiresConsensus).toBe(true);
  });

  it("requires consensus for complex queries", () => {
    const analysis: QueryAnalysis = {
      query: "complex",
      intent: "General analysis",
      domains: ["a", "b", "c"],
      complexity: "complex",
      dimensions: [],
      keywords: [],
    };
    const criteria = defineSuccessCriteria(analysis, []);
    expect(criteria.requiresConsensus).toBe(true);
  });

  it("sets minFormations based on complexity", () => {
    const simpleAnalysis: QueryAnalysis = {
      query: "simple",
      intent: "General analysis",
      domains: [],
      complexity: "simple",
      dimensions: [],
      keywords: [],
    };
    const simpleCriteria = defineSuccessCriteria(simpleAnalysis, [
      { slug: "a", reason: "", context: "", score: 1 },
      { slug: "b", reason: "", context: "", score: 1 },
    ]);
    expect(simpleCriteria.minFormations).toBe(1);

    const moderateAnalysis: QueryAnalysis = {
      ...simpleAnalysis,
      complexity: "moderate",
    };
    const moderateCriteria = defineSuccessCriteria(moderateAnalysis, [
      { slug: "a", reason: "", context: "", score: 1 },
      { slug: "b", reason: "", context: "", score: 1 },
    ]);
    expect(moderateCriteria.minFormations).toBe(2);
  });

  it("includes required dimensions", () => {
    const analysis = analyzeQuery("Budget review with risk assessment strategy");
    const formations = selectFormations(analysis);
    const criteria = defineSuccessCriteria(analysis, formations);
    expect(criteria.requiredDimensions).toEqual(analysis.dimensions);
  });
});

// ── Enhanced Convene Prompt ─────────────────────────────────────

describe("convene — buildEnhancedConvenePrompt", () => {
  it("includes the query", () => {
    const analysis = analyzeQuery("Test query");
    const prompt = buildEnhancedConvenePrompt("Test query", analysis);
    expect(prompt).toContain("Test query");
    expect(prompt).toContain('phase="convene"');
  });

  it("includes preliminary analysis", () => {
    const analysis = analyzeQuery("Strategic planning for Q2");
    const prompt = buildEnhancedConvenePrompt("Strategic planning for Q2", analysis);
    expect(prompt).toContain("<intent>");
    expect(prompt).toContain("<domains>");
    expect(prompt).toContain("<complexity>");
    expect(prompt).toContain("<dimensions>");
    expect(prompt).toContain("<keywords>");
  });

  it("includes available formations", () => {
    const analysis = analyzeQuery("test");
    const prompt = buildEnhancedConvenePrompt("test", analysis);
    expect(prompt).toContain("think-tank");
    expect(prompt).toContain("boardroom");
    expect(prompt).toContain("vrbo-ops");
    expect(prompt).toContain("software-development");
    expect(prompt).toContain("billing-ops");
  });

  it("includes instructions for the agent", () => {
    const analysis = analyzeQuery("test");
    const prompt = buildEnhancedConvenePrompt("test", analysis);
    expect(prompt).toContain("problem statement");
    expect(prompt).toContain("formations should participate");
    expect(prompt).toContain("successful outcome");
  });
});

// ── Convene Phase Execution ─────────────────────────────────────

describe("convene — executeConvene", () => {
  it("returns complete ConveneOutput", async () => {
    const deps = _makeMockConveneDeps();
    const result = await executeConvene(deps, "What should our Q2 strategy be?");

    expect(result.analysis).toBeDefined();
    expect(result.selectedFormations).toBeDefined();
    expect(result.successCriteria).toBeDefined();
    expect(result.summary).toBeDefined();
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("selects boardroom for strategic queries", async () => {
    const deps = _makeMockConveneDeps();
    const result = await executeConvene(deps, "Strategic planning for our Q2 roadmap");

    const slugs = result.selectedFormations.map(f => f.slug);
    expect(slugs).toContain("boardroom");
  });

  it("selects software-development for code queries", async () => {
    const deps = _makeMockConveneDeps();
    const result = await executeConvene(deps, "Implement and deploy the authentication feature");

    const slugs = result.selectedFormations.map(f => f.slug);
    expect(slugs).toContain("software-development");
  });

  it("selects billing-ops for medical billing queries", async () => {
    const deps = _makeMockConveneDeps();
    const result = await executeConvene(deps, "Review denial management and medical billing claims");

    const slugs = result.selectedFormations.map(f => f.slug);
    expect(slugs).toContain("billing-ops");
  });

  it("respects force-include option", async () => {
    const deps = _makeMockConveneDeps();
    const result = await executeConvene(deps, "Simple question", {
      forceFormations: ["vrbo-ops"],
    });

    const slugs = result.selectedFormations.map(f => f.slug);
    expect(slugs).toContain("vrbo-ops");
  });

  it("respects maxFormations option", async () => {
    const deps = _makeMockConveneDeps();
    const result = await executeConvene(deps, "Strategy billing code brainstorm rental", {
      maxFormations: 1,
    });

    expect(result.selectedFormations.length).toBeLessThanOrEqual(1);
  });

  it("includes agent refinement in summary", async () => {
    const deps = _makeMockConveneDeps("Custom agent insight: focus on cost analysis.");
    const result = await executeConvene(deps, "Budget review");

    expect(result.summary).toContain("Agent Refinement");
    expect(result.summary).toContain("Custom agent insight");
  });

  it("proceeds when agent refinement fails", async () => {
    const deps = {
      callAgent: async () => { throw new Error("Agent unavailable"); },
    };
    const result = await executeConvene(deps, "Strategic planning for Q2");

    // Should still return results from keyword analysis
    expect(result.analysis).toBeDefined();
    expect(result.selectedFormations.length).toBeGreaterThan(0);
    expect(result.summary).not.toContain("Agent Refinement");
  });

  it("skips agent refinement when skipAgentRefinement is true", async () => {
    let agentCalled = false;
    const deps = {
      callAgent: async () => { agentCalled = true; return "response"; },
    };
    await executeConvene(deps, "Strategy review", { skipAgentRefinement: true });
    expect(agentCalled).toBe(false);
  });

  it("summary includes formation list", async () => {
    const deps = _makeMockConveneDeps();
    const result = await executeConvene(deps, "Strategic planning for Q2 roadmap");

    expect(result.summary).toContain("Selected Formations");
    for (const f of result.selectedFormations) {
      expect(result.summary).toContain(f.slug);
    }
  });

  it("summary includes success criteria", async () => {
    const deps = _makeMockConveneDeps();
    const result = await executeConvene(deps, "Strategic planning for Q2");

    expect(result.summary).toContain("Success Criteria");
    expect(result.summary).toContain("Expected output:");
    expect(result.summary).toContain("Key questions:");
  });
});

// ── Mock Helpers ────────────────────────────────────────────────

describe("convene — mock helpers", () => {
  it("_makeMockConveneDeps returns callable deps", async () => {
    const deps = _makeMockConveneDeps();
    const response = await deps.callAgent("strategy", "test prompt");
    expect(response.length).toBeGreaterThan(0);
  });

  it("_makeMockConveneDeps accepts custom agent response", async () => {
    const deps = _makeMockConveneDeps("Custom response");
    const response = await deps.callAgent("strategy", "test");
    expect(response).toBe("Custom response");
  });

  it("_makeMockConveneOutput creates valid output", () => {
    const output = _makeMockConveneOutput();
    expect(output.analysis.query).toBeDefined();
    expect(output.selectedFormations.length).toBeGreaterThan(0);
    expect(output.successCriteria.expectedOutput).toBeDefined();
    expect(output.summary.length).toBeGreaterThan(0);
  });

  it("_makeMockConveneOutput accepts overrides", () => {
    const output = _makeMockConveneOutput({
      analysis: {
        query: "Custom query",
        intent: "Custom intent",
        domains: ["billing-ops"],
        complexity: "complex",
        dimensions: ["financial"],
        keywords: ["billing"],
      },
    });
    expect(output.analysis.query).toBe("Custom query");
    expect(output.analysis.complexity).toBe("complex");
    // Non-overridden fields preserved
    expect(output.selectedFormations.length).toBeGreaterThan(0);
  });
});

// ── E2E Scenarios ───────────────────────────────────────────────

describe("convene — E2E scenarios", () => {
  it("strategic planning scenario", async () => {
    const deps = _makeMockConveneDeps();
    const result = await executeConvene(
      deps,
      "We need to plan our Q2 strategy. Consider budget constraints, competitive risk, and team capacity.",
    );

    expect(result.analysis.intent).toBe("Create a plan");
    expect(result.analysis.complexity).not.toBe("simple");
    expect(result.analysis.dimensions).toContain("strategic");
    expect(result.analysis.dimensions).toContain("financial");
    expect(result.analysis.dimensions).toContain("risk");

    const slugs = result.selectedFormations.map(f => f.slug);
    expect(slugs).toContain("boardroom");

    expect(result.successCriteria.expectedOutput).toContain("plan");
    expect(result.successCriteria.keyQuestions.length).toBeGreaterThanOrEqual(2);
    expect(result.successCriteria.requiredDimensions.length).toBeGreaterThanOrEqual(2);
  });

  it("technical implementation scenario", async () => {
    const deps = _makeMockConveneDeps();
    const result = await executeConvene(
      deps,
      "Implement and deploy the new authentication feature. Need to refactor the middleware and add tests.",
    );

    expect(result.analysis.intent).toBe("Implementation guidance");
    expect(result.analysis.dimensions).toContain("technical");

    const slugs = result.selectedFormations.map(f => f.slug);
    expect(slugs).toContain("software-development");

    expect(result.successCriteria.expectedOutput).toContain("Technical");
  });

  it("multi-domain billing + strategy scenario", async () => {
    const deps = _makeMockConveneDeps();
    const result = await executeConvene(
      deps,
      "Review our medical billing denial rates and develop a strategic plan to improve revenue cycle compliance",
    );

    expect(result.analysis.domains).toContain("billing-ops");
    // Should detect both billing and strategic dimensions
    expect(result.analysis.dimensions.length).toBeGreaterThan(0);

    const slugs = result.selectedFormations.map(f => f.slug);
    expect(slugs).toContain("billing-ops");
    // Boardroom may also be selected for strategic aspect
  });

  it("vacation rental scenario", async () => {
    const deps = _makeMockConveneDeps();
    const result = await executeConvene(
      deps,
      "Review our vacation rental property pricing and guest occupancy rates for the spring season",
    );

    const slugs = result.selectedFormations.map(f => f.slug);
    expect(slugs).toContain("vrbo-ops");
    expect(result.analysis.domains).toContain("vrbo-ops");
  });

  it("ambiguous query with forced formations", async () => {
    const deps = _makeMockConveneDeps();
    const result = await executeConvene(
      deps,
      "General weekly review of everything",
      { forceFormations: ["boardroom", "billing-ops"] },
    );

    const slugs = result.selectedFormations.map(f => f.slug);
    expect(slugs).toContain("boardroom");
    expect(slugs).toContain("billing-ops");
  });
});
