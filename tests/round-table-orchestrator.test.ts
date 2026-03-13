/**
 * Round Table Orchestrator Tests — ELLIE-695
 *
 * Tests cover:
 *   - Prompt building (convene, discuss, converge, deliver)
 *   - Phase execution (each phase individually)
 *   - Full orchestration (runRoundTable through all 4 phases)
 *   - Formation selection and invocation
 *   - Output threading (phase output → next phase input)
 *   - Error handling (phase failure, formation failure, timeout)
 *   - Mock helpers
 *   - E2E (realistic scenario)
 */

import { describe, it, expect, beforeEach } from "bun:test";

import {
  // Prompt builders
  buildConvenePrompt,
  buildDiscussPrompt,
  buildConvergePrompt,
  buildDeliverPrompt,
  // Core
  runRoundTable,
  // Mock helpers
  _makeMockFormationInvoke,
  _makeMockFormationInvokeWithErrors,
  _makeMockFormationSelector,
  _makeMockAgentCall,
  _makeMockOrchestratorDeps,
  _resetIdCounter,
  // Types
  type RoundTableOrchestratorDeps,
  type RoundTableResult,
  type PhaseResult,
} from "../src/round-table/orchestrator.ts";

import {
  getSessionProgress,
  _makeMockDeps as _makeMockRoundTableDeps,
} from "../src/types/round-table.ts";

// ── Prompt Building ─────────────────────────────────────────────

describe("round table orchestrator — buildConvenePrompt", () => {
  it("includes the query", () => {
    const prompt = buildConvenePrompt("What should our Q2 strategy be?");
    expect(prompt).toContain("What should our Q2 strategy be?");
    expect(prompt).toContain('phase="convene"');
  });

  it("asks for problem statement and dimensions", () => {
    const prompt = buildConvenePrompt("test query");
    expect(prompt).toContain("problem statement");
    expect(prompt).toContain("dimensions");
    expect(prompt).toContain("perspectives");
  });
});

describe("round table orchestrator — buildDiscussPrompt", () => {
  it("includes query, convene output, and formation slug", () => {
    const prompt = buildDiscussPrompt("Q2 strategy", "Key dimensions: market, finance", "boardroom");
    expect(prompt).toContain("Q2 strategy");
    expect(prompt).toContain("Key dimensions: market, finance");
    expect(prompt).toContain("boardroom");
    expect(prompt).toContain('phase="discuss"');
  });

  it("instructs formation to contribute domain perspective", () => {
    const prompt = buildDiscussPrompt("test", "analysis", "research-panel");
    expect(prompt).toContain("domain perspective");
    expect(prompt).toContain("converge phase");
  });
});

describe("round table orchestrator — buildConvergePrompt", () => {
  it("includes all contributions", () => {
    const contributions = [
      { formation: "boardroom", output: "Strategic view: expand into new markets." },
      { formation: "research-panel", output: "Research view: market size is growing." },
    ];
    const prompt = buildConvergePrompt("Q2 strategy", "dimensions", contributions);
    expect(prompt).toContain('phase="converge"');
    expect(prompt).toContain('formation="boardroom"');
    expect(prompt).toContain('formation="research-panel"');
    expect(prompt).toContain("expand into new markets");
    expect(prompt).toContain("market size is growing");
  });

  it("asks for synthesis, not concatenation", () => {
    const prompt = buildConvergePrompt("test", "analysis", []);
    expect(prompt).toContain("agreement");
    expect(prompt).toContain("disagreements");
    expect(prompt).toContain("prioritized");
  });
});

describe("round table orchestrator — buildDeliverPrompt", () => {
  it("includes converge output", () => {
    const prompt = buildDeliverPrompt("Q2 strategy", "Consensus: hybrid approach");
    expect(prompt).toContain('phase="deliver"');
    expect(prompt).toContain("Consensus: hybrid approach");
    expect(prompt).toContain("Q2 strategy");
  });

  it("asks for polished final deliverable", () => {
    const prompt = buildDeliverPrompt("test", "synthesis");
    expect(prompt).toContain("final");
    expect(prompt).toContain("deliverable");
    expect(prompt).toContain("action items");
  });
});

// ── Full Orchestration ──────────────────────────────────────────

describe("round table orchestrator — runRoundTable", () => {
  beforeEach(() => {
    _resetIdCounter();
  });

  it("runs through all 4 phases successfully", async () => {
    const deps = _makeMockOrchestratorDeps({
      phaseFormations: { discuss: ["boardroom"] },
      formationResults: {
        boardroom: "Boardroom analysis: strategic recommendations here.",
      },
    });

    const result = await runRoundTable(deps, "What should our Q2 strategy be?");

    expect(result.success).toBe(true);
    expect(result.phases).toHaveLength(4);
    expect(result.phases[0].phase).toBe("convene");
    expect(result.phases[1].phase).toBe("discuss");
    expect(result.phases[2].phase).toBe("converge");
    expect(result.phases[3].phase).toBe("deliver");
    expect(result.phases.every(p => p.success)).toBe(true);
    expect(result.output.length).toBeGreaterThan(0);
  });

  it("session is completed after all phases", async () => {
    const deps = _makeMockOrchestratorDeps({
      phaseFormations: { discuss: ["boardroom"] },
    });

    const result = await runRoundTable(deps, "test query");
    expect(result.success).toBe(true);

    const progress = getSessionProgress(deps.roundTableDeps, result.sessionId);
    expect(progress).not.toBeNull();
    expect(progress!.session.status).toBe("completed");
    expect(progress!.session.phases_completed).toBe(4);
  });

  it("passes optional fields through", async () => {
    const deps = _makeMockOrchestratorDeps({
      phaseFormations: { discuss: ["boardroom"] },
    });

    const result = await runRoundTable(deps, "test", {
      initiatorAgent: "dev",
      channel: "telegram",
      workItemId: "ELLIE-695",
    });

    expect(result.success).toBe(true);
    const progress = getSessionProgress(deps.roundTableDeps, result.sessionId);
    expect(progress!.session.channel).toBe("telegram");
    expect(progress!.session.work_item_id).toBe("ELLIE-695");
    expect(progress!.session.initiator_agent).toBe("dev");
  });
});

// ── Formation Selection ─────────────────────────────────────────

describe("round table orchestrator — formation selection", () => {
  beforeEach(() => {
    _resetIdCounter();
  });

  it("invokes multiple formations in discuss phase", async () => {
    const invokedFormations: string[] = [];
    const deps: RoundTableOrchestratorDeps = {
      roundTableDeps: _makeMockRoundTableDeps(),
      invokeFormation: async (slug) => {
        invokedFormations.push(slug);
        return { success: true, synthesis: `[${slug}] done`, formationName: slug };
      },
      selectFormations: _makeMockFormationSelector({
        discuss: ["boardroom", "research-panel", "billing-ops"],
      }),
      callAgent: _makeMockAgentCall(),
    };

    const result = await runRoundTable(deps, "test");
    expect(result.success).toBe(true);
    expect(invokedFormations).toEqual(["boardroom", "research-panel", "billing-ops"]);

    // Discuss phase should record all formations used
    const discussPhase = result.phases.find(p => p.phase === "discuss");
    expect(discussPhase!.formationsUsed).toEqual(["boardroom", "research-panel", "billing-ops"]);
  });

  it("handles no formations selected gracefully", async () => {
    const deps = _makeMockOrchestratorDeps({
      phaseFormations: { discuss: [] }, // no formations
    });

    const result = await runRoundTable(deps, "test");
    expect(result.success).toBe(true);
    expect(result.phases[1].output).toContain("No formations selected");
  });

  it("handles formation invocation failure gracefully", async () => {
    const deps = _makeMockOrchestratorDeps({
      phaseFormations: { discuss: ["boardroom", "bad-formation"] },
      errorFormations: ["bad-formation"],
      formationResults: { boardroom: "Good analysis from boardroom." },
    });

    const result = await runRoundTable(deps, "test");
    expect(result.success).toBe(true);
    expect(result.phases[1].output).toContain("boardroom");
    expect(result.phases[1].output).toContain("Good analysis from boardroom");
    expect(result.phases[1].output).toContain("Error");
  });
});

// ── Output Threading ────────────────────────────────────────────

describe("round table orchestrator — output threading", () => {
  beforeEach(() => {
    _resetIdCounter();
  });

  it("convene output is available to discuss phase", async () => {
    let discussPromptReceived = "";

    const deps: RoundTableOrchestratorDeps = {
      roundTableDeps: _makeMockRoundTableDeps(),
      invokeFormation: async (slug, prompt) => {
        discussPromptReceived = prompt;
        return { success: true, synthesis: "discuss output", formationName: slug };
      },
      selectFormations: _makeMockFormationSelector({ discuss: ["boardroom"] }),
      callAgent: async (agent, prompt) => {
        if (prompt.includes('phase="convene"')) {
          return "CONVENE_MARKER: This is the convene analysis.";
        }
        return "agent response";
      },
    };

    await runRoundTable(deps, "test");
    expect(discussPromptReceived).toContain("CONVENE_MARKER");
  });

  it("discuss contributions are available to converge phase", async () => {
    let convergePromptReceived = "";

    const deps: RoundTableOrchestratorDeps = {
      roundTableDeps: _makeMockRoundTableDeps(),
      invokeFormation: _makeMockFormationInvoke({
        boardroom: "BOARDROOM_OUTPUT: strategic analysis",
      }),
      selectFormations: _makeMockFormationSelector({ discuss: ["boardroom"] }),
      callAgent: async (agent, prompt) => {
        if (prompt.includes('phase="converge"')) {
          convergePromptReceived = prompt;
        }
        return "agent response";
      },
    };

    await runRoundTable(deps, "test");
    expect(convergePromptReceived).toContain("BOARDROOM_OUTPUT");
  });

  it("converge output is available to deliver phase", async () => {
    let deliverPromptReceived = "";

    const deps: RoundTableOrchestratorDeps = {
      roundTableDeps: _makeMockRoundTableDeps(),
      invokeFormation: _makeMockFormationInvoke(),
      selectFormations: _makeMockFormationSelector({ discuss: ["boardroom"] }),
      callAgent: async (agent, prompt) => {
        if (prompt.includes('phase="converge"')) {
          return "CONVERGE_MARKER: synthesis complete";
        }
        if (prompt.includes('phase="deliver"')) {
          deliverPromptReceived = prompt;
        }
        return "agent response";
      },
    };

    await runRoundTable(deps, "test");
    expect(deliverPromptReceived).toContain("CONVERGE_MARKER");
  });

  it("phase outputs are persisted in round table stores", async () => {
    const deps = _makeMockOrchestratorDeps({
      phaseFormations: { discuss: ["boardroom"] },
      agentResponses: {
        strategy: "Custom strategy response",
      },
    });

    const result = await runRoundTable(deps, "test");
    expect(result.success).toBe(true);

    const progress = getSessionProgress(deps.roundTableDeps, result.sessionId);
    expect(progress).not.toBeNull();

    // All phases should be completed
    for (const phase of progress!.phases) {
      expect(phase.status).toBe("completed");
      expect(phase.output).not.toBeNull();
      expect(phase.output!.length).toBeGreaterThan(0);
    }

    // Check that discuss phase input = convene phase output
    const convenePhase = progress!.phases.find(p => p.phase_type === "convene");
    const discussPhase = progress!.phases.find(p => p.phase_type === "discuss");
    expect(discussPhase!.input).toBe(convenePhase!.output);
  });
});

// ── Error Handling ──────────────────────────────────────────────

describe("round table orchestrator — error handling", () => {
  beforeEach(() => {
    _resetIdCounter();
  });

  it("fails gracefully when convene agent fails", async () => {
    const deps: RoundTableOrchestratorDeps = {
      roundTableDeps: _makeMockRoundTableDeps(),
      invokeFormation: _makeMockFormationInvoke(),
      selectFormations: _makeMockFormationSelector(),
      callAgent: async () => { throw new Error("Agent crashed"); },
    };

    const result = await runRoundTable(deps, "test");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Agent crashed");
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].phase).toBe("convene");
    expect(result.phases[0].success).toBe(false);

    // Session should be failed
    const progress = getSessionProgress(deps.roundTableDeps, result.sessionId);
    expect(progress!.session.status).toBe("failed");
  });

  it("fails gracefully when converge agent fails", async () => {
    let callCount = 0;
    const deps: RoundTableOrchestratorDeps = {
      roundTableDeps: _makeMockRoundTableDeps(),
      invokeFormation: _makeMockFormationInvoke(),
      selectFormations: _makeMockFormationSelector({ discuss: ["boardroom"] }),
      callAgent: async (agent, prompt) => {
        callCount++;
        if (prompt.includes('phase="converge"')) {
          throw new Error("Converge agent crashed");
        }
        return "ok";
      },
    };

    const result = await runRoundTable(deps, "test");
    expect(result.success).toBe(false);
    expect(result.phases).toHaveLength(3); // convene, discuss, converge (failed)
    expect(result.phases[0].success).toBe(true);
    expect(result.phases[1].success).toBe(true);
    expect(result.phases[2].success).toBe(false);
    expect(result.phases[2].error).toContain("Converge agent crashed");
  });

  it("handles session timeout", async () => {
    const deps: RoundTableOrchestratorDeps = {
      roundTableDeps: _makeMockRoundTableDeps(),
      invokeFormation: _makeMockFormationInvoke(),
      selectFormations: _makeMockFormationSelector({ discuss: ["boardroom"] }),
      callAgent: async () => "ok",
    };

    // Set an impossibly short timeout
    const result = await runRoundTable(deps, "test", {
      config: { sessionTimeoutMs: -1 },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");

    const progress = getSessionProgress(deps.roundTableDeps, result.sessionId);
    expect(progress!.session.status).toBe("timed_out");
  });

  it("partial results available on mid-session failure", async () => {
    const deps: RoundTableOrchestratorDeps = {
      roundTableDeps: _makeMockRoundTableDeps(),
      invokeFormation: _makeMockFormationInvoke(),
      selectFormations: _makeMockFormationSelector({ discuss: ["boardroom"] }),
      callAgent: async (agent, prompt) => {
        if (prompt.includes('phase="deliver"')) throw new Error("Deliver failed");
        return "phase output";
      },
    };

    const result = await runRoundTable(deps, "test");
    expect(result.success).toBe(false);
    expect(result.phases).toHaveLength(4);
    // First 3 phases succeeded
    expect(result.phases[0].success).toBe(true);
    expect(result.phases[1].success).toBe(true);
    expect(result.phases[2].success).toBe(true);
    expect(result.phases[3].success).toBe(false);
    // Output should be from last successful phase (converge)
    expect(result.output).toBe("phase output");
  });
});

// ── Mock Helpers ────────────────────────────────────────────────

describe("round table orchestrator — mock helpers", () => {
  beforeEach(() => {
    _resetIdCounter();
  });

  it("_makeMockFormationInvoke returns canned results", async () => {
    const invoke = _makeMockFormationInvoke({ boardroom: "test output" });
    const result = await invoke("boardroom", "prompt");
    expect(result.success).toBe(true);
    expect(result.synthesis).toBe("test output");
    expect(result.formationName).toBe("boardroom");
  });

  it("_makeMockFormationInvoke returns default for unknown slugs", async () => {
    const invoke = _makeMockFormationInvoke();
    const result = await invoke("unknown", "prompt");
    expect(result.success).toBe(true);
    expect(result.synthesis).toContain("unknown");
  });

  it("_makeMockFormationInvokeWithErrors fails for specified slugs", async () => {
    const invoke = _makeMockFormationInvokeWithErrors(["bad"], { good: "success" });

    const good = await invoke("good", "prompt");
    expect(good.success).toBe(true);
    expect(good.synthesis).toBe("success");

    const bad = await invoke("bad", "prompt");
    expect(bad.success).toBe(false);
    expect(bad.error).toContain("bad");
  });

  it("_makeMockFormationSelector returns phase-specific formations", async () => {
    const selector = _makeMockFormationSelector({
      discuss: ["boardroom", "research-panel"],
      converge: ["boardroom"],
    });

    expect(await selector("discuss", "", null)).toEqual(["boardroom", "research-panel"]);
    expect(await selector("converge", "", null)).toEqual(["boardroom"]);
    expect(await selector("convene", "", null)).toEqual([]);
  });

  it("_makeMockAgentCall returns phase-appropriate defaults", async () => {
    const call = _makeMockAgentCall();

    const convene = await call("strategy", buildConvenePrompt("test"));
    expect(convene).toContain("analysis");

    const converge = await call("strategy", buildConvergePrompt("test", "analysis", []));
    expect(converge).toContain("Synthesis");

    const deliver = await call("strategy", buildDeliverPrompt("test", "synthesis"));
    expect(deliver).toContain("deliverable");
  });

  it("_makeMockOrchestratorDeps creates complete deps", async () => {
    const deps = _makeMockOrchestratorDeps();
    expect(deps.roundTableDeps).toBeDefined();
    expect(deps.invokeFormation).toBeDefined();
    expect(deps.selectFormations).toBeDefined();
    expect(deps.callAgent).toBeDefined();
  });
});

// ── E2E ─────────────────────────────────────────────────────────

describe("round table orchestrator — E2E", () => {
  beforeEach(() => {
    _resetIdCounter();
  });

  it("full Q2 strategy session with multiple formations", async () => {
    const deps = _makeMockOrchestratorDeps({
      phaseFormations: {
        discuss: ["boardroom", "research-panel"],
      },
      formationResults: {
        boardroom: "Strategic Analysis:\n- Market opportunity in adjacent vertical ($50M TAM)\n- Current product-market fit strong (NPS: 72)\n- Competitor threat from Series B startup launching Q3\n- Recommendation: defensive expansion — deepen current moat while piloting adjacent vertical",
        "research-panel": "Market Research:\n- Industry growing 18% YoY\n- Key trend: consolidation among mid-market players\n- Customer interviews show demand for integration features\n- Risk: regulatory changes in EU market by Q4",
      },
      agentResponses: {
        strategy: "Phase-specific strategy response",
      },
    });

    const result = await runRoundTable(deps, "What should our Q2 product strategy be?", {
      initiatorAgent: "strategy",
      channel: "telegram",
      workItemId: "ELLIE-100",
    });

    expect(result.success).toBe(true);
    expect(result.phases).toHaveLength(4);
    expect(result.output.length).toBeGreaterThan(0);

    // Verify all phases completed
    for (const phase of result.phases) {
      expect(phase.success).toBe(true);
      expect(phase.output.length).toBeGreaterThan(0);
    }

    // Discuss phase used both formations
    const discuss = result.phases.find(p => p.phase === "discuss");
    expect(discuss!.formationsUsed).toEqual(["boardroom", "research-panel"]);
    expect(discuss!.output).toContain("boardroom");
    expect(discuss!.output).toContain("research-panel");

    // Session is fully completed
    const progress = getSessionProgress(deps.roundTableDeps, result.sessionId);
    expect(progress!.session.status).toBe("completed");
    expect(progress!.completedPhases).toEqual(["convene", "discuss", "converge", "deliver"]);
    expect(progress!.progress).toBe("4/4 phases");
  });

  it("handles formation failure mid-session and still completes", async () => {
    const deps = _makeMockOrchestratorDeps({
      phaseFormations: {
        discuss: ["boardroom", "broken-formation", "research-panel"],
      },
      errorFormations: ["broken-formation"],
      formationResults: {
        boardroom: "Boardroom: solid strategic analysis.",
        "research-panel": "Research: market data analysis.",
      },
    });

    const result = await runRoundTable(deps, "Quarterly review");

    expect(result.success).toBe(true);
    expect(result.phases).toHaveLength(4);

    // Discuss phase should still succeed with partial results
    const discuss = result.phases.find(p => p.phase === "discuss");
    expect(discuss!.success).toBe(true);
    expect(discuss!.output).toContain("Boardroom: solid strategic analysis");
    expect(discuss!.output).toContain("Research: market data analysis");
    expect(discuss!.output).toContain("Error"); // broken-formation error captured
    expect(discuss!.formationsUsed).toEqual(["boardroom", "broken-formation", "research-panel"]);
  });
});
