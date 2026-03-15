/**
 * Formation Atomic Checkout — ELLIE-721
 *
 * Prevents two agents from running the same formation simultaneously
 * using compare-and-swap (CAS) semantics on the checked_out_by column.
 *
 * Pure module — database functions only, no side effects beyond SQL.
 */

import { sql } from "../../ellie-forest/src/index";
import type { FormationCheckoutStatus } from "./types/formation";

// ── Types ────────────────────────────────────────────────────

export interface CheckoutResult {
  success: boolean;
  session_id: string;
  checked_out_by: string | null;
  checked_out_at: Date | null;
  status: FormationCheckoutStatus;
}

export interface ReleaseResult {
  success: boolean;
  session_id: string;
  status: FormationCheckoutStatus;
}

export interface StaleCheckout {
  session_id: string;
  checked_out_by: string;
  checked_out_at: Date;
  status: FormationCheckoutStatus;
  formation_name: string;
}

/** Default stale timeout: 30 minutes. */
export const DEFAULT_STALE_TIMEOUT_MS = 30 * 60 * 1000;

// ── Atomic Checkout (CAS) ────────────────────────────────────

/**
 * Attempt to atomically check out a formation session.
 *
 * Uses a compare-and-swap pattern: only succeeds if `checked_out_by`
 * is currently NULL (no one holds the checkout). The UPDATE ... WHERE
 * clause ensures atomicity at the database level — concurrent callers
 * will see the same row but only one UPDATE will match.
 */
export async function checkoutSession(
  sessionId: string,
  agentId: string,
): Promise<CheckoutResult> {
  const rows = await sql<
    { id: string; checked_out_by: string | null; checked_out_at: Date | null; status: string }[]
  >`
    UPDATE formation_sessions
    SET
      checked_out_by = ${agentId}::uuid,
      checked_out_at = NOW(),
      status = 'checked_out',
      updated_at = NOW()
    WHERE id = ${sessionId}::uuid
      AND checked_out_by IS NULL
      AND status = 'pending'
    RETURNING id, checked_out_by, checked_out_at, status
  `;

  if (rows.length === 0) {
    // CAS failed — either session doesn't exist, or already checked out
    const [current] = await sql<
      { id: string; checked_out_by: string | null; checked_out_at: Date | null; status: string }[]
    >`
      SELECT id, checked_out_by, checked_out_at, status
      FROM formation_sessions
      WHERE id = ${sessionId}::uuid
    `;

    if (!current) {
      throw new Error(`Formation session ${sessionId} not found`);
    }

    return {
      success: false,
      session_id: current.id,
      checked_out_by: current.checked_out_by,
      checked_out_at: current.checked_out_at,
      status: current.status as FormationCheckoutStatus,
    };
  }

  const row = rows[0];
  return {
    success: true,
    session_id: row.id,
    checked_out_by: row.checked_out_by,
    checked_out_at: row.checked_out_at,
    status: row.status as FormationCheckoutStatus,
  };
}

// ── Transition to In-Progress ────────────────────────────────

/**
 * Move a checked-out session to in_progress. Only the agent
 * that holds the checkout can do this.
 */
export async function startSession(
  sessionId: string,
  agentId: string,
): Promise<CheckoutResult> {
  const rows = await sql<
    { id: string; checked_out_by: string | null; checked_out_at: Date | null; status: string }[]
  >`
    UPDATE formation_sessions
    SET status = 'in_progress', updated_at = NOW()
    WHERE id = ${sessionId}::uuid
      AND checked_out_by = ${agentId}::uuid
      AND status = 'checked_out'
    RETURNING id, checked_out_by, checked_out_at, status
  `;

  if (rows.length === 0) {
    throw new Error(
      `Cannot start session ${sessionId}: not checked out by agent ${agentId} or not in checked_out status`,
    );
  }

  const row = rows[0];
  return {
    success: true,
    session_id: row.id,
    checked_out_by: row.checked_out_by,
    checked_out_at: row.checked_out_at,
    status: row.status as FormationCheckoutStatus,
  };
}

// ── Release (Completion / Failure) ───────────────────────────

/**
 * Release a checkout on completion or failure. Clears the
 * checked_out_by/checked_out_at fields and sets the final status.
 *
 * Only the agent that holds the checkout can release it.
 */
export async function releaseSession(
  sessionId: string,
  agentId: string,
  finalStatus: "completed" | "failed",
): Promise<ReleaseResult> {
  // Use two separate queries to avoid nested sql`` calls:
  // one for completion (sets completed_at) and one for failure (leaves it).
  const rows = finalStatus === "completed"
    ? await sql<{ id: string; status: string }[]>`
        UPDATE formation_sessions
        SET
          checked_out_by = NULL,
          checked_out_at = NULL,
          status = ${finalStatus},
          updated_at = NOW(),
          completed_at = NOW()
        WHERE id = ${sessionId}::uuid
          AND checked_out_by = ${agentId}::uuid
          AND status IN ('checked_out', 'in_progress')
        RETURNING id, status
      `
    : await sql<{ id: string; status: string }[]>`
        UPDATE formation_sessions
        SET
          checked_out_by = NULL,
          checked_out_at = NULL,
          status = ${finalStatus},
          updated_at = NOW()
        WHERE id = ${sessionId}::uuid
          AND checked_out_by = ${agentId}::uuid
          AND status IN ('checked_out', 'in_progress')
        RETURNING id, status
      `;

  if (rows.length === 0) {
    throw new Error(
      `Cannot release session ${sessionId}: not checked out by agent ${agentId}`,
    );
  }

  return {
    success: true,
    session_id: rows[0].id,
    status: rows[0].status as FormationCheckoutStatus,
  };
}

// ── Force Release (Admin / Stale Recovery) ───────────────────

/**
 * Force-release a session regardless of who holds it.
 * Used for stale checkout recovery.
 */
export async function forceReleaseSession(
  sessionId: string,
): Promise<ReleaseResult> {
  const rows = await sql<{ id: string; status: string }[]>`
    UPDATE formation_sessions
    SET
      checked_out_by = NULL,
      checked_out_at = NULL,
      status = 'pending',
      updated_at = NOW()
    WHERE id = ${sessionId}::uuid
      AND checked_out_by IS NOT NULL
    RETURNING id, status
  `;

  if (rows.length === 0) {
    throw new Error(
      `Cannot force-release session ${sessionId}: not currently checked out`,
    );
  }

  return {
    success: true,
    session_id: rows[0].id,
    status: rows[0].status as FormationCheckoutStatus,
  };
}

// ── Stale Checkout Detection ─────────────────────────────────

/**
 * Find formation sessions with stale checkouts (checked out longer
 * than the given timeout).
 */
export async function findStaleCheckouts(
  timeoutMs: number = DEFAULT_STALE_TIMEOUT_MS,
): Promise<StaleCheckout[]> {
  const intervalSeconds = Math.floor(timeoutMs / 1000);

  const rows = await sql<StaleCheckout[]>`
    SELECT
      id AS session_id,
      checked_out_by,
      checked_out_at,
      status,
      formation_name
    FROM formation_sessions
    WHERE checked_out_by IS NOT NULL
      AND status IN ('checked_out', 'in_progress')
      AND checked_out_at < NOW() - INTERVAL '1 second' * ${intervalSeconds}
    ORDER BY checked_out_at ASC
  `;

  return rows;
}

/**
 * Find and auto-release all stale checkouts. Returns the sessions
 * that were released.
 */
export async function releaseStaleCheckouts(
  timeoutMs: number = DEFAULT_STALE_TIMEOUT_MS,
): Promise<StaleCheckout[]> {
  const intervalSeconds = Math.floor(timeoutMs / 1000);

  const rows = await sql<StaleCheckout[]>`
    UPDATE formation_sessions
    SET
      checked_out_by = NULL,
      checked_out_at = NULL,
      status = 'pending',
      updated_at = NOW()
    WHERE checked_out_by IS NOT NULL
      AND status IN ('checked_out', 'in_progress')
      AND checked_out_at < NOW() - INTERVAL '1 second' * ${intervalSeconds}
    RETURNING
      id AS session_id,
      checked_out_by,
      checked_out_at,
      status,
      formation_name
  `;

  return rows;
}
