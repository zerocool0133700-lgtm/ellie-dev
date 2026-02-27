/**
 * Plane Sync Queue — Persistent retry queue for Plane API calls (ELLIE-234).
 *
 * When Plane API calls fail (circuit breaker open, transient errors, downtime),
 * updates are enqueued to a Postgres-backed table in the Forest DB. A polling
 * worker retries with exponential backoff until success or max attempts reached.
 *
 * Survives relay restarts — no more silently lost state updates.
 */

import { log } from "./logger.ts";

const logger = log.child("plane-queue");

// Lazy-load Forest DB to avoid circular deps at import time
let _sql: ReturnType<typeof import("postgres").default> | null = null;

async function getSql() {
  if (!_sql) {
    const mod = await import("../../ellie-forest/src/db");
    _sql = mod.default;
  }
  return _sql;
}

// ── Types ──────────────────────────────────────────────────

export interface PlaneSyncItem {
  id: string;
  action: "state_change" | "add_comment";
  work_item_id: string;
  project_id: string | null;
  issue_id: string | null;
  state_group: string | null;
  comment_html: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  next_retry_at: Date;
  session_id: string | null;
  created_at: Date;
}

// ── Enqueue ────────────────────────────────────────────────

/**
 * Enqueue a Plane state change for reliable delivery.
 * Called when the direct API call fails or circuit breaker is open.
 */
export async function enqueuePlaneStateChange(opts: {
  workItemId: string;
  stateGroup: string;
  projectId?: string;
  issueId?: string;
  sessionId?: string;
}): Promise<void> {
  try {
    const sql = await getSql();
    await sql`
      INSERT INTO plane_sync_queue (action, work_item_id, state_group, project_id, issue_id, session_id)
      VALUES ('state_change', ${opts.workItemId}, ${opts.stateGroup}, ${opts.projectId || null}, ${opts.issueId || null}, ${opts.sessionId || null})
    `;
    logger.info("Enqueued state change", { workItemId: opts.workItemId, stateGroup: opts.stateGroup });
  } catch (err) {
    logger.error("Failed to enqueue state change", err);
  }
}

/**
 * Enqueue a Plane comment for reliable delivery.
 */
export async function enqueuePlaneComment(opts: {
  workItemId: string;
  commentHtml: string;
  projectId?: string;
  issueId?: string;
  sessionId?: string;
}): Promise<void> {
  try {
    const sql = await getSql();
    await sql`
      INSERT INTO plane_sync_queue (action, work_item_id, comment_html, project_id, issue_id, session_id)
      VALUES ('add_comment', ${opts.workItemId}, ${opts.commentHtml}, ${opts.projectId || null}, ${opts.issueId || null}, ${opts.sessionId || null})
    `;
    logger.info("Enqueued comment", { workItemId: opts.workItemId });
  } catch (err) {
    logger.error("Failed to enqueue comment", err);
  }
}

// ── Worker ─────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30_000; // 30s between polls
const BATCH_SIZE = 10;
let workerTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Process pending queue items. Dequeues with FOR UPDATE SKIP LOCKED
 * to handle concurrent workers safely (future-proofing).
 */
export async function processQueue(): Promise<{ processed: number; failed: number }> {
  const sql = await getSql();
  let processed = 0;
  let failed = 0;

  // Grab items that are due for retry
  const items = await sql<PlaneSyncItem[]>`
    SELECT * FROM plane_sync_queue
    WHERE status IN ('pending', 'processing')
      AND next_retry_at <= NOW()
    ORDER BY next_retry_at ASC
    LIMIT ${BATCH_SIZE}
    FOR UPDATE SKIP LOCKED
  `;

  if (items.length === 0) return { processed: 0, failed: 0 };

  // Lazy-import plane functions to avoid circular dependency
  const { resolveWorkItemId, updateIssueState, addIssueComment, isPlaneConfigured } =
    await import("./plane.ts");

  if (!isPlaneConfigured()) {
    logger.warn("Plane not configured — skipping queue processing");
    return { processed: 0, failed: 0 };
  }

  for (const item of items) {
    try {
      // Mark as processing
      await sql`UPDATE plane_sync_queue SET status = 'processing', attempts = attempts + 1 WHERE id = ${item.id}`;

      // Resolve UUIDs if not cached
      let projectId = item.project_id;
      let issueId = item.issue_id;
      if (!projectId || !issueId) {
        const resolved = await resolveWorkItemId(item.work_item_id);
        if (!resolved) {
          throw new Error(`Could not resolve work item: ${item.work_item_id}`);
        }
        projectId = resolved.projectId;
        issueId = resolved.issueId;
        // Cache for future retries
        await sql`UPDATE plane_sync_queue SET project_id = ${projectId}, issue_id = ${issueId} WHERE id = ${item.id}`;
      }

      // Execute the action
      if (item.action === "state_change" && item.state_group) {
        const { getStateIdByGroup } = await import("./plane.ts");
        const stateId = await getStateIdByGroup(projectId, item.state_group);
        if (!stateId) throw new Error(`Unknown state group: ${item.state_group}`);
        const result = await updateIssueState(projectId, issueId, stateId);
        if (result === null) throw new Error("updateIssueState returned null (circuit breaker or API error)");
      } else if (item.action === "add_comment" && item.comment_html) {
        const result = await addIssueComment(projectId, issueId, item.comment_html);
        if (result === null) throw new Error("addIssueComment returned null (circuit breaker or API error)");
      }

      // Success — mark completed
      await sql`UPDATE plane_sync_queue SET status = 'completed', last_error = NULL WHERE id = ${item.id}`;
      logger.info("Synced", { action: item.action, workItemId: item.work_item_id });
      processed++;

    } catch (err: any) {
      const attempts = (item.attempts || 0) + 1;
      const errorMsg = err?.message || String(err);

      if (attempts >= item.max_attempts) {
        // Dead letter
        await sql`UPDATE plane_sync_queue SET status = 'failed', last_error = ${errorMsg} WHERE id = ${item.id}`;
        logger.error("Gave up after max attempts", { workItemId: item.work_item_id, action: item.action, attempts });
        failed++;
      } else {
        // Exponential backoff: 30s, 60s, 120s, 240s, 480s
        const backoffSec = 30 * Math.pow(2, attempts - 1);
        await sql`
          UPDATE plane_sync_queue
          SET status = 'pending', last_error = ${errorMsg},
              next_retry_at = NOW() + ${backoffSec + ' seconds'}::INTERVAL
          WHERE id = ${item.id}
        `;
        logger.warn("Will retry", { workItemId: item.work_item_id, action: item.action, attempts, nextRetryIn: `${backoffSec}s` });
      }
    }
  }

  return { processed, failed };
}

// ── Lifecycle ──────────────────────────────────────────────

/**
 * Start the queue worker polling loop.
 */
export function startPlaneQueueWorker(): void {
  if (workerTimer) return;

  logger.info("Starting Plane sync queue worker", { pollIntervalMs: POLL_INTERVAL_MS });

  // Process immediately on startup (catch anything from before restart)
  processQueue().catch(err => logger.error("Initial queue processing failed", err));

  workerTimer = setInterval(() => {
    processQueue().catch(err => logger.error("Queue processing failed", err));
  }, POLL_INTERVAL_MS);
}

/**
 * Stop the queue worker.
 */
export function stopPlaneQueueWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

// ── Status (for health endpoint) ───────────────────────────

export async function getPlaneQueueStatus(): Promise<{
  pending: number;
  processing: number;
  failed: number;
  oldest_pending: string | null;
}> {
  try {
    const sql = await getSql();
    const [counts] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'processing') AS processing,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        MIN(created_at) FILTER (WHERE status = 'pending') AS oldest_pending
      FROM plane_sync_queue
      WHERE status NOT IN ('completed')
    `;
    return {
      pending: Number(counts.pending),
      processing: Number(counts.processing),
      failed: Number(counts.failed),
      oldest_pending: counts.oldest_pending?.toISOString() || null,
    };
  } catch {
    return { pending: 0, processing: 0, failed: 0, oldest_pending: null };
  }
}

/**
 * Purge completed items older than 7 days.
 */
export async function purgeCompleted(): Promise<number> {
  try {
    const sql = await getSql();
    const result = await sql`
      DELETE FROM plane_sync_queue
      WHERE status = 'completed' AND created_at < NOW() - INTERVAL '7 days'
    `;
    return result.count;
  } catch {
    return 0;
  }
}
