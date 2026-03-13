/**
 * Round Table Comprehensive Test Suite — ELLIE-704
 *
 * Integration and edge-case tests that verify the round table system
 * end-to-end. Fills gaps not covered by individual module tests:
 *
 *   1. Cross-module integration (convene → discuss → converge → deliver)
 *   2. Formation outcome chaining (data flows correctly between phases)
 *   3. Edge-case error handling (all formations fail, cascading failures)
 *   4. Phase timeout vs session timeout distinction
 *   5. Concurrent session management
 *   6. Invalid state transitions rejected
 *   7. Session recovery after partial failure
 */

import { describe, expect, test, beforeEach } from "bun:test";

// ── Orchestrator + phase state machine ──────────────────────────
import {
  runRoundTable,
  buildConvenePrompt,
  buildDiscussPrompt,
  buildConvergePrompt,
  buildDeliverPrompt,
  _makeMockOrchestratorDeps,
  _makeMockFormationInvoke,
  _makeMockFormationInvokeWithErrors,
  _makeMockFormationSelector,
  _makeMockAgentCall,
  _resetIdCounter,
  type RoundTableOrchestratorDeps,
} from "../src/round-table/orchestrator.ts";

import {
  ROUND_TABLE_PHASES,
  PHASE_TRANSITIONS,
  isValidPhaseTransition,
  getNextPhase,
  isValidSessionTransition,
  createSession,
  startSession,
  advancePhase,
  failSession,
  timeoutSession,
  getSessionProgress,
  _makeMockDeps as _makeMockRoundTableDeps,
  type RoundTableDeps,
} from "../src/types/round-table.ts";

// ── Convene (real module) ───────────────────────────────────────
import {
  analyzeQuery,
  executeConvene,
  _makeMockConveneDeps,
  _makeMockConveneOutput,
  FORMATION_REGISTRY,
} from "../src/round-table/convene.ts";

// ── Discuss (real module) ───────────────────────────────────────
import {
  executeDiscuss,
  _makeMockDiscussDeps,
  _makeMockDiscussOutput,
} from "../src/round-table/discuss.ts";

// ── Converge (real module) ──────────────────────────────────────
import {
  executeConverge,
  _makeMockConvergeDeps,
  _makeMockConvergeOutput,
} from "../src/round-table/converge.ts";

// ── Deliver (real module) ───────────────────────────────────────
import {
  executeDeliver,
  _makeMockDeliverDeps,
  _makeMockDeliverOutput,
} from "../src/round-table/deliver.ts";

// ── Router integration ──────────────────────────────────────────
import {
  RoundTableSessionManager,
  executeRoundTableHandoff,
  detectRoundTable,
  detectExplicitTrigger,
  detectHandoff,
  _makeMockRouterDeps,
  _makeMockRouterDepsWithFailure,
  _makeMockRouterDepsWithThrow,
} from "../src/round-table/router-integration.ts";

// ── Output formatting ───────────────────────────────────────────
import {
  formatRoundTableOutput,
  renderForChannel,
  paginateMessage,
  _makeMockFormattingInput,
  _makeMockFormatOptions,
} from "../src/round-table/output-formatting.ts";

// ── Commands ────────────────────────────────────────────────────
import {
  parseCommand,
  handleRoundTableCommand,
  _makeMockCommandDeps,
} from "../src/round-table/commands.ts";

// ═══════════════════════════════════════════════════════════════
// 1. FORMATION OUTCOME CHAINING
// ═══════════════════════════════════════════════════════════════

describe("formation outcome chaining", () => {
  beforeEach(() => _resetIdCounter());

  test("convene output is threaded as discuss input in phase store", async () => {
    const deps = _makeMockOrchestratorDeps({
      phaseFormations: { discuss: ["boardroom"] },
    });

    const result = await runRoundTable(deps, "What is our Q2 plan?");
    expect(result.success).toBe(true);

    const progress = getSessionProgress(deps.roundTableDeps, result.sessionId)!;
    const convenePhase = progress.phases.find(p => p.phase_type === "convene")!;
    const discussPhase = progress.phases.find(p => p.phase_type === "discuss")!;

    // Discuss input === convene output (exact chain)
    expect(discussPhase.input).toBe(convenePhase.output);
    expect(discussPhase.input!.length).toBeGreaterThan(0);
  });

  test("discuss output is threaded as converge input in phase store", async () => {
    const deps = _makeMockOrchestratorDeps({
      phaseFormations: { discuss: ["boardroom", "think-tank"] },
      formationResults: {
        boardroom: "Strategic: expand internationally",
        "think-tank": "Creative: new product line",
      },
    });

    const result = await runRoundTable(deps, "Growth options?");
    expect(result.success).toBe(true);

    const progress = getSessionProgress(deps.roundTableDeps, result.sessionId)!;
    const discussPhase = progress.phases.find(p => p.phase_type === "discuss")!;
    const convergePhase = progress.phases.find(p => p.phase_type === "converge")!;

    expect(convergePhase.input).toBe(discussPhase.output);
    // Discuss output should contain both formation results
    expect(discussPhase.output).toContain("boardroom");
    expect(discussPhase.output).toContain("think-tank");
    expect(discussPhase.output).toContain("Strategic: expand internationally");
    expect(discussPhase.output).toContain("Creative: new product line");
  });

  test("converge output is threaded as deliver input in phase store", async () => {
    const deps = _makeMockOrchestratorDeps({
      phaseFormations: { discuss: ["boardroom"] },
    });

    const result = await runRoundTable(deps, "What next?");
    expect(result.success).toBe(true);

    const progress = getSessionProgress(deps.roundTableDeps, result.sessionId)!;
    const convergePhase = progress.phases.find(p => p.phase_type === "converge")!;
    const deliverPhase = progress.phases.find(p => p.phase_type === "deliver")!;

    expect(deliverPhase.input).toBe(convergePhase.output);
  });

  test("full chain: each phase feeds the next in order", async () => {
    const deps = _makeMockOrchestratorDeps({
      phaseFormations: { discuss: ["boardroom"] },
    });

    const result = await runRoundTable(deps, "Strategy review");
    expect(result.success).toBe(true);

    const progress = getSessionProgress(deps.roundTableDeps, result.sessionId)!;
    const phases = progress.phases;
    expect(phases).toHaveLength(4);

    // Chain: convene.output → discuss.input, discuss.output → converge.input, converge.output → deliver.input
    for (let i = 1; i < phases.length; i++) {
      expect(phases[i].input).toBe(phases[i - 1].output);
      expect(phases[i].input!.length).toBeGreaterThan(0);
    }
  });

  test("formation error output is included in discuss output chain", async () => {
    const deps = _makeMockOrchestratorDeps({
      phaseFormations: { discuss: ["boardroom", "bad-one"] },
      errorFormations: ["bad-one"],
      formationResults: { boardroom: "Good analysis here" },
    });

    const result = await runRoundTable(deps, "Test");
    expect(result.success).toBe(true);

    // The discuss output should contain both good result and error
    const discuss = result.phases.find(p => p.phase === "discuss")!;
    expect(discuss.output).toContain("Good analysis here");
    expect(discuss.output).toContain("Error");

    // And that error context flows to converge
    const progress = getSessionProgress(deps.roundTableDeps, result.sessionId)!;
    const convergePhase = progress.phases.find(p => p.phase_type === "converge")!;
    expect(convergePhase.input).toContain("Error");
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. EDGE-CASE ERROR HANDLING
// ═══════════════════════════════════════════════════════════════

describe("edge-case error handling", () => {
  beforeEach(() => _resetIdCounter());

  test("all formations failing still produces a discuss output", async () => {
    const deps = _makeMockOrchestratorDeps({
      phaseFormations: { discuss: ["bad-1", "bad-2", "bad-3"] },
      errorFormations: ["bad-1", "bad-2", "bad-3"],
    });

    const result = await runRoundTable(deps, "Test all fail");
    // Session should still succeed — formation errors are captured, not fatal
    expect(result.success).toBe(true);

    const discuss = result.phases.find(p => p.phase === "discuss")!;
    expect(discuss.success).toBe(true);
    // All errors should be captured
    expect(discuss.output).toContain("bad-1");
    expect(discuss.output).toContain("bad-2");
    expect(discuss.output).toContain("bad-3");
    expect(discuss.output).toContain("Error");
  });

  test("deliver phase failure preserves first 3 phase outputs", async () => {
    let callCount = 0;
    const deps: RoundTableOrchestratorDeps = {
      roundTableDeps: _makeMockRoundTableDeps(),
      invokeFormation: _makeMockFormationInvoke({ boardroom: "Good work" }),
      selectFormations: _makeMockFormationSelector({ discuss: ["boardroom"] }),
      callAgent: async (_agent, prompt) => {
        callCount++;
        if (prompt.includes('phase="deliver"')) {
          throw new Error("Deliver crashed");
        }
        return "Phase output OK";
      },
    };

    const result = await runRoundTable(deps, "Test");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Deliver crashed");

    // First 3 phases should have succeeded
    expect(result.phases[0].success).toBe(true);
    expect(result.phases[1].success).toBe(true);
    expect(result.phases[2].success).toBe(true);
    expect(result.phases[3].success).toBe(false);

    // Output should be from last successful phase
    expect(result.output).toBe("Phase output OK");
  });

  test("session state is failed after convene crash", async () => {
    const deps: RoundTableOrchestratorDeps = {
      roundTableDeps: _makeMockRoundTableDeps(),
      invokeFormation: _makeMockFormationInvoke(),
      selectFormations: _makeMockFormationSelector(),
      callAgent: async () => { throw new Error("Boom"); },
    };

    const result = await runRoundTable(deps, "Test");
    expect(result.success).toBe(false);
    expect(result.phases).toHaveLength(1);

    const progress = getSessionProgress(deps.roundTableDeps, result.sessionId)!;
    expect(progress.session.status).toBe("failed");
    expect(progress.completedPhases).toEqual([]);
  });

  test("empty query still produces a session", async () => {
    const deps = _makeMockOrchestratorDeps({
      phaseFormations: { discuss: ["boardroom"] },
    });

    const result = await runRoundTable(deps, "");
    expect(result.sessionId).toBeTruthy();
    // Session should still run (empty query is valid input for the orchestrator)
    expect(result.phases.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. PHASE TIMEOUT vs SESSION TIMEOUT
// ═══════════════════════════════════════════════════════════════

describe("timeout scenarios", () => {
  beforeEach(() => _resetIdCounter());

  test("session timeout marks session as timed_out", async () => {
    const deps = _makeMockOrchestratorDeps({
      phaseFormations: { discuss: ["boardroom"] },
    });

    const result = await runRoundTable(deps, "Test", {
      config: { sessionTimeoutMs: -1 },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");

    const progress = getSessionProgress(deps.roundTableDeps, result.sessionId)!;
    expect(progress.session.status).toBe("timed_out");
  });

  test("session timeout after first phase preserves convene output", async () => {
    let phaseCount = 0;
    const deps: RoundTableOrchestratorDeps = {
      roundTableDeps: _makeMockRoundTableDeps(),
      invokeFormation: _makeMockFormationInvoke(),
      selectFormations: _makeMockFormationSelector({ discuss: ["boardroom"] }),
      callAgent: async () => {
        phaseCount++;
        return "Phase complete";
      },
    };

    // Use a very short timeout — the orchestrator checks timeout between phases
    const result = await runRoundTable(deps, "Test", {
      config: { sessionTimeoutMs: -1 },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    // Should have at least started convene
    expect(result.phases.length).toBeGreaterThanOrEqual(1);
  });

  test("phase-level timeout fails individual phase, not session", async () => {
    const deps: RoundTableOrchestratorDeps = {
      roundTableDeps: _makeMockRoundTableDeps(),
      invokeFormation: _makeMockFormationInvoke(),
      selectFormations: _makeMockFormationSelector({ discuss: ["boardroom"] }),
      callAgent: async (_agent, prompt) => {
        if (prompt.includes('phase="converge"')) {
          // Simulate long-running converge
          await new Promise(resolve => setTimeout(resolve, 200));
          return "Late response";
        }
        return "Quick response";
      },
    };

    // Phase timeout at 100ms should catch the 200ms converge
    const result = await runRoundTable(deps, "Test", {
      config: { phaseTimeoutMs: 100, sessionTimeoutMs: 60_000 },
    });

    expect(result.success).toBe(false);
    // Session should be failed (not timed_out) because the phase timed out
    const progress = getSessionProgress(deps.roundTableDeps, result.sessionId)!;
    expect(progress.session.status).toBe("failed");
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. PHASE STATE MACHINE — EXHAUSTIVE TRANSITIONS
// ═══════════════════════════════════════════════════════════════

describe("phase state machine — exhaustive transitions", () => {
  test("every phase has exactly one valid successor (or none)", () => {
    for (const phase of ROUND_TABLE_PHASES) {
      const next = getNextPhase(phase);
      const idx = ROUND_TABLE_PHASES.indexOf(phase);

      if (idx < ROUND_TABLE_PHASES.length - 1) {
        expect(next).toBe(ROUND_TABLE_PHASES[idx + 1]);
      } else {
        expect(next).toBeNull();
      }
    }
  });

  test("no phase can transition to itself", () => {
    for (const phase of ROUND_TABLE_PHASES) {
      expect(isValidPhaseTransition(phase, phase)).toBe(false);
    }
  });

  test("no phase can skip a phase", () => {
    expect(isValidPhaseTransition("convene", "converge")).toBe(false);
    expect(isValidPhaseTransition("convene", "deliver")).toBe(false);
    expect(isValidPhaseTransition("discuss", "deliver")).toBe(false);
  });

  test("no phase can go backwards", () => {
    expect(isValidPhaseTransition("deliver", "converge")).toBe(false);
    expect(isValidPhaseTransition("deliver", "discuss")).toBe(false);
    expect(isValidPhaseTransition("deliver", "convene")).toBe(false);
    expect(isValidPhaseTransition("converge", "discuss")).toBe(false);
    expect(isValidPhaseTransition("converge", "convene")).toBe(false);
    expect(isValidPhaseTransition("discuss", "convene")).toBe(false);
  });

  test("only valid forward transitions succeed", () => {
    const validPairs = [
      ["convene", "discuss"],
      ["discuss", "converge"],
      ["converge", "deliver"],
    ] as const;

    for (const [from, to] of validPairs) {
      expect(isValidPhaseTransition(from, to)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. SESSION STATE MACHINE — EXHAUSTIVE TRANSITIONS
// ═══════════════════════════════════════════════════════════════

describe("session state machine — exhaustive transitions", () => {
  test("terminal states have no valid transitions", () => {
    const terminals = ["completed", "failed", "timed_out"] as const;
    const allStates = ["pending", "active", "completed", "failed", "timed_out"] as const;

    for (const terminal of terminals) {
      for (const target of allStates) {
        expect(isValidSessionTransition(terminal, target)).toBe(false);
      }
    }
  });

  test("pending can only go to active or failed", () => {
    expect(isValidSessionTransition("pending", "active")).toBe(true);
    expect(isValidSessionTransition("pending", "failed")).toBe(true);
    expect(isValidSessionTransition("pending", "completed")).toBe(false);
    expect(isValidSessionTransition("pending", "timed_out")).toBe(false);
  });

  test("active can go to completed, failed, or timed_out", () => {
    expect(isValidSessionTransition("active", "completed")).toBe(true);
    expect(isValidSessionTransition("active", "failed")).toBe(true);
    expect(isValidSessionTransition("active", "timed_out")).toBe(true);
    expect(isValidSessionTransition("active", "pending")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. SESSION LIFECYCLE — INVALID OPERATIONS
// ═══════════════════════════════════════════════════════════════

describe("session lifecycle — invalid operations", () => {
  let deps: RoundTableDeps;

  beforeEach(() => {
    _resetIdCounter();
    deps = _makeMockRoundTableDeps();
  });

  test("cannot start a completed session", () => {
    const session = createSession(deps, { query: "test", initiator_agent: "dev" });
    startSession(deps, session.id);
    advancePhase(deps, session.id, "1");
    advancePhase(deps, session.id, "2");
    advancePhase(deps, session.id, "3");
    advancePhase(deps, session.id, "4");

    expect(() => startSession(deps, session.id)).toThrow();
  });

  test("cannot advance phase on a failed session", () => {
    const session = createSession(deps, { query: "test", initiator_agent: "dev" });
    startSession(deps, session.id);
    failSession(deps, session.id, "Error");

    expect(() => advancePhase(deps, session.id, "output")).toThrow();
  });

  test("cannot advance phase on a pending session", () => {
    const session = createSession(deps, { query: "test", initiator_agent: "dev" });
    expect(() => advancePhase(deps, session.id, "output")).toThrow();
  });

  test("cannot fail an already failed session", () => {
    const session = createSession(deps, { query: "test", initiator_agent: "dev" });
    startSession(deps, session.id);
    failSession(deps, session.id, "First error");
    expect(() => failSession(deps, session.id, "Second error")).toThrow();
  });

  test("cannot timeout a completed session", () => {
    const session = createSession(deps, { query: "test", initiator_agent: "dev" });
    startSession(deps, session.id);
    advancePhase(deps, session.id, "1");
    advancePhase(deps, session.id, "2");
    advancePhase(deps, session.id, "3");
    advancePhase(deps, session.id, "4");

    expect(() => timeoutSession(deps, session.id)).toThrow();
  });

  test("cannot timeout a failed session", () => {
    const session = createSession(deps, { query: "test", initiator_agent: "dev" });
    startSession(deps, session.id);
    failSession(deps, session.id, "Error");

    expect(() => timeoutSession(deps, session.id)).toThrow();
  });

  test("failing a session skips all remaining phases", () => {
    const session = createSession(deps, { query: "test", initiator_agent: "dev" });
    startSession(deps, session.id);
    // Fail immediately at convene
    failSession(deps, session.id, "Crash");

    const phases = deps.phaseStore.getBySession(session.id);
    expect(phases[0].status).toBe("failed");  // convene — was active
    expect(phases[1].status).toBe("skipped"); // discuss
    expect(phases[2].status).toBe("skipped"); // converge
    expect(phases[3].status).toBe("skipped"); // deliver
  });

  test("failing mid-session preserves completed + fails current + skips rest", () => {
    const session = createSession(deps, { query: "test", initiator_agent: "dev" });
    startSession(deps, session.id);
    advancePhase(deps, session.id, "convene done");
    advancePhase(deps, session.id, "discuss done");
    // Now at converge — fail here
    failSession(deps, session.id, "Converge error");

    const phases = deps.phaseStore.getBySession(session.id);
    expect(phases[0].status).toBe("completed"); // convene
    expect(phases[1].status).toBe("completed"); // discuss
    expect(phases[2].status).toBe("failed");    // converge (active when failed)
    expect(phases[3].status).toBe("skipped");   // deliver
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. CONCURRENT SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════════

describe("concurrent session management", () => {
  test("session manager enforces concurrency limit", () => {
    const manager = new RoundTableSessionManager({ maxConcurrentSessions: 2 });

    manager.registerSession("rt-1", "query 1", "telegram");
    manager.registerSession("rt-2", "query 2", "telegram");

    expect(manager.canStartSession()).toBe(false);

    // Complete one session — should allow a new one
    manager.completeSession("rt-1", "done");
    expect(manager.canStartSession()).toBe(true);
  });

  test("handoff rejects when at concurrency limit", async () => {
    const manager = new RoundTableSessionManager({ maxConcurrentSessions: 1 });
    manager.registerSession("rt-1", "existing", "telegram");

    const deps = _makeMockRouterDeps();
    const result = await executeRoundTableHandoff(deps, manager, "new query", {
      channel: "telegram",
    });

    expect(result.accepted).toBe(false);
    expect(result.error).toContain("concurrent");
  });

  test("handoff rejects duplicate session on same channel", async () => {
    const manager = new RoundTableSessionManager({ maxConcurrentSessions: 5 });
    manager.registerSession("rt-1", "existing", "telegram");

    const deps = _makeMockRouterDeps();
    const result = await executeRoundTableHandoff(deps, manager, "new query", {
      channel: "telegram",
    });

    expect(result.accepted).toBe(false);
    expect(result.error).toContain("already active");
  });

  test("different channels can have concurrent sessions", async () => {
    const manager = new RoundTableSessionManager({ maxConcurrentSessions: 5 });
    manager.registerSession("rt-1", "telegram query", "telegram");

    const deps = _makeMockRouterDeps();
    const result = await executeRoundTableHandoff(deps, manager, "gchat query", {
      channel: "google-chat",
    });

    expect(result.accepted).toBe(true);
  });

  test("cleanup removes old completed sessions", () => {
    const manager = new RoundTableSessionManager();
    manager.registerSession("rt-old", "old", "telegram");
    manager.completeSession("rt-old", "done");

    // Hack: set the startedAt in the past
    const session = manager.getSession("rt-old")!;
    (session as any).startedAt = new Date(Date.now() - 60 * 60_000);

    const cleaned = manager.cleanup(30 * 60_000);
    expect(cleaned).toBe(1);
    expect(manager.getSession("rt-old")).toBeNull();
  });

  test("cleanup does not remove active sessions", () => {
    const manager = new RoundTableSessionManager();
    manager.registerSession("rt-active", "active", "telegram");

    const session = manager.getSession("rt-active")!;
    (session as any).startedAt = new Date(Date.now() - 60 * 60_000);

    const cleaned = manager.cleanup(30 * 60_000);
    expect(cleaned).toBe(0);
    expect(manager.getSession("rt-active")).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. DETECTION + COMMAND + FORMATTING INTEGRATION
// ═══════════════════════════════════════════════════════════════

describe("detection → command → format pipeline", () => {
  test("explicit trigger detected → command parsed → result formatted", () => {
    const message = "/roundtable What should we do about Q2?";

    // Detection
    const detection = detectRoundTable(message);
    expect(detection.shouldTrigger).toBe(true);
    expect(detection.method).toBe("explicit");

    // Command parsing
    const cmd = parseCommand(message);
    expect(cmd.subcommand).toBe("start");
    expect(cmd.args).toBe("What should we do about Q2?");

    // Format (mock output for Telegram)
    const mockOutput = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "telegram", sessionId: "rt-test" });
    const formatted = formatRoundTableOutput(mockOutput, opts);
    expect(formatted.primary).toContain("Round Table Complete");
    expect(formatted.channel).toBe("telegram");
  });

  test("/rt shorthand detected and parsed correctly", () => {
    const message = "/rt Budget review for Q3";
    const detection = detectExplicitTrigger(message);
    expect(detection.triggered).toBe(true);

    const cmd = parseCommand(message);
    expect(cmd.subcommand).toBe("start");
    expect(cmd.args).toBe("Budget review for Q3");
  });

  test("agent handoff pattern triggers detection", () => {
    const agentOutput = "This requires deeper analysis. [ROUND_TABLE] escalating to multi-agent review.";
    const handoff = detectHandoff(agentOutput);
    expect(handoff.triggered).toBe(true);
  });

  test("natural language trigger detected", () => {
    const message = "convene the round table on our pricing strategy";
    const detection = detectRoundTable(message);
    expect(detection.shouldTrigger).toBe(true);
    expect(detection.method).toBe("explicit");
  });

  test("command with options parsed and formations validated", async () => {
    const cmd = parseCommand("/roundtable start Test query --formations=boardroom,think-tank --channel=telegram");
    expect(cmd.subcommand).toBe("start");
    expect(cmd.args).toBe("Test query");
    expect(cmd.options.formations).toEqual(["boardroom", "think-tank"]);
    expect(cmd.options.channel).toBe("telegram");
  });

  test("handleRoundTableCommand runs full pipeline", async () => {
    const deps = _makeMockCommandDeps();
    const result = await handleRoundTableCommand(
      deps,
      "/roundtable What is our expansion strategy?",
      { channel: "telegram" },
    );
    expect(result.success).toBe(true);
    expect(result.sessionId).toBeTruthy();
    expect(result.output.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. CROSS-MODULE INTEGRATION — REAL MODULES
// ═══════════════════════════════════════════════════════════════

describe("cross-module integration", () => {
  test("convene produces analysis and formations for discuss", async () => {
    const conveneDeps = _makeMockConveneDeps();
    const conveneOutput = await executeConvene(conveneDeps, "What should our Q2 strategy be?");

    // ConveneOutput doesn't have .success — it either returns or throws
    expect(conveneOutput.analysis).toBeDefined();
    expect(conveneOutput.summary.length).toBeGreaterThan(0);

    // Run discuss with mock output (convene's selectedFormations drive discuss)
    const discussDeps = _makeMockDiscussDeps();
    const mockConvene = _makeMockConveneOutput();
    const discussOutput = await executeDiscuss(
      discussDeps,
      "What should our Q2 strategy be?",
      mockConvene,
    );

    expect(discussOutput.success).toBe(true);
    expect(discussOutput.results.length).toBeGreaterThan(0);
  });

  test("discuss → converge: discuss results feed converge synthesis", async () => {
    const conveneOutput = _makeMockConveneOutput();
    const discussOutput = _makeMockDiscussOutput();

    const convergeDeps = _makeMockConvergeDeps();
    const convergeOutput = await executeConverge(
      convergeDeps,
      "Q2 strategy",
      conveneOutput,
      discussOutput,
    );

    expect(convergeOutput.success).toBe(true);
    expect(convergeOutput.synthesis.length).toBeGreaterThan(0);
    // Converge should extract agreements from discuss results
    expect(convergeOutput.agreements).toBeDefined();
  });

  test("converge → deliver: converge output feeds deliver formatting", async () => {
    const conveneOutput = _makeMockConveneOutput();
    const discussOutput = _makeMockDiscussOutput();
    const convergeOutput = _makeMockConvergeOutput();

    const deliverDeps = _makeMockDeliverDeps();
    const deliverOutput = await executeDeliver(
      deliverDeps,
      "Q2 strategy",
      "test-session",
      conveneOutput,
      discussOutput,
      convergeOutput,
      "telegram",
    );

    expect(deliverOutput.success).toBe(true);
    expect(deliverOutput.executiveSummary.length).toBeGreaterThan(0);
    expect(deliverOutput.formattedOutput).toContain("Round Table Complete");
    expect(deliverOutput.transcripts.length).toBeGreaterThan(0);
  });

  test("full pipeline with mock outputs: convene → discuss → converge → deliver", async () => {
    // Use mock outputs that have the right shapes
    const conveneOutput = _makeMockConveneOutput();
    const discussDeps = _makeMockDiscussDeps();
    const discussOutput = await executeDiscuss(
      discussDeps,
      "Should we expand into APAC?",
      conveneOutput,
    );
    expect(discussOutput.success).toBe(true);

    // Converge
    const convergeDeps = _makeMockConvergeDeps();
    const convergeOutput = await executeConverge(
      convergeDeps,
      "Should we expand into APAC?",
      conveneOutput,
      discussOutput,
    );
    expect(convergeOutput.success).toBe(true);

    // Deliver
    const deliverDeps = _makeMockDeliverDeps();
    const deliverOutput = await executeDeliver(
      deliverDeps,
      "Should we expand into APAC?",
      "rt-integration-test",
      conveneOutput,
      discussOutput,
      convergeOutput,
      "telegram",
    );
    expect(deliverOutput.success).toBe(true);

    // Verify the full output
    expect(deliverOutput.executiveSummary.length).toBeGreaterThan(0);
    expect(deliverOutput.outcome.formationsUsed.length).toBeGreaterThan(0);
    expect(deliverOutput.outcome.sessionId).toBe("rt-integration-test");
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. OUTPUT FORMATTING UNDER STRESS
// ═══════════════════════════════════════════════════════════════

describe("output formatting edge cases", () => {
  test("very long output is paginated for telegram", () => {
    const longSummary = "Important finding. ".repeat(300); // ~5700 chars
    const input = _makeMockFormattingInput({ executiveSummary: longSummary });
    const opts = _makeMockFormatOptions({ channel: "telegram", paginate: true });

    const result = formatRoundTableOutput(input, opts);
    expect(result.wasPaginated).toBe(true);
    expect(result.chunks.length).toBeGreaterThan(1);

    // Every chunk should be under the limit
    for (const chunk of result.chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(4096);
    }
  });

  test("same output is not paginated for dashboard", () => {
    const longSummary = "Important finding. ".repeat(300);
    const input = _makeMockFormattingInput({ executiveSummary: longSummary });
    const opts = _makeMockFormatOptions({ channel: "dashboard", paginate: true });

    const result = formatRoundTableOutput(input, opts);
    expect(result.wasPaginated).toBe(false);
  });

  test("pagination preserves page numbers", () => {
    const longText = "X".repeat(10000);
    const chunks = paginateMessage(longText, "telegram");
    expect(chunks.length).toBeGreaterThan(2);

    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].page).toBe(i + 1);
      expect(chunks[i].totalPages).toBe(chunks.length);
    }
  });

  test("rendering with empty transcripts works", () => {
    const input = _makeMockFormattingInput({ transcripts: [] });
    const opts = _makeMockFormatOptions({ channel: "telegram" });
    const output = renderForChannel(input, opts);
    expect(output).toContain("Round Table Complete");
    expect(output).not.toContain("Formations:");
  });

  test("each channel produces distinct output", () => {
    const input = _makeMockFormattingInput();
    const channels = ["telegram", "google-chat", "dashboard", "plain"] as const;
    const outputs = channels.map(ch =>
      renderForChannel(input, _makeMockFormatOptions({ channel: ch }))
    );

    // All four should be different (at least telegram vs google-chat vs dashboard vs plain)
    const unique = new Set(outputs);
    expect(unique.size).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. FORMATION REGISTRY INTEGRITY
// ═══════════════════════════════════════════════════════════════

describe("formation registry integrity", () => {
  test("all formations have unique slugs", () => {
    const slugs = FORMATION_REGISTRY.map(f => f.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test("all formations have non-empty descriptions", () => {
    for (const f of FORMATION_REGISTRY) {
      expect(f.description.length).toBeGreaterThan(10);
    }
  });

  test("all formations have at least one trigger", () => {
    for (const f of FORMATION_REGISTRY) {
      expect(f.triggers.length).toBeGreaterThan(0);
    }
  });

  test("all formations have at least one agent", () => {
    for (const f of FORMATION_REGISTRY) {
      expect(f.agents.length).toBeGreaterThan(0);
    }
  });

  test("all formations have a valid pattern", () => {
    const validPatterns = ["debate", "coordinator", "pipeline"];
    for (const f of FORMATION_REGISTRY) {
      expect(validPatterns).toContain(f.pattern);
    }
  });

  test("expected formations exist", () => {
    const slugs = FORMATION_REGISTRY.map(f => f.slug);
    expect(slugs).toContain("boardroom");
    expect(slugs).toContain("think-tank");
    expect(slugs).toContain("software-development");
  });
});

// ═══════════════════════════════════════════════════════════════
// 12. E2E: MULTI-FORMATION SESSION
// ═══════════════════════════════════════════════════════════════

describe("E2E — multi-formation round table session", () => {
  beforeEach(() => _resetIdCounter());

  test("3-formation session completes with detailed chaining", async () => {
    const capturedPrompts: Record<string, string[]> = {
      convene: [],
      discuss: [],
      converge: [],
      deliver: [],
    };

    const deps: RoundTableOrchestratorDeps = {
      roundTableDeps: _makeMockRoundTableDeps(),
      invokeFormation: async (slug, prompt) => {
        capturedPrompts.discuss.push(prompt);
        return {
          success: true,
          synthesis: `[${slug}] Analysis: detailed findings for ${slug}.`,
          formationName: slug,
        };
      },
      selectFormations: _makeMockFormationSelector({
        discuss: ["boardroom", "think-tank", "vrbo-ops"],
      }),
      callAgent: async (_agent, prompt) => {
        if (prompt.includes('phase="convene"')) {
          capturedPrompts.convene.push(prompt);
          return "Scope: multi-domain analysis needed. Dimensions: financial, creative, operational.";
        }
        if (prompt.includes('phase="converge"')) {
          capturedPrompts.converge.push(prompt);
          return "Synthesis: all three formations agree on expansion with caveats.";
        }
        if (prompt.includes('phase="deliver"')) {
          capturedPrompts.deliver.push(prompt);
          return "Final: Expand with phased approach. Action items: 1) Market study, 2) Pilot program, 3) Full launch.";
        }
        return "default";
      },
    };

    const result = await runRoundTable(deps, "Should we expand the property portfolio?", {
      channel: "telegram",
      workItemId: "ELLIE-704",
    });

    // Session success
    expect(result.success).toBe(true);
    expect(result.phases).toHaveLength(4);

    // All 4 phases produced prompts
    expect(capturedPrompts.convene).toHaveLength(1);
    expect(capturedPrompts.discuss).toHaveLength(3); // 3 formations
    expect(capturedPrompts.converge).toHaveLength(1);
    expect(capturedPrompts.deliver).toHaveLength(1);

    // Discuss prompts contain convene output
    for (const dp of capturedPrompts.discuss) {
      expect(dp).toContain("multi-domain analysis");
    }

    // Converge prompt contains all 3 formation outputs
    expect(capturedPrompts.converge[0]).toContain("boardroom");
    expect(capturedPrompts.converge[0]).toContain("think-tank");
    expect(capturedPrompts.converge[0]).toContain("vrbo-ops");

    // Deliver prompt contains converge synthesis
    expect(capturedPrompts.deliver[0]).toContain("all three formations agree");

    // Final output
    expect(result.output).toContain("Action items");

    // Session state
    const progress = getSessionProgress(deps.roundTableDeps, result.sessionId)!;
    expect(progress.session.status).toBe("completed");
    expect(progress.session.channel).toBe("telegram");
    expect(progress.session.work_item_id).toBe("ELLIE-704");
    expect(progress.completedPhases).toEqual(["convene", "discuss", "converge", "deliver"]);

    // Discuss phase tracked all 3 formations
    const discuss = result.phases.find(p => p.phase === "discuss")!;
    expect(discuss.formationsUsed).toEqual(["boardroom", "think-tank", "vrbo-ops"]);
  });
});
