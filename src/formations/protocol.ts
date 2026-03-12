/**
 * Formation Protocol — ELLIE-674
 *
 * Inter-agent communication primitives and protocol executors for formations.
 * Handles message creation, storage, retrieval, broadcasting, direct messaging,
 * round management, and vote aggregation.
 *
 * All external dependencies (DB read/write) are injectable for testability.
 */

import { log } from "../logger.ts";
import type {
  FormationSession,
  FormationMessage,
  FormationMessageType,
  FormationSessionState,
  InteractionProtocol,
} from "../types/formation.ts";

const logger = log.child("formation-protocol");

// ── Injectable Dependencies ─────────────────────────────────────

export interface FormationMessageWriter {
  insertMessage(msg: InsertFormationMessage): Promise<FormationMessage>;
  insertMessages(msgs: InsertFormationMessage[]): Promise<FormationMessage[]>;
}

export interface FormationMessageReader {
  getMessagesBySession(sessionId: string): Promise<FormationMessage[]>;
  getMessagesByRound(sessionId: string, turnNumber: number): Promise<FormationMessage[]>;
  getMessagesByAgent(sessionId: string, agentName: string): Promise<FormationMessage[]>;
  getMessagesByType(sessionId: string, messageType: FormationMessageType): Promise<FormationMessage[]>;
}

export interface FormationSessionStore {
  getSession(sessionId: string): Promise<FormationSession | null>;
  createSession(session: InsertFormationSession): Promise<FormationSession>;
  updateSession(sessionId: string, updates: Partial<Pick<FormationSession, "state" | "turn_count" | "completed_at" | "metadata">>): Promise<FormationSession>;
}

export interface ProtocolDeps {
  messageWriter: FormationMessageWriter;
  messageReader: FormationMessageReader;
  sessionStore: FormationSessionStore;
}

// ── Insert Types ────────────────────────────────────────────────

export interface InsertFormationMessage {
  session_id: string;
  from_agent: string;
  to_agent: string | null;
  content: string;
  turn_number: number;
  message_type: FormationMessageType;
  metadata?: Record<string, unknown>;
}

export interface InsertFormationSession {
  formation_name: string;
  initiator_agent: string;
  channel?: string;
  work_item_id?: string;
  protocol: InteractionProtocol;
  participating_agents: string[];
  metadata?: Record<string, unknown>;
}

// ── Vote Types ──────────────────────────────────────────────────

export interface Vote {
  agent: string;
  choice: string;
  confidence?: number;
  reasoning?: string;
}

export interface VoteResult {
  winner: string | null;
  scores: Map<string, number>;
  totalVotes: number;
  consensusReached: boolean;
  /** Ratio of votes for the winner (0-1). */
  consensusScore: number;
  votes: Vote[];
}

// ── Protocol Executor Results ───────────────────────────────────

export interface ProtocolRoundResult {
  sessionId: string;
  roundNumber: number;
  messages: FormationMessage[];
  isComplete: boolean;
  nextAgent?: string;
}

// ── Message Creation Primitives ─────────────────────────────────

/**
 * Post a message from one agent to a formation session.
 */
export async function postMessage(
  deps: ProtocolDeps,
  sessionId: string,
  fromAgent: string,
  content: string,
  opts: {
    toAgent?: string;
    messageType?: FormationMessageType;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<FormationMessage> {
  const session = await deps.sessionStore.getSession(sessionId);
  if (!session) {
    throw new Error(`Formation session ${sessionId} not found`);
  }
  if (session.state !== "active") {
    throw new Error(`Formation session ${sessionId} is ${session.state}, not active`);
  }

  const msg = await deps.messageWriter.insertMessage({
    session_id: sessionId,
    from_agent: fromAgent,
    to_agent: opts.toAgent ?? null,
    content,
    turn_number: session.turn_count,
    message_type: opts.messageType ?? "response",
    metadata: opts.metadata,
  });

  logger.info("Message posted", {
    sessionId,
    fromAgent,
    toAgent: opts.toAgent,
    type: opts.messageType ?? "response",
    turn: session.turn_count,
  });

  return msg;
}

/**
 * Broadcast a message from one agent (typically the facilitator) to all agents.
 * Creates one message per target agent, all in the same turn.
 */
export async function broadcast(
  deps: ProtocolDeps,
  sessionId: string,
  fromAgent: string,
  content: string,
  opts: {
    messageType?: FormationMessageType;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<FormationMessage[]> {
  const session = await deps.sessionStore.getSession(sessionId);
  if (!session) {
    throw new Error(`Formation session ${sessionId} not found`);
  }
  if (session.state !== "active") {
    throw new Error(`Formation session ${sessionId} is ${session.state}, not active`);
  }

  const targets = session.participating_agents.filter(a => a !== fromAgent);
  if (targets.length === 0) {
    return [];
  }

  const msgs: InsertFormationMessage[] = targets.map(target => ({
    session_id: sessionId,
    from_agent: fromAgent,
    to_agent: target,
    content,
    turn_number: session.turn_count,
    message_type: opts.messageType ?? "proposal",
    metadata: opts.metadata,
  }));

  const inserted = await deps.messageWriter.insertMessages(msgs);

  logger.info("Broadcast sent", {
    sessionId,
    fromAgent,
    targets,
    type: opts.messageType ?? "proposal",
    turn: session.turn_count,
  });

  return inserted;
}

/**
 * Send a direct message from one agent to another.
 */
export async function directMessage(
  deps: ProtocolDeps,
  sessionId: string,
  fromAgent: string,
  toAgent: string,
  content: string,
  opts: {
    messageType?: FormationMessageType;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<FormationMessage> {
  return postMessage(deps, sessionId, fromAgent, content, {
    toAgent,
    messageType: opts.messageType ?? "response",
    metadata: opts.metadata,
  });
}

// ── Message Retrieval ───────────────────────────────────────────

/**
 * Get all messages in a formation session, ordered by creation time.
 */
export async function getSessionMessages(
  deps: ProtocolDeps,
  sessionId: string,
): Promise<FormationMessage[]> {
  return deps.messageReader.getMessagesBySession(sessionId);
}

/**
 * Get messages for a specific round.
 */
export async function getRoundMessages(
  deps: ProtocolDeps,
  sessionId: string,
  roundNumber: number,
): Promise<FormationMessage[]> {
  return deps.messageReader.getMessagesByRound(sessionId, roundNumber);
}

/**
 * Get all messages from a specific agent in a session.
 */
export async function getAgentMessages(
  deps: ProtocolDeps,
  sessionId: string,
  agentName: string,
): Promise<FormationMessage[]> {
  return deps.messageReader.getMessagesByAgent(sessionId, agentName);
}

// ── Round Management ────────────────────────────────────────────

/**
 * Advance the session to the next round.
 * Returns the updated turn count.
 */
export async function advanceRound(
  deps: ProtocolDeps,
  sessionId: string,
): Promise<number> {
  const session = await deps.sessionStore.getSession(sessionId);
  if (!session) {
    throw new Error(`Formation session ${sessionId} not found`);
  }
  if (session.state !== "active") {
    throw new Error(`Formation session ${sessionId} is ${session.state}, not active`);
  }

  const newTurn = session.turn_count + 1;

  // Check if max turns reached
  if (session.protocol.maxTurns > 0 && newTurn >= session.protocol.maxTurns) {
    await deps.sessionStore.updateSession(sessionId, {
      turn_count: newTurn,
      state: "completed",
      completed_at: new Date(),
    });
    logger.info("Session completed (max turns reached)", { sessionId, turn: newTurn });
    return newTurn;
  }

  await deps.sessionStore.updateSession(sessionId, { turn_count: newTurn });
  logger.info("Round advanced", { sessionId, turn: newTurn });
  return newTurn;
}

/**
 * Complete a formation session.
 */
export async function completeSession(
  deps: ProtocolDeps,
  sessionId: string,
  opts: { summary?: string } = {},
): Promise<FormationSession> {
  const session = await deps.sessionStore.getSession(sessionId);
  if (!session) {
    throw new Error(`Formation session ${sessionId} not found`);
  }

  const metadata = { ...session.metadata };
  if (opts.summary) {
    metadata.completion_summary = opts.summary;
  }

  const updated = await deps.sessionStore.updateSession(sessionId, {
    state: "completed",
    completed_at: new Date(),
    metadata,
  });

  // Post a system message recording the completion
  await deps.messageWriter.insertMessage({
    session_id: sessionId,
    from_agent: "system",
    to_agent: null,
    content: opts.summary ?? "Formation session completed.",
    turn_number: session.turn_count,
    message_type: "system",
  });

  logger.info("Session completed", { sessionId, turns: session.turn_count });
  return updated;
}

/**
 * Fail a formation session.
 */
export async function failSession(
  deps: ProtocolDeps,
  sessionId: string,
  reason: string,
): Promise<FormationSession> {
  const session = await deps.sessionStore.getSession(sessionId);
  if (!session) {
    throw new Error(`Formation session ${sessionId} not found`);
  }

  const updated = await deps.sessionStore.updateSession(sessionId, {
    state: "failed",
    completed_at: new Date(),
    metadata: { ...session.metadata, failure_reason: reason },
  });

  await deps.messageWriter.insertMessage({
    session_id: sessionId,
    from_agent: "system",
    to_agent: null,
    content: `Formation failed: ${reason}`,
    turn_number: session.turn_count,
    message_type: "system",
  });

  logger.warn("Session failed", { sessionId, reason });
  return updated;
}

// ── Vote Aggregation ────────────────────────────────────────────

/**
 * Parse votes from messages in a given round.
 * Expects message metadata to contain { vote: "choice", confidence?: number, reasoning?: "..." }
 */
export function parseVotes(messages: FormationMessage[]): Vote[] {
  const votes: Vote[] = [];
  for (const msg of messages) {
    const meta = msg.metadata as Record<string, unknown> | undefined;
    if (meta && typeof meta.vote === "string") {
      votes.push({
        agent: msg.from_agent,
        choice: meta.vote,
        confidence: typeof meta.confidence === "number" ? meta.confidence : undefined,
        reasoning: typeof meta.reasoning === "string" ? meta.reasoning : undefined,
      });
    }
  }
  return votes;
}

/**
 * Aggregate votes and determine consensus.
 * Simple majority wins. Consensus is reached when the winner has > threshold of votes.
 */
export function aggregateVotes(
  votes: Vote[],
  threshold = 0.5,
): VoteResult {
  if (votes.length === 0) {
    return {
      winner: null,
      scores: new Map(),
      totalVotes: 0,
      consensusReached: false,
      consensusScore: 0,
      votes,
    };
  }

  const scores = new Map<string, number>();

  for (const vote of votes) {
    const weight = vote.confidence ?? 1;
    scores.set(vote.choice, (scores.get(vote.choice) ?? 0) + weight);
  }

  let winner: string | null = null;
  let maxScore = 0;
  for (const [choice, score] of scores) {
    if (score > maxScore) {
      maxScore = score;
      winner = choice;
    }
  }

  const totalWeight = Array.from(scores.values()).reduce((a, b) => a + b, 0);
  const consensusScore = totalWeight > 0 ? maxScore / totalWeight : 0;

  return {
    winner,
    scores,
    totalVotes: votes.length,
    consensusReached: consensusScore > threshold,
    consensusScore,
    votes,
  };
}

/**
 * Collect votes from a round and aggregate them.
 */
export async function collectAndAggregateVotes(
  deps: ProtocolDeps,
  sessionId: string,
  roundNumber: number,
  threshold = 0.5,
): Promise<VoteResult> {
  const messages = await deps.messageReader.getMessagesByRound(sessionId, roundNumber);
  const votes = parseVotes(messages);
  return aggregateVotes(votes, threshold);
}

// ── Protocol Executors ──────────────────────────────────────────

/**
 * Fan-out executor: broadcast a proposal to all agents and collect responses.
 * Used for "coordinator" pattern where one agent proposes, others respond.
 */
export async function executeFanOut(
  deps: ProtocolDeps,
  sessionId: string,
  proposerAgent: string,
  proposal: string,
): Promise<ProtocolRoundResult> {
  const session = await deps.sessionStore.getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  // Post the proposal
  const proposalMsg = await postMessage(deps, sessionId, proposerAgent, proposal, {
    messageType: "proposal",
  });

  // Advance to next round for responses
  const roundNumber = await advanceRound(deps, sessionId);

  return {
    sessionId,
    roundNumber,
    messages: [proposalMsg],
    isComplete: false,
    nextAgent: undefined, // All agents can respond
  };
}

/**
 * Debate executor: two agents alternate proposing and responding.
 * Returns the next agent who should speak.
 */
export async function executeDebate(
  deps: ProtocolDeps,
  sessionId: string,
  agentA: string,
  agentB: string,
): Promise<ProtocolRoundResult> {
  const session = await deps.sessionStore.getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  // Determine whose turn it is based on round parity
  const currentRound = session.turn_count;
  const nextAgent = currentRound % 2 === 0 ? agentA : agentB;

  // Check if max turns reached
  const isComplete = session.protocol.maxTurns > 0 && currentRound >= session.protocol.maxTurns - 1;

  const roundMessages = await deps.messageReader.getMessagesByRound(sessionId, currentRound);

  return {
    sessionId,
    roundNumber: currentRound,
    messages: roundMessages,
    isComplete,
    nextAgent,
  };
}

/**
 * Consensus executor: collect votes from all agents, aggregate, determine outcome.
 */
export async function executeConsensus(
  deps: ProtocolDeps,
  sessionId: string,
  threshold = 0.5,
): Promise<ProtocolRoundResult & { voteResult: VoteResult }> {
  const session = await deps.sessionStore.getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const voteResult = await collectAndAggregateVotes(deps, sessionId, session.turn_count, threshold);

  const isComplete = voteResult.consensusReached;

  if (isComplete && voteResult.winner) {
    // Post a decision message recording the consensus
    await postMessage(deps, sessionId, "system", `Consensus reached: ${voteResult.winner} (score: ${(voteResult.consensusScore * 100).toFixed(0)}%)`, {
      messageType: "decision",
      metadata: {
        winner: voteResult.winner,
        consensusScore: voteResult.consensusScore,
        scores: Object.fromEntries(voteResult.scores),
      },
    });
  }

  const roundMessages = await deps.messageReader.getMessagesByRound(sessionId, session.turn_count);

  return {
    sessionId,
    roundNumber: session.turn_count,
    messages: roundMessages,
    isComplete,
    voteResult,
  };
}

/**
 * Delegation executor: coordinator assigns a task to a specific agent.
 * Posts a system message with the delegation and returns the target agent.
 */
export async function executeDelegation(
  deps: ProtocolDeps,
  sessionId: string,
  coordinatorAgent: string,
  targetAgent: string,
  task: string,
): Promise<ProtocolRoundResult> {
  const session = await deps.sessionStore.getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  if (!session.participating_agents.includes(targetAgent)) {
    throw new Error(`Agent "${targetAgent}" is not a participant in session ${sessionId}`);
  }

  const delegationMsg = await directMessage(
    deps,
    sessionId,
    coordinatorAgent,
    targetAgent,
    task,
    { messageType: "proposal", metadata: { delegation: true } },
  );

  const roundNumber = await advanceRound(deps, sessionId);

  return {
    sessionId,
    roundNumber,
    messages: [delegationMsg],
    isComplete: false,
    nextAgent: targetAgent,
  };
}

/**
 * Pipeline executor: advance through agents in order (turnOrder).
 * Returns the next agent in the pipeline.
 */
export async function executePipeline(
  deps: ProtocolDeps,
  sessionId: string,
): Promise<ProtocolRoundResult> {
  const session = await deps.sessionStore.getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const turnOrder = session.protocol.turnOrder ?? session.participating_agents;
  if (turnOrder.length === 0) {
    throw new Error("Pipeline has no agents in turn order");
  }

  const currentRound = session.turn_count;
  const agentIndex = currentRound % turnOrder.length;
  const nextAgentIndex = (currentRound + 1) % turnOrder.length;
  const isLastInCycle = agentIndex === turnOrder.length - 1;

  // Check if we've completed all cycles
  const completedCycles = Math.floor(currentRound / turnOrder.length);
  const maxCycles = session.protocol.maxTurns > 0
    ? Math.ceil(session.protocol.maxTurns / turnOrder.length)
    : 0;
  const isComplete = maxCycles > 0 && completedCycles >= maxCycles;

  const roundMessages = await deps.messageReader.getMessagesByRound(sessionId, currentRound);

  return {
    sessionId,
    roundNumber: currentRound,
    messages: roundMessages,
    isComplete,
    nextAgent: isComplete ? undefined : turnOrder[nextAgentIndex],
  };
}

// ── Session Creation Helper ─────────────────────────────────────

/**
 * Start a new formation session.
 */
export async function startSession(
  deps: ProtocolDeps,
  opts: InsertFormationSession,
): Promise<FormationSession> {
  const session = await deps.sessionStore.createSession(opts);

  // Post a system message recording the session start
  await deps.messageWriter.insertMessage({
    session_id: session.id,
    from_agent: "system",
    to_agent: null,
    content: `Formation "${opts.formation_name}" started by ${opts.initiator_agent} with agents: ${opts.participating_agents.join(", ")}`,
    turn_number: 0,
    message_type: "system",
  });

  logger.info("Formation session started", {
    sessionId: session.id,
    formation: opts.formation_name,
    agents: opts.participating_agents,
  });

  return session;
}

// ── Testing Helpers ─────────────────────────────────────────────

let _idCounter = 0;

function _nextId(): string {
  return `test-${++_idCounter}`;
}

export function _resetIdCounter(): void {
  _idCounter = 0;
}

export function _makeMockMessage(
  overrides: Partial<FormationMessage> = {},
): FormationMessage {
  return {
    id: _nextId(),
    created_at: new Date(),
    session_id: "test-session",
    from_agent: "dev",
    to_agent: null,
    content: "Test message",
    turn_number: 0,
    message_type: "response",
    metadata: {},
    ...overrides,
  };
}

export function _makeMockSession(
  overrides: Partial<FormationSession> = {},
): FormationSession {
  return {
    id: "test-session",
    created_at: new Date(),
    updated_at: new Date(),
    completed_at: null,
    formation_name: "test-formation",
    state: "active",
    turn_count: 0,
    initiator_agent: "dev",
    channel: "internal",
    work_item_id: null,
    protocol: {
      pattern: "coordinator",
      maxTurns: 10,
      coordinator: "dev",
      requiresApproval: false,
    },
    participating_agents: ["dev", "critic", "research"],
    metadata: {},
    ...overrides,
  };
}

/**
 * Create in-memory mock deps for testing.
 * All messages and sessions are stored in arrays for inspection.
 */
export function _makeMockDeps(
  initialSession?: FormationSession,
): ProtocolDeps & {
  messages: FormationMessage[];
  sessions: Map<string, FormationSession>;
} {
  const messages: FormationMessage[] = [];
  const sessions = new Map<string, FormationSession>();

  if (initialSession) {
    sessions.set(initialSession.id, { ...initialSession });
  }

  return {
    messages,
    sessions,
    messageWriter: {
      async insertMessage(msg: InsertFormationMessage): Promise<FormationMessage> {
        const created: FormationMessage = {
          id: _nextId(),
          created_at: new Date(),
          session_id: msg.session_id,
          from_agent: msg.from_agent,
          to_agent: msg.to_agent,
          content: msg.content,
          turn_number: msg.turn_number,
          message_type: msg.message_type,
          metadata: msg.metadata ?? {},
        };
        messages.push(created);
        return created;
      },
      async insertMessages(msgs: InsertFormationMessage[]): Promise<FormationMessage[]> {
        const results: FormationMessage[] = [];
        for (const msg of msgs) {
          const created: FormationMessage = {
            id: _nextId(),
            created_at: new Date(),
            session_id: msg.session_id,
            from_agent: msg.from_agent,
            to_agent: msg.to_agent,
            content: msg.content,
            turn_number: msg.turn_number,
            message_type: msg.message_type,
            metadata: msg.metadata ?? {},
          };
          messages.push(created);
          results.push(created);
        }
        return results;
      },
    },
    messageReader: {
      async getMessagesBySession(sessionId: string): Promise<FormationMessage[]> {
        return messages.filter(m => m.session_id === sessionId);
      },
      async getMessagesByRound(sessionId: string, turnNumber: number): Promise<FormationMessage[]> {
        return messages.filter(m => m.session_id === sessionId && m.turn_number === turnNumber);
      },
      async getMessagesByAgent(sessionId: string, agentName: string): Promise<FormationMessage[]> {
        return messages.filter(m => m.session_id === sessionId && m.from_agent === agentName);
      },
      async getMessagesByType(sessionId: string, messageType: FormationMessageType): Promise<FormationMessage[]> {
        return messages.filter(m => m.session_id === sessionId && m.message_type === messageType);
      },
    },
    sessionStore: {
      async getSession(sessionId: string): Promise<FormationSession | null> {
        return sessions.get(sessionId) ?? null;
      },
      async createSession(input: InsertFormationSession): Promise<FormationSession> {
        const session: FormationSession = {
          id: _nextId(),
          created_at: new Date(),
          updated_at: new Date(),
          completed_at: null,
          formation_name: input.formation_name,
          state: "active",
          turn_count: 0,
          initiator_agent: input.initiator_agent,
          channel: input.channel ?? "internal",
          work_item_id: input.work_item_id ?? null,
          protocol: input.protocol,
          participating_agents: input.participating_agents,
          metadata: input.metadata ?? {},
        };
        sessions.set(session.id, session);
        return session;
      },
      async updateSession(sessionId: string, updates): Promise<FormationSession> {
        const session = sessions.get(sessionId);
        if (!session) throw new Error(`Session ${sessionId} not found`);
        const updated = { ...session, ...updates, updated_at: new Date() };
        sessions.set(sessionId, updated);
        return updated;
      },
    },
  };
}
