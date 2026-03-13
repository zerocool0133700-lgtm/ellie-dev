/**
 * Round Table Session Schema Tests — ELLIE-694
 *
 * Tests cover:
 *   - Phase state machine (transitions, ordering, validation)
 *   - Session state machine (transitions, validation)
 *   - Core types (shape verification)
 *   - Lifecycle management (create, start, advance, complete, fail, timeout)
 *   - Mock helpers
 *   - Migration SQL validation
 *   - E2E (full session lifecycle)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  // Phase state machine
  ROUND_TABLE_PHASES,
  PHASE_TRANSITIONS,
  isValidPhaseTransition,
  getNextPhase,
  getPhaseIndex,
  isValidPhaseType,
  // Session state machine
  ROUND_TABLE_SESSION_STATES,
  SESSION_STATE_TRANSITIONS,
  isValidSessionTransition,
  isValidSessionState,
  // Phase states
  ROUND_TABLE_PHASE_STATES,
  // Lifecycle
  createSession,
  startSession,
  advancePhase,
  failSession,
  timeoutSession,
  getSessionProgress,
  // Mock helpers
  _resetIdCounter,
  _makeMockSessionStore,
  _makeMockPhaseStore,
  _makeMockDeps,
  // Types
  type RoundTableSession,
  type RoundTablePhase,
  type RoundTablePhaseType,
  type RoundTableSessionState,
  type RoundTablePhaseState,
  type CreateRoundTableOpts,
  type RoundTableDeps,
} from "../src/types/round-table.ts";

// ── Phase State Machine ────────────────────────────────────────

describe("round table — phase state machine", () => {
  it("has 4 phases in correct order", () => {
    expect(ROUND_TABLE_PHASES).toEqual(["convene", "discuss", "converge", "deliver"]);
  });

  it("convene → discuss is valid", () => {
    expect(isValidPhaseTransition("convene", "discuss")).toBe(true);
  });

  it("discuss → converge is valid", () => {
    expect(isValidPhaseTransition("discuss", "converge")).toBe(true);
  });

  it("converge → deliver is valid", () => {
    expect(isValidPhaseTransition("converge", "deliver")).toBe(true);
  });

  it("deliver has no next phase (terminal)", () => {
    expect(getNextPhase("deliver")).toBeNull();
    expect(PHASE_TRANSITIONS["deliver"]).toBeNull();
  });

  it("rejects invalid transitions (skipping phases)", () => {
    expect(isValidPhaseTransition("convene", "converge")).toBe(false);
    expect(isValidPhaseTransition("convene", "deliver")).toBe(false);
    expect(isValidPhaseTransition("discuss", "deliver")).toBe(false);
  });

  it("rejects backward transitions", () => {
    expect(isValidPhaseTransition("discuss", "convene")).toBe(false);
    expect(isValidPhaseTransition("deliver", "convene")).toBe(false);
    expect(isValidPhaseTransition("converge", "discuss")).toBe(false);
  });

  it("getNextPhase returns correct successor", () => {
    expect(getNextPhase("convene")).toBe("discuss");
    expect(getNextPhase("discuss")).toBe("converge");
    expect(getNextPhase("converge")).toBe("deliver");
    expect(getNextPhase("deliver")).toBeNull();
  });

  it("getPhaseIndex returns correct indices", () => {
    expect(getPhaseIndex("convene")).toBe(0);
    expect(getPhaseIndex("discuss")).toBe(1);
    expect(getPhaseIndex("converge")).toBe(2);
    expect(getPhaseIndex("deliver")).toBe(3);
  });

  it("isValidPhaseType accepts valid phases", () => {
    for (const phase of ROUND_TABLE_PHASES) {
      expect(isValidPhaseType(phase)).toBe(true);
    }
  });

  it("isValidPhaseType rejects invalid phases", () => {
    expect(isValidPhaseType("brainstorm")).toBe(false);
    expect(isValidPhaseType("")).toBe(false);
    expect(isValidPhaseType("CONVENE")).toBe(false);
  });
});

// ── Session State Machine ──────────────────────────────────────

describe("round table — session state machine", () => {
  it("has 5 session states", () => {
    expect(ROUND_TABLE_SESSION_STATES).toEqual([
      "pending", "active", "completed", "failed", "timed_out",
    ]);
  });

  it("pending → active is valid", () => {
    expect(isValidSessionTransition("pending", "active")).toBe(true);
  });

  it("pending → failed is valid", () => {
    expect(isValidSessionTransition("pending", "failed")).toBe(true);
  });

  it("active → completed is valid", () => {
    expect(isValidSessionTransition("active", "completed")).toBe(true);
  });

  it("active → failed is valid", () => {
    expect(isValidSessionTransition("active", "failed")).toBe(true);
  });

  it("active → timed_out is valid", () => {
    expect(isValidSessionTransition("active", "timed_out")).toBe(true);
  });

  it("completed is terminal (no valid transitions)", () => {
    expect(SESSION_STATE_TRANSITIONS["completed"]).toEqual([]);
    expect(isValidSessionTransition("completed", "active")).toBe(false);
    expect(isValidSessionTransition("completed", "failed")).toBe(false);
  });

  it("failed is terminal", () => {
    expect(SESSION_STATE_TRANSITIONS["failed"]).toEqual([]);
  });

  it("timed_out is terminal", () => {
    expect(SESSION_STATE_TRANSITIONS["timed_out"]).toEqual([]);
  });

  it("rejects backward transitions", () => {
    expect(isValidSessionTransition("active", "pending")).toBe(false);
    expect(isValidSessionTransition("completed", "active")).toBe(false);
  });

  it("isValidSessionState accepts valid states", () => {
    for (const state of ROUND_TABLE_SESSION_STATES) {
      expect(isValidSessionState(state)).toBe(true);
    }
  });

  it("isValidSessionState rejects invalid states", () => {
    expect(isValidSessionState("running")).toBe(false);
    expect(isValidSessionState("")).toBe(false);
  });
});

// ── Phase States ───────────────────────────────────────────────

describe("round table — phase states", () => {
  it("has 5 phase states", () => {
    expect(ROUND_TABLE_PHASE_STATES).toEqual([
      "pending", "active", "completed", "failed", "skipped",
    ]);
  });
});

// ── Mock Helpers ───────────────────────────────────────────────

describe("round table — mock helpers", () => {
  beforeEach(() => {
    _resetIdCounter();
  });

  it("_makeMockSessionStore creates sessions", () => {
    const store = _makeMockSessionStore();
    const session = store.create({
      query: "test query",
      initiator_agent: "strategy",
    });
    expect(session.id).toBe("test-1");
    expect(session.query).toBe("test query");
    expect(session.status).toBe("pending");
    expect(session.phases_completed).toBe(0);
    expect(session.current_phase).toBeNull();
  });

  it("_makeMockSessionStore get and update", () => {
    const store = _makeMockSessionStore();
    const session = store.create({
      query: "test",
      initiator_agent: "dev",
    });
    expect(store.get(session.id)).not.toBeNull();
    expect(store.get("nonexistent")).toBeNull();

    const updated = store.update(session.id, { status: "active" });
    expect(updated!.status).toBe("active");
    expect(store.update("nonexistent", {})).toBeNull();
  });

  it("_makeMockPhaseStore creates and queries phases", () => {
    const store = _makeMockPhaseStore();
    const p1 = store.create("sess-1", "convene");
    const p2 = store.create("sess-1", "discuss");
    store.create("sess-2", "convene");

    expect(p1.phase_type).toBe("convene");
    expect(p1.phase_order).toBe(0);
    expect(p2.phase_order).toBe(1);
    expect(p1.status).toBe("pending");

    const bySession = store.getBySession("sess-1");
    expect(bySession).toHaveLength(2);
    expect(bySession[0].phase_order).toBeLessThan(bySession[1].phase_order);

    const found = store.getBySessionAndType("sess-1", "convene");
    expect(found).not.toBeNull();
    expect(found!.phase_type).toBe("convene");

    expect(store.getBySessionAndType("sess-1", "deliver")).toBeNull();
  });

  it("_makeMockDeps creates combined deps", () => {
    const deps = _makeMockDeps();
    expect(deps.sessionStore).toBeDefined();
    expect(deps.phaseStore).toBeDefined();
  });

  it("_resetIdCounter resets counter", () => {
    const store = _makeMockSessionStore();
    store.create({ query: "a", initiator_agent: "x" });
    _resetIdCounter();
    const session = store.create({ query: "b", initiator_agent: "y" });
    expect(session.id).toBe("test-1");
  });
});

// ── Lifecycle: createSession ───────────────────────────────────

describe("round table — createSession", () => {
  let deps: RoundTableDeps;

  beforeEach(() => {
    _resetIdCounter();
    deps = _makeMockDeps();
  });

  it("creates a session in pending state", () => {
    const session = createSession(deps, {
      query: "What should our Q2 strategy be?",
      initiator_agent: "strategy",
    });
    expect(session.status).toBe("pending");
    expect(session.query).toBe("What should our Q2 strategy be?");
    expect(session.phases_completed).toBe(0);
    expect(session.current_phase).toBeNull();
  });

  it("pre-creates all four phase records", () => {
    const session = createSession(deps, {
      query: "test",
      initiator_agent: "dev",
    });
    const phases = deps.phaseStore.getBySession(session.id);
    expect(phases).toHaveLength(4);
    expect(phases.map(p => p.phase_type)).toEqual(["convene", "discuss", "converge", "deliver"]);
    expect(phases.every(p => p.status === "pending")).toBe(true);
  });

  it("passes optional fields through", () => {
    const session = createSession(deps, {
      query: "test",
      initiator_agent: "dev",
      channel: "telegram",
      work_item_id: "ELLIE-694",
      metadata: { source: "test" },
    });
    expect(session.channel).toBe("telegram");
    expect(session.work_item_id).toBe("ELLIE-694");
    expect(session.metadata).toEqual({ source: "test" });
  });
});

// ── Lifecycle: startSession ────────────────────────────────────

describe("round table — startSession", () => {
  let deps: RoundTableDeps;

  beforeEach(() => {
    _resetIdCounter();
    deps = _makeMockDeps();
  });

  it("moves session to active and activates convene phase", () => {
    const session = createSession(deps, {
      query: "test",
      initiator_agent: "dev",
    });

    const started = startSession(deps, session.id);
    expect(started.status).toBe("active");
    expect(started.current_phase).toBe("convene");

    const convene = deps.phaseStore.getBySessionAndType(session.id, "convene");
    expect(convene!.status).toBe("active");
  });

  it("throws if session not found", () => {
    expect(() => startSession(deps, "nonexistent")).toThrow("Session not found");
  });

  it("throws if session already active", () => {
    const session = createSession(deps, {
      query: "test",
      initiator_agent: "dev",
    });
    startSession(deps, session.id);
    expect(() => startSession(deps, session.id)).toThrow("Cannot start session");
  });
});

// ── Lifecycle: advancePhase ────────────────────────────────────

describe("round table — advancePhase", () => {
  let deps: RoundTableDeps;
  let sessionId: string;

  beforeEach(() => {
    _resetIdCounter();
    deps = _makeMockDeps();
    const session = createSession(deps, {
      query: "test",
      initiator_agent: "dev",
    });
    startSession(deps, session.id);
    sessionId = session.id;
  });

  it("completes convene and activates discuss", () => {
    const updated = advancePhase(deps, sessionId, "Convene output: agents identified");

    expect(updated.current_phase).toBe("discuss");
    expect(updated.phases_completed).toBe(1);

    const convene = deps.phaseStore.getBySessionAndType(sessionId, "convene");
    expect(convene!.status).toBe("completed");
    expect(convene!.output).toBe("Convene output: agents identified");

    const discuss = deps.phaseStore.getBySessionAndType(sessionId, "discuss");
    expect(discuss!.status).toBe("active");
    expect(discuss!.input).toBe("Convene output: agents identified");
  });

  it("passes formations_used through", () => {
    advancePhase(deps, sessionId, "output", ["boardroom", "research-panel"]);

    const convene = deps.phaseStore.getBySessionAndType(sessionId, "convene");
    expect(convene!.formations_used).toEqual(["boardroom", "research-panel"]);
  });

  it("completing deliver completes the session", () => {
    advancePhase(deps, sessionId, "convene done");
    advancePhase(deps, sessionId, "discuss done");
    advancePhase(deps, sessionId, "converge done");
    const final = advancePhase(deps, sessionId, "deliver done");

    expect(final.status).toBe("completed");
    expect(final.current_phase).toBeNull();
    expect(final.phases_completed).toBe(4);
    expect(final.completed_at).not.toBeNull();
  });

  it("throws if session not active", () => {
    const session2 = createSession(deps, {
      query: "test2",
      initiator_agent: "dev",
    });
    expect(() => advancePhase(deps, session2.id, "output")).toThrow(
      'Cannot advance phase in "pending" session',
    );
  });

  it("throws if session not found", () => {
    expect(() => advancePhase(deps, "nonexistent", "output")).toThrow("Session not found");
  });

  it("each phase receives previous phase output as input", () => {
    advancePhase(deps, sessionId, "convene-output");
    advancePhase(deps, sessionId, "discuss-output");
    advancePhase(deps, sessionId, "converge-output");

    const discuss = deps.phaseStore.getBySessionAndType(sessionId, "discuss");
    expect(discuss!.input).toBe("convene-output");

    const converge = deps.phaseStore.getBySessionAndType(sessionId, "converge");
    expect(converge!.input).toBe("discuss-output");

    const deliver = deps.phaseStore.getBySessionAndType(sessionId, "deliver");
    expect(deliver!.input).toBe("converge-output");
  });
});

// ── Lifecycle: failSession ─────────────────────────────────────

describe("round table — failSession", () => {
  let deps: RoundTableDeps;

  beforeEach(() => {
    _resetIdCounter();
    deps = _makeMockDeps();
  });

  it("fails an active session", () => {
    const session = createSession(deps, {
      query: "test",
      initiator_agent: "dev",
    });
    startSession(deps, session.id);

    const failed = failSession(deps, session.id, "Formation crashed");
    expect(failed.status).toBe("failed");
    expect(failed.current_phase).toBeNull();
    expect(failed.completed_at).not.toBeNull();
    expect(failed.metadata).toEqual({ failureReason: "Formation crashed" });
  });

  it("fails the current phase and skips remaining", () => {
    const session = createSession(deps, {
      query: "test",
      initiator_agent: "dev",
    });
    startSession(deps, session.id);
    advancePhase(deps, session.id, "convene done");
    // Now in discuss phase
    failSession(deps, session.id, "Error in discuss");

    const phases = deps.phaseStore.getBySession(session.id);
    expect(phases[0].status).toBe("completed"); // convene
    expect(phases[1].status).toBe("failed"); // discuss
    expect(phases[2].status).toBe("skipped"); // converge
    expect(phases[3].status).toBe("skipped"); // deliver
  });

  it("can fail a pending session", () => {
    const session = createSession(deps, {
      query: "test",
      initiator_agent: "dev",
    });
    const failed = failSession(deps, session.id, "Never started");
    expect(failed.status).toBe("failed");
  });

  it("throws if session already completed", () => {
    const session = createSession(deps, {
      query: "test",
      initiator_agent: "dev",
    });
    startSession(deps, session.id);
    advancePhase(deps, session.id, "1");
    advancePhase(deps, session.id, "2");
    advancePhase(deps, session.id, "3");
    advancePhase(deps, session.id, "4");

    expect(() => failSession(deps, session.id, "too late")).toThrow(
      'Cannot fail session in "completed" state',
    );
  });
});

// ── Lifecycle: timeoutSession ──────────────────────────────────

describe("round table — timeoutSession", () => {
  let deps: RoundTableDeps;

  beforeEach(() => {
    _resetIdCounter();
    deps = _makeMockDeps();
  });

  it("times out an active session", () => {
    const session = createSession(deps, {
      query: "test",
      initiator_agent: "dev",
    });
    startSession(deps, session.id);

    const timedOut = timeoutSession(deps, session.id);
    expect(timedOut.status).toBe("timed_out");
    expect(timedOut.current_phase).toBeNull();
    expect(timedOut.completed_at).not.toBeNull();
  });

  it("fails current phase and skips remaining", () => {
    const session = createSession(deps, {
      query: "test",
      initiator_agent: "dev",
    });
    startSession(deps, session.id);
    advancePhase(deps, session.id, "convene done");
    // In discuss phase
    timeoutSession(deps, session.id);

    const phases = deps.phaseStore.getBySession(session.id);
    expect(phases[0].status).toBe("completed");
    expect(phases[1].status).toBe("failed");
    expect(phases[1].output).toBe("Phase timed out");
    expect(phases[2].status).toBe("skipped");
    expect(phases[3].status).toBe("skipped");
  });

  it("throws if session already completed", () => {
    const session = createSession(deps, {
      query: "test",
      initiator_agent: "dev",
    });
    startSession(deps, session.id);
    advancePhase(deps, session.id, "1");
    advancePhase(deps, session.id, "2");
    advancePhase(deps, session.id, "3");
    advancePhase(deps, session.id, "4");

    expect(() => timeoutSession(deps, session.id)).toThrow(
      'Cannot timeout session in "completed" state',
    );
  });
});

// ── Lifecycle: getSessionProgress ──────────────────────────────

describe("round table — getSessionProgress", () => {
  let deps: RoundTableDeps;

  beforeEach(() => {
    _resetIdCounter();
    deps = _makeMockDeps();
  });

  it("returns null for missing session", () => {
    expect(getSessionProgress(deps, "nonexistent")).toBeNull();
  });

  it("returns progress for a new session", () => {
    const session = createSession(deps, {
      query: "test",
      initiator_agent: "dev",
    });
    const progress = getSessionProgress(deps, session.id)!;
    expect(progress.session.status).toBe("pending");
    expect(progress.phases).toHaveLength(4);
    expect(progress.completedPhases).toEqual([]);
    expect(progress.currentPhase).toBeNull();
    expect(progress.progress).toBe("0/4 phases");
  });

  it("returns progress mid-session", () => {
    const session = createSession(deps, {
      query: "test",
      initiator_agent: "dev",
    });
    startSession(deps, session.id);
    advancePhase(deps, session.id, "convene done");
    advancePhase(deps, session.id, "discuss done");

    const progress = getSessionProgress(deps, session.id)!;
    expect(progress.session.status).toBe("active");
    expect(progress.completedPhases).toEqual(["convene", "discuss"]);
    expect(progress.currentPhase!.phase_type).toBe("converge");
    expect(progress.progress).toBe("2/4 phases");
  });

  it("returns progress for completed session", () => {
    const session = createSession(deps, {
      query: "test",
      initiator_agent: "dev",
    });
    startSession(deps, session.id);
    advancePhase(deps, session.id, "1");
    advancePhase(deps, session.id, "2");
    advancePhase(deps, session.id, "3");
    advancePhase(deps, session.id, "4");

    const progress = getSessionProgress(deps, session.id)!;
    expect(progress.session.status).toBe("completed");
    expect(progress.completedPhases).toHaveLength(4);
    expect(progress.currentPhase).toBeNull();
    expect(progress.progress).toBe("4/4 phases");
  });
});

// ── Type Shape Verification ────────────────────────────────────

describe("round table — type shapes", () => {
  beforeEach(() => {
    _resetIdCounter();
  });

  it("RoundTableSession has all expected fields", () => {
    const deps = _makeMockDeps();
    const session = createSession(deps, {
      query: "test",
      initiator_agent: "dev",
      channel: "telegram",
      work_item_id: "ELLIE-694",
    });

    const keys = Object.keys(session).sort();
    expect(keys).toEqual([
      "channel",
      "completed_at",
      "created_at",
      "current_phase",
      "id",
      "initiator_agent",
      "metadata",
      "phases_completed",
      "query",
      "status",
      "updated_at",
      "work_item_id",
    ]);
  });

  it("RoundTablePhase has all expected fields", () => {
    const store = _makeMockPhaseStore();
    const phase = store.create("sess-1", "convene");

    const keys = Object.keys(phase).sort();
    expect(keys).toEqual([
      "completed_at",
      "created_at",
      "formations_used",
      "id",
      "input",
      "metadata",
      "output",
      "phase_order",
      "phase_type",
      "session_id",
      "status",
      "updated_at",
    ]);
  });
});

// ── Migration SQL Validation ───────────────────────────────────

describe("round table — migration SQL", () => {
  const sql = readFileSync(
    join(import.meta.dir, "../migrations/supabase/20260313_round_table_tables.sql"),
    "utf-8",
  );

  it("creates round_table_sessions table", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS round_table_sessions");
  });

  it("creates round_table_phases table", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS round_table_phases");
  });

  it("round_table_sessions has status CHECK constraint", () => {
    expect(sql).toContain("status IN ('pending', 'active', 'completed', 'failed', 'timed_out')");
  });

  it("round_table_sessions has current_phase CHECK constraint", () => {
    expect(sql).toContain("current_phase IN ('convene', 'discuss', 'converge', 'deliver')");
  });

  it("round_table_phases has phase_type CHECK constraint", () => {
    expect(sql).toContain("phase_type IN ('convene', 'discuss', 'converge', 'deliver')");
  });

  it("round_table_phases has status CHECK constraint", () => {
    expect(sql).toContain("status IN ('pending', 'active', 'completed', 'failed', 'skipped')");
  });

  it("round_table_phases references round_table_sessions", () => {
    expect(sql).toContain("REFERENCES round_table_sessions(id) ON DELETE CASCADE");
  });

  it("has indexes on key columns", () => {
    expect(sql).toContain("idx_round_table_sessions_status");
    expect(sql).toContain("idx_round_table_sessions_created_at");
    expect(sql).toContain("idx_round_table_sessions_work_item_id");
    expect(sql).toContain("idx_round_table_phases_session_id");
    expect(sql).toContain("idx_round_table_phases_session_order");
  });

  it("enables RLS on both tables", () => {
    expect(sql).toContain("ALTER TABLE round_table_sessions ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE round_table_phases ENABLE ROW LEVEL SECURITY");
  });

  it("has active session partial index", () => {
    expect(sql).toContain("idx_round_table_sessions_active");
    expect(sql).toContain("WHERE status = 'active'");
  });
});

// ── E2E ────────────────────────────────────────────────────────

describe("round table — E2E", () => {
  beforeEach(() => {
    _resetIdCounter();
  });

  it("full session lifecycle: create → start → all phases → complete", () => {
    const deps = _makeMockDeps();

    // Create
    const session = createSession(deps, {
      query: "What should our Q2 product strategy be?",
      initiator_agent: "strategy",
      channel: "telegram",
      work_item_id: "ELLIE-100",
    });
    expect(session.status).toBe("pending");

    // Start
    const started = startSession(deps, session.id);
    expect(started.status).toBe("active");
    expect(started.current_phase).toBe("convene");

    // Convene
    const afterConvene = advancePhase(
      deps,
      session.id,
      "Identified participants: strategy, research, finance. Framed the question around product-market fit.",
      ["boardroom"],
    );
    expect(afterConvene.current_phase).toBe("discuss");
    expect(afterConvene.phases_completed).toBe(1);

    // Discuss
    const afterDiscuss = advancePhase(
      deps,
      session.id,
      "Three proposals: (A) expand current vertical, (B) enter new market, (C) hybrid. Finance notes A has best ROI, Research favors B for growth.",
      ["boardroom", "research-panel"],
    );
    expect(afterDiscuss.current_phase).toBe("converge");
    expect(afterDiscuss.phases_completed).toBe(2);

    // Converge
    const afterConverge = advancePhase(
      deps,
      session.id,
      "Consensus reached: Hybrid approach (C) with phased rollout. Phase 1: deepen current vertical (Q2). Phase 2: pilot new market (Q3).",
    );
    expect(afterConverge.current_phase).toBe("deliver");
    expect(afterConverge.phases_completed).toBe(3);

    // Deliver
    const completed = advancePhase(
      deps,
      session.id,
      "Q2 Strategy Document: 1) Focus 60% resources on current vertical optimization. 2) Allocate 40% to new market research. 3) Go/no-go decision for Q3 expansion by June 15.",
    );
    expect(completed.status).toBe("completed");
    expect(completed.current_phase).toBeNull();
    expect(completed.phases_completed).toBe(4);
    expect(completed.completed_at).not.toBeNull();

    // Verify all phases
    const phases = deps.phaseStore.getBySession(session.id);
    expect(phases).toHaveLength(4);
    expect(phases.every(p => p.status === "completed")).toBe(true);
    expect(phases[0].formations_used).toEqual(["boardroom"]);
    expect(phases[1].formations_used).toEqual(["boardroom", "research-panel"]);
    expect(phases[1].input).toBe(phases[0].output); // chain check
    expect(phases[2].input).toBe(phases[1].output);
    expect(phases[3].input).toBe(phases[2].output);
  });

  it("session failure mid-way preserves completed phases", () => {
    const deps = _makeMockDeps();
    const session = createSession(deps, {
      query: "Analyze competitor landscape",
      initiator_agent: "research",
    });
    startSession(deps, session.id);

    // Complete convene
    advancePhase(deps, session.id, "Participants identified, scope set.");
    // Fail during discuss
    const failed = failSession(deps, session.id, "Research agent crashed");

    expect(failed.status).toBe("failed");
    expect(failed.phases_completed).toBe(1); // only convene completed

    const progress = getSessionProgress(deps, session.id)!;
    expect(progress.completedPhases).toEqual(["convene"]);

    const phases = deps.phaseStore.getBySession(session.id);
    expect(phases[0].status).toBe("completed");
    expect(phases[1].status).toBe("failed");
    expect(phases[2].status).toBe("skipped");
    expect(phases[3].status).toBe("skipped");
  });
});
