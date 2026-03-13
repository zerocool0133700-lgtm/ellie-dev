/**
 * Round Table: Discuss Phase Tests — ELLIE-698
 *
 * Tests cover:
 *   - Prompt building (per-formation, includes convene context)
 *   - Parallel execution (multiple formations at once)
 *   - Timeout enforcement
 *   - Graceful degradation (failed formations don't block)
 *   - Result collection and summary formatting
 *   - Configuration (maxConcurrent, minSuccessful)
 *   - Mock helpers
 *   - E2E scenarios (multi-formation success, partial failure, all fail)
 */

import { describe, it, expect } from "bun:test";

import {
  // Prompt building
  buildDiscussFormationPrompt,
  // Phase execution
  executeDiscuss,
  type DiscussOutput,
  type FormationResult,
  // Mock helpers
  _makeMockDiscussDeps,
  _makeMockDiscussDepsWithThrows,
  _makeMockSlowDiscussDeps,
  _makeMockDiscussOutput,
} from "../src/round-table/discuss.ts";

import {
  _makeMockConveneOutput,
  type ConveneOutput,
} from "../src/round-table/convene.ts";

// ── Prompt Building ─────────────────────────────────────────────

describe("discuss — buildDiscussFormationPrompt", () => {
  const convene = _makeMockConveneOutput();

  it("includes the original query", () => {
    const prompt = buildDiscussFormationPrompt("Q2 strategy?", convene, convene.selectedFormations[0]);
    expect(prompt).toContain("Q2 strategy?");
    expect(prompt).toContain('phase="discuss"');
  });

  it("includes convene summary", () => {
    const prompt = buildDiscussFormationPrompt("test", convene, convene.selectedFormations[0]);
    expect(prompt).toContain(convene.summary);
  });

  it("includes formation slug and context", () => {
    const formation = convene.selectedFormations[0]; // boardroom
    const prompt = buildDiscussFormationPrompt("test", convene, formation);
    expect(prompt).toContain(`slug="${formation.slug}"`);
    expect(prompt).toContain(formation.context);
    expect(prompt).toContain(formation.reason);
  });

  it("includes instructions for the formation", () => {
    const prompt = buildDiscussFormationPrompt("test", convene, convene.selectedFormations[0]);
    expect(prompt).toContain("domain perspective");
    expect(prompt).toContain("converge phase");
    expect(prompt).toContain("risks");
  });

  it("builds different prompts for different formations", () => {
    const prompt1 = buildDiscussFormationPrompt("test", convene, convene.selectedFormations[0]);
    const prompt2 = buildDiscussFormationPrompt("test", convene, convene.selectedFormations[1]);
    expect(prompt1).not.toBe(prompt2);
    expect(prompt1).toContain("boardroom");
    expect(prompt2).toContain("think-tank");
  });
});

// ── Parallel Execution ──────────────────────────────────────────

describe("discuss — executeDiscuss (parallel)", () => {
  it("executes all selected formations", async () => {
    const convene = _makeMockConveneOutput();
    const deps = _makeMockDiscussDeps({
      boardroom: "Strategic analysis complete.",
      "think-tank": "Ideas generated.",
    });

    const result = await executeDiscuss(deps, "Q2 strategy", convene);

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.succeeded).toEqual(["boardroom", "think-tank"]);
    expect(result.failed).toHaveLength(0);
  });

  it("runs formations in parallel (not sequential)", async () => {
    const convene = _makeMockConveneOutput();
    const startTimes: number[] = [];

    const deps = {
      invokeFormation: async (slug: string) => {
        startTimes.push(Date.now());
        await new Promise(r => setTimeout(r, 10));
        return { success: true, synthesis: `[${slug}] done` };
      },
    };

    await executeDiscuss(deps, "test", convene);

    // Both formations should start within a few ms of each other
    expect(startTimes).toHaveLength(2);
    expect(Math.abs(startTimes[0] - startTimes[1])).toBeLessThan(20);
  });

  it("returns empty results for no formations", async () => {
    const convene = _makeMockConveneOutput({ selectedFormations: [] });
    const deps = _makeMockDiscussDeps();

    const result = await executeDiscuss(deps, "test", convene);

    expect(result.success).toBe(false);
    expect(result.results).toHaveLength(0);
    expect(result.summary).toContain("No formations");
  });
});

// ── Timeout Enforcement ─────────────────────────────────────────

describe("discuss — timeout enforcement", () => {
  it("times out slow formations", async () => {
    const convene = _makeMockConveneOutput({
      selectedFormations: [
        { slug: "slow-one", reason: "test", context: "test", score: 5 },
      ],
    });
    const deps = _makeMockSlowDiscussDeps(500); // 500ms delay

    const result = await executeDiscuss(deps, "test", convene, {
      formationTimeoutMs: 50, // 50ms timeout
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].timedOut).toBe(true);
    expect(result.results[0].error).toContain("timed out");
  }, 5000);

  it("fast formations complete before timeout", async () => {
    const convene = _makeMockConveneOutput();
    const deps = _makeMockDiscussDeps({
      boardroom: "Fast result",
      "think-tank": "Also fast",
    });

    const result = await executeDiscuss(deps, "test", convene, {
      formationTimeoutMs: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.results.every(r => !r.timedOut)).toBe(true);
  });
});

// ── Graceful Degradation ────────────────────────────────────────

describe("discuss — graceful degradation", () => {
  it("succeeds with partial results when some formations fail", async () => {
    const convene = _makeMockConveneOutput({
      selectedFormations: [
        { slug: "good", reason: "test", context: "test", score: 5 },
        { slug: "bad", reason: "test", context: "test", score: 3 },
      ],
    });
    const deps = _makeMockDiscussDeps({ good: "Good analysis" }, ["bad"]);

    const result = await executeDiscuss(deps, "test", convene);

    expect(result.success).toBe(true);
    expect(result.succeeded).toEqual(["good"]);
    expect(result.failed).toEqual(["bad"]);
    expect(result.results).toHaveLength(2);
  });

  it("handles formation crashes gracefully", async () => {
    const convene = _makeMockConveneOutput({
      selectedFormations: [
        { slug: "stable", reason: "test", context: "test", score: 5 },
        { slug: "crashy", reason: "test", context: "test", score: 3 },
      ],
    });
    const deps = _makeMockDiscussDepsWithThrows({ stable: "Stable output" }, ["crashy"]);

    const result = await executeDiscuss(deps, "test", convene);

    expect(result.success).toBe(true);
    expect(result.succeeded).toEqual(["stable"]);
    expect(result.failed).toEqual(["crashy"]);
    expect(result.results[1].error).toContain("crashed");
  });

  it("fails when all formations fail", async () => {
    const convene = _makeMockConveneOutput({
      selectedFormations: [
        { slug: "bad1", reason: "test", context: "test", score: 5 },
        { slug: "bad2", reason: "test", context: "test", score: 3 },
      ],
    });
    const deps = _makeMockDiscussDeps({}, ["bad1", "bad2"]);

    const result = await executeDiscuss(deps, "test", convene);

    expect(result.success).toBe(false);
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toEqual(["bad1", "bad2"]);
  });

  it("respects minSuccessful configuration", async () => {
    const convene = _makeMockConveneOutput({
      selectedFormations: [
        { slug: "good", reason: "test", context: "test", score: 5 },
        { slug: "bad", reason: "test", context: "test", score: 3 },
        { slug: "also-bad", reason: "test", context: "test", score: 2 },
      ],
    });
    const deps = _makeMockDiscussDeps({ good: "Analysis" }, ["bad", "also-bad"]);

    // Requires 2 successful but only 1 succeeds
    const result = await executeDiscuss(deps, "test", convene, { minSuccessful: 2 });
    expect(result.success).toBe(false);
    expect(result.succeeded).toEqual(["good"]);

    // Requires 1 successful — passes
    const result2 = await executeDiscuss(deps, "test", convene, { minSuccessful: 1 });
    expect(result2.success).toBe(true);
  });
});

// ── Result Collection & Summary ─────────────────────────────────

describe("discuss — result collection", () => {
  it("records duration for each formation", async () => {
    const convene = _makeMockConveneOutput();
    const deps = _makeMockDiscussDeps();

    const result = await executeDiscuss(deps, "test", convene);

    for (const r of result.results) {
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("records total duration", async () => {
    const convene = _makeMockConveneOutput();
    const deps = _makeMockDiscussDeps();

    const result = await executeDiscuss(deps, "test", convene);

    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("summary includes successful formations", async () => {
    const convene = _makeMockConveneOutput();
    const deps = _makeMockDiscussDeps({
      boardroom: "Board analysis here.",
      "think-tank": "Ideas here.",
    });

    const result = await executeDiscuss(deps, "test", convene);

    expect(result.summary).toContain("boardroom");
    expect(result.summary).toContain("think-tank");
    expect(result.summary).toContain("Board analysis here.");
    expect(result.summary).toContain("Ideas here.");
  });

  it("summary includes failed formations with error", async () => {
    const convene = _makeMockConveneOutput({
      selectedFormations: [
        { slug: "good", reason: "test", context: "test", score: 5 },
        { slug: "bad", reason: "test", context: "test", score: 3 },
      ],
    });
    const deps = _makeMockDiscussDeps({ good: "Success" }, ["bad"]);

    const result = await executeDiscuss(deps, "test", convene);

    expect(result.summary).toContain("bad (FAILED)");
    expect(result.summary).toContain("Error:");
  });

  it("summary includes counts", async () => {
    const convene = _makeMockConveneOutput();
    const deps = _makeMockDiscussDeps();

    const result = await executeDiscuss(deps, "test", convene);

    expect(result.summary).toContain("2/2 formations contributed");
  });
});

// ── Concurrency Control ─────────────────────────────────────────

describe("discuss — concurrency control", () => {
  it("respects maxConcurrent limit", async () => {
    let peakConcurrent = 0;
    let currentConcurrent = 0;

    const convene = _makeMockConveneOutput({
      selectedFormations: [
        { slug: "a", reason: "test", context: "test", score: 5 },
        { slug: "b", reason: "test", context: "test", score: 4 },
        { slug: "c", reason: "test", context: "test", score: 3 },
        { slug: "d", reason: "test", context: "test", score: 2 },
      ],
    });

    const deps = {
      invokeFormation: async (slug: string) => {
        currentConcurrent++;
        peakConcurrent = Math.max(peakConcurrent, currentConcurrent);
        await new Promise(r => setTimeout(r, 20));
        currentConcurrent--;
        return { success: true, synthesis: `[${slug}] done` };
      },
    };

    await executeDiscuss(deps, "test", convene, { maxConcurrent: 2 });

    expect(peakConcurrent).toBeLessThanOrEqual(2);
  }, 5000);
});

// ── Options Passthrough ─────────────────────────────────────────

describe("discuss — options passthrough", () => {
  it("passes channel and workItemId to formations", async () => {
    const convene = _makeMockConveneOutput({
      selectedFormations: [
        { slug: "test-formation", reason: "test", context: "test", score: 5 },
      ],
    });

    let receivedOpts: { channel?: string; workItemId?: string } | undefined;
    const deps = {
      invokeFormation: async (slug: string, prompt: string, opts?: { channel?: string; workItemId?: string }) => {
        receivedOpts = opts;
        return { success: true, synthesis: "done" };
      },
    };

    await executeDiscuss(deps, "test", convene, undefined, {
      channel: "telegram",
      workItemId: "ELLIE-698",
    });

    expect(receivedOpts).toBeDefined();
    expect(receivedOpts!.channel).toBe("telegram");
    expect(receivedOpts!.workItemId).toBe("ELLIE-698");
  });
});

// ── Mock Helpers ────────────────────────────────────────────────

describe("discuss — mock helpers", () => {
  it("_makeMockDiscussDeps returns successful results", async () => {
    const deps = _makeMockDiscussDeps({ boardroom: "test output" });
    const result = await deps.invokeFormation("boardroom", "prompt");
    expect(result.success).toBe(true);
    expect(result.synthesis).toBe("test output");
  });

  it("_makeMockDiscussDeps returns failure for error slugs", async () => {
    const deps = _makeMockDiscussDeps({}, ["bad"]);
    const result = await deps.invokeFormation("bad", "prompt");
    expect(result.success).toBe(false);
    expect(result.error).toContain("bad");
  });

  it("_makeMockDiscussDeps returns default for unknown slugs", async () => {
    const deps = _makeMockDiscussDeps();
    const result = await deps.invokeFormation("unknown", "prompt");
    expect(result.success).toBe(true);
    expect(result.synthesis).toContain("unknown");
  });

  it("_makeMockDiscussDepsWithThrows throws for specified slugs", async () => {
    const deps = _makeMockDiscussDepsWithThrows({}, ["crashy"]);
    await expect(deps.invokeFormation("crashy", "prompt")).rejects.toThrow("crashed");
  });

  it("_makeMockSlowDiscussDeps delays before returning", async () => {
    const deps = _makeMockSlowDiscussDeps(50);
    const start = Date.now();
    await deps.invokeFormation("test", "prompt");
    expect(Date.now() - start).toBeGreaterThanOrEqual(40); // allow small timing variance
  });

  it("_makeMockDiscussOutput creates valid output", () => {
    const output = _makeMockDiscussOutput();
    expect(output.success).toBe(true);
    expect(output.results).toHaveLength(2);
    expect(output.succeeded).toContain("boardroom");
    expect(output.summary.length).toBeGreaterThan(0);
  });

  it("_makeMockDiscussOutput accepts overrides", () => {
    const output = _makeMockDiscussOutput({
      success: false,
      failed: ["broken"],
    });
    expect(output.success).toBe(false);
    expect(output.failed).toContain("broken");
    // Non-overridden fields preserved
    expect(output.results).toHaveLength(2);
  });
});

// ── E2E Scenarios ───────────────────────────────────────────────

describe("discuss — E2E scenarios", () => {
  it("full multi-formation strategy discussion", async () => {
    const convene = _makeMockConveneOutput({
      analysis: {
        query: "What should our Q2 strategy be?",
        intent: "Create a plan",
        domains: ["boardroom", "think-tank"],
        complexity: "moderate",
        dimensions: ["strategic", "financial"],
        keywords: ["strategy", "plan"],
      },
      selectedFormations: [
        {
          slug: "boardroom",
          reason: "Domain match; Has strategic perspective",
          context: "Focus: Strategic decision-making\nDimensions: strategic, financial",
          score: 6,
        },
        {
          slug: "think-tank",
          reason: "Domain match; Creative perspective",
          context: "Focus: Brainstorming and ideation",
          score: 4,
        },
      ],
    });

    const deps = _makeMockDiscussDeps({
      boardroom: "Strategic Analysis:\n- Market opportunity: $50M TAM in adjacent vertical\n- Competitive risk: Series B startup launching Q3\n- Recommendation: Defensive expansion while deepening current moat\n- Budget impact: $2.5M incremental investment needed",
      "think-tank": "Creative Ideas:\n1. Launch a community-led growth program (low cost, high viral potential)\n2. Build an integration marketplace (platform play)\n3. Acquire the Series B competitor pre-launch\nThemes: Platform strategy, community leverage, defensive positioning",
    });

    const result = await executeDiscuss(deps, "What should our Q2 strategy be?", convene);

    expect(result.success).toBe(true);
    expect(result.succeeded).toEqual(["boardroom", "think-tank"]);
    expect(result.failed).toHaveLength(0);
    expect(result.results[0].output).toContain("$50M TAM");
    expect(result.results[1].output).toContain("integration marketplace");
    expect(result.summary).toContain("2/2 formations contributed");
  });

  it("partial failure with graceful recovery", async () => {
    const convene = _makeMockConveneOutput({
      selectedFormations: [
        { slug: "boardroom", reason: "Strategic", context: "Strategy", score: 6 },
        { slug: "billing-ops", reason: "Financial", context: "Billing", score: 4 },
        { slug: "vrbo-ops", reason: "Ops", context: "Property", score: 3 },
      ],
    });

    const deps = _makeMockDiscussDepsWithThrows(
      {
        boardroom: "Strategic recommendations ready.",
        "vrbo-ops": "Property analysis complete.",
      },
      ["billing-ops"], // crashes
    );

    const result = await executeDiscuss(deps, "Quarterly review", convene);

    expect(result.success).toBe(true);
    expect(result.succeeded).toEqual(["boardroom", "vrbo-ops"]);
    expect(result.failed).toEqual(["billing-ops"]);
    expect(result.summary).toContain("2/3 formations contributed");
    expect(result.summary).toContain("billing-ops (FAILED)");
    expect(result.summary).toContain("Strategic recommendations ready.");
  });

  it("complete failure — all formations down", async () => {
    const convene = _makeMockConveneOutput({
      selectedFormations: [
        { slug: "a", reason: "test", context: "test", score: 5 },
        { slug: "b", reason: "test", context: "test", score: 3 },
      ],
    });

    const deps = _makeMockDiscussDepsWithThrows({}, ["a", "b"]);

    const result = await executeDiscuss(deps, "test", convene);

    expect(result.success).toBe(false);
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toEqual(["a", "b"]);
    expect(result.summary).toContain("0/2 formations contributed");
  });

  it("mixed timeout and crash", async () => {
    const convene = _makeMockConveneOutput({
      selectedFormations: [
        { slug: "fast", reason: "test", context: "test", score: 5 },
        { slug: "slow", reason: "test", context: "test", score: 4 },
        { slug: "crashy", reason: "test", context: "test", score: 3 },
      ],
    });

    const deps = {
      invokeFormation: async (slug: string) => {
        if (slug === "crashy") throw new Error("Formation crashed");
        if (slug === "slow") await new Promise(r => setTimeout(r, 500));
        return { success: true, synthesis: `[${slug}] done` };
      },
    };

    const result = await executeDiscuss(deps, "test", convene, {
      formationTimeoutMs: 50, // times out "slow"
    });

    expect(result.succeeded).toEqual(["fast"]);
    expect(result.failed).toContain("slow");
    expect(result.failed).toContain("crashy");

    const slowResult = result.results.find(r => r.slug === "slow");
    expect(slowResult!.timedOut).toBe(true);

    const crashResult = result.results.find(r => r.slug === "crashy");
    expect(crashResult!.timedOut).toBe(false);
    expect(crashResult!.error).toContain("crashed");
  }, 5000);
});
