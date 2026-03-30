/**
 * Off-Hours Scheduler — ELLIE-1136
 *
 * Background polling loop that dispatches overnight autonomous agent tasks.
 *
 * Flow:
 * 1. Dave says "run the overnight queue"
 * 2. startOvernightSession() creates an overnight_sessions record
 * 3. Every 60s the loop checks: should I stop? slots available? tasks ready?
 * 4. For each available slot + ready task: launches a Docker container
 * 5. Stops on: end time reached, Dave sends a message, manual stop, or all tasks done
 */

import { log } from "../logger.ts";
import { getRelayDeps } from "../relay-state.ts";
import { buildContainerEnv, runOvernightTask, CONSTANTS as DOCKER_CONSTANTS } from "./docker-executor.ts";
// Lazy-imported to avoid pulling ellie-forest into the module graph at load time
// import { buildOvernightPrompt } from "./prompt-builder.ts";
import type { ContainerState, SchedulerConfig, StopReason } from "./types.ts";

const logger = log.child("overnight-scheduler");

const POLL_INTERVAL_MS = 60_000;
const DEFAULT_CONCURRENCY = 2;
const PR_URL_PATTERN = /https:\/\/github\.com\/[^\s]+\/pull\/\d+/;

// ── Module State ────────────────────────────────────────────

let _running = false;
let _config: SchedulerConfig | null = null;
let _pollTimer: ReturnType<typeof setTimeout> | null = null;
let _userActivityFlag = false;
const _runningContainers = new Map<string, ContainerState>();

// ── Public API ──────────────────────────────────────────────

/**
 * Called by message handlers when Dave sends a message during an overnight run.
 */
export function flagUserActivity(): void {
  _userActivityFlag = true;
  logger.info("User activity flagged — scheduler will stop on next poll");
}

/**
 * Used by message handlers to check if the overnight scheduler is active.
 */
export function isOvernightRunning(): boolean {
  return _running;
}

/**
 * Parse an end-time string like "4am", "6am", "06:00".
 * Defaults to 6 AM. If the resolved time is before `now`, pushes to next day.
 */
export function parseEndTime(input?: string, now?: Date): Date {
  const ref = now ?? new Date();
  let hour = 6; // default

  if (input) {
    const trimmed = input.trim().toLowerCase();

    // Match "4am", "6 am", "4AM"
    const amMatch = trimmed.match(/^(\d{1,2})\s*am$/i);
    if (amMatch) {
      hour = parseInt(amMatch[1], 10);
    }

    // Match "4pm", "6 pm" — convert to 24h
    const pmMatch = trimmed.match(/^(\d{1,2})\s*pm$/i);
    if (pmMatch) {
      const h = parseInt(pmMatch[1], 10);
      hour = h === 12 ? 12 : h + 12;
    }

    // Match "06:00", "14:30" — take the hour
    const timeMatch = trimmed.match(/^(\d{1,2}):(\d{2})$/);
    if (timeMatch) {
      hour = parseInt(timeMatch[1], 10);
    }

    // Plain number: "6" -> 6 AM
    if (/^\d{1,2}$/.test(trimmed)) {
      hour = parseInt(trimmed, 10);
    }
  }

  const endsAt = new Date(ref);
  endsAt.setHours(hour, 0, 0, 0);

  // If the time is before now, push to next day
  if (endsAt.getTime() <= ref.getTime()) {
    endsAt.setDate(endsAt.getDate() + 1);
  }

  return endsAt;
}

/**
 * Determine if the scheduler should stop.
 * Returns the reason, or null if it should keep running.
 */
export function shouldStop(endsAt: Date, userActivity: boolean): StopReason | null {
  if (userActivity) return "user_activity";
  if (Date.now() >= endsAt.getTime()) return "time_limit";
  return null;
}

// ── Session Lifecycle ───────────────────────────────────────

export interface StartOvernightOpts {
  endTime?: string;
  concurrency?: number;
}

/**
 * Create an overnight session and start the polling loop.
 */
export async function startOvernightSession(opts?: StartOvernightOpts): Promise<{ sessionId: string; endsAt: Date }> {
  if (_running) {
    throw new Error("Overnight session already running");
  }

  const { supabase } = getRelayDeps();
  if (!supabase) throw new Error("Supabase not available — cannot start overnight session");

  const endsAt = parseEndTime(opts?.endTime);
  const concurrency = opts?.concurrency ?? DEFAULT_CONCURRENCY;

  // Create session record
  const { data, error } = await supabase
    .from("overnight_sessions")
    .insert({
      started_at: new Date().toISOString(),
      ends_at: endsAt.toISOString(),
      status: "running",
      concurrency_limit: concurrency,
      tasks_total: 0,
      tasks_completed: 0,
      tasks_failed: 0,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create overnight session: ${error?.message ?? "no data"}`);
  }

  const sessionId = data.id;

  _config = { endsAt, concurrencyLimit: concurrency, sessionId };
  _running = true;
  _userActivityFlag = false;
  _runningContainers.clear();

  logger.info("Overnight session started", {
    sessionId,
    endsAt: endsAt.toISOString(),
    concurrency,
  });

  // Start the polling loop (non-blocking)
  schedulePoll();

  return { sessionId, endsAt };
}

/**
 * Stop the overnight session and update the DB record.
 */
export async function stopOvernightSession(reason: StopReason): Promise<void> {
  if (!_running || !_config) {
    logger.warn("stopOvernightSession called but no session is running");
    return;
  }

  const { supabase } = getRelayDeps();
  const sessionId = _config.sessionId;

  // Clear timer
  if (_pollTimer) {
    clearTimeout(_pollTimer);
    _pollTimer = null;
  }

  _running = false;

  // Update session record
  if (supabase) {
    const { error } = await supabase
      .from("overnight_sessions")
      .update({
        stopped_at: new Date().toISOString(),
        status: reason === "all_done" ? "completed" : "stopped",
        stop_reason: reason,
      })
      .eq("id", sessionId);

    if (error) {
      logger.error("Failed to update session record", { sessionId, error: error.message });
    }
  }

  logger.info("Overnight session stopped", { sessionId, reason });

  // Reset state
  _config = null;
  _userActivityFlag = false;
  // Note: running containers continue — they're autonomous. We just stop launching new ones.
}

// ── Polling Loop ────────────────────────────────────────────

function schedulePoll(): void {
  if (!_running) return;
  _pollTimer = setTimeout(() => pollTick(), POLL_INTERVAL_MS);
}

async function pollTick(): Promise<void> {
  if (!_running || !_config) return;

  try {
    // Check stop conditions
    const reason = shouldStop(_config.endsAt, _userActivityFlag);
    if (reason) {
      await stopOvernightSession(reason);
      return;
    }

    // How many slots are free?
    const activeCount = _runningContainers.size;
    const freeSlots = _config.concurrencyLimit - activeCount;

    if (freeSlots <= 0) {
      logger.debug("No free slots, waiting", { active: activeCount });
      schedulePoll();
      return;
    }

    // Fetch ready tasks from GTD
    const tasks = await fetchReadyTasks(freeSlots);

    if (tasks.length === 0) {
      // Check if we're done — no running containers and no tasks
      if (activeCount === 0) {
        logger.info("No more tasks and no running containers — all done");
        await stopOvernightSession("all_done");
        return;
      }
      logger.debug("No ready tasks, waiting for running containers to finish");
      schedulePoll();
      return;
    }

    // Launch tasks
    for (const task of tasks) {
      await launchTask(task);
    }
  } catch (err) {
    logger.error("Poll tick error", { error: err instanceof Error ? err.message : String(err) });
  }

  schedulePoll();
}

// ── Task Fetching ───────────────────────────────────────────

interface GtdTask {
  id: string;
  title: string;
  content: string | null;
  assigned_agent: string | null;
  work_item_id: string | null;
}

async function fetchReadyTasks(slots: number): Promise<GtdTask[]> {
  const { supabase } = getRelayDeps();
  if (!supabase) return [];

  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("todos")
    .select("*")
    .eq("status", "open")
    .not("scheduled_at", "is", null)
    .lte("scheduled_at", now)
    .order("priority")
    .limit(slots);

  if (error) {
    logger.error("Failed to fetch ready tasks", { error: error.message });
    return [];
  }

  return (data ?? []).map((row: any) => ({
    id: row.id,
    title: row.title,
    content: row.content,
    assigned_agent: row.assigned_agent ?? "dev",
    work_item_id: row.work_item_id,
  }));
}

// ── Task Launch ─────────────────────────────────────────────

async function launchTask(task: GtdTask): Promise<void> {
  if (!_config) return;

  const { supabase } = getRelayDeps();
  if (!supabase) return;

  const sessionId = _config.sessionId;
  const agentName = task.assigned_agent ?? "dev";

  // Create task result record
  const { data: taskResult, error: insertErr } = await supabase
    .from("overnight_task_results")
    .insert({
      session_id: sessionId,
      gtd_task_id: task.id,
      assigned_agent: agentName,
      task_title: task.title,
      task_content: task.content,
      status: "running",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertErr || !taskResult) {
    logger.error("Failed to create task result record", { taskId: task.id, error: insertErr?.message });
    return;
  }

  const taskResultId = taskResult.id;

  // Update session tasks_total
  await supabase.rpc("increment_session_counter", {
    p_session_id: sessionId,
    p_field: "tasks_total",
  }).catch(() => {
    // Fallback: direct update
    supabase
      .from("overnight_sessions")
      .update({ tasks_total: (_runningContainers.size + 1) })
      .eq("id", sessionId);
  });

  // Mark GTD task as in-progress
  await supabase
    .from("todos")
    .update({ status: "in_progress" })
    .eq("id", task.id);

  // Build prompt (lazy import to avoid pulling ellie-forest at module load)
  const { buildOvernightPrompt } = await import("./prompt-builder.ts");
  const { prompt, systemPrompt } = await buildOvernightPrompt({
    taskTitle: task.title,
    taskContent: task.content ?? "",
    assignedAgent: agentName,
    workItemId: task.work_item_id ?? undefined,
  });

  // Build container env
  // SECURITY (ELLIE-1142): GH_TOKEN must NEVER be embedded in REPO_URL.
  // The container receives GH_TOKEN as a separate env var and uses git
  // credential helpers for auth — the URL stays credential-free.
  const ghToken = process.env.OVERNIGHT_GH_TOKEN || process.env.GH_TOKEN || "";
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || "";
  const repoUrl = process.env.OVERNIGHT_REPO_URL || "https://github.com/evelife/ellie-dev.git";

  const branchName = `overnight/${task.work_item_id ?? task.id}`;

  const env = buildContainerEnv({
    GH_TOKEN: ghToken,
    CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
    REPO_URL: repoUrl,
    FEATURE_BRANCH: branchName,
    AGENT_JOB_ID: taskResultId,
    PROMPT: prompt,
    SYSTEM_PROMPT: systemPrompt,
  });

  // Track container state
  const containerState: ContainerState = {
    taskResultId,
    containerId: "", // filled after launch
    containerName: `ellie-overnight-${taskResultId}`,
    volumeName: `ellie-overnight-vol-${taskResultId}`,
    startedAt: Date.now(),
    gtdTaskId: task.id,
  };

  _runningContainers.set(taskResultId, containerState);

  // Update task result with branch name
  await supabase
    .from("overnight_task_results")
    .update({ branch_name: branchName })
    .eq("id", taskResultId);

  logger.info("Launching overnight task", {
    taskResultId,
    taskTitle: task.title,
    agent: agentName,
    branch: branchName,
  });

  // Fire-and-forget: run container, handle completion
  runOvernightTask(taskResultId, env)
    .then((result) => onTaskComplete(taskResultId, task.id, result))
    .catch((err) => onTaskError(taskResultId, task.id, err));
}

// ── Task Completion ─────────────────────────────────────────

async function onTaskComplete(
  taskResultId: string,
  gtdTaskId: string,
  result: { exitCode: number; logs: string },
): Promise<void> {
  _runningContainers.delete(taskResultId);

  const { supabase } = getRelayDeps();
  if (!supabase || !_config) return;

  const success = result.exitCode === 0;
  const timedOut = result.exitCode === DOCKER_CONSTANTS.TIMEOUT_EXIT_CODE;
  const cleanLogs = sanitizeLogs(result.logs);
  const prUrl = extractPrUrl(cleanLogs);
  const prNumber = prUrl ? parseInt(prUrl.match(/\/pull\/(\d+)/)?.[1] ?? "0", 10) || null : null;

  // Update task result
  const errorMsg = success
    ? null
    : timedOut
      ? "Container timed out — killed after exceeding deadline"
      : `Exit code: ${result.exitCode}`;

  await supabase
    .from("overnight_task_results")
    .update({
      status: success ? "completed" : "failed",
      pr_url: prUrl,
      pr_number: prNumber,
      summary: cleanLogs.slice(-2000), // last 2KB of sanitized logs
      error: errorMsg,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - (_runningContainers.get(taskResultId)?.startedAt ?? Date.now()),
    })
    .eq("id", taskResultId);

  // Update GTD task
  await supabase
    .from("todos")
    .update({ status: success ? "done" : "open" })
    .eq("id", gtdTaskId);

  // Update session counters
  const counterField = success ? "tasks_completed" : "tasks_failed";
  await supabase.rpc("increment_session_counter", {
    p_session_id: _config.sessionId,
    p_field: counterField,
  }).catch(() => {
    logger.warn("Failed to increment session counter", { field: counterField });
  });

  logger.info("Task completed", {
    taskResultId,
    success,
    exitCode: result.exitCode,
    prUrl,
  });
}

async function onTaskError(taskResultId: string, gtdTaskId: string, err: unknown): Promise<void> {
  _runningContainers.delete(taskResultId);

  const { supabase } = getRelayDeps();
  if (!supabase || !_config) return;

  const message = err instanceof Error ? err.message : String(err);

  await supabase
    .from("overnight_task_results")
    .update({
      status: "failed",
      error: message,
      completed_at: new Date().toISOString(),
    })
    .eq("id", taskResultId);

  await supabase
    .from("todos")
    .update({ status: "open" })
    .eq("id", gtdTaskId);

  await supabase.rpc("increment_session_counter", {
    p_session_id: _config.sessionId,
    p_field: "tasks_failed",
  }).catch(() => {});

  logger.error("Task errored", { taskResultId, error: message });
}

// ── Helpers ─────────────────────────────────────────────────

function extractPrUrl(logs: string): string | null {
  const match = logs.match(PR_URL_PATTERN);
  return match ? match[0] : null;
}

/**
 * Strip tokens/credentials from log output before storing in DB.
 * SECURITY (ELLIE-1142): Prevents credential leaks via stored container logs.
 */
export function sanitizeLogs(logs: string): string {
  return logs
    // GitHub tokens (classic ghp_ and fine-grained github_pat_)
    .replace(/ghp_[A-Za-z0-9_]{36,}/g, "ghp_***REDACTED***")
    .replace(/github_pat_[A-Za-z0-9_]{22,}/g, "github_pat_***REDACTED***")
    // Tokens embedded in URLs: https://TOKEN@github.com/...
    .replace(/https:\/\/[^@\s]+@github\.com/g, "https://***REDACTED***@github.com")
    // Generic bearer/token patterns in headers
    .replace(/(Authorization:\s*(?:Bearer|token)\s+)\S+/gi, "$1***REDACTED***");
}

// ── Testing Exports ─────────────────────────────────────────

export function _resetForTesting(): void {
  _running = false;
  _config = null;
  _userActivityFlag = false;
  _runningContainers.clear();
  if (_pollTimer) {
    clearTimeout(_pollTimer);
    _pollTimer = null;
  }
}
