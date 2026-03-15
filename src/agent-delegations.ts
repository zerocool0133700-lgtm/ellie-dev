/**
 * Agent Delegation Flows — ELLIE-727
 *
 * Delegate tasks down the org chart, escalate up.
 * Traceable audit log with linked work sessions.
 *
 * Builds on ELLIE-725 (agent hierarchy / reports_to).
 */

import { sql } from "../../ellie-forest/src/index";

// ── Types ────────────────────────────────────────────────────

export type DelegationDirection = "delegate" | "escalate";
export type DelegationStatus = "pending" | "accepted" | "completed" | "failed" | "rejected" | "cancelled";

export const VALID_DELEGATION_STATUSES = [
  "pending", "accepted", "completed", "failed", "rejected", "cancelled",
] as const;

export interface AgentDelegation {
  id: string;
  created_at: Date;
  updated_at: Date;
  direction: DelegationDirection;
  from_agent_id: string;
  to_agent_id: string;
  status: DelegationStatus;
  summary: string;
  context: Record<string, unknown>;
  parent_work_session_id: string | null;
  child_work_session_id: string | null;
  work_item_id: string | null;
  accepted_at: Date | null;
  completed_at: Date | null;
  result: string | null;
  result_context: Record<string, unknown>;
}

export interface CreateDelegationInput {
  direction: DelegationDirection;
  from_agent_id: string;
  to_agent_id: string;
  summary: string;
  context?: Record<string, unknown>;
  parent_work_session_id?: string;
  work_item_id?: string;
}

/** Result of a delegation chain trace (audit trail). */
export interface DelegationChainEntry {
  id: string;
  direction: DelegationDirection;
  from_agent_id: string;
  to_agent_id: string;
  status: DelegationStatus;
  summary: string;
  created_at: Date;
  depth: number;
}

// ── Create Delegation ───────────────────────────────────────

/**
 * Create a delegation (delegate down) or escalation (escalate up).
 * Validates the org chart relationship exists before creating.
 */
export async function createDelegation(
  input: CreateDelegationInput,
): Promise<AgentDelegation> {
  // Validate relationship: for delegation, to_agent must report to from_agent;
  // for escalation, from_agent must report to to_agent.
  const [relationship] = await sql<{ reports_to: string | null }[]>`
    SELECT reports_to FROM agents WHERE id = ${
      input.direction === "delegate" ? input.to_agent_id : input.from_agent_id
    }::uuid
  `;

  if (!relationship) {
    throw new Error(`Agent not found`);
  }

  const expectedManager = input.direction === "delegate"
    ? input.from_agent_id
    : input.to_agent_id;

  if (relationship.reports_to !== expectedManager) {
    throw new Error(
      input.direction === "delegate"
        ? `Cannot delegate: target agent does not report to sender`
        : `Cannot escalate: sender does not report to target agent`,
    );
  }

  const [delegation] = await sql<AgentDelegation[]>`
    INSERT INTO agent_delegations (
      direction, from_agent_id, to_agent_id, summary,
      context, parent_work_session_id, work_item_id
    )
    VALUES (
      ${input.direction},
      ${input.from_agent_id}::uuid,
      ${input.to_agent_id}::uuid,
      ${input.summary},
      ${sql.json(input.context ?? {})},
      ${input.parent_work_session_id ?? null}::uuid,
      ${input.work_item_id ?? null}
    )
    RETURNING *
  `;

  return delegation;
}

// ── Accept / Reject ─────────────────────────────────────────

/**
 * Accept a pending delegation. Only the to_agent can accept.
 */
export async function acceptDelegation(
  delegationId: string,
  childWorkSessionId?: string,
): Promise<AgentDelegation | null> {
  const [delegation] = await sql<AgentDelegation[]>`
    UPDATE agent_delegations
    SET
      status = 'accepted',
      accepted_at = NOW(),
      child_work_session_id = ${childWorkSessionId ?? null}::uuid,
      updated_at = NOW()
    WHERE id = ${delegationId}::uuid
      AND status = 'pending'
    RETURNING *
  `;

  return delegation ?? null;
}

/**
 * Reject a pending delegation.
 */
export async function rejectDelegation(
  delegationId: string,
  reason?: string,
): Promise<AgentDelegation | null> {
  const [delegation] = await sql<AgentDelegation[]>`
    UPDATE agent_delegations
    SET
      status = 'rejected',
      result = ${reason ?? null},
      updated_at = NOW()
    WHERE id = ${delegationId}::uuid
      AND status = 'pending'
    RETURNING *
  `;

  return delegation ?? null;
}

// ── Complete / Fail ─────────────────────────────────────────

/**
 * Mark a delegation as completed with result.
 */
export async function completeDelegation(
  delegationId: string,
  result?: string,
  resultContext?: Record<string, unknown>,
): Promise<AgentDelegation | null> {
  const [delegation] = await sql<AgentDelegation[]>`
    UPDATE agent_delegations
    SET
      status = 'completed',
      completed_at = NOW(),
      result = ${result ?? null},
      result_context = ${sql.json(resultContext ?? {})},
      updated_at = NOW()
    WHERE id = ${delegationId}::uuid
      AND status = 'accepted'
    RETURNING *
  `;

  return delegation ?? null;
}

/**
 * Mark a delegation as failed.
 */
export async function failDelegation(
  delegationId: string,
  error: string,
): Promise<AgentDelegation | null> {
  const [delegation] = await sql<AgentDelegation[]>`
    UPDATE agent_delegations
    SET
      status = 'failed',
      completed_at = NOW(),
      result = ${error},
      updated_at = NOW()
    WHERE id = ${delegationId}::uuid
      AND status = 'accepted'
    RETURNING *
  `;

  return delegation ?? null;
}

/**
 * Cancel a pending delegation (by the sender).
 */
export async function cancelDelegation(
  delegationId: string,
): Promise<AgentDelegation | null> {
  const [delegation] = await sql<AgentDelegation[]>`
    UPDATE agent_delegations
    SET status = 'cancelled', updated_at = NOW()
    WHERE id = ${delegationId}::uuid
      AND status = 'pending'
    RETURNING *
  `;

  return delegation ?? null;
}

// ── Queries ─────────────────────────────────────────────────

/**
 * Get a delegation by ID.
 */
export async function getDelegation(id: string): Promise<AgentDelegation | null> {
  const [d] = await sql<AgentDelegation[]>`
    SELECT * FROM agent_delegations WHERE id = ${id}::uuid
  `;
  return d ?? null;
}

/**
 * Get pending delegations for an agent (tasks waiting for them).
 */
export async function getPendingForAgent(agentId: string): Promise<AgentDelegation[]> {
  return sql<AgentDelegation[]>`
    SELECT * FROM agent_delegations
    WHERE to_agent_id = ${agentId}::uuid AND status = 'pending'
    ORDER BY created_at ASC
  `;
}

/**
 * Get delegations sent by an agent.
 */
export async function getSentByAgent(
  agentId: string,
  opts: { status?: DelegationStatus; limit?: number } = {},
): Promise<AgentDelegation[]> {
  const limit = opts.limit ?? 50;

  if (opts.status) {
    return sql<AgentDelegation[]>`
      SELECT * FROM agent_delegations
      WHERE from_agent_id = ${agentId}::uuid AND status = ${opts.status}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  }

  return sql<AgentDelegation[]>`
    SELECT * FROM agent_delegations
    WHERE from_agent_id = ${agentId}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

/**
 * Get the delegation chain for a work item (audit trail).
 * Follows parent_work_session_id links to build the chain.
 */
export async function getDelegationChain(
  workItemId: string,
): Promise<AgentDelegation[]> {
  return sql<AgentDelegation[]>`
    SELECT * FROM agent_delegations
    WHERE work_item_id = ${workItemId}
    ORDER BY created_at ASC
  `;
}

/**
 * Build a delegation chain trace from a starting delegation.
 * Pure function — groups delegations by work_item_id and orders by time.
 */
export function traceDelegationChain(
  delegations: AgentDelegation[],
): DelegationChainEntry[] {
  return delegations
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map((d, i) => ({
      id: d.id,
      direction: d.direction,
      from_agent_id: d.from_agent_id,
      to_agent_id: d.to_agent_id,
      status: d.status,
      summary: d.summary,
      created_at: d.created_at,
      depth: i,
    }));
}
