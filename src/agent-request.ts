/**
 * Agent Request — ELLIE-600
 *
 * Coordinator notification system for inter-agent requests.
 * When an agent needs another agent during a workflow, it submits
 * a request through the coordinator for approval.
 *
 * Flow:
 *  1. Agent submits request (agent-request-sent)
 *  2. Coordinator approves or denies
 *  3. On approval: sub-commitment created, routing info returned (agent-request-approved)
 *  4. On denial: rejection reason returned to requesting agent
 *  5. On completion: agent-request-completed event
 *
 * Depends on: ELLIE-598 (sub-commitments), ELLIE-599 (agent registry)
 *
 * Pure module — in-memory store with zero external side effects.
 */

import { randomUUID } from "crypto";
import {
  createSubCommitment,
  type Commitment,
} from "./commitment-ledger.ts";
import {
  lookupAgent,
  resolveRoute,
  type RegisteredAgent,
} from "./agent-registry.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type AgentRequestStatus = "pending" | "approved" | "denied" | "completed" | "timed_out";

export type AgentRequestEvent =
  | "agent-request-sent"
  | "agent-request-approved"
  | "agent-request-denied"
  | "agent-request-completed"
  | "agent-request-timed-out";

export interface AgentRequest {
  id: string;
  sessionId: string;
  parentCommitmentId: string;
  requestingAgent: string;
  targetAgent: string;
  reason: string;
  estimatedDuration?: number;
  requiredCapability?: string;
  status: AgentRequestStatus;
  createdAt: string;
  resolvedAt?: string;
  denialReason?: string;
  subCommitmentId?: string;
}

export interface CreateAgentRequestInput {
  sessionId: string;
  parentCommitmentId: string;
  requestingAgent: string;
  targetAgent: string;
  reason: string;
  estimatedDuration?: number;
  requiredCapability?: string;
}

export interface ApprovalResult {
  approved: true;
  request: AgentRequest;
  subCommitment: Commitment;
  routeInfo: RegisteredAgent;
  event: AgentRequestEvent;
}

export interface DenialResult {
  approved: false;
  request: AgentRequest;
  reason: string;
  event: AgentRequestEvent;
}

export interface CompletionResult {
  request: AgentRequest;
  event: AgentRequestEvent;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ProgressEvent {
  event: AgentRequestEvent;
  requestId: string;
  timestamp: string;
  details: Record<string, unknown>;
}

// ── Configuration ────────────────────────────────────────────────────────────

/** Default request timeout: 10 minutes. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

// ── Storage ──────────────────────────────────────────────────────────────────

const _requests = new Map<string, AgentRequest>();
const _events: ProgressEvent[] = [];

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate an agent request before submission.
 * Checks that required fields are present and target agent exists.
 */
export function validateAgentRequest(input: CreateAgentRequestInput): ValidationResult {
  const errors: string[] = [];

  if (!input.sessionId?.trim()) errors.push("sessionId is required");
  if (!input.parentCommitmentId?.trim()) errors.push("parentCommitmentId is required");
  if (!input.requestingAgent?.trim()) errors.push("requestingAgent is required");
  if (!input.targetAgent?.trim()) errors.push("targetAgent is required");
  if (!input.reason?.trim()) errors.push("reason is required");
  if (input.requestingAgent === input.targetAgent) {
    errors.push("requestingAgent and targetAgent must be different");
  }

  return { valid: errors.length === 0, errors };
}

// ── Request lifecycle ────────────────────────────────────────────────────────

/**
 * Submit an inter-agent request for coordinator review.
 * Returns the request and an agent-request-sent event.
 */
export function submitAgentRequest(input: CreateAgentRequestInput): {
  request: AgentRequest;
  event: ProgressEvent;
} | { error: string } {
  const validation = validateAgentRequest(input);
  if (!validation.valid) {
    return { error: validation.errors.join("; ") };
  }

  const now = new Date().toISOString();
  const request: AgentRequest = {
    id: randomUUID(),
    sessionId: input.sessionId,
    parentCommitmentId: input.parentCommitmentId,
    requestingAgent: input.requestingAgent,
    targetAgent: input.targetAgent,
    reason: input.reason,
    estimatedDuration: input.estimatedDuration,
    requiredCapability: input.requiredCapability,
    status: "pending",
    createdAt: now,
  };

  _requests.set(request.id, request);

  const event = recordEvent("agent-request-sent", request.id, {
    requestingAgent: input.requestingAgent,
    targetAgent: input.targetAgent,
    reason: input.reason,
  });

  return { request, event };
}

/**
 * Approve an agent request.
 * Creates a sub-commitment and returns routing info for the target agent.
 * Returns null if request not found or not pending.
 */
export function approveAgentRequest(
  requestId: string,
  turnCreated: number,
): ApprovalResult | { error: string } {
  const request = _requests.get(requestId);
  if (!request) return { error: "Request not found" };
  if (request.status !== "pending") return { error: `Request is ${request.status}, not pending` };

  // Check target agent availability
  const route = resolveRoute(request.targetAgent, request.requiredCapability);
  if (!route.routable) {
    return { error: route.reason };
  }

  // Create sub-commitment under the parent
  const subCommitment = createSubCommitment({
    sessionId: request.sessionId,
    parentCommitmentId: request.parentCommitmentId,
    description: request.reason,
    requestingAgent: request.requestingAgent,
    targetAgent: request.targetAgent,
    turnCreated,
    estimatedDuration: request.estimatedDuration,
  });

  if (!subCommitment) {
    return { error: "Failed to create sub-commitment (parent not found)" };
  }

  // Update request
  const updated: AgentRequest = {
    ...request,
    status: "approved",
    resolvedAt: new Date().toISOString(),
    subCommitmentId: subCommitment.id,
  };
  _requests.set(requestId, updated);

  recordEvent("agent-request-approved", requestId, {
    targetAgent: request.targetAgent,
    subCommitmentId: subCommitment.id,
  });

  return {
    approved: true,
    request: updated,
    subCommitment,
    routeInfo: route.agent,
    event: "agent-request-approved",
  };
}

/**
 * Deny an agent request with a reason.
 * Returns null if request not found or not pending.
 */
export function denyAgentRequest(
  requestId: string,
  reason: string,
): DenialResult | { error: string } {
  const request = _requests.get(requestId);
  if (!request) return { error: "Request not found" };
  if (request.status !== "pending") return { error: `Request is ${request.status}, not pending` };

  const updated: AgentRequest = {
    ...request,
    status: "denied",
    resolvedAt: new Date().toISOString(),
    denialReason: reason,
  };
  _requests.set(requestId, updated);

  recordEvent("agent-request-denied", requestId, {
    reason,
    targetAgent: request.targetAgent,
  });

  return {
    approved: false,
    request: updated,
    reason,
    event: "agent-request-denied",
  };
}

/**
 * Mark an approved request as completed.
 * Called when the target agent finishes its work.
 */
export function completeAgentRequest(requestId: string): CompletionResult | { error: string } {
  const request = _requests.get(requestId);
  if (!request) return { error: "Request not found" };
  if (request.status !== "approved") return { error: `Request is ${request.status}, not approved` };

  const updated: AgentRequest = {
    ...request,
    status: "completed",
    resolvedAt: new Date().toISOString(),
  };
  _requests.set(requestId, updated);

  recordEvent("agent-request-completed", requestId, {
    targetAgent: request.targetAgent,
    requestingAgent: request.requestingAgent,
  });

  return { request: updated, event: "agent-request-completed" };
}

/**
 * Time out pending requests that have exceeded the timeout.
 * Returns the number of requests timed out.
 */
export function timeoutPendingRequests(
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  now?: Date,
): number {
  const cutoff = (now ?? new Date()).getTime() - timeoutMs;
  let count = 0;

  for (const [id, request] of _requests) {
    if (request.status === "pending" && new Date(request.createdAt).getTime() <= cutoff) {
      _requests.set(id, {
        ...request,
        status: "timed_out",
        resolvedAt: new Date().toISOString(),
      });
      recordEvent("agent-request-timed-out", id, {
        targetAgent: request.targetAgent,
        requestingAgent: request.requestingAgent,
      });
      count++;
    }
  }

  return count;
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Get a request by ID.
 */
export function getAgentRequest(requestId: string): AgentRequest | null {
  return _requests.get(requestId) ?? null;
}

/**
 * List requests, optionally filtered by status and/or session.
 */
export function listAgentRequests(
  filters?: { status?: AgentRequestStatus; sessionId?: string },
): AgentRequest[] {
  let results = [..._requests.values()];
  if (filters?.status) results = results.filter(r => r.status === filters.status);
  if (filters?.sessionId) results = results.filter(r => r.sessionId === filters.sessionId);
  return results;
}

/**
 * List pending requests for coordinator prompt injection.
 */
export function listPendingRequests(sessionId?: string): AgentRequest[] {
  return listAgentRequests({ status: "pending", sessionId });
}

/**
 * Get progress events for a request.
 */
export function getRequestEvents(requestId: string): ProgressEvent[] {
  return _events.filter(e => e.requestId === requestId);
}

// ── Prompt injection ─────────────────────────────────────────────────────────

/**
 * Build a prompt section showing pending inter-agent requests.
 * Returns null if no pending requests.
 */
export function buildPendingRequestsSection(requests: AgentRequest[]): string | null {
  if (requests.length === 0) return null;

  const lines: string[] = [`\nPENDING AGENT REQUESTS (${requests.length}):`];
  lines.push("These requests need coordinator approval before agents can collaborate.");

  for (const r of requests) {
    const duration = r.estimatedDuration ? ` (~${r.estimatedDuration}m)` : "";
    lines.push(`- ${r.requestingAgent} → ${r.targetAgent}: ${r.reason}${duration}`);
  }

  lines.push("Approve or deny each request. Use agent-request approve/deny commands.");

  return lines.join("\n");
}

// ── Events ───────────────────────────────────────────────────────────────────

function recordEvent(
  event: AgentRequestEvent,
  requestId: string,
  details: Record<string, unknown>,
): ProgressEvent {
  const entry: ProgressEvent = {
    event,
    requestId,
    timestamp: new Date().toISOString(),
    details,
  };
  _events.push(entry);
  return entry;
}

// ── Testing ──────────────────────────────────────────────────────────────────

/** Reset all state — for testing only. */
export function _resetAgentRequestsForTesting(): void {
  _requests.clear();
  _events.length = 0;
}
