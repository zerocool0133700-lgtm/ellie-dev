/**
 * Commitment Ledger — ELLIE-588 + ELLIE-598
 *
 * Session-scoped in-memory store for tracking agent commitments
 * (promises made during conversation). Commitments are created when
 * an agent says "I will do X" and resolved when the action is done.
 *
 * ELLIE-598: Sub-commitment support — nested tasks within a main commitment.
 * When an agent needs another agent mid-workflow (e.g., dev asks critic),
 * that creates a sub-commitment under the parent with its own lifecycle.
 *
 * Session-scoped: each session has its own ledger, cleared on session end.
 * Stale commitments auto-flagged after configurable timeout.
 */

import { randomUUID } from "crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export type CommitmentSource = "dispatch" | "conversational";
export type CommitmentStatus = "pending" | "resolved" | "timed_out";

export interface Commitment {
  id: string;
  sessionId: string;
  description: string;
  source: CommitmentSource;
  status: CommitmentStatus;
  createdAt: string;
  resolvedAt?: string;
  turnCreated: number;
  turnResolved?: number;
  /** ELLIE-598: Parent commitment ID for sub-commitments. */
  parentCommitmentId?: string;
  /** ELLIE-598: Estimated duration in minutes. */
  estimatedDuration?: number;
  /** ELLIE-598: Agent that requested this sub-commitment. */
  requestingAgent?: string;
  /** ELLIE-598: Agent that should fulfill this sub-commitment. */
  targetAgent?: string;
  /** ELLIE-598: Work item ID — inherited from parent for sub-commitments. */
  workItemId?: string;
}

export interface CreateCommitmentInput {
  sessionId: string;
  description: string;
  source: CommitmentSource;
  turnCreated: number;
  /** ELLIE-598: Work item ID for top-level commitments. */
  workItemId?: string;
}

/** ELLIE-598: Input for creating a sub-commitment. */
export interface CreateSubCommitmentInput {
  sessionId: string;
  parentCommitmentId: string;
  description: string;
  requestingAgent: string;
  targetAgent: string;
  turnCreated: number;
  estimatedDuration?: number;
}

// ── Configuration ────────────────────────────────────────────────────────────

/** Default stale threshold: 30 minutes */
const DEFAULT_STALE_THRESHOLD_MS = 30 * 60 * 1000;

// ── Storage ──────────────────────────────────────────────────────────────────

/** Session ID → list of commitments */
const _ledger = new Map<string, Commitment[]>();

// ── CRUD operations ──────────────────────────────────────────────────────────

/**
 * Create a new commitment in the ledger.
 */
export function createCommitment(input: CreateCommitmentInput): Commitment {
  const commitment: Commitment = {
    id: randomUUID(),
    sessionId: input.sessionId,
    description: input.description,
    source: input.source,
    status: "pending",
    createdAt: new Date().toISOString(),
    turnCreated: input.turnCreated,
    workItemId: input.workItemId,
  };

  const existing = _ledger.get(input.sessionId) ?? [];
  existing.push(commitment);
  _ledger.set(input.sessionId, existing);

  return commitment;
}

/**
 * ELLIE-598: Create a sub-commitment under a parent commitment.
 * Inherits workItemId from the parent. Returns null if parent not found.
 */
export function createSubCommitment(input: CreateSubCommitmentInput): Commitment | null {
  const parent = getCommitment(input.sessionId, input.parentCommitmentId);
  if (!parent) return null;

  const commitment: Commitment = {
    id: randomUUID(),
    sessionId: input.sessionId,
    description: input.description,
    source: "dispatch",
    status: "pending",
    createdAt: new Date().toISOString(),
    turnCreated: input.turnCreated,
    parentCommitmentId: input.parentCommitmentId,
    requestingAgent: input.requestingAgent,
    targetAgent: input.targetAgent,
    estimatedDuration: input.estimatedDuration,
    workItemId: parent.workItemId,
  };

  const existing = _ledger.get(input.sessionId) ?? [];
  existing.push(commitment);
  _ledger.set(input.sessionId, existing);

  return commitment;
}

/**
 * Resolve a commitment by ID within a session.
 * Returns the updated commitment, or null if not found.
 */
export function resolveCommitment(
  sessionId: string,
  commitmentId: string,
  turnResolved: number,
): Commitment | null {
  const commitments = _ledger.get(sessionId);
  if (!commitments) return null;

  const commitment = commitments.find(c => c.id === commitmentId);
  if (!commitment || commitment.status !== "pending") return null;

  commitment.status = "resolved";
  commitment.resolvedAt = new Date().toISOString();
  commitment.turnResolved = turnResolved;

  return commitment;
}

/**
 * List all commitments for a session, optionally filtered by status.
 */
export function listCommitments(
  sessionId: string,
  status?: CommitmentStatus,
): Commitment[] {
  const commitments = _ledger.get(sessionId) ?? [];
  if (!status) return [...commitments];
  return commitments.filter(c => c.status === status);
}

/**
 * Get a single commitment by ID within a session.
 */
export function getCommitment(
  sessionId: string,
  commitmentId: string,
): Commitment | null {
  const commitments = _ledger.get(sessionId) ?? [];
  return commitments.find(c => c.id === commitmentId) ?? null;
}

/**
 * Flag stale pending commitments as timed_out.
 * Returns the number of commitments flagged.
 */
export function timeoutStaleCommitments(
  sessionId: string,
  thresholdMs: number = DEFAULT_STALE_THRESHOLD_MS,
  now?: Date,
): number {
  const commitments = _ledger.get(sessionId);
  if (!commitments) return 0;

  const cutoff = (now ?? new Date()).getTime() - thresholdMs;
  let flagged = 0;

  for (const c of commitments) {
    if (c.status === "pending" && new Date(c.createdAt).getTime() <= cutoff) {
      c.status = "timed_out";
      flagged++;
    }
  }

  return flagged;
}

/**
 * Clear all commitments for a session (called on session end).
 */
export function clearSession(sessionId: string): void {
  _ledger.delete(sessionId);
}

/**
 * Clear all sessions — for testing only.
 */
export function _resetLedgerForTesting(): void {
  _ledger.clear();
}

/**
 * Get count of pending commitments for a session.
 */
export function pendingCount(sessionId: string): number {
  const commitments = _ledger.get(sessionId) ?? [];
  return commitments.filter(c => c.status === "pending").length;
}

// ── ELLIE-598: Sub-commitment queries ────────────────────────────────────────

/**
 * List all sub-commitments for a given parent commitment.
 */
export function listSubCommitments(
  sessionId: string,
  parentCommitmentId: string,
  status?: CommitmentStatus,
): Commitment[] {
  const commitments = _ledger.get(sessionId) ?? [];
  const subs = commitments.filter(c => c.parentCommitmentId === parentCommitmentId);
  if (!status) return [...subs];
  return subs.filter(c => c.status === status);
}

/**
 * Check if a commitment is a sub-commitment (has a parent).
 */
export function isSubCommitment(commitment: Commitment): boolean {
  return commitment.parentCommitmentId !== undefined;
}

/**
 * List only top-level commitments (no parent) for a session.
 */
export function listTopLevelCommitments(
  sessionId: string,
  status?: CommitmentStatus,
): Commitment[] {
  const commitments = _ledger.get(sessionId) ?? [];
  const topLevel = commitments.filter(c => !c.parentCommitmentId);
  if (!status) return [...topLevel];
  return topLevel.filter(c => c.status === status);
}

/**
 * Get a commitment with all its sub-commitments as a tree.
 */
export interface CommitmentWithChildren {
  commitment: Commitment;
  children: Commitment[];
}

export function getCommitmentTree(
  sessionId: string,
  commitmentId: string,
): CommitmentWithChildren | null {
  const commitment = getCommitment(sessionId, commitmentId);
  if (!commitment) return null;

  return {
    commitment,
    children: listSubCommitments(sessionId, commitmentId),
  };
}
