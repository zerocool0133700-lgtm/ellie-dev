/**
 * Dispatch Commitment Tracker — ELLIE-589
 *
 * Auto-logs dispatch receipts as pending commitments in the commitment ledger.
 * Hooks into the specialist dispatch lifecycle:
 *  - trackDispatchStart: creates a pending commitment when specialist dispatches
 *  - trackDispatchComplete: resolves the commitment on success
 *  - trackDispatchFailure: times out the commitment on error/timeout
 *
 * Pure wrappers around commitment-ledger — no I/O, fully testable.
 */

import {
  createCommitment,
  resolveCommitment,
  getCommitment,
  listCommitments,
  type Commitment,
} from "./commitment-ledger.ts";
import { log } from "./logger.ts";

const logger = log.child("dispatch-commitment-tracker");

// ── Types ────────────────────────────────────────────────────────────────────

export interface DispatchTrackingResult {
  commitmentId: string;
  commitment: Commitment;
}

// ── Track dispatch lifecycle ─────────────────────────────────────────────────

/**
 * Create a pending commitment when a specialist dispatch starts.
 * Call after job creation in runSpecialistAsync.
 */
export function trackDispatchStart(
  sessionId: string,
  agentName: string,
  workItemId: string | undefined,
  promptSummary: string,
  turn: number,
): DispatchTrackingResult {
  const description = workItemId
    ? `Dispatch to ${agentName} for ${workItemId}: ${promptSummary}`
    : `Dispatch to ${agentName}: ${promptSummary}`;

  const commitment = createCommitment({
    sessionId,
    description,
    source: "dispatch",
    turnCreated: turn,
  });

  logger.info("Dispatch commitment created", {
    commitmentId: commitment.id,
    sessionId,
    agentName,
    workItemId,
  });

  return { commitmentId: commitment.id, commitment };
}

/**
 * Resolve a dispatch commitment when the specialist completes successfully.
 */
export function trackDispatchComplete(
  sessionId: string,
  commitmentId: string,
  turn: number,
): Commitment | null {
  const resolved = resolveCommitment(sessionId, commitmentId, turn);

  if (resolved) {
    logger.info("Dispatch commitment resolved", {
      commitmentId,
      sessionId,
    });
  } else {
    logger.warn("Failed to resolve dispatch commitment — not found or already resolved", {
      commitmentId,
      sessionId,
    });
  }

  return resolved;
}

/**
 * Mark a dispatch commitment as timed_out when the specialist fails or times out.
 * Directly mutates the commitment status since timeoutStaleCommitments uses
 * a time threshold which doesn't apply to explicit failure.
 */
export function trackDispatchFailure(
  sessionId: string,
  commitmentId: string,
): Commitment | null {
  const commitment = getCommitment(sessionId, commitmentId);

  if (!commitment || commitment.status !== "pending") {
    logger.warn("Failed to mark dispatch commitment as timed_out — not found or not pending", {
      commitmentId,
      sessionId,
    });
    return null;
  }

  // Direct mutation — commitment is a reference to the ledger entry
  commitment.status = "timed_out";

  logger.info("Dispatch commitment marked timed_out", {
    commitmentId,
    sessionId,
  });

  return commitment;
}

/**
 * Get all dispatch-source commitments for a session.
 */
export function listDispatchCommitments(
  sessionId: string,
): Commitment[] {
  return listCommitments(sessionId).filter(c => c.source === "dispatch");
}
