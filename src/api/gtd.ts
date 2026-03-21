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
import { AGENT_DISPLAY_NAMES } from "./gtd-types.ts";
import { log } from "../logger.ts";
import postgres from "postgres";

const logger = log.child("gtd-api");

// Lazy-load direct Postgres connection for atomic operations
let _pgSql: ReturnType<typeof postgres> | null = null;
function getPgSql(): ReturnType<typeof postgres> {
  if (_pgSql) return _pgSql;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  _pgSql = postgres(url, { max: 2 });
  return _pgSql;
}

// ELLIE-290: Context tag validation — tags starting with @ must match this pattern
const CONTEXT_TAG_PATTERN = /^@[a-z][a-z0-9-]*$/;

export function validateTags(tags: unknown[]): string | null {
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

    // Auto-assign sequence: max+1 within the project group (atomic query)
    const projectId = (item as Record<string, unknown>).project_id || null;

    // ELLIE-917: Auto-classify effort when agents create todos
    const autoEffort = (item as Record<string, unknown>).effort || classifyEffort(content);

    // ELLIE-924: Support agent assignment on task creation for orchestration
    const assignedAgent = (item as Record<string, unknown>).assigned_agent || (item as Record<string, unknown>).delegated_to || null;
    const delegatedBy = (item as Record<string, unknown>).delegated_by || null;

    // Validation: If assigned_agent is set, verify it's a valid agent type
    if (assignedAgent && typeof assignedAgent === "string") {
      const validAgents = ["general", "dev", "research", "content", "critic", "strategy", "ops"];
      if (!validAgents.includes(assignedAgent)) {
        errors.push(`Invalid assigned_agent "${assignedAgent}" — must be one of: ${validAgents.join(", ")}`);
        continue;
      }
    }

    // Use raw SQL for atomic sequence assignment (ELLIE-914 fix #1)
    try {
      const sql = getPgSql();
      const delegatedAt = assignedAgent && delegatedBy ? new Date().toISOString() : null;
      const priority = (item as Record<string, unknown>).priority || null;
      const sourceType = (item as Record<string, unknown>).source_type || "agent";
      const sourceRef = (item as Record<string, unknown>).source_ref || null;
      const sourceConvId = (item as Record<string, unknown>).conversation_id || null;
      const tags = Array.isArray((item as Record<string, unknown>).tags) ? (item as Record<string, unknown>).tags : [];
      const context = (item as Record<string, unknown>).context || null;
      const isReference = (item as Record<string, unknown>).is_reference || false;

      const inserted = await sql`
        INSERT INTO todos (
          content, status, priority, tags, source_type, source_ref, source_conversation_id,
          project_id, sequence, effort, context, is_reference, assigned_agent, delegated_by, delegated_at
        )
        VALUES (
          ${content.trim()}, 'inbox', ${priority}, ${sql.array(tags)}, ${sourceType}, ${sourceRef}, ${sourceConvId},
          ${projectId},
          (SELECT COALESCE(MAX(sequence), 0) + 1 FROM todos WHERE ${projectId ? sql`project_id = ${projectId}` : sql`project_id IS NULL`}),
          ${autoEffort}, ${context}, ${isReference}, ${assignedAgent}, ${delegatedBy}, ${delegatedAt}
        )
        RETURNING id, content, sequence, assigned_agent, delegated_by
      `;

      if (inserted[0]) {
        results.push(inserted[0] as { id: string; content: string });
      }
    } catch (err) {
      errors.push(`Insert failed: ${(err as Error).message}`);
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
  const agentFilter = req.query?.agent || null; // ELLIE-886
  const sortMode = req.query?.sort || "score"; // "score" (default) or "sequence"
  const limitNum = Number(req.query?.limit);
  const limit = Math.min(Number.isFinite(limitNum) && limitNum > 0 ? limitNum : 10, 50);

  let query = supabase
    .from("todos")
    .select("*")
    .eq("status", "open")
    .order(sortMode === "sequence" ? "sequence" : "created_at", { ascending: true })
    .limit(50);

  // ELLIE-886: Filter by assigned agent
  if (agentFilter) query = query.eq("assigned_agent", agentFilter);

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const todos = (data || []) as TodoRow[];

  // When sort=sequence, return in sequence order without scoring
  if (sortMode === "sequence") {
    const topItems = todos.slice(0, limit);
    res.json({ next_actions: topItems, context, total_open: todos.length, sort: "sequence" });
    return;
  }

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

    // Context match (ELLIE-914 fix #5: use new context field, not old tags array)
    if (context && t.context === context) score += 15;

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
    sort: "score",
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
  if (parsed.sequence !== undefined) {
    const seq = Number(parsed.sequence);
    if (!Number.isInteger(seq) || seq < 0) {
      res.status(400).json({ error: "sequence must be a non-negative integer" });
      return;
    }
    updates.sequence = seq;
  }

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

// ── ELLIE-888: GET /api/gtd/team — Team overview ────────────

async function handleTeamOverview(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const { data: todos, error } = await supabase
    .from("todos")
    .select("status, assigned_agent")
    .not("status", "in", "(cancelled)");

  if (error) { res.status(500).json({ error: error.message }); return; }

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: doneThisWeek } = await supabase
    .from("todos")
    .select("assigned_agent")
    .eq("status", "done")
    .gte("completed_at", weekAgo);

  const agentTypes = Object.keys(AGENT_DISPLAY_NAMES);
  const agents = agentTypes.map(agent => {
    const agentTodos = (todos ?? []).filter(t => t.assigned_agent === agent);
    const doneCount = (doneThisWeek ?? []).filter(t => t.assigned_agent === agent).length;
    return {
      agent,
      display_name: AGENT_DISPLAY_NAMES[agent] || agent,
      open: agentTodos.filter(t => t.status === "open").length,
      waiting: agentTodos.filter(t => t.status === "waiting_for").length,
      inbox: agentTodos.filter(t => t.status === "inbox").length,
      done_this_week: doneCount,
    };
  });

  const unassigned = (todos ?? []).filter(t => !t.assigned_agent);
  res.json({
    success: true,
    agents,
    unassigned: {
      inbox: unassigned.filter(t => t.status === "inbox").length,
      open: unassigned.filter(t => t.status === "open").length,
      waiting: unassigned.filter(t => t.status === "waiting_for").length,
    },
    total_open: (todos ?? []).filter(t => t.status === "open").length,
  });
}

// ── ELLIE-892: POST /api/gtd/delegate — Delegate task ──────

async function handleDelegate(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const { todo_id, to_agent, delegated_by, note } = req.body ?? {};

  if (!todo_id || !to_agent) {
    res.status(400).json({ error: "todo_id and to_agent required" });
    return;
  }

  const agentType = String(to_agent);

  // ELLIE-909: Validate agent type is known
  if (!AGENT_DISPLAY_NAMES[agentType]) {
    res.status(400).json({ error: `Unknown agent type: ${agentType}. Valid: ${Object.keys(AGENT_DISPLAY_NAMES).join(", ")}` });
    return;
  }

  // ELLIE-912: Validate todo_id is a UUID
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(todo_id))) {
    res.status(400).json({ error: "Invalid todo_id format" });
    return;
  }

  const displayName = AGENT_DISPLAY_NAMES[agentType];

  // Validate todo exists
  const { data: todo, error: fetchErr } = await supabase
    .from("todos")
    .select("*")
    .eq("id", todo_id)
    .single();

  if (fetchErr || !todo) { res.status(404).json({ error: "Todo not found" }); return; }

  // ELLIE-909: Validate todo is in a delegatable state
  if (todo.status === "done" || todo.status === "cancelled") {
    res.status(400).json({ error: `Cannot delegate a ${todo.status} todo` });
    return;
  }

  // ELLIE-913: Use provided delegated_by, don't hardcode "Dave"
  const delegator = typeof delegated_by === "string" && delegated_by.trim() ? delegated_by.trim() : "Dave";

  const updates: Record<string, unknown> = {
    assigned_agent: agentType,
    assigned_to: displayName,
    delegated_by: delegator,
    delegated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Transition inbox → open on delegation
  if (todo.status === "inbox") updates.status = "open";

  const { data: updated, error: updateErr } = await supabase
    .from("todos")
    .update(updates)
    .eq("id", todo_id)
    .select()
    .single();

  if (updateErr) { res.status(500).json({ error: updateErr.message }); return; }

  logger.info("Task delegated", { todoId: todo_id, agent: agentType, by: delegated_by });

  // ELLIE-896: Delegation notification (fire and forget)
  try {
    const { getNotifyCtx } = await import("../relay-state.ts");
    const { notify } = await import("../notifications.ts");
    notify(getNotifyCtx(), {
      event: "delegation",
      workItemId: todo_id,
      telegramMessage: `📋 Task delegated to ${displayName}: ${todo.content.substring(0, 100)}`,
      gchatMessage: `📋 Task delegated to ${displayName}: ${todo.content.substring(0, 100)}`,
    }).catch(err => logger.error("[gtd] Delegation notification failed", err));
  } catch (err) { logger.error("[gtd] Delegation notification setup failed", err); }

  res.json({ success: true, todo: updated });
}

// ── ELLIE-893: POST /api/gtd/delegate/complete ─────────────

async function handleDelegateComplete(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const { todo_id, agent, result } = req.body ?? {};

  if (!todo_id) { res.status(400).json({ error: "todo_id required" }); return; }

  const { data: updated, error } = await supabase
    .from("todos")
    .update({
      status: "done",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", todo_id)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  logger.info("Delegated task completed", { todoId: todo_id, agent });

  // Notify delegator
  if (updated?.delegated_by) {
    try {
      const { getNotifyCtx } = await import("../relay-state.ts");
      const { notify } = await import("../notifications.ts");
      const agentDisplay = AGENT_DISPLAY_NAMES[String(agent)] || String(agent);
      notify(getNotifyCtx(), {
        event: "delegation_complete",
        workItemId: todo_id,
        telegramMessage: `✅ ${agentDisplay} completed: ${updated.content?.substring(0, 100)}${result ? `\nResult: ${result}` : ""}`,
        gchatMessage: `✅ ${agentDisplay} completed delegated task`,
      }).catch(() => {});
    } catch {}
  }

  res.json({ success: true, todo: updated });
}

// ── POST /api/gtd/reorder — Batch reorder todos within a project ──

async function handleReorder(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const { project_id, order } = req.body ?? {};

  if (!Array.isArray(order) || order.length === 0) {
    res.status(400).json({ error: "order must be a non-empty array of todo IDs" });
    return;
  }

  // Validate all entries are UUID strings
  for (const id of order) {
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      res.status(400).json({ error: `Invalid todo ID in order array: ${id}` });
      return;
    }
  }

  // Use raw SQL for batch UPDATE to avoid partial record creation (ELLIE-914 fix #2)
  try {
    const sql = getPgSql();
    const now = new Date().toISOString();

    // Build a single UPDATE using CASE for batch updates
    await sql`
      UPDATE todos
      SET
        sequence = CASE id
          ${sql(order.map((id: string, idx: number) => sql`WHEN ${id}::uuid THEN ${idx + 1}`))}
          ELSE sequence
        END,
        updated_at = ${now}
      WHERE id = ANY(${sql.array(order)}::uuid[])
    `;

    logger.info("Todos reordered", { project_id: project_id || "unassigned", count: order.length });
    res.json({ success: true, reordered: order.length });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ── ELLIE-916: Context management ───────────────────────────

async function handleListContexts(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase
    .from("gtd_contexts")
    .select("*")
    .order("sort_order", { ascending: true });

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true, contexts: data ?? [] });
}

async function handleCreateContext(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const { name, label, icon, color, calendar_enabled } = req.body ?? {};
  if (!name || !label) { res.status(400).json({ error: "name and label required" }); return; }

  // ELLIE-914 fix #3: Validate name format to match URL regex for update/delete endpoints
  if (!/^[a-z][a-z0-9-]*$/.test(String(name))) {
    res.status(400).json({ error: "Context name must start with lowercase letter and contain only lowercase letters, numbers, and hyphens" });
    return;
  }

  const { data: existing } = await supabase.from("gtd_contexts").select("sort_order").order("sort_order", { ascending: false }).limit(1);
  const nextOrder = (Number(existing?.[0]?.sort_order) || 0) + 1;

  // ELLIE-914 fix #4: Removed ghost 'tag' field that doesn't exist in schema
  const { data, error } = await supabase
    .from("gtd_contexts")
    .insert({ name: String(name), label, icon: icon || null, color: color || null, calendar_enabled: calendar_enabled || false, sort_order: nextOrder })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true, context: data });
}

async function handleUpdateContext(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const name = req.params?.name;
  if (!name) { res.status(400).json({ error: "Missing context name" }); return; }

  const updates: Record<string, unknown> = {};
  for (const key of ["label", "icon", "color", "calendar_enabled", "calendar_id", "sort_order"]) {
    if (req.body?.[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }

  const { data, error } = await supabase
    .from("gtd_contexts")
    .update(updates)
    .eq("name", name)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true, context: data });
}

async function handleDeleteContext(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const name = req.params?.name;
  if (!name) { res.status(400).json({ error: "Missing context name" }); return; }

  const { error } = await supabase.from("gtd_contexts").delete().eq("name", name);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
}

// ── ELLIE-917: Auto effort classification ──────────────────

import { EFFORT_RULES } from "./gtd-types.ts";

function classifyEffort(content: string): "quick" | "medium" | "deep" {
  const lower = content.toLowerCase();
  // Check deep first (most specific)
  for (const kw of EFFORT_RULES.deep.keywords) {
    if (lower.includes(kw)) return "deep";
  }
  for (const kw of EFFORT_RULES.medium.keywords) {
    if (lower.includes(kw)) return "medium";
  }
  for (const kw of EFFORT_RULES.quick.keywords) {
    if (lower.includes(kw)) return "quick";
  }
  // Default to medium if no keywords match
  return "medium";
}

// ── ELLIE-918: Waiting-for auto-creation ───────────────────

async function handleAutoWaitingFor(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const { content, work_item_id, agent, context } = req.body ?? {};
  if (!content) { res.status(400).json({ error: "content required" }); return; }

  const effort = classifyEffort(String(content));

  const { data, error } = await supabase
    .from("todos")
    .insert({
      content: String(content),
      status: "waiting_for",
      waiting_on: agent || "external",
      waiting_since: new Date().toISOString(),
      source_type: "agent",
      source_ref: work_item_id || null,
      context: context || "plane",
      effort,
      assigned_agent: agent || null,
      assigned_to: agent ? (AGENT_DISPLAY_NAMES[String(agent)] || String(agent)) : null,
    })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  logger.info("Auto waiting-for created", { todoId: data.id, workItem: work_item_id, agent });
  res.json({ success: true, todo: data });
}

// ── ELLIE-903: Workload snapshots ──────────────────────────

async function handleSnapshotCapture(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const agentTypes = Object.keys(AGENT_DISPLAY_NAMES);
  const { data: todos } = await supabase
    .from("todos")
    .select("status, assigned_agent")
    .not("status", "in", "(cancelled)");

  const today = new Date().toISOString().split("T")[0];
  const rows = agentTypes.map(agent => {
    const agentTodos = (todos ?? []).filter(t => t.assigned_agent === agent);
    return {
      agent_type: agent,
      snapshot_date: today,
      open_count: agentTodos.filter(t => t.status === "open").length,
      waiting_count: agentTodos.filter(t => t.status === "waiting_for").length,
      done_count: agentTodos.filter(t => t.status === "done").length,
    };
  });

  const { error } = await supabase.from("gtd_workload_snapshots").upsert(rows, { onConflict: "agent_type,snapshot_date" });
  if (error) { res.status(500).json({ error: error.message }); return; }

  logger.info("Workload snapshot captured", { date: today, agents: agentTypes.length });
  res.json({ success: true, date: today, snapshots: rows });
}

async function handleSnapshotList(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const days = Math.min(Math.max(parseInt(req.query?.days || "30"), 1), 365); // ELLIE-912: bounds check
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const { data, error } = await supabase
    .from("gtd_workload_snapshots")
    .select("*")
    .gte("snapshot_date", since)
    .order("snapshot_date", { ascending: true });

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true, snapshots: data ?? [] });
}

// ── ELLIE-906: GET /api/gtd/reports/velocity ───────────────

async function handleVelocityReport(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  // ELLIE-910: Single query instead of N+1 (one query per week)
  const weeks = Math.min(Math.max(parseInt(req.query?.weeks || "4"), 1), 12); // ELLIE-912: bounds check
  const since = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("todos")
    .select("assigned_agent, completed_at")
    .eq("status", "done")
    .gte("completed_at", since);

  if (error) { res.status(500).json({ error: error.message }); return; }

  // Group by week + agent in memory
  const results: Array<{ week_start: string; agent: string; done_count: number }> = [];
  const buckets: Record<string, Record<string, number>> = {};

  for (const t of data ?? []) {
    const completedAt = new Date(t.completed_at);
    // Find which week bucket this falls into
    const weekOffset = Math.floor((Date.now() - completedAt.getTime()) / (7 * 24 * 60 * 60 * 1000));
    const weekStart = new Date(Date.now() - (weekOffset + 1) * 7 * 24 * 60 * 60 * 1000);
    const weekKey = weekStart.toISOString().split("T")[0];
    const agent = t.assigned_agent || "unassigned";

    if (!buckets[weekKey]) buckets[weekKey] = {};
    buckets[weekKey][agent] = (buckets[weekKey][agent] || 0) + 1;
  }

  for (const [weekStart, agents] of Object.entries(buckets)) {
    for (const [agent, count] of Object.entries(agents)) {
      results.push({ week_start: weekStart, agent, done_count: count });
    }
  }

  res.json({ success: true, velocity: results });
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

  // ELLIE-916: GET /api/gtd/contexts — list contexts
  if (req.method === "GET" && pathname === "/api/gtd/contexts") {
    safeAsync(handleListContexts({ query: queryParams }, mockRes, supabase));
    return true;
  }

  // ELLIE-916: POST /api/gtd/contexts — create context
  if (req.method === "POST" && pathname === "/api/gtd/contexts") {
    safeAsync((async () => {
      const raw = await readBody(req, res);
      if (raw === null) return;
      let data: Record<string, unknown>;
      try { data = JSON.parse(raw); } catch { jsonRes(res, 400, { error: "Invalid JSON" }); return; }
      await handleCreateContext({ body: data, query: queryParams }, mockRes, supabase);
    })());
    return true;
  }

  // ELLIE-916: PATCH /api/gtd/contexts/:name — update context
  const ctxMatch = pathname.match(/^\/api\/gtd\/contexts\/([a-z][a-z0-9-]*)$/);
  if (ctxMatch && req.method === "PATCH") {
    safeAsync((async () => {
      const raw = await readBody(req, res);
      if (raw === null) return;
      let data: Record<string, unknown>;
      try { data = JSON.parse(raw); } catch { jsonRes(res, 400, { error: "Invalid JSON" }); return; }
      await handleUpdateContext({ body: data, query: queryParams, params: { name: ctxMatch[1] } }, mockRes, supabase);
    })());
    return true;
  }

  // ELLIE-916: DELETE /api/gtd/contexts/:name
  if (ctxMatch && req.method === "DELETE") {
    safeAsync(handleDeleteContext({ params: { name: ctxMatch[1] } }, mockRes, supabase));
    return true;
  }

  // ELLIE-918: POST /api/gtd/waiting-for — auto-create waiting-for from ticket work
  if (req.method === "POST" && pathname === "/api/gtd/waiting-for") {
    safeAsync((async () => {
      const raw = await readBody(req, res);
      if (raw === null) return;
      let data: Record<string, unknown>;
      try { data = JSON.parse(raw); } catch { jsonRes(res, 400, { error: "Invalid JSON" }); return; }
      await handleAutoWaitingFor({ body: data, query: queryParams }, mockRes, supabase);
    })());
    return true;
  }

  // ELLIE-888: GET /api/gtd/team — team overview
  if (req.method === "GET" && pathname === "/api/gtd/team") {
    safeAsync(handleTeamOverview({ query: queryParams }, mockRes, supabase));
    return true;
  }

  // ELLIE-903: POST /api/gtd/snapshots/capture — capture workload snapshot
  if (req.method === "POST" && pathname === "/api/gtd/snapshots/capture") {
    safeAsync(handleSnapshotCapture({ query: queryParams }, mockRes, supabase));
    return true;
  }

  // ELLIE-903: GET /api/gtd/snapshots — list snapshots
  if (req.method === "GET" && pathname === "/api/gtd/snapshots") {
    safeAsync(handleSnapshotList({ query: queryParams }, mockRes, supabase));
    return true;
  }

  // ELLIE-906: GET /api/gtd/reports/velocity — done per agent per week
  if (req.method === "GET" && pathname === "/api/gtd/reports/velocity") {
    safeAsync(handleVelocityReport({ query: queryParams }, mockRes, supabase));
    return true;
  }

  // POST /api/gtd/reorder — batch reorder todos within a project
  if (req.method === "POST" && pathname === "/api/gtd/reorder") {
    safeAsync((async () => {
      const raw = await readBody(req, res);
      if (raw === null) return;
      let data: Record<string, unknown>;
      try { data = JSON.parse(raw); } catch { jsonRes(res, 400, { error: "Invalid JSON" }); return; }
      await handleReorder({ body: data, query: queryParams }, mockRes, supabase);
    })());
    return true;
  }

  // ELLIE-892: POST /api/gtd/delegate — delegate task to agent
  if (req.method === "POST" && pathname === "/api/gtd/delegate") {
    safeAsync((async () => {
      const raw = await readBody(req, res);
      if (raw === null) return;
      let data: Record<string, unknown>;
      try { data = JSON.parse(raw); } catch { jsonRes(res, 400, { error: "Invalid JSON" }); return; }
      await handleDelegate({ body: data, query: queryParams }, mockRes, supabase);
    })());
    return true;
  }

  // ELLIE-893: POST /api/gtd/delegate/complete — complete delegated task
  if (req.method === "POST" && pathname === "/api/gtd/delegate/complete") {
    safeAsync((async () => {
      const raw = await readBody(req, res);
      if (raw === null) return;
      let data: Record<string, unknown>;
      try { data = JSON.parse(raw); } catch { jsonRes(res, 400, { error: "Invalid JSON" }); return; }
      await handleDelegateComplete({ body: data, query: queryParams }, mockRes, supabase);
    })());
    return true;
  }

  return false;
}
