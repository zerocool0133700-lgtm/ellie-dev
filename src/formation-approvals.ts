/**
 * Formation Approval Gates — ELLIE-726
 *
 * Human-in-the-loop approval for high-stakes formation outputs.
 * Request, approve, reject, timeout lifecycle.
 *
 * Database functions module — uses postgres.js via ellie-forest.
 */

import { sql } from "../../ellie-forest/src/index";

// ── Types ────────────────────────────────────────────────────

export type ApprovalStatus = "pending" | "approved" | "rejected" | "timed_out";

export const VALID_APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "timed_out",
] as const;

/** Default approval timeout: 1 hour. */
export const DEFAULT_TIMEOUT_SECONDS = 3600;

/** A formation approval record (maps to formation_approvals table). */
export interface FormationApproval {
  id: string;
  created_at: Date;
  formation_session_id: string;
  required_approver_id: string | null;
  status: ApprovalStatus;
  requested_at: Date;
  responded_at: Date | null;
  timeout_seconds: number;
  summary: string;
  context: Record<string, unknown>;
  responded_by: string | null;
  rejection_reason: string | null;
  channel: string;
  external_message_id: string | null;
}

/** Input for requesting an approval. */
export interface RequestApprovalInput {
  formation_session_id: string;
  summary: string;
  required_approver_id?: string;
  timeout_seconds?: number;
  context?: Record<string, unknown>;
  channel?: string;
  external_message_id?: string;
}

/** Result of checking whether a session can proceed. */
export interface ApprovalGateResult {
  can_proceed: boolean;
  status: ApprovalStatus | "no_approval_required";
  approval_id: string | null;
  rejection_reason: string | null;
}

// ── Request Approval ────────────────────────────────────────

/**
 * Create a new approval request for a formation session.
 */
export async function requestApproval(
  input: RequestApprovalInput,
): Promise<FormationApproval> {
  const [approval] = await sql<FormationApproval[]>`
    INSERT INTO formation_approvals (
      formation_session_id, required_approver_id, summary,
      timeout_seconds, context, channel, external_message_id
    )
    VALUES (
      ${input.formation_session_id}::uuid,
      ${input.required_approver_id ?? null}::uuid,
      ${input.summary},
      ${input.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS},
      ${sql.json(input.context ?? {})},
      ${input.channel ?? "telegram"},
      ${input.external_message_id ?? null}
    )
    RETURNING *
  `;

  return approval;
}

// ── Approve / Reject ────────────────────────────────────────

/**
 * Approve a pending approval request.
 * Only works if status is still 'pending'.
 */
export async function approveRequest(
  approvalId: string,
  respondedBy: string,
): Promise<FormationApproval | null> {
  const [approval] = await sql<FormationApproval[]>`
    UPDATE formation_approvals
    SET
      status = 'approved',
      responded_at = NOW(),
      responded_by = ${respondedBy}
    WHERE id = ${approvalId}::uuid
      AND status = 'pending'
    RETURNING *
  `;

  return approval ?? null;
}

/**
 * Reject a pending approval request.
 */
export async function rejectRequest(
  approvalId: string,
  respondedBy: string,
  reason?: string,
): Promise<FormationApproval | null> {
  const [approval] = await sql<FormationApproval[]>`
    UPDATE formation_approvals
    SET
      status = 'rejected',
      responded_at = NOW(),
      responded_by = ${respondedBy},
      rejection_reason = ${reason ?? null}
    WHERE id = ${approvalId}::uuid
      AND status = 'pending'
    RETURNING *
  `;

  return approval ?? null;
}

// ── Timeout ─────────────────────────────────────────────────

/**
 * Find and mark timed-out approvals.
 * An approval is timed out when:
 *   status = 'pending' AND NOW() > requested_at + timeout_seconds
 */
export async function expireTimedOutApprovals(): Promise<FormationApproval[]> {
  return sql<FormationApproval[]>`
    UPDATE formation_approvals
    SET
      status = 'timed_out',
      responded_at = NOW()
    WHERE status = 'pending'
      AND requested_at + (timeout_seconds || ' seconds')::interval < NOW()
    RETURNING *
  `;
}

// ── Gate Check ──────────────────────────────────────────────

/**
 * Check if a formation session can proceed through the approval gate.
 *
 * Returns:
 * - can_proceed=true, status='no_approval_required' — no approval needed
 * - can_proceed=true, status='approved' — approved
 * - can_proceed=false, status='pending' — waiting for approval
 * - can_proceed=false, status='rejected' — rejected
 * - can_proceed=false, status='timed_out' — timed out
 */
export async function checkApprovalGate(
  sessionId: string,
): Promise<ApprovalGateResult> {
  const [approval] = await sql<FormationApproval[]>`
    SELECT * FROM formation_approvals
    WHERE formation_session_id = ${sessionId}::uuid
    ORDER BY requested_at DESC
    LIMIT 1
  `;

  if (!approval) {
    return {
      can_proceed: true,
      status: "no_approval_required",
      approval_id: null,
      rejection_reason: null,
    };
  }

  return {
    can_proceed: approval.status === "approved",
    status: approval.status,
    approval_id: approval.id,
    rejection_reason: approval.rejection_reason,
  };
}

// ── Queries ─────────────────────────────────────────────────

/**
 * Get a specific approval by ID.
 */
export async function getApproval(
  approvalId: string,
): Promise<FormationApproval | null> {
  const [approval] = await sql<FormationApproval[]>`
    SELECT * FROM formation_approvals WHERE id = ${approvalId}::uuid
  `;
  return approval ?? null;
}

/**
 * Get all approvals for a formation session.
 */
export async function getSessionApprovals(
  sessionId: string,
): Promise<FormationApproval[]> {
  return sql<FormationApproval[]>`
    SELECT * FROM formation_approvals
    WHERE formation_session_id = ${sessionId}::uuid
    ORDER BY requested_at DESC
  `;
}

/**
 * Get all pending approvals, optionally filtered by channel.
 */
export async function getPendingApprovals(
  opts: { channel?: string; limit?: number } = {},
): Promise<FormationApproval[]> {
  const limit = opts.limit ?? 50;

  if (opts.channel) {
    return sql<FormationApproval[]>`
      SELECT * FROM formation_approvals
      WHERE status = 'pending' AND channel = ${opts.channel}
      ORDER BY requested_at ASC
      LIMIT ${limit}
    `;
  }

  return sql<FormationApproval[]>`
    SELECT * FROM formation_approvals
    WHERE status = 'pending'
    ORDER BY requested_at ASC
    LIMIT ${limit}
  `;
}

/**
 * Update the external message ID (after sending the approval
 * request to Telegram/GChat).
 */
export async function setExternalMessageId(
  approvalId: string,
  externalMessageId: string,
): Promise<FormationApproval | null> {
  const [approval] = await sql<FormationApproval[]>`
    UPDATE formation_approvals
    SET external_message_id = ${externalMessageId}
    WHERE id = ${approvalId}::uuid
    RETURNING *
  `;
  return approval ?? null;
}
