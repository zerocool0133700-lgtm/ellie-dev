/**
 * Overnight Dashboard API — ELLIE-1146 / ELLIE-1149
 *
 * Endpoints for viewing overnight session status, task history, and results.
 * Approval/rejection workflow for morning review of completed tasks.
 */

import type { ApiRequest, ApiResponse } from "./types.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "../logger.ts";
import { isOvernightRunning } from "../overnight/scheduler.ts";

const logger = log.child("overnight-api");

/** GET /api/overnight/status — current session + running tasks */
export async function getOvernightStatus(
  _req: ApiRequest,
  res: ApiResponse,
  supabase: SupabaseClient | null,
): Promise<void> {
  if (!supabase) {
    return res.status(503).json({ error: "Database unavailable" });
  }

  try {
    const { data: session } = await supabase
      .from("overnight_sessions")
      .select("*")
      .eq("status", "running")
      .order("started_at", { ascending: false })
      .limit(1)
      .single();

    if (!session) {
      return res.status(200).json({
        running: isOvernightRunning(),
        session: null,
        tasks: [],
      });
    }

    const { data: tasks } = await supabase
      .from("overnight_task_results")
      .select("*")
      .eq("session_id", session.id)
      .order("started_at", { ascending: false });

    return res.status(200).json({
      running: true,
      session,
      tasks: tasks ?? [],
    });
  } catch (err: any) {
    logger.error("Failed to fetch overnight status", err);
    return res.status(500).json({ error: err?.message ?? "Internal error" });
  }
}

/** GET /api/overnight/sessions — paginated session list */
export async function getOvernightSessions(
  req: ApiRequest,
  res: ApiResponse,
  supabase: SupabaseClient | null,
): Promise<void> {
  if (!supabase) {
    return res.status(503).json({ error: "Database unavailable" });
  }

  try {
    const limit = Math.min(parseInt(req.query?.limit ?? "20", 10) || 20, 100);
    const offset = parseInt(req.query?.offset ?? "0", 10) || 0;

    const { data: sessions, error, count } = await supabase
      .from("overnight_sessions")
      .select("*", { count: "exact" })
      .order("started_at", { ascending: false })
      .limit(limit)
      .range(offset, offset + limit - 1);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({
      sessions: sessions ?? [],
      total: count ?? 0,
      limit,
      offset,
    });
  } catch (err: any) {
    logger.error("Failed to fetch overnight sessions", err);
    return res.status(500).json({ error: err?.message ?? "Internal error" });
  }
}

/** GET /api/overnight/sessions/:id — single session with its tasks */
export async function getOvernightSessionDetail(
  req: ApiRequest,
  res: ApiResponse,
  supabase: SupabaseClient | null,
): Promise<void> {
  const id = req.params?.id;
  if (!id) {
    return res.status(400).json({ error: "Missing session id" });
  }
  if (!supabase) {
    return res.status(503).json({ error: "Database unavailable" });
  }

  try {
    const { data: session } = await supabase
      .from("overnight_sessions")
      .select("*")
      .eq("id", id)
      .single();

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const { data: tasks } = await supabase
      .from("overnight_task_results")
      .select("*")
      .eq("session_id", id)
      .order("started_at", { ascending: false });

    return res.status(200).json({
      session,
      tasks: tasks ?? [],
    });
  } catch (err: any) {
    logger.error("Failed to fetch session detail", err);
    return res.status(500).json({ error: err?.message ?? "Internal error" });
  }
}

/** GET /api/overnight/sessions/:id/tasks — tasks for a session, with optional status filter */
export async function getOvernightSessionTasks(
  req: ApiRequest,
  res: ApiResponse,
  supabase: SupabaseClient | null,
): Promise<void> {
  const id = req.params?.id;
  if (!id) {
    return res.status(400).json({ error: "Missing session id" });
  }
  if (!supabase) {
    return res.status(503).json({ error: "Database unavailable" });
  }

  try {
    let query = supabase
      .from("overnight_task_results")
      .select("*")
      .eq("session_id", id);

    const statusFilter = req.query?.status;
    if (statusFilter) {
      query = query.eq("status", statusFilter);
    }

    const { data: tasks, error } = await query
      .order("started_at", { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ tasks: tasks ?? [] });
  } catch (err: any) {
    logger.error("Failed to fetch session tasks", err);
    return res.status(500).json({ error: err?.message ?? "Internal error" });
  }
}

// ── GitHub helpers ──────────────────────────────────────────

/** Parse owner/repo from a GitHub PR URL like https://github.com/evelife/ellie-dev/pull/42 */
function parseGitHubPrUrl(prUrl: string): { owner: string; repo: string } | null {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\//);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function getGitHubToken(): string | null {
  return process.env.OVERNIGHT_GH_TOKEN || process.env.GH_TOKEN || null;
}

async function mergeGitHubPr(owner: string, repo: string, prNumber: number, token: string): Promise<{ ok: boolean; error?: string }> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ merge_method: "squash" }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    return { ok: false, error: (body as any)?.message ?? `GitHub returned ${resp.status}` };
  }
  return { ok: true };
}

async function closeGitHubPr(owner: string, repo: string, prNumber: number, token: string): Promise<{ ok: boolean; error?: string }> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
  const resp = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ state: "closed" }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    return { ok: false, error: (body as any)?.message ?? `GitHub returned ${resp.status}` };
  }
  return { ok: true };
}

// ── Approval/Rejection ──────────────────────────────────────

/** Shared validation for approve/reject: fetch task, check preconditions */
async function validateTaskForAction(
  req: ApiRequest,
  res: ApiResponse,
  supabase: SupabaseClient | null,
): Promise<{ task: any } | null> {
  const id = req.params?.id;
  if (!id) {
    res.status(400).json({ error: "Missing task id" });
    return null;
  }
  if (!supabase) {
    res.status(503).json({ error: "Database unavailable" });
    return null;
  }

  const { data: task } = await supabase
    .from("overnight_task_results")
    .select("*")
    .eq("id", id)
    .single();

  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return null;
  }

  if (!task.pr_number || !task.pr_url) {
    res.status(400).json({ error: "Task has no PR to act on" });
    return null;
  }

  if (task.status === "merged" || task.status === "rejected") {
    res.status(409).json({ error: `Task already ${task.status}` });
    return null;
  }

  // ELLIE-1163: Only completed tasks can be approved/rejected
  if (task.status !== "completed") {
    res.status(409).json({ error: `Cannot act on task in '${task.status}' status — only 'completed' tasks can be approved or rejected` });
    return null;
  }

  return { task };
}

/** POST /api/overnight/tasks/:id/approve — merge PR and mark task approved */
export async function approveOvernightTask(
  req: ApiRequest,
  res: ApiResponse,
  supabase: SupabaseClient | null,
): Promise<void> {
  try {
    const validated = await validateTaskForAction(req, res, supabase);
    if (!validated) return;
    const { task } = validated;

    const token = getGitHubToken();
    if (!token) {
      return res.status(500).json({ error: "GitHub token not configured" });
    }

    const parsed = parseGitHubPrUrl(task.pr_url);
    if (!parsed) {
      return res.status(500).json({ error: "Cannot parse PR URL" });
    }

    const result = await mergeGitHubPr(parsed.owner, parsed.repo, task.pr_number, token);
    if (!result.ok) {
      return res.status(502).json({ error: `Failed to merge PR: ${result.error}` });
    }

    await supabase!
      .from("overnight_task_results")
      .update({ status: "merged" })
      .eq("id", task.id);

    logger.info(`Task ${task.id} approved — PR #${task.pr_number} merged`);
    return res.status(200).json({ status: "merged", pr_number: task.pr_number, task_id: task.id });
  } catch (err: any) {
    logger.error("Failed to approve overnight task", err);
    return res.status(500).json({ error: err?.message ?? "Internal error" });
  }
}

/** POST /api/overnight/tasks/:id/reject — close PR and mark task rejected */
export async function rejectOvernightTask(
  req: ApiRequest,
  res: ApiResponse,
  supabase: SupabaseClient | null,
): Promise<void> {
  try {
    const validated = await validateTaskForAction(req, res, supabase);
    if (!validated) return;
    const { task } = validated;

    const token = getGitHubToken();
    if (!token) {
      return res.status(500).json({ error: "GitHub token not configured" });
    }

    const parsed = parseGitHubPrUrl(task.pr_url);
    if (!parsed) {
      return res.status(500).json({ error: "Cannot parse PR URL" });
    }

    const result = await closeGitHubPr(parsed.owner, parsed.repo, task.pr_number, token);
    if (!result.ok) {
      return res.status(502).json({ error: `Failed to close PR: ${result.error}` });
    }

    const reason = (req.body?.reason as string) || null;
    await supabase!
      .from("overnight_task_results")
      .update({ status: "rejected", error: reason })
      .eq("id", task.id);

    logger.info(`Task ${task.id} rejected — PR #${task.pr_number} closed${reason ? `: ${reason}` : ""}`);
    return res.status(200).json({ status: "rejected", pr_number: task.pr_number, task_id: task.id, reason });
  } catch (err: any) {
    logger.error("Failed to reject overnight task", err);
    return res.status(500).json({ error: err?.message ?? "Internal error" });
  }
}

/** GET /api/overnight/tasks/:id — single task detail */
export async function getOvernightTaskDetail(
  req: ApiRequest,
  res: ApiResponse,
  supabase: SupabaseClient | null,
): Promise<void> {
  const id = req.params?.id;
  if (!id) {
    return res.status(400).json({ error: "Missing task id" });
  }
  if (!supabase) {
    return res.status(503).json({ error: "Database unavailable" });
  }

  try {
    const { data: task } = await supabase
      .from("overnight_task_results")
      .select("*")
      .eq("id", id)
      .single();

    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    return res.status(200).json({ task });
  } catch (err: any) {
    logger.error("Failed to fetch task detail", err);
    return res.status(500).json({ error: err?.message ?? "Internal error" });
  }
}
