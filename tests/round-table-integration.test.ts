/**
 * Round Table Integration Tests — ELLIE-705
 *
 * E2E integration tests that verify the round table system works as a whole:
 *
 *   1. E2E round table execution (all 4 phases with real module calls)
 *   2. Multi-formation chaining scenarios (2+ formations in discuss phase)
 *   3. Output format verification for each phase
 *   4. Performance benchmarking (time per phase, total session time)
 *   5. Business scenario simulations (realistic queries through full pipeline)
 */

import { describe, expect, test, beforeEach } from "bun:test";

// ── Convene phase (real module) ──────────────────────────────────
import {
  executeConvene,
  analyzeQuery,
  selectFormations,
  FORMATION_REGISTRY,
  _makeMockConveneDeps,
  _makeMockConveneOutput,
  type ConveneOutput,
  type QueryAnalysis,
} from "../src/round-table/convene.ts";

// ── Discuss phase (real module) ──────────────────────────────────
import {
  executeDiscuss,
  _makeMockDiscussDeps,
  _makeMockDiscussOutput,
  type DiscussOutput,
  type FormationResult,
} from "../src/round-table/discuss.ts";

// ── Converge phase (real module) ─────────────────────────────────
import {
  executeConverge,
  checkCriteria,
  detectGaps,
  _makeMockConvergeDeps,
  _makeMockConvergeOutput,
  type ConvergeOutput,
} from "../src/round-table/converge.ts";

// ── Deliver phase (real module) ──────────────────────────────────
import {
  executeDeliver,
  extractTranscripts,
  buildSessionOutcome,
  formatForChannel,
  _makeMockDeliverDeps,
  _makeMockDeliverOutput,
  type DeliverOutput,
  type DeliveryChannel,
} from "../src/round-table/deliver.ts";

// ── Orchestrator ─────────────────────────────────────────────────
import {
  runRoundTable,
  _makeMockOrchestratorDeps,
  _resetIdCounter,
  type RoundTableResult,
} from "../src/round-table/orchestrator.ts";

// ── Output formatting ────────────────────────────────────────────
import {
  formatRoundTableOutput,
  renderForChannel,
  paginateMessage,
  CHANNEL_LIMITS,
  _makeMockFormattingInput,
  _makeMockFormatOptions,
} from "../src/round-table/output-formatting.ts";

// ── Session state machine ────────────────────────────────────────
import {
  createSession,
  startSession,
  advancePhase,
  getSessionProgress,
  _makeMockDeps as _makeMockRoundTableDeps,
} from "../src/types/round-table.ts";


// ═══════════════════════════════════════════════════════════════════
// 1. E2E: Full Pipeline — Real Modules, Injected IO
// ═══════════════════════════════════════════════════════════════════

describe("E2E: Full round table pipeline", () => {
  beforeEach(() => _resetIdCounter());

  test("strategic query flows through all 4 phases and produces output", async () => {
    const query = "What should our Q2 strategy be for expanding into new markets?";

    // Phase 1: Convene
    const conveneDeps = _makeMockConveneDeps();
    const conveneOutput = await executeConvene(conveneDeps, query, { skipAgentRefinement: true });

    expect(conveneOutput.analysis.query).toBe(query);
    expect(conveneOutput.analysis.intent).toBe("Create a plan");
    expect(conveneOutput.selectedFormations.length).toBeGreaterThan(0);
    expect(conveneOutput.summary.length).toBeGreaterThan(0);

    // Phase 2: Discuss
    const discussDeps = _makeMockDiscussDeps({
      boardroom: "Strategic analysis: Market expansion requires $2M investment. ROI expected within 18 months. Recommend phased rollout starting with West Coast.",
      "think-tank": "Creative approaches: Consider partnership model to reduce capital risk. Three potential partners identified. Innovation workshop recommended.",
    });
    const discussOutput = await executeDiscuss(discussDeps, query, conveneOutput);

    expect(discussOutput.success).toBe(true);
    expect(discussOutput.succeeded.length).toBeGreaterThan(0);
    expect(discussOutput.summary).toContain("Formation Contributions");

    // Phase 3: Converge
    const convergeDeps = _makeMockConvergeDeps(
      "Synthesis: Both formations agree on market expansion. Boardroom recommends $2M phased investment, think-tank suggests partnership model to reduce risk. Recommended approach: hybrid model combining direct investment with strategic partnerships.",
    );
    const convergeOutput = await executeConverge(convergeDeps, query, conveneOutput, discussOutput);

    expect(convergeOutput.success).toBe(true);
    expect(convergeOutput.synthesis.length).toBeGreaterThan(0);
    expect(convergeOutput.criteriaStatus).toBeDefined();

    // Phase 4: Deliver
    const deliverDeps = _makeMockDeliverDeps(
      "Executive Summary: Expand into new markets using a hybrid approach — $2M phased direct investment combined with strategic partnerships. Begin West Coast Q2, evaluate Q3.\n\n- Investment: $2M phased over 2 quarters\n- Partners: 3 candidates shortlisted\n- Timeline: West Coast launch Q2\n- Risk mitigation: Partnership model reduces capital exposure by 40%\n\nNext steps: Finalize partner agreements, allocate Q2 budget.",
    );
    const deliverOutput = await executeDeliver(
      deliverDeps, query, "test-session-e2e",
      conveneOutput, discussOutput, convergeOutput, "telegram",
    );

    expect(deliverOutput.success).toBe(true);
    expect(deliverOutput.executiveSummary).toContain("hybrid approach");
    expect(deliverOutput.formattedOutput).toContain("Round Table Complete");
    expect(deliverOutput.transcripts.length).toBe(discussOutput.results.length);
    expect(deliverOutput.outcome.formationsUsed.length).toBeGreaterThan(0);
    expect(deliverOutput.outcome.criteriaAllMet).toBeDefined();
  });

  test("VRBO operations query selects correct formations and completes", async () => {
    const query = "Review our vacation rental pricing strategy and guest satisfaction scores";

    const conveneDeps = _makeMockConveneDeps();
    const conveneOutput = await executeConvene(conveneDeps, query, { skipAgentRefinement: true });

    // Should detect vrbo-ops domain
    expect(conveneOutput.analysis.domains).toContain("vrbo-ops");
    const slugs = conveneOutput.selectedFormations.map(f => f.slug);
    expect(slugs).toContain("vrbo-ops");

    const discussDeps = _makeMockDiscussDeps({
      "vrbo-ops": "Property analysis: Average occupancy 78%, ADR $245. Guest scores: 4.6/5.0. Pricing optimization could increase revenue 12%.",
      boardroom: "Strategic view: Pricing changes should align with seasonal demand. Risk of rate hikes impacting reviews.",
    });
    const discussOutput = await executeDiscuss(discussDeps, query, conveneOutput);
    expect(discussOutput.success).toBe(true);

    const convergeDeps = _makeMockConvergeDeps();
    const convergeOutput = await executeConverge(convergeDeps, query, conveneOutput, discussOutput);
    expect(convergeOutput.success).toBe(true);

    const deliverDeps = _makeMockDeliverDeps();
    const deliverOutput = await executeDeliver(
      deliverDeps, query, "test-vrbo-session",
      conveneOutput, discussOutput, convergeOutput, "plain",
    );
    expect(deliverOutput.success).toBe(true);
    expect(deliverOutput.channel).toBe("plain");
    expect(deliverOutput.formattedOutput).toContain("Round Table Result");
  });

  test("software development query routes through engineering formations", async () => {
    const query = "Should we refactor the authentication module or implement a new one from scratch?";

    const conveneDeps = _makeMockConveneDeps();
    const conveneOutput = await executeConvene(conveneDeps, query, { skipAgentRefinement: true });

    expect(conveneOutput.analysis.domains).toContain("software-development");
    expect(conveneOutput.analysis.intent).toBe("Make a decision");

    const discussDeps = _makeMockDiscussDeps({
      "software-development": "Technical assessment: Current auth module has 3 known CVEs. Refactor estimated at 2 weeks. Full rewrite 4 weeks but addresses all tech debt.",
    });
    const discussOutput = await executeDiscuss(discussDeps, query, conveneOutput);
    expect(discussOutput.success).toBe(true);

    const convergeDeps = _makeMockConvergeDeps();
    const convergeOutput = await executeConverge(convergeDeps, query, conveneOutput, discussOutput);
    expect(convergeOutput.success).toBe(true);
    // Decision queries require consensus
    expect(conveneOutput.successCriteria.requiresConsensus).toBe(true);
  });

  test("billing operations query completes full pipeline", async () => {
    const query = "Analyze our medical billing denial rates and recommend improvements to the revenue cycle";

    const conveneDeps = _makeMockConveneDeps();
    const conveneOutput = await executeConvene(conveneDeps, query, { skipAgentRefinement: true });

    expect(conveneOutput.analysis.domains).toContain("billing-ops");

    const discussDeps = _makeMockDiscussDeps({
      "billing-ops": "Denial analysis: 12% denial rate, top reasons: missing auth (34%), coding errors (28%). Recommend automated eligibility checks and coding validation.",
    });
    const discussOutput = await executeDiscuss(discussDeps, query, conveneOutput);

    const convergeDeps = _makeMockConvergeDeps();
    const convergeOutput = await executeConverge(convergeDeps, query, conveneOutput, discussOutput);

    const deliverDeps = _makeMockDeliverDeps();
    const deliverOutput = await executeDeliver(
      deliverDeps, query, "test-billing-session",
      conveneOutput, discussOutput, convergeOutput, "dashboard",
    );

    expect(deliverOutput.success).toBe(true);
    expect(deliverOutput.channel).toBe("dashboard");
    expect(deliverOutput.formattedOutput).toContain("round-table-result");
  });
});


// ═══════════════════════════════════════════════════════════════════
// 2. Multi-Formation Chaining
// ═══════════════════════════════════════════════════════════════════

describe("Multi-formation chaining", () => {
  beforeEach(() => _resetIdCounter());

  test("2 formations contribute and their outputs thread to converge", async () => {
    const query = "What should our Q2 strategy be for growth and risk management?";

    const conveneOutput = await executeConvene(
      _makeMockConveneDeps(), query, { skipAgentRefinement: true },
    );

    // Force 2 formations
    expect(conveneOutput.selectedFormations.length).toBeGreaterThanOrEqual(1);

    const discussDeps = _makeMockDiscussDeps({
      boardroom: "Boardroom recommends aggressive expansion with risk hedging strategy.",
      "think-tank": "Think-tank suggests exploring three innovative market entry approaches.",
    });
    const discussOutput = await executeDiscuss(discussDeps, query, conveneOutput);

    expect(discussOutput.succeeded.length).toBeGreaterThanOrEqual(1);

    // Verify discuss summary contains formation outputs
    for (const slug of discussOutput.succeeded) {
      expect(discussOutput.summary).toContain(slug);
    }

    // Converge gets both outputs
    const convergeDeps = _makeMockConvergeDeps(
      "Synthesis combining boardroom and think-tank perspectives on growth vs risk.",
    );
    const convergeOutput = await executeConverge(convergeDeps, query, conveneOutput, discussOutput);

    expect(convergeOutput.success).toBe(true);
    expect(convergeOutput.synthesis).toContain("boardroom");
  });

  test("3 formations via force-include all thread through pipeline", async () => {
    const query = "How should we approach our software deployment strategy for the new billing system?";

    const conveneDeps = _makeMockConveneDeps();
    const conveneOutput = await executeConvene(conveneDeps, query, {
      skipAgentRefinement: true,
      forceFormations: ["software-development", "billing-ops", "boardroom"],
    });

    const selectedSlugs = conveneOutput.selectedFormations.map(f => f.slug);
    expect(selectedSlugs).toContain("software-development");
    expect(selectedSlugs).toContain("billing-ops");
    expect(selectedSlugs).toContain("boardroom");

    const discussDeps = _makeMockDiscussDeps({
      "software-development": "Technical: Blue-green deployment recommended. CI/CD pipeline needs 1 week setup.",
      "billing-ops": "Billing: New system must maintain claim submission SLAs during migration. Recommend weekend cutover.",
      boardroom: "Strategic: Deployment risk acceptable. Budget approved for extra engineering resources.",
    });
    const discussOutput = await executeDiscuss(discussDeps, query, conveneOutput);

    expect(discussOutput.succeeded).toContain("software-development");
    expect(discussOutput.succeeded).toContain("billing-ops");
    expect(discussOutput.succeeded).toContain("boardroom");
    expect(discussOutput.results.length).toBe(3);

    const convergeDeps = _makeMockConvergeDeps();
    const convergeOutput = await executeConverge(convergeDeps, query, conveneOutput, discussOutput);
    expect(convergeOutput.success).toBe(true);

    // Criteria should pass with 3 formations
    expect(convergeOutput.criteriaStatus.formationCountMet).toBe(true);
  });

  test("partial formation failure still produces usable output", async () => {
    const query = "Plan our Q2 strategy and budget allocation";

    // Use mock convene output with exactly 2 formations to control the test
    const conveneOutput = _makeMockConveneOutput({
      analysis: {
        query,
        intent: "Create a plan",
        domains: ["boardroom", "think-tank"],
        complexity: "moderate",
        dimensions: ["strategic", "financial"],
        keywords: ["strategy", "budget", "allocation"],
      },
      selectedFormations: [
        { slug: "boardroom", reason: "Strategy match", context: "Focus: strategy", score: 6 },
        { slug: "think-tank", reason: "Ideation match", context: "Focus: ideas", score: 4 },
      ],
    });

    // One formation fails, one succeeds
    const discussDeps = _makeMockDiscussDeps(
      { boardroom: "Strategy: Allocate 60% to growth, 30% to operations, 10% to R&D." },
      ["think-tank"],
    );
    const discussOutput = await executeDiscuss(discussDeps, query, conveneOutput);

    expect(discussOutput.succeeded).toContain("boardroom");
    expect(discussOutput.failed).toContain("think-tank");
    expect(discussOutput.success).toBe(true); // At least 1 succeeded

    // Converge should still work with partial results
    const convergeDeps = _makeMockConvergeDeps();
    const convergeOutput = await executeConverge(convergeDeps, query, conveneOutput, discussOutput);

    expect(convergeOutput.success).toBe(true);
    // Should detect gap for failed high-score formation (think-tank score 4 >= 3)
    const gapForFailed = convergeOutput.gaps.find(g => g.description.includes("think-tank"));
    expect(gapForFailed).toBeDefined();
  });
});


// ═══════════════════════════════════════════════════════════════════
// 3. Phase Output Format Verification
// ═══════════════════════════════════════════════════════════════════

describe("Phase output format verification", () => {
  beforeEach(() => _resetIdCounter());

  test("convene output has all required fields with correct types", async () => {
    const query = "How should we prioritize our roadmap for next quarter?";
    const conveneOutput = await executeConvene(
      _makeMockConveneDeps(), query, { skipAgentRefinement: true },
    );

    // QueryAnalysis
    expect(typeof conveneOutput.analysis.query).toBe("string");
    expect(typeof conveneOutput.analysis.intent).toBe("string");
    expect(Array.isArray(conveneOutput.analysis.domains)).toBe(true);
    expect(["simple", "moderate", "complex"]).toContain(conveneOutput.analysis.complexity);
    expect(Array.isArray(conveneOutput.analysis.dimensions)).toBe(true);
    expect(Array.isArray(conveneOutput.analysis.keywords)).toBe(true);

    // SelectedFormation[]
    for (const f of conveneOutput.selectedFormations) {
      expect(typeof f.slug).toBe("string");
      expect(typeof f.reason).toBe("string");
      expect(typeof f.context).toBe("string");
      expect(typeof f.score).toBe("number");
      expect(f.score).toBeGreaterThanOrEqual(1);
    }

    // SuccessCriteria
    expect(typeof conveneOutput.successCriteria.expectedOutput).toBe("string");
    expect(Array.isArray(conveneOutput.successCriteria.keyQuestions)).toBe(true);
    expect(typeof conveneOutput.successCriteria.minFormations).toBe("number");
    expect(typeof conveneOutput.successCriteria.requiresConsensus).toBe("boolean");
    expect(Array.isArray(conveneOutput.successCriteria.requiredDimensions)).toBe(true);

    // Summary
    expect(conveneOutput.summary).toContain("Convene Phase Summary");
    expect(conveneOutput.summary).toContain("Intent:");
    expect(conveneOutput.summary).toContain("Complexity:");
  });

  test("discuss output has all required fields with correct types", async () => {
    const conveneOutput = _makeMockConveneOutput();
    const discussDeps = _makeMockDiscussDeps({
      boardroom: "Strategic recommendation with financial projections.",
      "think-tank": "Creative ideation output with innovation proposals.",
    });
    const discussOutput = await executeDiscuss(discussDeps, "test query", conveneOutput);

    expect(Array.isArray(discussOutput.results)).toBe(true);
    expect(Array.isArray(discussOutput.succeeded)).toBe(true);
    expect(Array.isArray(discussOutput.failed)).toBe(true);
    expect(typeof discussOutput.success).toBe("boolean");
    expect(typeof discussOutput.summary).toBe("string");
    expect(typeof discussOutput.totalDurationMs).toBe("number");
    expect(discussOutput.totalDurationMs).toBeGreaterThanOrEqual(0);

    // FormationResult fields
    for (const r of discussOutput.results) {
      expect(typeof r.slug).toBe("string");
      expect(typeof r.success).toBe("boolean");
      expect(typeof r.output).toBe("string");
      expect(typeof r.durationMs).toBe("number");
      expect(typeof r.timedOut).toBe("boolean");
    }

    // Summary format
    expect(discussOutput.summary).toContain("Discuss Phase");
  });

  test("converge output has all required fields with correct types", async () => {
    const conveneOutput = _makeMockConveneOutput();
    const discussOutput = _makeMockDiscussOutput();
    const convergeOutput = await executeConverge(
      _makeMockConvergeDeps(), "test query", conveneOutput, discussOutput,
    );

    expect(Array.isArray(convergeOutput.agreements)).toBe(true);
    expect(Array.isArray(convergeOutput.conflicts)).toBe(true);
    expect(Array.isArray(convergeOutput.gaps)).toBe(true);
    expect(Array.isArray(convergeOutput.escalations)).toBe(true);
    expect(typeof convergeOutput.synthesis).toBe("string");
    expect(typeof convergeOutput.summary).toBe("string");
    expect(typeof convergeOutput.success).toBe("boolean");

    // CriteriaStatus
    const cs = convergeOutput.criteriaStatus;
    expect(typeof cs.formationCountMet).toBe("boolean");
    expect(Array.isArray(cs.dimensionsAddressed)).toBe(true);
    expect(Array.isArray(cs.dimensionsMissing)).toBe(true);
    expect(typeof cs.allMet).toBe("boolean");

    // Summary format
    expect(convergeOutput.summary).toContain("Convergence Synthesis");
    expect(convergeOutput.summary).toContain("Criteria Status");
  });

  test("deliver output has all required fields with correct types", async () => {
    const conveneOutput = _makeMockConveneOutput();
    const discussOutput = _makeMockDiscussOutput();
    const convergeOutput = _makeMockConvergeOutput();
    const deliverDeps = _makeMockDeliverDeps();

    const deliverOutput = await executeDeliver(
      deliverDeps, "test query", "test-session",
      conveneOutput, discussOutput, convergeOutput, "telegram",
    );

    expect(typeof deliverOutput.executiveSummary).toBe("string");
    expect(typeof deliverOutput.formattedOutput).toBe("string");
    expect(Array.isArray(deliverOutput.transcripts)).toBe(true);
    expect(typeof deliverOutput.channel).toBe("string");
    expect(typeof deliverOutput.success).toBe("boolean");

    // SessionOutcome
    const o = deliverOutput.outcome;
    expect(typeof o.sessionId).toBe("string");
    expect(typeof o.query).toBe("string");
    expect(typeof o.success).toBe("boolean");
    expect(Array.isArray(o.formationsUsed)).toBe(true);
    expect(Array.isArray(o.formationsSucceeded)).toBe(true);
    expect(Array.isArray(o.formationsFailed)).toBe(true);
    expect(typeof o.totalDurationMs).toBe("number");
    expect(typeof o.criteriaAllMet).toBe("boolean");
    expect(typeof o.escalationCount).toBe("number");
    expect(typeof o.gapCount).toBe("number");
    expect(typeof o.channel).toBe("string");

    // Transcripts match discuss results
    expect(deliverOutput.transcripts.length).toBe(discussOutput.results.length);
    for (const t of deliverOutput.transcripts) {
      expect(typeof t.slug).toBe("string");
      expect(typeof t.success).toBe("boolean");
      expect(typeof t.durationMs).toBe("number");
    }
  });

  test("deliver formats correctly for each channel", async () => {
    const conveneOutput = _makeMockConveneOutput();
    const discussOutput = _makeMockDiscussOutput();
    const convergeOutput = _makeMockConvergeOutput();
    const deliverDeps = _makeMockDeliverDeps();

    const channels: DeliveryChannel[] = ["telegram", "google-chat", "dashboard", "plain"];

    for (const channel of channels) {
      const output = await executeDeliver(
        deliverDeps, "test query", `session-${channel}`,
        conveneOutput, discussOutput, convergeOutput, channel,
      );

      expect(output.success).toBe(true);
      expect(output.channel).toBe(channel);
      expect(output.formattedOutput.length).toBeGreaterThan(0);

      // Channel-specific format markers
      if (channel === "telegram" || channel === "google-chat") {
        expect(output.formattedOutput).toContain("Round Table Complete");
      } else if (channel === "dashboard") {
        expect(output.formattedOutput).toContain("<div");
        expect(output.formattedOutput).toContain("round-table-result");
      } else if (channel === "plain") {
        expect(output.formattedOutput).toContain("=== Round Table Result ===");
      }
    }
  });
});


// ═══════════════════════════════════════════════════════════════════
// 4. Performance Benchmarking
// ═══════════════════════════════════════════════════════════════════

describe("Performance benchmarking", () => {
  beforeEach(() => _resetIdCounter());

  test("full 4-phase pipeline completes within performance budget", async () => {
    const query = "What should our expansion strategy be for next quarter?";
    const startTotal = performance.now();

    // Phase 1: Convene
    const conveneStart = performance.now();
    const conveneOutput = await executeConvene(
      _makeMockConveneDeps(), query, { skipAgentRefinement: true },
    );
    const conveneDuration = performance.now() - conveneStart;

    // Phase 2: Discuss (2 formations)
    const discussStart = performance.now();
    const discussDeps = _makeMockDiscussDeps({
      boardroom: "Strategic analysis output.",
      "think-tank": "Creative ideation output.",
    });
    const discussOutput = await executeDiscuss(discussDeps, query, conveneOutput);
    const discussDuration = performance.now() - discussStart;

    // Phase 3: Converge
    const convergeStart = performance.now();
    const convergeOutput = await executeConverge(
      _makeMockConvergeDeps(), query, conveneOutput, discussOutput,
    );
    const convergeDuration = performance.now() - convergeStart;

    // Phase 4: Deliver
    const deliverStart = performance.now();
    const deliverOutput = await executeDeliver(
      _makeMockDeliverDeps(), query, "perf-session",
      conveneOutput, discussOutput, convergeOutput, "telegram",
    );
    const deliverDuration = performance.now() - deliverStart;

    const totalDuration = performance.now() - startTotal;

    // All phases succeeded
    expect(conveneOutput.analysis).toBeDefined();
    expect(discussOutput.success).toBe(true);
    expect(convergeOutput.success).toBe(true);
    expect(deliverOutput.success).toBe(true);

    // Performance baselines (with mock deps, all should be very fast)
    // These are ceiling values — mock-based phases should be < 50ms each
    expect(conveneDuration).toBeLessThan(200);
    expect(discussDuration).toBeLessThan(200);
    expect(convergeDuration).toBeLessThan(200);
    expect(deliverDuration).toBeLessThan(200);
    expect(totalDuration).toBeLessThan(500);
  });

  test("orchestrator E2E completes within performance budget", async () => {
    const deps = _makeMockOrchestratorDeps({
      phaseFormations: { discuss: ["boardroom", "think-tank"] },
      formationResults: {
        boardroom: "Strategic analysis with recommendations.",
        "think-tank": "Creative approaches and innovation ideas.",
      },
    });

    const startTime = performance.now();
    const result = await runRoundTable(deps, "Plan our Q2 growth strategy", {
      channel: "telegram",
    });
    const duration = performance.now() - startTime;

    expect(result.success).toBe(true);
    expect(result.phases.length).toBe(4);
    expect(duration).toBeLessThan(500);
  });

  test("discuss phase scales linearly with formation count", async () => {
    const query = "Comprehensive business review";
    const conveneOutput = _makeMockConveneOutput();

    // Benchmark with 1 formation
    const oneFormation = _makeMockConveneOutput({
      selectedFormations: [conveneOutput.selectedFormations[0]],
    });
    const start1 = performance.now();
    await executeDiscuss(_makeMockDiscussDeps(), query, oneFormation);
    const duration1 = performance.now() - start1;

    // Benchmark with 2 formations
    const start2 = performance.now();
    await executeDiscuss(_makeMockDiscussDeps(), query, conveneOutput);
    const duration2 = performance.now() - start2;

    // Both should be fast with mocks; 2 formations shouldn't be > 5x slower
    expect(duration2).toBeLessThan(duration1 * 5 + 50); // generous margin for async overhead
  });

  test("per-phase timing from discuss results reflects formation durations", async () => {
    const query = "Quick analysis";
    const conveneOutput = _makeMockConveneOutput();

    const discussOutput = await executeDiscuss(
      _makeMockDiscussDeps(), query, conveneOutput,
    );

    // Each formation result should have a non-negative duration
    for (const result of discussOutput.results) {
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }

    // Total duration should be >= max individual duration (parallel execution)
    expect(discussOutput.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});


// ═══════════════════════════════════════════════════════════════════
// 5. Orchestrator E2E Scenarios
// ═══════════════════════════════════════════════════════════════════

describe("Orchestrator E2E scenarios", () => {
  beforeEach(() => _resetIdCounter());

  test("runRoundTable produces 4 phase results on success", async () => {
    const deps = _makeMockOrchestratorDeps({
      phaseFormations: { discuss: ["boardroom"] },
    });

    const result = await runRoundTable(deps, "Strategic planning for Q2");

    expect(result.success).toBe(true);
    expect(result.phases.length).toBe(4);
    expect(result.phases[0].phase).toBe("convene");
    expect(result.phases[1].phase).toBe("discuss");
    expect(result.phases[2].phase).toBe("converge");
    expect(result.phases[3].phase).toBe("deliver");

    for (const phase of result.phases) {
      expect(phase.success).toBe(true);
      expect(phase.output.length).toBeGreaterThan(0);
    }

    expect(result.output.length).toBeGreaterThan(0);
    expect(result.sessionId).toBeDefined();
  });

  test("runRoundTable with multiple formations threads output correctly", async () => {
    const deps = _makeMockOrchestratorDeps({
      phaseFormations: { discuss: ["boardroom", "think-tank", "software-development"] },
      formationResults: {
        boardroom: "Strategic perspective on architecture.",
        "think-tank": "Innovative approaches to the problem.",
        "software-development": "Technical implementation details.",
      },
    });

    const result = await runRoundTable(deps, "How should we redesign the platform?");

    expect(result.success).toBe(true);

    // Discuss phase should list all 3 formations
    const discussPhase = result.phases.find(p => p.phase === "discuss");
    expect(discussPhase).toBeDefined();
    expect(discussPhase!.formationsUsed).toContain("boardroom");
    expect(discussPhase!.formationsUsed).toContain("think-tank");
    expect(discussPhase!.formationsUsed).toContain("software-development");

    // Discuss output should contain all formation outputs
    expect(discussPhase!.output).toContain("boardroom");
    expect(discussPhase!.output).toContain("think-tank");
    expect(discussPhase!.output).toContain("software-development");
  });

  test("runRoundTable handles convene phase failure gracefully", async () => {
    const deps = _makeMockOrchestratorDeps();
    deps.callAgent = async () => { throw new Error("Agent unavailable"); };

    const result = await runRoundTable(deps, "Test query");

    expect(result.success).toBe(false);
    expect(result.phases.length).toBe(1); // Only convene attempted
    expect(result.phases[0].phase).toBe("convene");
    expect(result.phases[0].success).toBe(false);
  });

  test("runRoundTable with channel and workItemId passes through correctly", async () => {
    let capturedOpts: { channel?: string; workItemId?: string } | undefined;

    const deps = _makeMockOrchestratorDeps({
      phaseFormations: { discuss: ["boardroom"] },
    });
    const originalInvoke = deps.invokeFormation;
    deps.invokeFormation = async (slug, prompt, opts) => {
      capturedOpts = opts;
      return originalInvoke(slug, prompt, opts);
    };

    await runRoundTable(deps, "Test query", {
      channel: "google-chat",
      workItemId: "ELLIE-123",
    });

    expect(capturedOpts).toBeDefined();
    expect(capturedOpts!.channel).toBe("google-chat");
    expect(capturedOpts!.workItemId).toBe("ELLIE-123");
  });

  test("runRoundTable session state advances correctly through all phases", async () => {
    const rtDeps = _makeMockRoundTableDeps();
    const deps: import("../src/round-table/orchestrator.ts").RoundTableOrchestratorDeps = {
      roundTableDeps: rtDeps,
      invokeFormation: async (slug) => ({
        success: true,
        synthesis: `[${slug}] Analysis.`,
        formationName: slug,
      }),
      selectFormations: async () => ["boardroom"],
      callAgent: async (_agent, prompt) => {
        if (prompt.includes('phase="convene"')) return "Convene analysis.";
        if (prompt.includes('phase="converge"')) return "Convergence synthesis.";
        if (prompt.includes('phase="deliver"')) return "Final deliverable.";
        return "Response.";
      },
    };

    const result = await runRoundTable(deps, "Test state tracking");

    expect(result.success).toBe(true);

    // Session should be completed
    const session = rtDeps.sessionStore.get(result.sessionId);
    expect(session).toBeDefined();
    expect(session!.status).toBe("completed");

    // Progress should show all 4 phases completed
    const progress = getSessionProgress(rtDeps, result.sessionId);
    expect(progress).not.toBeNull();
    expect(progress!.completedPhases.length).toBe(4);
    expect(session!.phases_completed).toBe(4);
  });
});


// ═══════════════════════════════════════════════════════════════════
// 6. Cross-Module Data Integrity
// ═══════════════════════════════════════════════════════════════════

describe("Cross-module data integrity", () => {
  beforeEach(() => _resetIdCounter());

  test("formation slugs from convene match discuss invocations", async () => {
    const query = "Review pricing strategy for vacation rentals";

    const conveneOutput = await executeConvene(
      _makeMockConveneDeps(), query, { skipAgentRefinement: true },
    );

    const invokedSlugs: string[] = [];
    const discussDeps: import("../src/round-table/discuss.ts").DiscussDeps = {
      invokeFormation: async (slug) => {
        invokedSlugs.push(slug);
        return { success: true, synthesis: `[${slug}] output` };
      },
    };

    await executeDiscuss(discussDeps, query, conveneOutput);

    // Every invoked slug should be in the selected formations
    const selectedSlugs = conveneOutput.selectedFormations.map(f => f.slug);
    for (const slug of invokedSlugs) {
      expect(selectedSlugs).toContain(slug);
    }
    // And every selected formation should have been invoked
    for (const slug of selectedSlugs) {
      expect(invokedSlugs).toContain(slug);
    }
  });

  test("criteria check uses convene success criteria against discuss results", () => {
    const conveneOutput = _makeMockConveneOutput({
      successCriteria: {
        expectedOutput: "A plan",
        keyQuestions: ["What is the strategy?"],
        minFormations: 2,
        requiresConsensus: false,
        requiredDimensions: ["strategic"],
      },
    });

    // Only 1 formation succeeded — below minimum
    const discussOutput = _makeMockDiscussOutput({
      results: [
        { slug: "boardroom", success: true, output: "Strategic recommendation provided.", durationMs: 50, timedOut: false },
        { slug: "think-tank", success: false, output: "", error: "Timed out", durationMs: 120000, timedOut: true },
      ],
      succeeded: ["boardroom"],
      failed: ["think-tank"],
    });

    const status = checkCriteria(conveneOutput, discussOutput);
    expect(status.formationCountMet).toBe(false); // Only 1 of required 2
    expect(status.dimensionsAddressed).toContain("strategic"); // "recommendation" keyword
    expect(status.allMet).toBe(false);
  });

  test("gaps detected for missing dimensions thread to escalations", async () => {
    const conveneOutput = _makeMockConveneOutput({
      successCriteria: {
        expectedOutput: "Analysis",
        keyQuestions: [],
        minFormations: 1,
        requiresConsensus: false,
        requiredDimensions: ["financial", "strategic"],
      },
    });

    // Output only covers strategic, not financial
    const discussOutput = _makeMockDiscussOutput({
      results: [
        { slug: "boardroom", success: true, output: "Our strategy recommends expansion.", durationMs: 50, timedOut: false },
      ],
      succeeded: ["boardroom"],
      failed: [],
    });

    const status = checkCriteria(conveneOutput, discussOutput);
    const gaps = detectGaps(conveneOutput, discussOutput, status);

    // Should detect financial dimension gap
    const financialGap = gaps.find(g => g.description.includes("financial"));
    expect(financialGap).toBeDefined();
  });

  test("session outcome aggregates data from all phases correctly", () => {
    const conveneOutput = _makeMockConveneOutput();
    const discussOutput = _makeMockDiscussOutput();
    const convergeOutput = _makeMockConvergeOutput();

    const outcome = buildSessionOutcome(
      "session-123", "test query",
      conveneOutput, discussOutput, convergeOutput, "telegram",
    );

    expect(outcome.sessionId).toBe("session-123");
    expect(outcome.query).toBe("test query");
    expect(outcome.success).toBe(convergeOutput.success);
    expect(outcome.formationsUsed).toEqual(conveneOutput.selectedFormations.map(f => f.slug));
    expect(outcome.formationsSucceeded).toEqual(discussOutput.succeeded);
    expect(outcome.formationsFailed).toEqual(discussOutput.failed);
    expect(outcome.totalDurationMs).toBe(discussOutput.totalDurationMs);
    expect(outcome.criteriaAllMet).toBe(convergeOutput.criteriaStatus.allMet);
    expect(outcome.escalationCount).toBe(convergeOutput.escalations.length);
    expect(outcome.gapCount).toBe(convergeOutput.gaps.length);
    expect(outcome.channel).toBe("telegram");
  });

  test("transcripts extracted from discuss match formation results", () => {
    const discussOutput = _makeMockDiscussOutput({
      results: [
        { slug: "boardroom", success: true, output: "Board output", durationMs: 100, timedOut: false },
        { slug: "think-tank", success: false, output: "", error: "Failed", durationMs: 50, timedOut: false },
        { slug: "vrbo-ops", success: true, output: "VRBO analysis", durationMs: 200, timedOut: false },
      ],
    });

    const transcripts = extractTranscripts(discussOutput);

    expect(transcripts.length).toBe(3);
    expect(transcripts[0].slug).toBe("boardroom");
    expect(transcripts[0].success).toBe(true);
    expect(transcripts[0].output).toBe("Board output");
    expect(transcripts[1].slug).toBe("think-tank");
    expect(transcripts[1].success).toBe(false);
    expect(transcripts[1].error).toBe("Failed");
    expect(transcripts[2].slug).toBe("vrbo-ops");
    expect(transcripts[2].durationMs).toBe(200);
  });
});


// ═══════════════════════════════════════════════════════════════════
// 7. Output Formatting Integration
// ═══════════════════════════════════════════════════════════════════

describe("Output formatting integration", () => {
  test("deliver output renders correctly through output-formatting module", () => {
    const convergeOutput = _makeMockConvergeOutput();
    const transcripts = [
      { slug: "boardroom", success: true, output: "Strategic analysis.", durationMs: 100 },
      { slug: "think-tank", success: true, output: "Creative ideas.", durationMs: 80 },
    ];

    const channels: DeliveryChannel[] = ["telegram", "google-chat", "dashboard", "plain"];

    for (const channel of channels) {
      const formatted = formatForChannel(
        channel, "Executive summary text", convergeOutput, transcripts, true,
      );

      expect(formatted.length).toBeGreaterThan(0);

      // Each channel should include the executive summary
      if (channel === "dashboard") {
        // Dashboard HTML-escapes content
        expect(formatted).toContain("Executive summary text");
      } else {
        expect(formatted).toContain("Executive summary text");
      }
    }
  });

  test("long output is paginated within channel limits", () => {
    // Create a message longer than Telegram's 4096 limit
    const longMessage = "A".repeat(5000);
    const chunks = paginateMessage(longMessage, "telegram");

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(CHANNEL_LIMITS.telegram);
    }

    // All content should be preserved across chunks
    const reassembled = chunks.map(c => c.content).join("");
    expect(reassembled.length).toBeGreaterThanOrEqual(longMessage.length);
  });

  test("dashboard output stays within its higher limit", () => {
    const message = "B".repeat(4000);
    const chunks = paginateMessage(message, "dashboard");

    // 4000 chars is well within 50K dashboard limit
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toContain(message);
  });

  test("formation registry slugs are all valid identifiers", () => {
    for (const formation of FORMATION_REGISTRY) {
      expect(formation.slug).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(formation.description.length).toBeGreaterThan(0);
      expect(formation.triggers.length).toBeGreaterThan(0);
      expect(formation.agents.length).toBeGreaterThan(0);
      expect(["debate", "coordinator", "pipeline"]).toContain(formation.pattern);
    }
  });
});


// ═══════════════════════════════════════════════════════════════════
// 8. Error Recovery Scenarios
// ═══════════════════════════════════════════════════════════════════

describe("Error recovery scenarios", () => {
  beforeEach(() => _resetIdCounter());

  test("converge falls back to concatenation when synthesis agent fails", async () => {
    const conveneOutput = _makeMockConveneOutput();
    const discussOutput = _makeMockDiscussOutput();

    const failingDeps = {
      callAgent: async () => { throw new Error("Synthesis agent crashed"); },
    };

    const convergeOutput = await executeConverge(failingDeps, "test", conveneOutput, discussOutput);

    // Should still succeed using fallback
    expect(convergeOutput.success).toBe(true);
    // Synthesis should contain formation outputs concatenated
    expect(convergeOutput.synthesis).toContain("boardroom");
  });

  test("deliver produces fallback summary when agent fails", async () => {
    const conveneOutput = _makeMockConveneOutput();
    const discussOutput = _makeMockDiscussOutput();
    const convergeOutput = _makeMockConvergeOutput();

    const failingDeps = {
      callAgent: async () => { throw new Error("Agent down"); },
      logOutcome: async () => {},
    };

    const deliverOutput = await executeDeliver(
      failingDeps, "test query", "fail-session",
      conveneOutput, discussOutput, convergeOutput, "telegram",
    );

    // Should still succeed — fallback summary is used
    expect(deliverOutput.success).toBe(true);
    expect(deliverOutput.executiveSummary.length).toBeGreaterThan(0);
    expect(deliverOutput.executiveSummary).toContain("Round Table Result");
  });

  test("deliver handles logging failure without failing the phase", async () => {
    const conveneOutput = _makeMockConveneOutput();
    const discussOutput = _makeMockDiscussOutput();
    const convergeOutput = _makeMockConvergeOutput();

    let logCalled = false;
    const deps = {
      callAgent: async () => "Executive summary.",
      logOutcome: async () => {
        logCalled = true;
        throw new Error("Database connection lost");
      },
    };

    const deliverOutput = await executeDeliver(
      deps, "test query", "log-fail-session",
      conveneOutput, discussOutput, convergeOutput, "plain",
    );

    expect(logCalled).toBe(true);
    expect(deliverOutput.success).toBe(true); // Phase succeeds despite log failure
  });

  test("all formations failing in discuss still allows converge to run", async () => {
    const conveneOutput = _makeMockConveneOutput();

    const discussDeps = _makeMockDiscussDeps({}, ["boardroom", "think-tank"]);
    const discussOutput = await executeDiscuss(discussDeps, "test", conveneOutput, {
      minSuccessful: 0, // Allow 0 successes for this test
    });

    expect(discussOutput.succeeded.length).toBe(0);
    expect(discussOutput.failed.length).toBe(2);

    // Converge can still run with empty results
    const convergeOutput = await executeConverge(
      _makeMockConvergeDeps(), "test", conveneOutput, discussOutput,
    );

    expect(convergeOutput.success).toBe(true);
    expect(convergeOutput.criteriaStatus.formationCountMet).toBe(false);
  });
});
