/**
 * GTD API — Agent-facing endpoints for GTD interaction
 *
 * ELLIE-275: Ellie interaction layer for GTD
 * ELLIE-281: Refactored to ApiRequest/ApiResponse pattern
 *
 * Layer 1: Raw API endpoints for any agent to read/write GTD data.
 * - POST /api/gtd/inbox      — Capture items from conversations
 * - GET  /api/gtd/next-actions — Know what's on the user's plate
 * - GET  /api/gtd/review-state — Check if weekly review is due
 * - PATCH /api/gtd/todos/:id  — Update status (with permission)
 * - GET  /api/gtd/summary     — Quick GTD state for context surfacing
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { IncomingMessage, ServerResponse } from "http";
import type { ApiRequest, ApiResponse } from "./types.ts";
import type { TodoRow } from "./gtd-types.ts";
import { log } from "../logger.ts";

const logger = log.child("gtd-api");

// ELLIE-290: Context tag validation — tags starting with @ must match this pattern
const CONTEXT_TAG_PATTERN = /^@[a-z][a-z0-9-]*$/;

function validateTags(tags: unknown[]): string | null {
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    if (tag.startsWith("@") && !CONTEXT_TAG_PATTERN.test(tag)) {
      return `Invalid context tag "${tag}" — must match @lowercase-with-dashes`;
    }
  }
  return null;
}

// ── POST /api/gtd/inbox — Capture items ─────────────────────

async function handleInbox(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const parsed = req.body;
  if (!parsed) {
    res.status(400).json({ error: "Missing request body" });
    return;
  }

  const items = Array.isArray(parsed.items) ? parsed.items : [parsed];

  const results: { id: string; content: string }[] = [];
  const errors: string[] = [];

  for (const item of items) {
    const content = (item as Record<string, unknown>).content as string | undefined;
    if (!content || typeof content !== "string" || !content.trim()) {
      errors.push("Missing or empty content field");
      continue;
    }

    // ELLIE-290: Validate context tags
    const tags = Array.isArray((item as Record<string, unknown>).tags) ? (item as Record<string, unknown>).tags as unknown[] : [];
    const tagError = validateTags(tags);
    if (tagError) {
      errors.push(tagError);
      continue;
    }

    const { data, error } = await supabase
      .from("todos")
      .insert({
        content: content.trim(),
        status: "inbox",
        priority: (item as Record<string, unknown>).priority || null,
        tags: Array.isArray((item as Record<string, unknown>).tags) ? (item as Record<string, unknown>).tags : [],
        source_type: (item as Record<string, unknown>).source_type || "agent",
        source_ref: (item as Record<string, unknown>).source_ref || null,
        source_conversation_id: (item as Record<string, unknown>).conversation_id || null,
      })
      .select("id, content")
      .single();

    if (error) {
      errors.push(`Insert failed: ${error.message}`);
    } else if (data) {
      results.push(data as { id: string; content: string });
    }
  }

  logger.info("Inbox capture", { captured: results.length, errors: errors.length });
  res.json({ captured: results, errors: errors.length > 0 ? errors : undefined });
}

// ── GET /api/gtd/next-actions ────────────────────────────────

/**
 * Scoring algorithm: also exists in two other locations (ELLIE-282).
 * Keep in sync with:
 *   - ellie-home/app/composables/useTodoScoring.ts  (client)
 *   - ellie-home/server/utils/todoScoring.ts         (dashboard server)
 */
async function handleNextActions(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const context = req.query?.context || null;
  const limit = Math.min(Number(req.query?.limit) || 10, 50);

  const { data, error } = await supabase
    .from("todos")
    .select("*")
    .eq("status", "open")
    .order("created_at", { ascending: true })
    .limit(50);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const todos = (data || []) as TodoRow[];

  // Simple scoring (mirrors dashboard logic)
  const scored = todos.map((t) => {
    let score = 0;

    // Priority
    if (t.priority === "high") score += 30;
    else if (t.priority === "medium") score += 20;
    else if (t.priority === "low") score += 10;

    // Due date urgency
    if (t.due_date) {
      const daysUntil = Math.ceil((new Date(t.due_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      if (daysUntil < 0) score += 40 + Math.min(Math.abs(daysUntil), 10);
      else if (daysUntil <= 1) score += 35;
      else if (daysUntil <= 3) score += 25;
      else if (daysUntil <= 7) score += 15;
      else score += 5;
    }

    // Context match
    if (context && t.tags?.includes(context)) score += 15;

    // Age bonus
    const ageInDays = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000 * 60 * 60 * 24));
    score += Math.min(Math.floor(ageInDays / 3), 10);

    return { ...t, _score: score };
  });

  scored.sort((a, b) => {
    const diff = b._score - a._score;
    if (diff !== 0) return diff;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  const topItems = scored.slice(0, limit).map(({ _score, ...rest }) => ({
    ...rest,
    score: _score,
  }));

  res.json({
    next_actions: topItems,
    context,
    total_open: todos.length,
  });
}

// ── GET /api/gtd/review-state ────────────────────────────────

/**
 * Review state detection reads `daily_rollups` rows where
 * `rollup_date LIKE 'review-%'` — these are written by the weekly
 * review generator at weekly-review.ts:303 (`rollup_date: review-${data.weekOf}`).
 * ELLIE-285: Keep the naming convention in sync.
 */
async function handleReviewState(_req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Check last weekly review
  const { data: lastReview } = await supabase
    .from("daily_rollups")
    .select("rollup_date, digest")
    .like("rollup_date", "review-%")
    .order("rollup_date", { ascending: false })
    .limit(1)
    .single();

  const lastReviewDate = lastReview?.rollup_date?.replace("review-", "") || null;
  const lastReviewAge = lastReviewDate
    ? Math.floor((now.getTime() - new Date(lastReviewDate).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  const reviewOverdue = lastReviewAge === null || lastReviewAge >= 7;

  // Count items by status
  const { data: allTodos } = await supabase
    .from("todos")
    .select("status, due_date, updated_at")
    .neq("status", "cancelled");

  const todos = (allTodos || []) as { status: string; due_date: string | null; updated_at: string }[];

  const inboxCount = todos.filter((t) => t.status === "inbox").length;
  const openCount = todos.filter((t) => t.status === "open").length;
  const waitingCount = todos.filter((t) => t.status === "waiting_for").length;
  const somedayCount = todos.filter((t) => t.status === "someday").length;
  const overdueCount = todos.filter(
    (t) => t.status === "open" && t.due_date && new Date(t.due_date) < now,
  ).length;
  const staleCount = todos.filter(
    (t) => t.status === "open" && new Date(t.updated_at) < weekAgo,
  ).length;

  // Active projects
  const { data: projectData } = await supabase
    .from("todo_projects")
    .select("id, name, updated_at")
    .eq("status", "active");

  const projects = (projectData || []) as { id: string; name: string; updated_at: string }[];
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const staleProjectCount = projects.filter((p) => new Date(p.updated_at) < twoWeeksAgo).length;

  // ELLIE-289: Find active projects with no open next-actions
  const projectIds = projects.map((p) => p.id);
  const projectsWithoutActions: string[] = [];
  if (projectIds.length > 0) {
    const { data: projectTodos } = await supabase
      .from("todos")
      .select("project_id")
      .in("project_id", projectIds)
      .eq("status", "open");

    const projectsWithActions = new Set((projectTodos || []).map((t: { project_id: string }) => t.project_id));
    for (const p of projects) {
      if (!projectsWithActions.has(p.id)) {
        projectsWithoutActions.push(p.name);
      }
    }
  }

  // ELLIE-291: Waiting-for age tracking
  const waitingAges: { content: string; days: number; waiting_on: string | null }[] = [];
  if (waitingCount > 0) {
    const { data: waitingDetails } = await supabase
      .from("todos")
      .select("content, waiting_on, updated_at")
      .eq("status", "waiting_for");

    for (const w of (waitingDetails || []) as { content: string; waiting_on: string | null; updated_at: string }[]) {
      const days = Math.floor((now.getTime() - new Date(w.updated_at).getTime()) / (1000 * 60 * 60 * 24));
      if (days >= 7) {
        waitingAges.push({ content: w.content, days, waiting_on: w.waiting_on });
      }
    }
  }

  // Build nudges (things Ellie should mention if relevant)
  const nudges: string[] = [];
  if (reviewOverdue) nudges.push(`Weekly review is ${lastReviewAge === null ? "never done" : `${lastReviewAge} days overdue`} — want to do it now?`);
  if (inboxCount > 0) nudges.push(`You have ${inboxCount} unprocessed inbox item${inboxCount > 1 ? "s" : ""} — want to process them?`);
  if (overdueCount > 0) nudges.push(`${overdueCount} item${overdueCount > 1 ? "s" : ""} are overdue`);
  if (staleCount > 3) nudges.push(`${staleCount} items haven't been updated in a week — some might be worth moving to someday`);
  if (staleProjectCount > 0) nudges.push(`${staleProjectCount} project${staleProjectCount > 1 ? "s" : ""} haven't been updated in 2+ weeks`);
  // ELLIE-289: Nudge for projects without next actions
  if (projectsWithoutActions.length > 0) {
    const names = projectsWithoutActions.slice(0, 3).join(", ");
    const suffix = projectsWithoutActions.length > 3 ? ` (+${projectsWithoutActions.length - 3} more)` : "";
    nudges.push(`${projectsWithoutActions.length} active project${projectsWithoutActions.length > 1 ? "s have" : " has"} no next actions: ${names}${suffix}`);
  }
  // ELLIE-291: Nudge for stale waiting-for items
  if (waitingAges.length > 0) {
    const oldest = waitingAges.sort((a, b) => b.days - a.days)[0];
    nudges.push(`${waitingAges.length} waiting-for item${waitingAges.length > 1 ? "s" : ""} older than a week — oldest: "${oldest.content}" (${oldest.days}d${oldest.waiting_on ? `, on ${oldest.waiting_on}` : ""})`);
  }

  res.json({
    review_overdue: reviewOverdue,
    last_review_date: lastReviewDate,
    last_review_age_days: lastReviewAge,
    counts: {
      inbox: inboxCount,
      open: openCount,
      waiting: waitingCount,
      someday: somedayCount,
      overdue: overdueCount,
      stale: staleCount,
      active_projects: projects.length,
      stale_projects: staleProjectCount,
      projects_without_actions: projectsWithoutActions.length,
    },
    nudges,
    waiting_ages: waitingAges.length > 0 ? waitingAges : undefined,
  });
}

// ── PATCH /api/gtd/todos/:id ─────────────────────────────────

const VALID_STATUSES = ["inbox", "open", "done", "cancelled", "waiting_for", "someday"] as const;
const VALID_PRIORITIES = ["high", "medium", "low", null] as const;

async function handleUpdateTodo(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const todoId = req.params?.id;
  if (!todoId) {
    res.status(400).json({ error: "Missing todo ID" });
    return;
  }

  const parsed = req.body;
  if (!parsed) {
    res.status(400).json({ error: "Missing request body" });
    return;
  }

  // Validate status (ELLIE-279)
  if (parsed.status !== undefined) {
    if (!VALID_STATUSES.includes(parsed.status as typeof VALID_STATUSES[number])) {
      res.status(400).json({ error: `Invalid status: ${parsed.status}. Allowed: ${VALID_STATUSES.join(", ")}` });
      return;
    }
  }

  // Validate priority (ELLIE-279)
  if (parsed.priority !== undefined) {
    if (parsed.priority !== null && !VALID_PRIORITIES.includes(parsed.priority as typeof VALID_PRIORITIES[number])) {
      res.status(400).json({ error: `Invalid priority: ${parsed.priority}. Allowed: high, medium, low, null` });
      return;
    }
  }

  // ELLIE-290: Validate context tags
  if (parsed.tags !== undefined && Array.isArray(parsed.tags)) {
    const tagError = validateTags(parsed.tags);
    if (tagError) {
      res.status(400).json({ error: tagError });
      return;
    }
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (parsed.status !== undefined) {
    updates.status = parsed.status;
    if (parsed.status === "done" || parsed.status === "cancelled") {
      updates.completed_at = new Date().toISOString();
    } else {
      updates.completed_at = null;
    }
    // ELLIE-291: Track when item entered waiting_for
    if (parsed.status === "waiting_for") {
      updates.waiting_since = new Date().toISOString();
    } else {
      updates.waiting_on = null;
      updates.waiting_since = null;
    }
  }
  if (parsed.priority !== undefined) updates.priority = parsed.priority;
  if (parsed.due_date !== undefined) updates.due_date = parsed.due_date;
  if (parsed.tags !== undefined) updates.tags = parsed.tags;
  if (parsed.waiting_on !== undefined) updates.waiting_on = parsed.waiting_on;
  if (parsed.project_id !== undefined) updates.project_id = parsed.project_id;
  if (parsed.content !== undefined) updates.content = parsed.content;

  const { data, error } = await supabase
    .from("todos")
    .update(updates)
    .eq("id", todoId)
    .select()
    .single();

  if (error) {
    res.status(error.code === "PGRST116" ? 404 : 500).json({ error: error.message });
    return;
  }

  logger.info("Todo updated via API", { id: todoId, status: parsed.status });
  res.json(data);
}

// ── GET /api/gtd/summary — Quick state for context surfacing ─

async function handleSummary(_req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const { data: allTodos } = await supabase
    .from("todos")
    .select("content, status, priority, due_date, tags, project_id, waiting_on")
    .in("status", ["inbox", "open", "waiting_for"])
    .order("created_at", { ascending: true });

  const todos = (allTodos || []) as Pick<TodoRow, "content" | "status" | "priority" | "due_date" | "tags" | "project_id" | "waiting_on">[];

  const now = new Date();
  const inbox = todos.filter((t) => t.status === "inbox");
  const open = todos.filter((t) => t.status === "open");
  const waiting = todos.filter((t) => t.status === "waiting_for");
  const overdue = open.filter((t) => t.due_date && new Date(t.due_date) < now);

  // Build a concise text summary for agent context
  const lines: string[] = [];
  if (inbox.length) lines.push(`${inbox.length} inbox items need processing`);
  if (overdue.length) {
    lines.push(`${overdue.length} overdue: ${overdue.slice(0, 3).map((t) => t.content).join(", ")}${overdue.length > 3 ? "..." : ""}`);
  }
  if (waiting.length) {
    lines.push(`${waiting.length} waiting: ${waiting.slice(0, 3).map((t) => `${t.content}${t.waiting_on ? ` (on ${t.waiting_on})` : ""}`).join(", ")}${waiting.length > 3 ? "..." : ""}`);
  }
  lines.push(`${open.length} open actions`);

  // Top 5 open items by priority
  const topOpen = [...open]
    .sort((a, b) => {
      const prio = { high: 3, medium: 2, low: 1 } as Record<string, number>;
      return (prio[b.priority || ""] || 0) - (prio[a.priority || ""] || 0);
    })
    .slice(0, 5);

  res.json({
    summary_text: lines.join(". ") + ".",
    counts: {
      inbox: inbox.length,
      open: open.length,
      waiting: waiting.length,
      overdue: overdue.length,
    },
    top_actions: topOpen.map((t) => ({
      content: t.content,
      priority: t.priority,
      due_date: t.due_date,
      tags: t.tags,
    })),
  });
}

// ── Route dispatcher ─────────────────────────────────────────

const MAX_BODY_BYTES = 1024 * 1024; // 1MB (ELLIE-278)

function jsonRes(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  return new Promise((resolve) => {
    let body = "";
    let bytes = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        aborted = true;
        jsonRes(res, 413, { error: "Request body too large (max 1MB)" });
        req.destroy();
        resolve(null);
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => { if (!aborted) resolve(body); });
    req.on("error", () => { if (!aborted) { aborted = true; resolve(null); } });
  });
}

/** Build ApiRequest/ApiResponse from raw HTTP objects, then dispatch to handler */
export function handleGtdRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  supabase: SupabaseClient | null,
): boolean {
  if (!pathname.startsWith("/api/gtd/")) return false;

  if (!supabase) {
    jsonRes(res, 500, { error: "Supabase not configured" });
    return true;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const queryParams: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { queryParams[k] = v; });

  const mockRes: ApiResponse = {
    status: (code: number) => ({
      json: (data: unknown) => { jsonRes(res, code, data); },
    }),
    json: (data: unknown) => { jsonRes(res, 200, data); },
  };

  /** Wrap async handler to catch unhandled rejections (ELLIE-276) */
  const safeAsync = (promise: Promise<void>): void => {
    promise.catch((err) => {
      logger.error("GTD handler failed", err);
      if (!res.writableEnded) {
        jsonRes(res, 500, { error: "Internal server error" });
      }
    });
  };

  // GET endpoints — no body parsing needed
  if (req.method === "GET") {
    const mockReq: ApiRequest = { query: queryParams };

    if (pathname === "/api/gtd/next-actions") {
      safeAsync(handleNextActions(mockReq, mockRes, supabase));
      return true;
    }
    if (pathname === "/api/gtd/review-state") {
      safeAsync(handleReviewState(mockReq, mockRes, supabase));
      return true;
    }
    if (pathname === "/api/gtd/summary") {
      safeAsync(handleSummary(mockReq, mockRes, supabase));
      return true;
    }
  }

  // POST/PATCH endpoints — need body parsing
  if (req.method === "POST" && pathname === "/api/gtd/inbox") {
    safeAsync((async () => {
      const raw = await readBody(req, res);
      if (raw === null) return;
      let data: Record<string, unknown>;
      try { data = JSON.parse(raw); } catch { jsonRes(res, 400, { error: "Invalid JSON" }); return; }
      await handleInbox({ body: data, query: queryParams }, mockRes, supabase);
    })());
    return true;
  }

  const todoMatch = pathname.match(/^\/api\/gtd\/todos\/([0-9a-f-]{36})$/);
  if (todoMatch && req.method === "PATCH") {
    safeAsync((async () => {
      const raw = await readBody(req, res);
      if (raw === null) return;
      let data: Record<string, unknown>;
      try { data = JSON.parse(raw); } catch { jsonRes(res, 400, { error: "Invalid JSON" }); return; }
      await handleUpdateTodo({ body: data, query: queryParams, params: { id: todoMatch[1] } }, mockRes, supabase);
    })());
    return true;
  }

  return false;
}
