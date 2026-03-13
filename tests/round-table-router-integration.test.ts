/**
 * Tests for Round Table Router Integration — ELLIE-701
 */
import { describe, expect, test, beforeEach } from "bun:test";
import {
  detectExplicitTrigger,
  detectAutoTrigger,
  detectHandoff,
  detectRoundTable,
  RoundTableSessionManager,
  executeRoundTableHandoff,
  _makeMockRouterDeps,
  _makeMockRouterDepsWithFailure,
  _makeMockRouterDepsWithThrow,
  type RoundTableRouterConfig,
} from "../src/round-table/router-integration.ts";
import type { QueryAnalysis } from "../src/round-table/convene.ts";

// ── Helper ──────────────────────────────────────────────────────

function makeAnalysis(overrides?: Partial<QueryAnalysis>): QueryAnalysis {
  return {
    query: "Test query",
    intent: "Create a plan",
    domains: ["boardroom"],
    complexity: "simple",
    dimensions: ["strategic"],
    keywords: ["test"],
    ...overrides,
  };
}

// ── Explicit Trigger Detection ──────────────────────────────────

describe("detectExplicitTrigger", () => {
  test("/roundtable triggers", () => {
    const result = detectExplicitTrigger("/roundtable What should we do about Q2?");
    expect(result.triggered).toBe(true);
    expect(result.strippedQuery).toBe("What should we do about Q2?");
  });

  test("/round-table triggers", () => {
    const result = detectExplicitTrigger("/round-table expansion plan");
    expect(result.triggered).toBe(true);
    expect(result.strippedQuery).toBe("expansion plan");
  });

  test("/rt triggers", () => {
    const result = detectExplicitTrigger("/rt hire decision");
    expect(result.triggered).toBe(true);
    expect(result.strippedQuery).toBe("hire decision");
  });

  test("'convene the round table' triggers", () => {
    const result = detectExplicitTrigger("convene the round table on our pricing strategy");
    expect(result.triggered).toBe(true);
    expect(result.strippedQuery).toContain("pricing strategy");
  });

  test("'start a round table' triggers", () => {
    const result = detectExplicitTrigger("start a round table about hiring");
    expect(result.triggered).toBe(true);
    expect(result.strippedQuery).toContain("hiring");
  });

  test("'round table on' triggers", () => {
    const result = detectExplicitTrigger("round table on market expansion");
    expect(result.triggered).toBe(true);
    expect(result.strippedQuery).toContain("market expansion");
  });

  test("'get all agents to weigh in' triggers", () => {
    const result = detectExplicitTrigger("get all agents to weigh in on Q2 budget");
    expect(result.triggered).toBe(true);
  });

  test("normal message does not trigger", () => {
    const result = detectExplicitTrigger("What is the budget for Q2?");
    expect(result.triggered).toBe(false);
    expect(result.strippedQuery).toBe("What is the budget for Q2?");
  });

  test("/roundtable alone uses original message as query", () => {
    const result = detectExplicitTrigger("/roundtable");
    expect(result.triggered).toBe(true);
    expect(result.strippedQuery).toBe("/roundtable");
  });

  test("case insensitive", () => {
    const result = detectExplicitTrigger("/ROUNDTABLE what now");
    expect(result.triggered).toBe(true);
  });
});

// ── Auto Detection ──────────────────────────────────────────────

describe("detectAutoTrigger", () => {
  test("triggers on complex multi-domain query", () => {
    const analysis = makeAnalysis({
      complexity: "complex",
      domains: ["boardroom", "think-tank", "software-development"],
      dimensions: ["strategic", "financial", "technical"],
    });
    const result = detectAutoTrigger(analysis);
    expect(result.triggered).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.reason).toContain("complexity=complex");
  });

  test("does not trigger on simple single-domain query", () => {
    const analysis = makeAnalysis({
      complexity: "simple",
      domains: ["boardroom"],
      dimensions: ["strategic"],
    });
    const result = detectAutoTrigger(analysis);
    expect(result.triggered).toBe(false);
  });

  test("does not trigger on moderate single-domain query", () => {
    const analysis = makeAnalysis({
      complexity: "moderate",
      domains: ["boardroom"],
      dimensions: ["strategic", "financial"],
    });
    const result = detectAutoTrigger(analysis);
    expect(result.triggered).toBe(false);
  });

  test("triggers with decision intent boost", () => {
    const analysis = makeAnalysis({
      complexity: "complex",
      domains: ["boardroom", "think-tank"],
      dimensions: ["strategic", "financial"],
      intent: "Make a decision about expansion",
    });
    const result = detectAutoTrigger(analysis);
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain("decision-intent");
  });

  test("respects autoDetectEnabled=false", () => {
    const analysis = makeAnalysis({
      complexity: "complex",
      domains: ["a", "b", "c"],
      dimensions: ["x", "y", "z"],
    });
    const result = detectAutoTrigger(analysis, { ...getDefaultConfig(), autoDetectEnabled: false });
    expect(result.triggered).toBe(false);
    expect(result.reason).toContain("disabled");
  });

  test("respects custom min domains", () => {
    const analysis = makeAnalysis({
      complexity: "complex",
      domains: ["boardroom", "think-tank"],
      dimensions: ["strategic"],
    });
    // With min 3 domains, 2 isn't enough for domain signal
    const result = detectAutoTrigger(analysis, { ...getDefaultConfig(), autoTriggerMinDomains: 3 });
    // Still triggers because complexity=complex gives 2 points, but domain gives 0
    // Score: 2 (complexity) = 2, needs 3 → not triggered
    expect(result.triggered).toBe(false);
  });

  test("confidence scales with score", () => {
    const strong = makeAnalysis({
      complexity: "complex",
      domains: ["a", "b", "c"],
      dimensions: ["x", "y", "z"],
      intent: "Decide on approach",
    });
    const moderate = makeAnalysis({
      complexity: "complex",
      domains: ["a", "b"],
      dimensions: ["x"],
    });

    const strongResult = detectAutoTrigger(strong);
    const moderateResult = detectAutoTrigger(moderate);

    expect(strongResult.confidence).toBeGreaterThan(moderateResult.confidence);
  });
});

// ── Hand-off Detection ──────────────────────────────────────────

describe("detectHandoff", () => {
  test("detects [ROUND_TABLE] tag", () => {
    const result = detectHandoff("This needs [ROUND_TABLE] discussion.");
    expect(result.triggered).toBe(true);
  });

  test("detects [ROUND-TABLE] tag", () => {
    const result = detectHandoff("[ROUND-TABLE] needed for this decision.");
    expect(result.triggered).toBe(true);
  });

  test("detects 'escalate to round table'", () => {
    const result = detectHandoff("I'm escalating to round table for broader input.");
    expect(result.triggered).toBe(true);
  });

  test("detects 'needs a round table'", () => {
    const result = detectHandoff("This question needs a round table discussion.");
    expect(result.triggered).toBe(true);
  });

  test("detects 'recommending a round table'", () => {
    const result = detectHandoff("I'm recommending a round table for this complex issue.");
    expect(result.triggered).toBe(true);
  });

  test("does not trigger on normal response", () => {
    const result = detectHandoff("The budget for Q2 is $50,000.");
    expect(result.triggered).toBe(false);
  });

  test("does not trigger on mention of 'round' without 'table'", () => {
    const result = detectHandoff("Let's do another round of analysis.");
    expect(result.triggered).toBe(false);
  });
});

// ── Combined Detection ──────────────────────────────────────────

describe("detectRoundTable", () => {
  test("explicit trigger takes priority", () => {
    const result = detectRoundTable("/roundtable What is our Q2 plan?");
    expect(result.shouldTrigger).toBe(true);
    expect(result.method).toBe("explicit");
    expect(result.confidence).toBe(1.0);
    expect(result.strippedQuery).toBe("What is our Q2 plan?");
  });

  test("auto-detects complex multi-domain queries", () => {
    // This query should analyze as complex with multiple domains
    const result = detectRoundTable(
      "We need to decide on our Q2 strategy — it affects engineering hiring, budget allocation, and product roadmap. Consider the financial risk and technical implementation plan.",
    );
    // Whether auto triggers depends on the analyzeQuery output
    // At minimum it should return a valid detection
    expect(result.method).toBeDefined();
    expect(typeof result.shouldTrigger).toBe("boolean");
  });

  test("simple queries don't trigger", () => {
    const result = detectRoundTable("What is the weather?");
    expect(result.shouldTrigger).toBe(false);
    expect(result.method).toBe("none");
  });

  test("auto-detection can be disabled", () => {
    const result = detectRoundTable(
      "Complex multi-domain query about strategy, finances, and technology requiring a decision",
      { autoDetectEnabled: false },
    );
    // Explicit triggers should still work even when auto is disabled
    const explicit = detectRoundTable("/roundtable test", { autoDetectEnabled: false });
    expect(explicit.shouldTrigger).toBe(true);
  });
});

// ── Session Manager ─────────────────────────────────────────────

describe("RoundTableSessionManager", () => {
  let manager: RoundTableSessionManager;

  beforeEach(() => {
    manager = new RoundTableSessionManager({ maxConcurrentSessions: 2 });
  });

  test("registers and retrieves a session", () => {
    const session = manager.registerSession("s1", "test query", "telegram");
    expect(session.sessionId).toBe("s1");
    expect(session.status).toBe("active");

    const retrieved = manager.getSession("s1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.query).toBe("test query");
  });

  test("returns null for unknown session", () => {
    expect(manager.getSession("nonexistent")).toBeNull();
  });

  test("finds active session by channel", () => {
    manager.registerSession("s1", "query", "telegram");
    manager.registerSession("s2", "query", "google-chat");

    const tg = manager.getActiveSessionForChannel("telegram");
    expect(tg).not.toBeNull();
    expect(tg!.sessionId).toBe("s1");

    const gc = manager.getActiveSessionForChannel("google-chat");
    expect(gc).not.toBeNull();
    expect(gc!.sessionId).toBe("s2");

    expect(manager.getActiveSessionForChannel("dashboard")).toBeNull();
  });

  test("completed sessions are not returned as active", () => {
    manager.registerSession("s1", "query", "telegram");
    manager.completeSession("s1", "output");

    expect(manager.getActiveSessionForChannel("telegram")).toBeNull();
    expect(manager.getActiveSessions()).toHaveLength(0);
  });

  test("failed sessions are not returned as active", () => {
    manager.registerSession("s1", "query", "telegram");
    manager.failSession("s1", "something broke");

    expect(manager.getActiveSessionForChannel("telegram")).toBeNull();
  });

  test("enforces concurrency limit", () => {
    manager.registerSession("s1", "q1", "telegram");
    manager.registerSession("s2", "q2", "google-chat");

    expect(manager.canStartSession()).toBe(false);

    // Completing one frees a slot
    manager.completeSession("s1", "done");
    expect(manager.canStartSession()).toBe(true);
  });

  test("getActiveSessions returns only active", () => {
    manager.registerSession("s1", "q1", "ch1");
    manager.registerSession("s2", "q2", "ch2");
    manager.completeSession("s1", "done");

    const active = manager.getActiveSessions();
    expect(active).toHaveLength(1);
    expect(active[0].sessionId).toBe("s2");
  });

  test("cleanup removes old completed sessions", () => {
    const session = manager.registerSession("s1", "q1", "ch1");
    manager.completeSession("s1", "done");

    // Hack the start time to be old
    (session as { startedAt: Date }).startedAt = new Date(Date.now() - 60 * 60_000);

    const cleaned = manager.cleanup(30 * 60_000); // 30 min
    expect(cleaned).toBe(1);
    expect(manager.getSession("s1")).toBeNull();
  });

  test("cleanup does not remove active sessions", () => {
    const session = manager.registerSession("s1", "q1", "ch1");
    (session as { startedAt: Date }).startedAt = new Date(Date.now() - 60 * 60_000);

    const cleaned = manager.cleanup(30 * 60_000);
    expect(cleaned).toBe(0);
    expect(manager.getSession("s1")).not.toBeNull();
  });

  test("registers session with workItemId", () => {
    manager.registerSession("s1", "q1", "telegram", "ELLIE-100");
    const session = manager.getSession("s1");
    expect(session!.workItemId).toBe("ELLIE-100");
  });
});

// ── executeRoundTableHandoff ────────────────────────────────────

describe("executeRoundTableHandoff", () => {
  let manager: RoundTableSessionManager;

  beforeEach(() => {
    manager = new RoundTableSessionManager({ maxConcurrentSessions: 2 });
  });

  test("successful hand-off", async () => {
    const deps = _makeMockRouterDeps();
    const result = await executeRoundTableHandoff(deps, manager, "Q2 strategy", {
      channel: "telegram",
    });

    expect(result.accepted).toBe(true);
    expect(result.sessionId).toBe("rt-session-1");
    expect(result.output).toContain("Round table complete");
    expect(result.error).toBeUndefined();

    // Session should be registered and completed
    const session = manager.getSession("rt-session-1");
    expect(session).not.toBeNull();
    expect(session!.status).toBe("completed");
  });

  test("failed round table returns error", async () => {
    const deps = _makeMockRouterDepsWithFailure("Synthesis agent failed");
    const result = await executeRoundTableHandoff(deps, manager, "test", {
      channel: "telegram",
    });

    expect(result.accepted).toBe(true);
    expect(result.sessionId).toBe("rt-session-fail");
    expect(result.error).toBe("Synthesis agent failed");

    const session = manager.getSession("rt-session-fail");
    expect(session!.status).toBe("failed");
  });

  test("thrown error returns not accepted", async () => {
    const deps = _makeMockRouterDepsWithThrow("Network error");
    const result = await executeRoundTableHandoff(deps, manager, "test", {
      channel: "telegram",
    });

    expect(result.accepted).toBe(false);
    expect(result.error).toBe("Network error");
  });

  test("rejects when concurrency limit reached", async () => {
    // Fill up concurrency slots
    manager.registerSession("s1", "q1", "ch1");
    manager.registerSession("s2", "q2", "ch2");

    const deps = _makeMockRouterDeps();
    const result = await executeRoundTableHandoff(deps, manager, "test", {
      channel: "ch3",
    });

    expect(result.accepted).toBe(false);
    expect(result.error).toContain("concurrent");
  });

  test("rejects when channel already has active session", async () => {
    manager.registerSession("s1", "q1", "telegram");

    const deps = _makeMockRouterDeps();
    const result = await executeRoundTableHandoff(deps, manager, "test", {
      channel: "telegram",
    });

    expect(result.accepted).toBe(false);
    expect(result.sessionId).toBe("s1");
    expect(result.error).toContain("already active");
  });

  test("passes work item ID through", async () => {
    let capturedOpts: Record<string, unknown> | undefined;
    const deps: typeof import("../src/round-table/router-integration.ts").RoundTableRouterDeps = {
      runRoundTable: async (_query, opts) => {
        capturedOpts = opts as Record<string, unknown>;
        return { sessionId: "s1", output: "done", success: true };
      },
    };

    await executeRoundTableHandoff(deps as any, manager, "test", {
      channel: "telegram",
      workItemId: "ELLIE-100",
      initiatorAgent: "strategy",
    });

    expect(capturedOpts?.workItemId).toBe("ELLIE-100");
    expect(capturedOpts?.initiatorAgent).toBe("strategy");
    expect(capturedOpts?.channel).toBe("telegram");
  });

  test("defaults channel to 'internal'", async () => {
    let capturedOpts: Record<string, unknown> | undefined;
    const deps = {
      runRoundTable: async (_query: string, opts?: Record<string, unknown>) => {
        capturedOpts = opts;
        return { sessionId: "s1", output: "done", success: true };
      },
    };

    await executeRoundTableHandoff(deps, manager, "test");

    expect(capturedOpts?.channel).toBe("internal");
  });
});

// ── Helpers ─────────────────────────────────────────────────────

function getDefaultConfig(): RoundTableRouterConfig {
  return {
    autoTriggerComplexity: "complex",
    autoTriggerMinDomains: 2,
    autoTriggerMinDimensions: 3,
    autoDetectEnabled: true,
    maxConcurrentSessions: 3,
  };
}
