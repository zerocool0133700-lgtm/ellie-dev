/**
 * Round Table Session Schema — ELLIE-694
 *
 * Round tables are orchestrated multi-phase sessions where formations
 * collaborate through structured phases to answer a query or complete
 * a task.
 *
 * Phase state machine:
 *   convene → discuss → converge → deliver
 *
 * Each phase may invoke one or more formations, and the output of
 * each phase feeds into the next as input.
 *
 * Pure module — types, state machine, and lifecycle helpers only, no side effects.
 */

// ── Phase State Machine ────────────────────────────────────────

/** The four phases of a round table session, in order. */
export const ROUND_TABLE_PHASES = [
  "convene",
  "discuss",
  "converge",
  "deliver",
] as const;

export type RoundTablePhaseType = typeof ROUND_TABLE_PHASES[number];

/** Valid transitions: each phase can only advance to the next. */
export const PHASE_TRANSITIONS: Record<RoundTablePhaseType, RoundTablePhaseType | null> = {
  convene: "discuss",
  discuss: "converge",
  converge: "deliver",
  deliver: null, // terminal
};

/** Check if a transition from one phase to another is valid. */
export function isValidPhaseTransition(
  from: RoundTablePhaseType,
  to: RoundTablePhaseType,
): boolean {
  return PHASE_TRANSITIONS[from] === to;
}

/** Get the next phase after the given one, or null if terminal. */
export function getNextPhase(phase: RoundTablePhaseType): RoundTablePhaseType | null {
  return PHASE_TRANSITIONS[phase];
}

/** Get the index of a phase (0-based). */
export function getPhaseIndex(phase: RoundTablePhaseType): number {
  return ROUND_TABLE_PHASES.indexOf(phase);
}

/** Check if a phase type string is valid. */
export function isValidPhaseType(phase: string): phase is RoundTablePhaseType {
  return (ROUND_TABLE_PHASES as readonly string[]).includes(phase);
}

// ── Session States ─────────────────────────────────────────────

export const ROUND_TABLE_SESSION_STATES = [
  "pending",
  "active",
  "completed",
  "failed",
  "timed_out",
] as const;

export type RoundTableSessionState = typeof ROUND_TABLE_SESSION_STATES[number];

/** Valid session state transitions. */
export const SESSION_STATE_TRANSITIONS: Record<RoundTableSessionState, RoundTableSessionState[]> = {
  pending: ["active", "failed"],
  active: ["completed", "failed", "timed_out"],
  completed: [], // terminal
  failed: [], // terminal
  timed_out: [], // terminal
};

/** Check if a session state transition is valid. */
export function isValidSessionTransition(
  from: RoundTableSessionState,
  to: RoundTableSessionState,
): boolean {
  return SESSION_STATE_TRANSITIONS[from].includes(to);
}

/** Check if a session state string is valid. */
export function isValidSessionState(state: string): state is RoundTableSessionState {
  return (ROUND_TABLE_SESSION_STATES as readonly string[]).includes(state);
}

// ── Phase States ───────────────────────────────────────────────

export const ROUND_TABLE_PHASE_STATES = [
  "pending",
  "active",
  "completed",
  "failed",
  "skipped",
] as const;

export type RoundTablePhaseState = typeof ROUND_TABLE_PHASE_STATES[number];

// ── Core Types ─────────────────────────────────────────────────

/** A round table session record (maps to round_table_sessions table). */
export interface RoundTableSession {
  id: string;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;

  /** The user query or task that initiated this session. */
  query: string;
  /** Current session state. */
  status: RoundTableSessionState;
  /** Number of phases completed so far (0–4). */
  phases_completed: number;
  /** Current phase type, or null if not yet started. */
  current_phase: RoundTablePhaseType | null;

  /** Agent that initiated the session. */
  initiator_agent: string;
  /** Channel where the session was initiated. */
  channel: string;
  /** Associated work item (e.g. ELLIE-xxx). */
  work_item_id: string | null;

  /** Arbitrary metadata. */
  metadata: Record<string, unknown>;
}

/** A phase within a round table session (maps to round_table_phases table). */
export interface RoundTablePhase {
  id: string;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;

  /** Parent session. */
  session_id: string;
  /** Which phase this is. */
  phase_type: RoundTablePhaseType;
  /** Phase execution state. */
  status: RoundTablePhaseState;
  /** Ordinal position (0=convene, 1=discuss, 2=converge, 3=deliver). */
  phase_order: number;

  /** Input fed into this phase (typically the prior phase's output). */
  input: string | null;
  /** Output produced by this phase. */
  output: string | null;
  /** Formations invoked during this phase. */
  formations_used: string[];

  /** Arbitrary metadata. */
  metadata: Record<string, unknown>;
}

// ── Lifecycle Management ───────────────────────────────────────

/** Options for creating a new round table session. */
export interface CreateRoundTableOpts {
  query: string;
  initiator_agent: string;
  channel?: string;
  work_item_id?: string;
  metadata?: Record<string, unknown>;
}

/** Injectable session store for creating/reading/updating sessions. */
export interface RoundTableSessionStore {
  create(opts: CreateRoundTableOpts): RoundTableSession;
  get(id: string): RoundTableSession | null;
  update(id: string, fields: Partial<RoundTableSession>): RoundTableSession | null;
}

/** Injectable phase store for creating/reading/updating phases. */
export interface RoundTablePhaseStore {
  create(sessionId: string, phaseType: RoundTablePhaseType): RoundTablePhase;
  get(id: string): RoundTablePhase | null;
  getBySession(sessionId: string): RoundTablePhase[];
  getBySessionAndType(sessionId: string, phaseType: RoundTablePhaseType): RoundTablePhase | null;
  update(id: string, fields: Partial<RoundTablePhase>): RoundTablePhase | null;
}

/** Combined deps for lifecycle operations. */
export interface RoundTableDeps {
  sessionStore: RoundTableSessionStore;
  phaseStore: RoundTablePhaseStore;
}

// ── Lifecycle Functions ────────────────────────────────────────

/**
 * Create a new round table session in pending state.
 * Also pre-creates all four phase records in pending state.
 */
export function createSession(deps: RoundTableDeps, opts: CreateRoundTableOpts): RoundTableSession {
  const session = deps.sessionStore.create(opts);

  // Pre-create all four phases in order
  for (const phaseType of ROUND_TABLE_PHASES) {
    deps.phaseStore.create(session.id, phaseType);
  }

  return session;
}

/**
 * Start a session — moves from pending to active, activates the convene phase.
 * Returns the updated session or throws if transition is invalid.
 */
export function startSession(deps: RoundTableDeps, sessionId: string): RoundTableSession {
  const session = deps.sessionStore.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  if (!isValidSessionTransition(session.status, "active")) {
    throw new Error(`Cannot start session in "${session.status}" state`);
  }

  const convenePhase = deps.phaseStore.getBySessionAndType(sessionId, "convene");
  if (convenePhase) {
    deps.phaseStore.update(convenePhase.id, { status: "active" });
  }

  return deps.sessionStore.update(sessionId, {
    status: "active",
    current_phase: "convene",
  })!;
}

/**
 * Advance to the next phase. Completes the current phase and activates the next.
 * If the current phase is "deliver", completes the session.
 * Returns the updated session.
 */
export function advancePhase(
  deps: RoundTableDeps,
  sessionId: string,
  phaseOutput: string,
  formationsUsed?: string[],
): RoundTableSession {
  const session = deps.sessionStore.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  if (session.status !== "active") {
    throw new Error(`Cannot advance phase in "${session.status}" session`);
  }

  if (!session.current_phase) {
    throw new Error("Session has no current phase");
  }

  const currentPhase = deps.phaseStore.getBySessionAndType(sessionId, session.current_phase);
  if (currentPhase) {
    deps.phaseStore.update(currentPhase.id, {
      status: "completed",
      output: phaseOutput,
      formations_used: formationsUsed ?? currentPhase.formations_used,
      completed_at: new Date(),
    });
  }

  const nextPhaseType = getNextPhase(session.current_phase);

  if (!nextPhaseType) {
    // Terminal — complete the session
    return deps.sessionStore.update(sessionId, {
      status: "completed",
      current_phase: null,
      phases_completed: session.phases_completed + 1,
      completed_at: new Date(),
    })!;
  }

  // Activate next phase, passing current output as input
  const nextPhase = deps.phaseStore.getBySessionAndType(sessionId, nextPhaseType);
  if (nextPhase) {
    deps.phaseStore.update(nextPhase.id, {
      status: "active",
      input: phaseOutput,
    });
  }

  return deps.sessionStore.update(sessionId, {
    current_phase: nextPhaseType,
    phases_completed: session.phases_completed + 1,
  })!;
}

/**
 * Fail a session. Marks the current phase as failed and the session as failed.
 */
export function failSession(
  deps: RoundTableDeps,
  sessionId: string,
  reason: string,
): RoundTableSession {
  const session = deps.sessionStore.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  if (!isValidSessionTransition(session.status, "failed")) {
    throw new Error(`Cannot fail session in "${session.status}" state`);
  }

  // Fail the current phase if there is one
  if (session.current_phase) {
    const currentPhase = deps.phaseStore.getBySessionAndType(sessionId, session.current_phase);
    if (currentPhase && currentPhase.status === "active") {
      deps.phaseStore.update(currentPhase.id, {
        status: "failed",
        output: reason,
      });
    }
  }

  // Skip remaining pending phases
  const phases = deps.phaseStore.getBySession(sessionId);
  for (const phase of phases) {
    if (phase.status === "pending") {
      deps.phaseStore.update(phase.id, { status: "skipped" });
    }
  }

  return deps.sessionStore.update(sessionId, {
    status: "failed",
    current_phase: null,
    completed_at: new Date(),
    metadata: { ...session.metadata, failureReason: reason },
  })!;
}

/**
 * Time out a session. Similar to fail but with timed_out state.
 */
export function timeoutSession(
  deps: RoundTableDeps,
  sessionId: string,
): RoundTableSession {
  const session = deps.sessionStore.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  if (!isValidSessionTransition(session.status, "timed_out")) {
    throw new Error(`Cannot timeout session in "${session.status}" state`);
  }

  // Fail the current phase if there is one
  if (session.current_phase) {
    const currentPhase = deps.phaseStore.getBySessionAndType(sessionId, session.current_phase);
    if (currentPhase && currentPhase.status === "active") {
      deps.phaseStore.update(currentPhase.id, {
        status: "failed",
        output: "Phase timed out",
      });
    }
  }

  // Skip remaining pending phases
  const phases = deps.phaseStore.getBySession(sessionId);
  for (const phase of phases) {
    if (phase.status === "pending") {
      deps.phaseStore.update(phase.id, { status: "skipped" });
    }
  }

  return deps.sessionStore.update(sessionId, {
    status: "timed_out",
    current_phase: null,
    completed_at: new Date(),
  })!;
}

/**
 * Get a summary of session progress.
 */
export function getSessionProgress(deps: RoundTableDeps, sessionId: string): {
  session: RoundTableSession;
  phases: RoundTablePhase[];
  completedPhases: string[];
  currentPhase: RoundTablePhase | null;
  progress: string;
} | null {
  const session = deps.sessionStore.get(sessionId);
  if (!session) return null;

  const phases = deps.phaseStore.getBySession(sessionId);
  const completedPhases = phases
    .filter(p => p.status === "completed")
    .map(p => p.phase_type);

  const currentPhase = session.current_phase
    ? phases.find(p => p.phase_type === session.current_phase) ?? null
    : null;

  const progress = `${session.phases_completed}/${ROUND_TABLE_PHASES.length} phases`;

  return { session, phases, completedPhases, currentPhase, progress };
}

// ── Testing Helpers ────────────────────────────────────────────

let _testIdCounter = 0;

export function _resetIdCounter(): void {
  _testIdCounter = 0;
}

function _nextId(): string {
  _testIdCounter++;
  return `test-${_testIdCounter}`;
}

/** Create a mock in-memory session store. */
export function _makeMockSessionStore(): RoundTableSessionStore {
  const sessions = new Map<string, RoundTableSession>();

  return {
    create(opts: CreateRoundTableOpts): RoundTableSession {
      const id = _nextId();
      const now = new Date();
      const session: RoundTableSession = {
        id,
        created_at: now,
        updated_at: now,
        completed_at: null,
        query: opts.query,
        status: "pending",
        phases_completed: 0,
        current_phase: null,
        initiator_agent: opts.initiator_agent,
        channel: opts.channel ?? "internal",
        work_item_id: opts.work_item_id ?? null,
        metadata: opts.metadata ?? {},
      };
      sessions.set(id, session);
      return session;
    },
    get(id: string) {
      return sessions.get(id) ?? null;
    },
    update(id: string, fields: Partial<RoundTableSession>) {
      const session = sessions.get(id);
      if (!session) return null;
      const updated = { ...session, ...fields, updated_at: new Date() };
      sessions.set(id, updated);
      return updated;
    },
  };
}

/** Create a mock in-memory phase store. */
export function _makeMockPhaseStore(): RoundTablePhaseStore {
  const phases = new Map<string, RoundTablePhase>();

  return {
    create(sessionId: string, phaseType: RoundTablePhaseType): RoundTablePhase {
      const id = _nextId();
      const now = new Date();
      const phase: RoundTablePhase = {
        id,
        created_at: now,
        updated_at: now,
        completed_at: null,
        session_id: sessionId,
        phase_type: phaseType,
        status: "pending",
        phase_order: getPhaseIndex(phaseType),
        input: null,
        output: null,
        formations_used: [],
        metadata: {},
      };
      phases.set(id, phase);
      return phase;
    },
    get(id: string) {
      return phases.get(id) ?? null;
    },
    getBySession(sessionId: string) {
      return Array.from(phases.values())
        .filter(p => p.session_id === sessionId)
        .sort((a, b) => a.phase_order - b.phase_order);
    },
    getBySessionAndType(sessionId: string, phaseType: RoundTablePhaseType) {
      return Array.from(phases.values())
        .find(p => p.session_id === sessionId && p.phase_type === phaseType) ?? null;
    },
    update(id: string, fields: Partial<RoundTablePhase>) {
      const phase = phases.get(id);
      if (!phase) return null;
      const updated = { ...phase, ...fields, updated_at: new Date() };
      phases.set(id, updated);
      return updated;
    },
  };
}

/** Create a complete mock deps object for testing. */
export function _makeMockDeps(): RoundTableDeps {
  return {
    sessionStore: _makeMockSessionStore(),
    phaseStore: _makeMockPhaseStore(),
  };
}
