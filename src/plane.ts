/**
 * Plane API Client
 *
 * REST client for interacting with the Plane project management API.
 * Used by work session endpoints to update work items on session start/complete.
 */

import { log } from "./logger.ts";
import { breakers, withRetry, isTransientError } from "./resilience.ts";
import { enqueuePlaneStateChange, enqueuePlaneComment } from "./plane-queue.ts";

const logger = log.child("plane");

const PLANE_API_KEY = process.env.PLANE_API_KEY;
const PLANE_BASE_URL = (process.env.PLANE_BASE_URL || "https://plane.ellie-labs.dev").replace(/\/api\/v1\/?$/, "");
const PLANE_WORKSPACE_SLUG = process.env.PLANE_WORKSPACE_SLUG || process.env.PLANE_WORKSPACE || "evelife";

export function isPlaneConfigured(): boolean {
  return !!PLANE_API_KEY;
}

// ============================================================
// TIMEOUT RECOVERY STATE LOCK
// ============================================================
// Prevents Plane state churn (Done→Progress→Done) during timeout
// recovery windows. When a Claude process times out, we lock state
// changes for a cooldown period so retries/restarts don't flip states.

let timeoutRecoveryUntil = 0;

export function setTimeoutRecoveryLock(durationMs: number = 60_000) {
  timeoutRecoveryUntil = Date.now() + durationMs;
  logger.info(`State lock set for ${durationMs / 1000}s — suppressing state changes during timeout recovery`);
}

export function clearTimeoutRecoveryLock() {
  timeoutRecoveryUntil = 0;
  logger.info("State lock cleared");
}

export function isInTimeoutRecovery(): boolean {
  if (timeoutRecoveryUntil === 0) return false;
  if (Date.now() > timeoutRecoveryUntil) {
    timeoutRecoveryUntil = 0; // Auto-expire
    return false;
  }
  return true;
}

/** Expose for testing */
export function _resetTimeoutRecoveryForTesting() {
  timeoutRecoveryUntil = 0;
}

async function planeRequest(path: string, options?: RequestInit) {
  return breakers.plane.call(
    () => withRetry(
      async () => {
        const res = await fetch(`${PLANE_BASE_URL}/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}${path}`, {
          ...options,
          headers: {
            "Content-Type": "application/json",
            "x-api-key": PLANE_API_KEY!,
            ...options?.headers,
          },
        });
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Plane API ${res.status}: ${body}`);
        }
        return res.json();
      },
      { maxRetries: 2, baseDelayMs: 1000, retryOn: isTransientError },
    ),
    null,
  );
}

/** Parse "ELLIE-7" into { projectIdentifier: "ELLIE", sequenceId: 7 } */
function parseWorkItemId(workItemId: string) {
  const match = workItemId.match(/^([A-Z]+)-(\d+)$/);
  if (!match) return null;
  return { projectIdentifier: match[1], sequenceId: parseInt(match[2]) };
}

/** Find a project UUID by its short identifier (e.g. "ELLIE") */
async function getProjectByIdentifier(identifier: string): Promise<string | null> {
  const data = await planeRequest("/projects/");
  if (!data) return null;
  const project = data.results?.find((p: Record<string, unknown>) => p.identifier === identifier);
  return project?.id ?? null;
}

/** Find an issue by sequence number within a project (returns full issue data) */
async function getIssueBySequenceId(projectId: string, sequenceId: number): Promise<Record<string, unknown> | null> {
  const data = await planeRequest(`/projects/${projectId}/issues/?sequence_id=${sequenceId}`);
  if (!data) return null;
  return data.results?.find((i: Record<string, unknown>) => i.sequence_id === sequenceId) ?? null;
}

/** Get the state UUID for a given group (e.g. "started" for In Progress) */
export async function getStateIdByGroup(projectId: string, group: string): Promise<string | null> {
  const data = await planeRequest(`/projects/${projectId}/states/`);
  if (!data) return null;
  const state = data.results?.find((s: Record<string, unknown>) => s.group === group);
  return state?.id ?? null;
}

/**
 * Get the current state group of an issue by its UUID.
 * Used by the queue worker to detect idempotency before retrying a state
 * change — if the issue is already in the target group, the PATCH is skipped
 * (ELLIE-488).
 */
export async function getIssueStateGroup(projectId: string, issueId: string): Promise<string | null> {
  const data = await planeRequest(`/projects/${projectId}/issues/${issueId}/`);
  if (!data) return null;
  return (data.state_detail as Record<string, string>)?.group ?? null;
}

/**
 * Resolve a readable work item ID (e.g. "ELLIE-7") to Plane UUIDs.
 * Returns { projectId, issueId } or null if not found.
 */
export async function resolveWorkItemId(workItemId: string) {
  const parsed = parseWorkItemId(workItemId);
  if (!parsed) return null;

  const projectId = await getProjectByIdentifier(parsed.projectIdentifier);
  if (!projectId) return null;

  const issue = await getIssueBySequenceId(projectId, parsed.sequenceId);
  if (!issue) return null;

  return { projectId, issueId: issue.id };
}

/** Update a Plane issue's state */
export async function updateIssueState(projectId: string, issueId: string, stateId: string) {
  return planeRequest(`/projects/${projectId}/issues/${issueId}/`, {
    method: "PATCH",
    body: JSON.stringify({ state: stateId }),
  });
}

/** Add a comment to a Plane issue */
export async function addIssueComment(projectId: string, issueId: string, commentHtml: string) {
  return planeRequest(`/projects/${projectId}/issues/${issueId}/comments/`, {
    method: "POST",
    body: JSON.stringify({ comment_html: commentHtml }),
  });
}

// ============================================================
// ATOMIC OPERATIONS (ELLIE-483)
// ============================================================
// State change + comment are executed sequentially as a logical
// transaction. If the comment fails after the state change, the
// state is rolled back. Idempotency checks prevent duplicate
// comments on retry.

/** List comments on a Plane issue (for idempotency checks) */
async function listIssueComments(projectId: string, issueId: string): Promise<Array<{ comment_html: string }>> {
  try {
    const data = await planeRequest(`/projects/${projectId}/issues/${issueId}/comments/`);
    if (!data) return [];
    return data.results || data || [];
  } catch {
    return [];
  }
}

/** Check if a comment containing a session ID already exists on an issue */
export async function sessionCommentExists(projectId: string, issueId: string, sessionId: string): Promise<boolean> {
  const comments = await listIssueComments(projectId, issueId);
  return comments.some((c: { comment_html: string }) => c.comment_html?.includes(sessionId));
}

/** Get an issue's current state UUID (for rollback tracking) */
async function getIssueCurrentStateId(projectId: string, issueId: string): Promise<string | null> {
  try {
    const data = await planeRequest(`/projects/${projectId}/issues/${issueId}/`);
    return (data?.state as string) ?? null;
  } catch {
    return null;
  }
}

interface AtomicResult {
  stateApplied: boolean;
  commentApplied: boolean;
  rolledBack: boolean;
  queued: boolean;
}

/**
 * Execute a state change + comment as a logical transaction (ELLIE-483).
 *
 * 1. Save current state for rollback
 * 2. Apply state change
 * 3. Apply comment (with idempotency check if sessionId present)
 * 4. On comment failure → rollback state, queue both for retry
 * 5. On state failure → queue both for retry (no rollback needed)
 */
async function atomicStateAndComment(opts: {
  projectId: string;
  issueId: string;
  workItemId: string;
  targetStateGroup: string;
  commentHtml: string;
  sessionId?: string;
  label: string;
}): Promise<AtomicResult> {
  const { projectId, issueId, workItemId, targetStateGroup, commentHtml, sessionId, label } = opts;
  const result: AtomicResult = { stateApplied: false, commentApplied: false, rolledBack: false, queued: false };

  // 1. Resolve target state ID
  const targetStateId = await getStateIdByGroup(projectId, targetStateGroup);
  if (!targetStateId) {
    logger.error("Could not resolve target state — queueing", { workItemId, targetStateGroup, label });
    await enqueuePlaneStateChange({ workItemId, stateGroup: targetStateGroup, projectId, issueId, sessionId });
    await enqueuePlaneComment({ workItemId, commentHtml, projectId, issueId, sessionId });
    result.queued = true;
    return result;
  }

  // 2. Save current state for rollback
  const previousStateId = await getIssueCurrentStateId(projectId, issueId);

  // 3. Apply state change
  try {
    const stateResult = await updateIssueState(projectId, issueId, targetStateId);
    if (stateResult === null) throw new Error("State update returned null (circuit breaker open)");
    result.stateApplied = true;
    logger.info(`${workItemId} → ${targetStateGroup} (${label})`);
  } catch (stateErr) {
    const msg = stateErr instanceof Error ? stateErr.message : String(stateErr);
    logger.warn("State change failed — queueing both operations", {
      workItemId, targetStateGroup, label, error: msg,
    });
    await enqueuePlaneStateChange({ workItemId, stateGroup: targetStateGroup, projectId, issueId, sessionId });
    await enqueuePlaneComment({ workItemId, commentHtml, projectId, issueId, sessionId });
    result.queued = true;
    return result;
  }

  // 4. Idempotency check — skip if comment with this session already exists
  if (sessionId) {
    try {
      const exists = await sessionCommentExists(projectId, issueId, sessionId);
      if (exists) {
        logger.info("Comment already exists — idempotent skip", { workItemId, sessionId, label });
        result.commentApplied = true;
        return result;
      }
    } catch {
      // Can't verify — proceed with adding (risk duplicate over losing comment)
    }
  }

  // 5. Apply comment
  try {
    const commentResult = await addIssueComment(projectId, issueId, commentHtml);
    if (commentResult === null) throw new Error("Comment returned null (circuit breaker open)");
    result.commentApplied = true;
    logger.info(`Added ${label} comment to ${workItemId}`);
  } catch (commentErr) {
    const msg = commentErr instanceof Error ? commentErr.message : String(commentErr);

    // 6. Rollback state change — restore previous state
    if (previousStateId && result.stateApplied) {
      try {
        await updateIssueState(projectId, issueId, previousStateId);
        result.rolledBack = true;
        logger.info("Rolled back state after comment failure", {
          workItemId, previousStateId, label,
        });
      } catch (rollbackErr) {
        const rbMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        logger.error("PARTIAL STATE — rollback also failed", {
          workItemId, label,
          stateApplied: targetStateGroup,
          commentFailed: msg,
          rollbackFailed: rbMsg,
          previousState: previousStateId,
        });
      }
    }

    // 7. Queue for retry
    if (result.rolledBack) {
      // Both operations need retrying (state was rolled back)
      await enqueuePlaneStateChange({ workItemId, stateGroup: targetStateGroup, projectId, issueId, sessionId });
      await enqueuePlaneComment({ workItemId, commentHtml, projectId, issueId, sessionId });
    } else {
      // State stuck applied — only queue the missing comment
      await enqueuePlaneComment({ workItemId, commentHtml, projectId, issueId, sessionId });
    }
    result.queued = true;
  }

  return result;
}

/**
 * High-level: update a Plane work item when a work session starts.
 * - Sets state to "In Progress"
 * - Adds a comment with the session ID
 * - Atomic: rolls back state if comment fails (ELLIE-483)
 *
 * Fails silently (logs warning) if Plane is not configured or the item can't be found.
 */
export async function updateWorkItemOnSessionStart(workItemId: string, sessionId: string) {
  if (!isPlaneConfigured()) {
    logger.info("Skipping — PLANE_API_KEY not configured");
    return;
  }

  if (isInTimeoutRecovery()) {
    logger.info(`Skipping state update for ${workItemId} — timeout recovery window active`);
    return;
  }

  const resolved = await resolveWorkItemId(workItemId);
  if (!resolved) {
    logger.warn("Could not resolve work item — queueing for retry", { workItemId });
    await enqueuePlaneStateChange({ workItemId, stateGroup: "started", sessionId });
    await enqueuePlaneComment({ workItemId, commentHtml: `<p>Work session started — <code>${sessionId}</code></p>`, sessionId });
    return;
  }

  await atomicStateAndComment({
    projectId: resolved.projectId as string,
    issueId: resolved.issueId as string,
    workItemId,
    targetStateGroup: "started",
    commentHtml: `<p>Work session started — <code>${sessionId}</code></p>`,
    sessionId,
    label: "session start",
  });
}

/**
 * High-level: update a Plane work item when a work session completes.
 * - Sets state to "Done" (or stays "In Progress" if blocked/paused)
 * - Adds a comment with the session summary
 * - Atomic: rolls back state if comment fails (ELLIE-483)
 *
 * Fails silently (logs warning) if Plane is not configured or the item can't be found.
 */
export async function updateWorkItemOnSessionComplete(
  workItemId: string,
  summary: string,
  status: "completed" | "blocked" | "paused" = "completed",
) {
  if (!isPlaneConfigured()) {
    logger.info("Skipping — PLANE_API_KEY not configured");
    return;
  }

  if (isInTimeoutRecovery()) {
    logger.info(`Skipping state update for ${workItemId} — timeout recovery window active`);
    return;
  }

  const stateGroup = status === "completed" ? "completed" : "started";
  const statusLabel = status === "completed" ? "completed" : status;
  const comment = `<p>Work session ${statusLabel}</p><p>${summary}</p>`;

  const resolved = await resolveWorkItemId(workItemId);
  if (!resolved) {
    logger.warn("Could not resolve work item — queueing for retry", { workItemId });
    await enqueuePlaneStateChange({ workItemId, stateGroup });
    await enqueuePlaneComment({ workItemId, commentHtml: comment });
    return;
  }

  await atomicStateAndComment({
    projectId: resolved.projectId as string,
    issueId: resolved.issueId as string,
    workItemId,
    targetStateGroup: stateGroup,
    commentHtml: comment,
    label: `session ${statusLabel}`,
  });
}

/**
 * High-level: update a Plane work item when a pipeline/session fails mid-execution.
 * - Moves ticket back to "unstarted" (Todo)
 * - Adds a comment with the failure reason
 * - Atomic: rolls back state if comment fails (ELLIE-483)
 *
 * Fails silently so it never masks the original error.
 */
export async function updateWorkItemOnFailure(workItemId: string, errorMessage: string) {
  if (!isPlaneConfigured()) return;
  if (isInTimeoutRecovery()) return;

  const resolved = await resolveWorkItemId(workItemId);
  if (!resolved) {
    logger.warn("Could not resolve work item for failure cleanup", { workItemId });
    return;
  }

  await atomicStateAndComment({
    projectId: resolved.projectId as string,
    issueId: resolved.issueId as string,
    workItemId,
    targetStateGroup: "unstarted",
    commentHtml: `<p>Pipeline failed — ticket moved back to Todo</p><p><code>${errorMessage.slice(0, 500)}</code></p>`,
    label: "pipeline failure",
  });
}

// ============================================================
// STARTUP RECONCILIATION (ELLIE-483)
// ============================================================

/**
 * Detect and recover from partial Plane update states on startup.
 *
 * Checks the plane_sync_queue for pending items that may indicate
 * a partial update (state applied but comment missing, or vice versa).
 * Logs detailed context for manual investigation and ensures queued
 * items will be processed by the queue worker.
 */
export async function reconcilePlaneState(): Promise<{ pending: number; orphaned: number }> {
  if (!isPlaneConfigured()) return { pending: 0, orphaned: 0 };

  let pending = 0;
  let orphaned = 0;

  try {
    const { getSql } = await import("./plane-queue.ts");
    const sql = await getSql();

    // Find all non-completed queue items grouped by work_item_id
    const items = await sql<Array<{ work_item_id: string; action: string; status: string; session_id: string | null; created_at: Date }>>`
      SELECT work_item_id, action, status, session_id, created_at
      FROM plane_sync_queue
      WHERE status IN ('pending', 'processing', 'failed')
      ORDER BY work_item_id, created_at ASC
    `;

    if (items.length === 0) return { pending: 0, orphaned: 0 };

    pending = items.length;

    // Group by work item to detect partial states
    const byWorkItem = new Map<string, typeof items>();
    for (const item of items) {
      const existing = byWorkItem.get(item.work_item_id) || [];
      existing.push(item);
      byWorkItem.set(item.work_item_id, existing);
    }

    for (const [workItemId, workItems] of byWorkItem) {
      const hasState = workItems.some(i => i.action === "state_change");
      const hasComment = workItems.some(i => i.action === "add_comment");
      const hasFailed = workItems.some(i => i.status === "failed");

      if (hasState !== hasComment) {
        // Only one of the pair is queued — the other may have been applied
        // while this one failed. This is a partial state.
        orphaned++;
        logger.warn("Partial Plane state detected on startup", {
          workItemId,
          stateQueued: hasState,
          commentQueued: hasComment,
          hasFailed,
          items: workItems.map(i => ({ action: i.action, status: i.status, age: `${Math.round((Date.now() - i.created_at.getTime()) / 60000)}min` })),
        });
      }

      if (hasFailed) {
        // Reset failed items to pending so the queue worker retries them
        await sql`
          UPDATE plane_sync_queue
          SET status = 'pending', next_retry_at = NOW()
          WHERE work_item_id = ${workItemId} AND status = 'failed'
        `;
        logger.info("Reset failed queue items for retry", { workItemId });
      }
    }

    if (orphaned > 0 || pending > 0) {
      logger.info("Plane reconciliation complete", { pending, orphaned });
    }
  } catch (err) {
    logger.error("Plane reconciliation failed", err);
  }

  return { pending, orphaned };
}

// ============================================================
// WORK ITEM QUERIES
// ============================================================

export interface WorkItemDetails {
  id: string;
  name: string;
  description: string;
  priority: string;
  state: string;
  sequenceId: number;
  projectIdentifier: string;
}

/** Strip HTML tags to plain text */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetch full details for a work item (e.g. "ELLIE-5").
 * Returns null if not found or Plane is not configured.
 */
export async function fetchWorkItemDetails(workItemId: string): Promise<WorkItemDetails | null> {
  if (!isPlaneConfigured()) return null;

  const parsed = parseWorkItemId(workItemId);
  if (!parsed) return null;

  try {
    const projectId = await getProjectByIdentifier(parsed.projectIdentifier);
    if (!projectId) return null;

    const issue = await getIssueBySequenceId(projectId, parsed.sequenceId);
    if (!issue) return null;

    return {
      id: issue.id,
      name: issue.name,
      description: stripHtml(issue.description_html || ""),
      priority: issue.priority || "none",
      state: issue.state,
      sequenceId: issue.sequence_id,
      projectIdentifier: parsed.projectIdentifier,
    };
  } catch (error) {
    logger.warn("Failed to fetch work item", { workItemId }, error);
    return null;
  }
}

/**
 * Check if a work item (e.g. "ELLIE-237") is in a Done/Cancelled state.
 * Used by ephemeral channel auto-archive (ELLIE-334).
 */
export async function isWorkItemDone(workItemId: string): Promise<boolean> {
  if (!isPlaneConfigured()) return false;
  try {
    const parsed = parseWorkItemId(workItemId);
    if (!parsed) return false;
    const projectId = await getProjectByIdentifier(parsed.projectIdentifier);
    if (!projectId) return false;
    const issue = await getIssueBySequenceId(projectId, parsed.sequenceId);
    if (!issue) return false;
    const group = (issue.state_detail as Record<string, string>)?.group;
    return group === "completed" || group === "cancelled";
  } catch {
    return false;
  }
}

export interface WorkItemSummary {
  sequenceId: number;
  name: string;
  priority: string;
}

/**
 * List open (non-completed, non-cancelled) issues for a project.
 */
export async function listOpenIssues(projectIdentifier: string, limit: number = 20): Promise<WorkItemSummary[]> {
  if (!isPlaneConfigured()) return [];

  try {
    const projectId = await getProjectByIdentifier(projectIdentifier);
    if (!projectId) return [];

    const data = await planeRequest(`/projects/${projectId}/issues/`);
    if (!data) return [];
    const issues = (data.results || [])
      .filter((i: Record<string, unknown>) => !["completed", "cancelled"].includes((i.state_detail as Record<string, string>)?.group || ""))
      .slice(0, limit)
      .map((i: Record<string, unknown>) => ({
        sequenceId: i.sequence_id,
        name: i.name,
        priority: i.priority || "none",
      }));

    return issues;
  } catch (error) {
    logger.warn("Failed to list issues", { projectIdentifier }, error);
    return [];
  }
}

/**
 * Create a new issue in a Plane project.
 * Returns the created issue's ID and sequence number, or null on failure.
 */
export async function createPlaneIssue(
  projectIdentifier: string,
  name: string,
  description?: string,
  priority?: string,
): Promise<{ id: string; sequenceId: number; identifier: string } | null> {
  if (!isPlaneConfigured()) return null;

  try {
    const projectId = await getProjectByIdentifier(projectIdentifier);
    if (!projectId) return null;

    const body: Record<string, string> = { name };
    if (description) body.description_html = `<p>${description}</p>`;
    if (priority) body.priority = priority;

    const issue = await planeRequest(`/projects/${projectId}/issues/`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    const identifier = `${projectIdentifier}-${issue.sequence_id}`;
    logger.info(`Created issue: ${identifier} — ${name}`);
    return { id: issue.id, sequenceId: issue.sequence_id, identifier };
  } catch (error) {
    logger.warn("Failed to create issue", { projectIdentifier }, error);
    return null;
  }
}
