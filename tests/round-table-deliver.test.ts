/**
 * Tests for Round Table: Deliver Phase — ELLIE-700
 */
import { describe, expect, test, beforeEach } from "bun:test";
import {
  buildSummaryPrompt,
  buildFallbackSummary,
  extractTranscripts,
  formatForTelegram,
  formatForDashboard,
  formatForPlain,
  formatForChannel,
  buildSessionOutcome,
  executeDeliver,
  _makeMockDeliverDeps,
  _makeMockDeliverDepsWithAgentFailure,
  _makeMockDeliverOutput,
  type DeliverOutput,
  type SessionOutcome,
  type FormationTranscript,
} from "../src/round-table/deliver.ts";
import { _makeMockConveneOutput } from "../src/round-table/convene.ts";
import { _makeMockDiscussOutput } from "../src/round-table/discuss.ts";
import { _makeMockConvergeOutput } from "../src/round-table/converge.ts";

// ── Summary Prompt Building ─────────────────────────────────────

describe("buildSummaryPrompt", () => {
  test("includes original query", () => {
    const converge = _makeMockConvergeOutput();
    const prompt = buildSummaryPrompt("What should we do about Q2?", converge);
    expect(prompt).toContain("What should we do about Q2?");
  });

  test("includes convergence synthesis", () => {
    const converge = _makeMockConvergeOutput({
      synthesis: "We recommend balanced expansion.",
    });
    const prompt = buildSummaryPrompt("Q2 strategy", converge);
    expect(prompt).toContain("We recommend balanced expansion.");
  });

  test("includes agreements section", () => {
    const converge = _makeMockConvergeOutput({
      agreements: [
        { point: "Expansion is viable", supporters: ["boardroom"], confidence: "strong" },
      ],
    });
    const prompt = buildSummaryPrompt("test", converge);
    expect(prompt).toContain("Expansion is viable");
    expect(prompt).toContain("strong");
  });

  test("shows 'None identified' when no agreements", () => {
    const converge = _makeMockConvergeOutput({ agreements: [] });
    const prompt = buildSummaryPrompt("test", converge);
    expect(prompt).toContain("None identified");
  });

  test("includes conflicts section", () => {
    const converge = _makeMockConvergeOutput({
      conflicts: [
        { point: "Timing disagreement", positions: [], needsEscalation: false, resolution: "Go with Q2" },
      ],
    });
    const prompt = buildSummaryPrompt("test", converge);
    expect(prompt).toContain("Timing disagreement");
    expect(prompt).toContain("Go with Q2");
  });

  test("includes gaps and escalations", () => {
    const converge = _makeMockConvergeOutput({
      gaps: [{ description: "Financial gap", suggestedFormations: [], severity: "critical" }],
      escalations: ["Budget approval needed"],
    });
    const prompt = buildSummaryPrompt("test", converge);
    expect(prompt).toContain("Financial gap");
    expect(prompt).toContain("Budget approval needed");
  });

  test("includes criteria-met status", () => {
    const converge = _makeMockConvergeOutput();
    const prompt = buildSummaryPrompt("test", converge);
    expect(prompt).toContain("<criteria-met>true</criteria-met>");
  });

  test("includes deliver phase instructions", () => {
    const converge = _makeMockConvergeOutput();
    const prompt = buildSummaryPrompt("test", converge);
    expect(prompt).toContain("executive summary");
    expect(prompt).toContain("action items");
  });
});

// ── Fallback Summary ────────────────────────────────────────────

describe("buildFallbackSummary", () => {
  test("includes query in header", () => {
    const converge = _makeMockConvergeOutput();
    const summary = buildFallbackSummary("Q2 strategy?", converge);
    expect(summary).toContain("Q2 strategy?");
  });

  test("includes synthesis content", () => {
    const converge = _makeMockConvergeOutput({
      synthesis: "We should expand into APAC.",
    });
    const summary = buildFallbackSummary("test", converge);
    expect(summary).toContain("We should expand into APAC.");
  });

  test("truncates long synthesis to ~500 chars", () => {
    const longText = "A".repeat(600);
    const converge = _makeMockConvergeOutput({ synthesis: longText });
    const summary = buildFallbackSummary("test", converge);
    expect(summary).toContain("...");
    // Should be truncated to 500 chars area
    expect(summary.length).toBeLessThan(700);
  });

  test("includes agreements when present", () => {
    const converge = _makeMockConvergeOutput({
      agreements: [
        { point: "Growth is needed", supporters: ["a"], confidence: "strong" },
      ],
    });
    const summary = buildFallbackSummary("test", converge);
    expect(summary).toContain("Key agreements");
    expect(summary).toContain("Growth is needed");
  });

  test("includes escalations when present", () => {
    const converge = _makeMockConvergeOutput({
      escalations: ["Legal review needed"],
    });
    const summary = buildFallbackSummary("test", converge);
    expect(summary).toContain("Needs attention");
    expect(summary).toContain("Legal review needed");
  });

  test("notes when criteria not met", () => {
    const converge = _makeMockConvergeOutput({
      criteriaStatus: {
        formationCountMet: true,
        dimensionsAddressed: [],
        dimensionsMissing: ["financial"],
        consensusReached: null,
        allMet: false,
      },
    });
    const summary = buildFallbackSummary("test", converge);
    expect(summary).toContain("Not all success criteria were met");
  });
});

// ── Transcript Extraction ───────────────────────────────────────

describe("extractTranscripts", () => {
  test("extracts transcripts from discuss output", () => {
    const discuss = _makeMockDiscussOutput();
    const transcripts = extractTranscripts(discuss);
    expect(transcripts).toHaveLength(2);
    expect(transcripts[0].slug).toBe("boardroom");
    expect(transcripts[0].success).toBe(true);
    expect(transcripts[0].durationMs).toBe(100);
  });

  test("includes failed formations with errors", () => {
    const discuss = _makeMockDiscussOutput({
      results: [
        { slug: "ok", success: true, output: "Good.", durationMs: 50, timedOut: false },
        { slug: "bad", success: false, output: "", error: "Crashed", durationMs: 10, timedOut: false },
      ],
    });
    const transcripts = extractTranscripts(discuss);
    expect(transcripts).toHaveLength(2);
    expect(transcripts[1].success).toBe(false);
    expect(transcripts[1].error).toBe("Crashed");
  });

  test("handles empty results", () => {
    const discuss = _makeMockDiscussOutput({ results: [] });
    const transcripts = extractTranscripts(discuss);
    expect(transcripts).toHaveLength(0);
  });
});

// ── Channel Formatting: Telegram ────────────────────────────────

describe("formatForTelegram", () => {
  const converge = _makeMockConvergeOutput();
  const transcripts: FormationTranscript[] = [
    { slug: "boardroom", success: true, output: "Analysis.", durationMs: 100 },
  ];

  test("includes Round Table Complete header", () => {
    const output = formatForTelegram("Summary here", converge, transcripts, true);
    expect(output).toContain("Round Table Complete");
  });

  test("includes executive summary", () => {
    const output = formatForTelegram("My summary text", converge, transcripts, true);
    expect(output).toContain("My summary text");
  });

  test("includes escalations when present", () => {
    const conv = _makeMockConvergeOutput({ escalations: ["Budget issue"] });
    const output = formatForTelegram("Summary", conv, transcripts, true);
    expect(output).toContain("Escalations");
    expect(output).toContain("Budget issue");
  });

  test("includes formation details when transcripts enabled", () => {
    const output = formatForTelegram("Summary", converge, transcripts, true);
    expect(output).toContain("boardroom");
    expect(output).toContain("100ms");
  });

  test("omits formation details when transcripts disabled", () => {
    const output = formatForTelegram("Summary", converge, transcripts, false);
    expect(output).not.toContain("Formation Details");
  });

  test("shows criteria status", () => {
    const output = formatForTelegram("Summary", converge, transcripts, true);
    expect(output).toContain("All criteria met");
  });

  test("shows warning when criteria not met", () => {
    const conv = _makeMockConvergeOutput({
      criteriaStatus: { formationCountMet: false, dimensionsAddressed: [], dimensionsMissing: ["x"], consensusReached: null, allMet: false },
    });
    const output = formatForTelegram("Summary", conv, transcripts, true);
    expect(output).toContain("Some criteria not met");
  });
});

// ── Channel Formatting: Dashboard (HTML) ────────────────────────

describe("formatForDashboard", () => {
  const converge = _makeMockConvergeOutput();
  const transcripts: FormationTranscript[] = [
    { slug: "boardroom", success: true, output: "Analysis.", durationMs: 100 },
  ];

  test("wraps in div with class", () => {
    const output = formatForDashboard("Summary", converge, transcripts, true);
    expect(output).toContain('<div class="round-table-result">');
    expect(output).toContain("</div>");
  });

  test("includes h2 header", () => {
    const output = formatForDashboard("Summary", converge, transcripts, true);
    expect(output).toContain("<h2>Round Table Result</h2>");
  });

  test("includes executive summary in div", () => {
    const output = formatForDashboard("My summary", converge, transcripts, true);
    expect(output).toContain("My summary");
    expect(output).toContain("executive-summary");
  });

  test("escapes HTML in summary", () => {
    const output = formatForDashboard("<script>alert(1)</script>", converge, transcripts, true);
    expect(output).toContain("&lt;script&gt;");
    expect(output).not.toContain("<script>");
  });

  test("includes agreements in HTML list", () => {
    const conv = _makeMockConvergeOutput({
      agreements: [{ point: "Growth needed", supporters: ["a", "b"], confidence: "strong" }],
    });
    const output = formatForDashboard("Summary", conv, transcripts, true);
    expect(output).toContain("<h3>Agreements</h3>");
    expect(output).toContain("Growth needed");
  });

  test("includes transcripts in details/summary", () => {
    const output = formatForDashboard("Summary", converge, transcripts, true);
    expect(output).toContain("<details>");
    expect(output).toContain("<summary>View formation details</summary>");
    expect(output).toContain("boardroom");
  });

  test("omits transcripts when disabled", () => {
    const output = formatForDashboard("Summary", converge, transcripts, false);
    expect(output).not.toContain("<details>");
  });

  test("shows criteria status with class", () => {
    const output = formatForDashboard("Summary", converge, transcripts, true);
    expect(output).toContain('class="criteria-status met"');
  });
});

// ── Channel Formatting: Plain Text ──────────────────────────────

describe("formatForPlain", () => {
  const converge = _makeMockConvergeOutput();
  const transcripts: FormationTranscript[] = [
    { slug: "boardroom", success: true, output: "Analysis.", durationMs: 100 },
  ];

  test("includes header", () => {
    const output = formatForPlain("Summary", converge, transcripts, true);
    expect(output).toContain("=== Round Table Result ===");
  });

  test("includes executive summary", () => {
    const output = formatForPlain("My plain summary", converge, transcripts, true);
    expect(output).toContain("My plain summary");
  });

  test("includes escalations when present", () => {
    const conv = _makeMockConvergeOutput({ escalations: ["Needs approval"] });
    const output = formatForPlain("Summary", conv, transcripts, true);
    expect(output).toContain("ESCALATIONS:");
    expect(output).toContain("Needs approval");
  });

  test("includes formation details with status", () => {
    const trs: FormationTranscript[] = [
      { slug: "ok-formation", success: true, output: "OK", durationMs: 50 },
      { slug: "bad-formation", success: false, output: "", error: "Fail", durationMs: 10 },
    ];
    const output = formatForPlain("Summary", converge, trs, true);
    expect(output).toContain("[OK] ok-formation");
    expect(output).toContain("[FAIL] bad-formation");
  });

  test("shows criteria status", () => {
    const output = formatForPlain("Summary", converge, transcripts, true);
    expect(output).toContain("STATUS: All criteria met");
  });
});

// ── formatForChannel routing ────────────────────────────────────

describe("formatForChannel", () => {
  const converge = _makeMockConvergeOutput();
  const transcripts: FormationTranscript[] = [];

  test("routes telegram to Telegram formatter", () => {
    const output = formatForChannel("telegram", "S", converge, transcripts, true);
    expect(output).toContain("Round Table Complete");
  });

  test("routes google-chat to Telegram formatter", () => {
    const output = formatForChannel("google-chat", "S", converge, transcripts, true);
    expect(output).toContain("Round Table Complete");
  });

  test("routes dashboard to HTML formatter", () => {
    const output = formatForChannel("dashboard", "S", converge, transcripts, true);
    expect(output).toContain("<div class=\"round-table-result\">");
  });

  test("routes plain to plain text formatter", () => {
    const output = formatForChannel("plain", "S", converge, transcripts, true);
    expect(output).toContain("=== Round Table Result ===");
  });
});

// ── Session Outcome ─────────────────────────────────────────────

describe("buildSessionOutcome", () => {
  test("builds outcome from phase outputs", () => {
    const convene = _makeMockConveneOutput();
    const discuss = _makeMockDiscussOutput();
    const converge = _makeMockConvergeOutput();

    const outcome = buildSessionOutcome("sess-1", "Q2 strategy", convene, discuss, converge, "telegram");

    expect(outcome.sessionId).toBe("sess-1");
    expect(outcome.query).toBe("Q2 strategy");
    expect(outcome.success).toBe(true);
    expect(outcome.formationsUsed).toEqual(["boardroom", "think-tank"]);
    expect(outcome.formationsSucceeded).toEqual(["boardroom", "think-tank"]);
    expect(outcome.formationsFailed).toEqual([]);
    expect(outcome.criteriaAllMet).toBe(true);
    expect(outcome.channel).toBe("telegram");
  });

  test("includes failure data", () => {
    const convene = _makeMockConveneOutput();
    const discuss = _makeMockDiscussOutput({
      succeeded: ["boardroom"],
      failed: ["think-tank"],
    });
    const converge = _makeMockConvergeOutput({
      escalations: ["A", "B"],
      gaps: [{ description: "gap1", suggestedFormations: [], severity: "critical" }],
    });

    const outcome = buildSessionOutcome("sess-2", "test", convene, discuss, converge, "dashboard");

    expect(outcome.formationsFailed).toEqual(["think-tank"]);
    expect(outcome.escalationCount).toBe(2);
    expect(outcome.gapCount).toBe(1);
    expect(outcome.channel).toBe("dashboard");
  });
});

// ── executeDeliver ──────────────────────────────────────────────

describe("executeDeliver", () => {
  const convene = _makeMockConveneOutput();
  const discuss = _makeMockDiscussOutput();
  const converge = _makeMockConvergeOutput();

  test("succeeds with agent-generated summary", async () => {
    const deps = _makeMockDeliverDeps("Agent summary: expand in Q2.");
    const result = await executeDeliver(deps, "Q2 plan", "sess-1", convene, discuss, converge, "telegram");

    expect(result.success).toBe(true);
    expect(result.executiveSummary).toBe("Agent summary: expand in Q2.");
    expect(result.channel).toBe("telegram");
    expect(result.formattedOutput).toContain("Round Table Complete");
    expect(result.formattedOutput).toContain("Agent summary: expand in Q2.");
  });

  test("falls back to extracted summary when agent fails", async () => {
    const deps = _makeMockDeliverDepsWithAgentFailure();
    const result = await executeDeliver(deps, "Q2 plan", "sess-1", convene, discuss, converge, "telegram");

    expect(result.success).toBe(true);
    expect(result.executiveSummary).toContain("Round Table Result");
    expect(result.executiveSummary).toContain("Q2 plan");
  });

  test("includes formation transcripts", async () => {
    const deps = _makeMockDeliverDeps();
    const result = await executeDeliver(deps, "test", "sess-1", convene, discuss, converge);

    expect(result.transcripts).toHaveLength(2);
    expect(result.transcripts[0].slug).toBe("boardroom");
    expect(result.transcripts[1].slug).toBe("think-tank");
  });

  test("logs session outcome", async () => {
    let loggedOutcome: SessionOutcome | null = null;
    const deps = _makeMockDeliverDeps("Summary", async (outcome) => {
      loggedOutcome = outcome;
    });

    await executeDeliver(deps, "test", "sess-1", convene, discuss, converge, "dashboard");

    expect(loggedOutcome).not.toBeNull();
    expect(loggedOutcome!.sessionId).toBe("sess-1");
    expect(loggedOutcome!.channel).toBe("dashboard");
  });

  test("succeeds even if outcome logging fails", async () => {
    const deps = _makeMockDeliverDeps("Summary", async () => {
      throw new Error("DB down");
    });

    const result = await executeDeliver(deps, "test", "sess-1", convene, discuss, converge);
    expect(result.success).toBe(true);
  });

  test("formats for dashboard channel", async () => {
    const deps = _makeMockDeliverDeps("Dashboard summary");
    const result = await executeDeliver(deps, "test", "sess-1", convene, discuss, converge, "dashboard");

    expect(result.channel).toBe("dashboard");
    expect(result.formattedOutput).toContain("<div class=\"round-table-result\">");
  });

  test("formats for plain channel", async () => {
    const deps = _makeMockDeliverDeps("Plain summary");
    const result = await executeDeliver(deps, "test", "sess-1", convene, discuss, converge, "plain");

    expect(result.channel).toBe("plain");
    expect(result.formattedOutput).toContain("=== Round Table Result ===");
  });

  test("truncates long agent summaries", async () => {
    const longSummary = "X".repeat(3000);
    const deps = _makeMockDeliverDeps(longSummary);
    const result = await executeDeliver(deps, "test", "sess-1", convene, discuss, converge, "telegram", {
      maxSummaryLength: 500,
    });

    expect(result.executiveSummary.length).toBeLessThanOrEqual(500);
    expect(result.executiveSummary.endsWith("...")).toBe(true);
  });

  test("omits transcripts when configured", async () => {
    const deps = _makeMockDeliverDeps("Summary");
    const result = await executeDeliver(
      deps, "test", "sess-1", convene, discuss, converge, "telegram",
      { includeTranscripts: false },
    );

    expect(result.formattedOutput).not.toContain("Formation Details");
  });

  test("builds correct outcome for partial failures", async () => {
    const failedDiscuss = _makeMockDiscussOutput({
      succeeded: ["boardroom"],
      failed: ["think-tank"],
      results: [
        { slug: "boardroom", success: true, output: "OK", durationMs: 50, timedOut: false },
        { slug: "think-tank", success: false, output: "", error: "Timeout", durationMs: 120000, timedOut: true },
      ],
    });
    const failedConverge = _makeMockConvergeOutput({
      escalations: ["think-tank timed out"],
      criteriaStatus: { formationCountMet: false, dimensionsAddressed: [], dimensionsMissing: ["financial"], consensusReached: null, allMet: false },
    });

    const deps = _makeMockDeliverDeps("Partial result");
    const result = await executeDeliver(deps, "test", "sess-1", convene, failedDiscuss, failedConverge, "telegram");

    expect(result.success).toBe(true);
    expect(result.outcome.formationsFailed).toEqual(["think-tank"]);
    expect(result.outcome.escalationCount).toBe(1);
    expect(result.formattedOutput).toContain("Some criteria not met");
  });
});

// ── Mock Helper ─────────────────────────────────────────────────

describe("_makeMockDeliverOutput", () => {
  test("returns valid default output", () => {
    const output = _makeMockDeliverOutput();
    expect(output.success).toBe(true);
    expect(output.channel).toBe("telegram");
    expect(output.transcripts).toHaveLength(2);
    expect(output.outcome.sessionId).toBe("test-session-1");
  });

  test("accepts overrides", () => {
    const output = _makeMockDeliverOutput({
      success: false,
      error: "Something broke",
      channel: "dashboard",
    });
    expect(output.success).toBe(false);
    expect(output.error).toBe("Something broke");
    expect(output.channel).toBe("dashboard");
  });
});
