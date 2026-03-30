/**
 * Orchestration Monitor — ELLIE-924
 *
 * Monitors active orchestrations and detects stalls. When a GTD task
 * assigned to an agent sits unstarted for > 5 minutes or in-progress
 * without updates for > 10 minutes, escalates to Dave via notification.
 *
 * Complements orchestration-tracker (which monitors dispatched agent processes)
 * with GTD-level task monitoring for orchestration workflows.
 */

import { log } from "./logger.ts";
import type { NotifyContext, NotifyOptions } from "./notification-policy.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TodoRow } from "./api/gtd-types.ts";

const logger = log.child("orchestration-monitor");

// ── Configuration ──────────────────────────────────────────

const UNSTARTED_THRESHOLD_MS = 5 * 60 * 1000;    // 5 minutes
const STALLED_THRESHOLD_MS = 10 * 60 * 1000;     // 10 minutes
const CHECK_INTERVAL_MS = 60 * 1000;              // Check every minute
const ORCHESTRATION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// ── State ──────────────────────────────────────────────────

let _monitorTimer: ReturnType<typeof setInterval> | null = null;
let _notifyFn: ((ctx: NotifyContext, opts: NotifyOptions) => Promise<void>) | null = null;
let _notifyCtx: NotifyContext | null = null;
let _supabase: SupabaseClient | null = null;

// Track when we last escalated a task to avoid notification spam
const lastEscalation = new Map<string, number>();

// ── Setup ──────────────────────────────────────────────────

export function setMonitorDependencies(
  supabase: SupabaseClient,
  notifyFn: typeof _notifyFn,
  notifyCtx: NotifyContext,
): void {
  _supabase = supabase;
  _notifyFn = notifyFn;
  _notifyCtx = notifyCtx;
}

// ── Monitor lifecycle ──────────────────────────────────────

export function startOrchestrationMonitor(): void {
  if (_monitorTimer) return; // already running
  if (!_supabase) {
    logger.warn("Cannot start monitor — Supabase client not set");
    return;
  }

  _monitorTimer = setInterval(() => {
    checkForStalledTasks().catch((err) => {
      logger.error("Monitor check failed", err);
    });
    checkOrchestrationTimeouts().catch((err) => {
      logger.error("Orchestration timeout check failed", err);
    });
  }, CHECK_INTERVAL_MS);

  logger.info("Orchestration monitor started", {
    check_interval_ms: CHECK_INTERVAL_MS,
    unstarted_threshold_ms: UNSTARTED_THRESHOLD_MS,
    stalled_threshold_ms: STALLED_THRESHOLD_MS,
  });
}

export function stopOrchestrationMonitor(): void {
  if (_monitorTimer) {
    clearInterval(_monitorTimer);
    _monitorTimer = null;
    logger.info("Orchestration monitor stopped");
  }
}

// ── Monitoring logic ───────────────────────────────────────

async function checkForStalledTasks(): Promise<void> {
  if (!_supabase || !_notifyFn || !_notifyCtx) return;

  try {
    // Find all tasks assigned to agents that are not completed/cancelled
    const { data: assignedTasks, error } = await _supabase
      .from("todos")
      .select("id, assigned_agent, delegated_by, status, created_at, updated_at, content, source_ref")
      .not("assigned_agent", "is", null)
      .in("status", ["inbox", "open"])
      .order("created_at", { ascending: true });

    if (error) {
      logger.error("Failed to fetch assigned tasks", error);
      return;
    }

    if (!assignedTasks || assignedTasks.length === 0) {
      return;
    }

    const now = Date.now();
    const todos = assignedTasks as TodoRow[];

    for (const task of todos) {
      const taskId = task.id;
      const createdAt = new Date(task.created_at).getTime();
      const updatedAt = new Date(task.updated_at).getTime();
      const ageMs = now - createdAt;
      const silenceMs = now - updatedAt;

      // Skip if we escalated this task recently (within last 30 minutes)
      const lastEscalated = lastEscalation.get(taskId);
      if (lastEscalated && now - lastEscalated < 30 * 60 * 1000) {
        continue;
      }

      // Check for unstarted tasks (status=inbox, old enough)
      if (task.status === "inbox" && ageMs > UNSTARTED_THRESHOLD_MS) {
        logger.warn("Unstarted task detected", {
          task_id: taskId.slice(0, 8),
          assigned_agent: task.assigned_agent,
          delegated_by: task.delegated_by,
          age_ms: ageMs,
          content: task.content.slice(0, 100),
        });

        await escalateTask(task, "unstarted", ageMs);
        lastEscalation.set(taskId, now);
        continue;
      }

      // Check for stalled tasks (status=open, no updates)
      if (task.status === "open" && silenceMs > STALLED_THRESHOLD_MS) {
        logger.warn("Stalled task detected", {
          task_id: taskId.slice(0, 8),
          assigned_agent: task.assigned_agent,
          delegated_by: task.delegated_by,
          silence_ms: silenceMs,
          content: task.content.slice(0, 100),
        });

        await escalateTask(task, "stalled", silenceMs);
        lastEscalation.set(taskId, now);
      }
    }
  } catch (err) {
    logger.error("Stalled task check failed", err);
  }
}

// ELLIE-1141: Check orchestration items for staleness (30 min hard timeout)
async function checkOrchestrationTimeouts(): Promise<void> {
  if (!_supabase) return;

  try {
    const { data: orchItems } = await _supabase
      .from("todos")
      .select("id, assigned_agent, assigned_to, status, updated_at, content, parent_id")
      .eq("is_orchestration", true)
      .eq("status", "open")
      .not("assigned_agent", "is", null);

    for (const item of orchItems ?? []) {
      const age = Date.now() - new Date(item.updated_at).getTime();
      if (age > ORCHESTRATION_TIMEOUT_MS) {
        const { updateItemStatus } = await import("./gtd-orchestration.ts");
        await updateItemStatus(item.id, "timed_out").catch(() => {});
        logger.warn("Orchestration item timed out", { id: item.id, agent: item.assigned_agent, age_ms: age });
      }
    }
  } catch (err) {
    logger.error("Orchestration timeout check failed", err);
  }
}

export async function recoverOrphanedOrchestration(): Promise<number> {
  const { findOrphanedParents, timeoutStaleChildren, checkParentCompletion } = await import("./gtd-orchestration.ts");
  const orphans = await findOrphanedParents(2 * 60 * 60 * 1000); // 2 hours
  for (const orphan of orphans) {
    await timeoutStaleChildren(orphan.id, 30 * 60 * 1000);
    await checkParentCompletion(orphan.id);
  }
  return orphans.length;
}

async function escalateTask(task: TodoRow, reason: "unstarted" | "stalled", durationMs: number): Promise<void> {
  if (!_notifyFn || !_notifyCtx) return;

  const minutes = Math.round(durationMs / 60_000);
  const agentName = task.assigned_agent || "unknown";
  const taskPreview = task.content.slice(0, 100);

  let message: string;
  if (reason === "unstarted") {
    message = `⚠️ GTD task unstarted for ${minutes}min — assigned to ${agentName}\n"${taskPreview}"`;
  } else {
    message = `⚠️ GTD task stalled (no updates ${minutes}min) — assigned to ${agentName}\n"${taskPreview}"`;
  }

  await _notifyFn(_notifyCtx, {
    event: "orchestration_stall",
    workItemId: task.source_ref || task.id.slice(0, 8),
    telegramMessage: message,
    gchatMessage: message,
  }).catch((err) => {
    logger.error("Escalation notification failed", { task_id: task.id }, err);
  });
}

// ── Testing support ────────────────────────────────────────

export function _resetForTesting(): void {
  if (_monitorTimer) {
    clearInterval(_monitorTimer);
    _monitorTimer = null;
  }
  lastEscalation.clear();
  _notifyFn = null;
  _notifyCtx = null;
  _supabase = null;
}
