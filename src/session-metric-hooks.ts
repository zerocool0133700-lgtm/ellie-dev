/**
 * Session Metric Hooks — ELLIE-622
 *
 * Pure functions that compute growth metrics from work session events
 * and record them via the growth-metrics-collector.
 *
 * Wired into work-session.ts lifecycle endpoints:
 *   - completeWorkSession → task completion rate, commit quality
 *   - pauseWorkSession    → blocker identification speed
 *
 * Metrics recorded (3 of 6 ant archetype metrics):
 *   1. Task completion rate  — 1 for completed, 0 for paused/failed
 *   2. Blocker ID speed      — seconds from session start to first blocker report
 *   3. Commit quality        — score 0-1 based on [ELLIE-XXX] prefix + message length
 */

import { recordMetric, recordSessionMetrics } from "./growth-metrics-collector";

// ── Metric Names (constants) ─────────────────────────────────────────────────

export const METRIC_TASK_COMPLETION = "task_completion_rate";
export const METRIC_BLOCKER_SPEED = "blocker_identification_speed";
export const METRIC_COMMIT_QUALITY = "commit_quality";

// ── Task Completion Rate ─────────────────────────────────────────────────────

/**
 * Record task completion outcome.
 *   value: 1 = completed successfully, 0 = paused/blocked/failed
 */
export function recordTaskCompletion(
  agentName: string,
  sessionId: string,
  completed: boolean,
  durationMinutes?: number,
): void {
  recordMetric(agentName, sessionId, METRIC_TASK_COMPLETION, completed ? 1 : 0, {
    ...(durationMinutes !== undefined ? { durationMinutes } : {}),
  });
}

// ── Blocker Identification Speed ─────────────────────────────────────────────

/**
 * Compute blocker identification speed in seconds.
 * Lower is better — fast escalation means the agent didn't struggle silently.
 */
export function computeBlockerSpeed(sessionStartedAt: string | Date, blockerReportedAt?: string | Date): number {
  const start = new Date(sessionStartedAt).getTime();
  const blocker = blockerReportedAt ? new Date(blockerReportedAt).getTime() : Date.now();
  return Math.max(0, Math.round((blocker - start) / 1000));
}

/**
 * Record blocker identification speed metric.
 */
export function recordBlockerSpeed(
  agentName: string,
  sessionId: string,
  sessionStartedAt: string | Date,
  blockerReason?: string,
): void {
  const seconds = computeBlockerSpeed(sessionStartedAt);
  recordMetric(agentName, sessionId, METRIC_BLOCKER_SPEED, seconds, {
    ...(blockerReason ? { reason: blockerReason } : {}),
  });
}

// ── Commit Quality ───────────────────────────────────────────────────────────

/**
 * Score a single commit message for quality (0-1).
 *
 * Criteria:
 *   - Has [ELLIE-XXX] prefix: +0.4
 *   - Message length >= 20 chars (descriptive): +0.3
 *   - Message length >= 50 chars (detailed): +0.3
 */
export function scoreCommitMessage(message: string, workItemId?: string): number {
  let score = 0;

  // Check for ticket prefix [ELLIE-XXX]
  const hasPrefix = /\[ELLIE-\d+\]/.test(message);
  if (hasPrefix) score += 0.4;

  // Check for specific work item reference if provided
  if (!hasPrefix && workItemId && message.includes(workItemId)) {
    score += 0.2; // partial credit for mentioning the ticket without brackets
  }

  // Message descriptiveness by length
  const trimmed = message.replace(/\[ELLIE-\d+\]\s*/, "").trim();
  if (trimmed.length >= 50) {
    score += 0.6;
  } else if (trimmed.length >= 20) {
    score += 0.3;
  }

  return Math.min(1, score);
}

/**
 * Score multiple commit messages and return the average quality.
 */
export function scoreCommitMessages(messages: string[], workItemId?: string): number {
  if (messages.length === 0) return 0;
  const total = messages.reduce((sum, msg) => sum + scoreCommitMessage(msg, workItemId), 0);
  return total / messages.length;
}

/**
 * Record commit quality metric for a session.
 */
export function recordCommitQuality(
  agentName: string,
  sessionId: string,
  commitMessages: string[],
  workItemId?: string,
): void {
  if (commitMessages.length === 0) return;
  const score = scoreCommitMessages(commitMessages, workItemId);
  recordMetric(agentName, sessionId, METRIC_COMMIT_QUALITY, score, {
    commitCount: commitMessages.length,
    ...(workItemId ? { workItemId } : {}),
  });
}

// ── Batch Collection ─────────────────────────────────────────────────────────

/**
 * Collect all available metrics at session completion.
 * Called from completeWorkSession.
 */
export function collectSessionCompleteMetrics(opts: {
  agentName: string;
  sessionId: string;
  durationMinutes: number;
  commitMessages?: string[];
  workItemId?: string;
}): void {
  // Task completion — session completed successfully
  recordTaskCompletion(opts.agentName, opts.sessionId, true, opts.durationMinutes);

  // Commit quality — if commit messages are available
  if (opts.commitMessages && opts.commitMessages.length > 0) {
    recordCommitQuality(opts.agentName, opts.sessionId, opts.commitMessages, opts.workItemId);
  }
}

/**
 * Collect metrics when a session is paused (blocker).
 * Called from pauseWorkSession.
 */
export function collectSessionPauseMetrics(opts: {
  agentName: string;
  sessionId: string;
  sessionStartedAt: string | Date;
  reason?: string;
}): void {
  // Task completion — session paused (not completed)
  recordTaskCompletion(opts.agentName, opts.sessionId, false);

  // Blocker identification speed — how fast the agent escalated
  if (opts.reason) {
    recordBlockerSpeed(opts.agentName, opts.sessionId, opts.sessionStartedAt, opts.reason);
  }
}
