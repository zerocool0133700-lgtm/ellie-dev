/**
 * Weekly Review Generation
 *
 * Sunday evening review of all open items: todos, waiting-for,
 * Plane activity, stale items, and suggestions.
 *
 * ELLIE-40: Weekly review prompt
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Bot } from "grammy";
import type { ApiRequest, ApiResponse } from "./types.ts";
import { sendGoogleChatMessage, isGoogleChatEnabled } from "../google-chat.ts";
import { listOpenIssues, isPlaneConfigured } from "../plane.ts";
import { log } from "../logger.ts";

const logger = log.child("weekly-review");

const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID!;
const GOOGLE_CHAT_SPACE = process.env.GOOGLE_CHAT_SPACE_NAME || "";

interface TodoItem {
  id: string;
  content: string;
  status: string;
  priority: string | null;
  due_date: string | null;
  tags: string[];
  waiting_on: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

interface TodoProject {
  id: string;
  name: string;
  status: string;
  outcome: string | null;
  created_at: string;
  updated_at: string;
}

interface WeeklyReviewData {
  weekOf: string;
  inboxItems: TodoItem[];
  openTodos: TodoItem[];
  waitingFor: TodoItem[];
  staleTodos: TodoItem[];
  overdueTodos: TodoItem[];
  somedayItems: TodoItem[];
  completedThisWeek: TodoItem[];
  projects: TodoProject[];
  staleProjects: TodoProject[];
  planeIssues: { sequenceId: number; name: string; priority: string }[];
}

/**
 * Gather all data needed for the weekly review.
 */
async function gatherReviewData(supabase: SupabaseClient): Promise<WeeklyReviewData> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekAgoISO = weekAgo.toISOString();
  const nowISO = now.toISOString();

  // Fetch all non-cancelled todos
  const { data: allTodos } = await supabase
    .from("todos")
    .select("*")
    .neq("status", "cancelled")
    .order("created_at", { ascending: true });

  const todos = (allTodos || []) as TodoItem[];

  const inboxItems = todos.filter((t) => t.status === "inbox");
  const openTodos = todos.filter((t) => t.status === "open");
  const waitingFor = todos.filter((t) => t.status === "waiting_for");
  const somedayItems = todos.filter((t) => t.status === "someday");

  // Stale: open items not updated in 7+ days
  const staleTodos = openTodos.filter((t) => t.updated_at < weekAgoISO);

  // Overdue: open items with due_date in the past
  const overdueTodos = openTodos.filter(
    (t) => t.due_date && new Date(t.due_date) < now,
  );

  // Completed this week
  const { data: completedData } = await supabase
    .from("todos")
    .select("*")
    .eq("status", "done")
    .gte("completed_at", weekAgoISO)
    .lte("completed_at", nowISO)
    .order("completed_at", { ascending: false });

  const completedThisWeek = (completedData || []) as TodoItem[];

  // GTD Projects
  const { data: projectData } = await supabase
    .from("todo_projects")
    .select("*")
    .eq("status", "active")
    .order("created_at", { ascending: true });

  const projects = (projectData || []) as TodoProject[];
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const staleProjects = projects.filter((p) => p.updated_at < twoWeeksAgo);

  // Plane open issues
  let planeIssues: { sequenceId: number; name: string; priority: string }[] = [];
  if (isPlaneConfigured()) {
    try {
      planeIssues = await listOpenIssues("ELLIE", 30);
    } catch (err) {
      logger.warn("Failed to fetch Plane issues", err);
    }
  }

  return {
    weekOf: nowISO.split("T")[0],
    inboxItems,
    openTodos,
    waitingFor,
    staleTodos,
    overdueTodos,
    somedayItems,
    completedThisWeek,
    projects,
    staleProjects,
    planeIssues,
  };
}

/**
 * Format the weekly review as human-readable text.
 */
function formatReviewText(data: WeeklyReviewData): string {
  const lines: string[] = [];

  lines.push(`🔄 Weekly Review — ${data.weekOf}`);
  lines.push("");

  // Inbox (unprocessed items)
  if (data.inboxItems.length) {
    lines.push(`📥 Inbox — unprocessed (${data.inboxItems.length})`);
    for (const t of data.inboxItems) {
      lines.push(`  • ${t.content}`);
    }
    lines.push("");
  }

  // Completed this week
  if (data.completedThisWeek.length) {
    lines.push(`✅ Completed this week (${data.completedThisWeek.length})`);
    for (const t of data.completedThisWeek) {
      lines.push(`  • ${t.content}`);
    }
    lines.push("");
  }

  // Overdue
  if (data.overdueTodos.length) {
    lines.push(`🚨 Overdue (${data.overdueTodos.length})`);
    for (const t of data.overdueTodos) {
      const due = new Date(t.due_date!).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      lines.push(`  • ${t.content} (due ${due})`);
    }
    lines.push("");
  }

  // Waiting for
  if (data.waitingFor.length) {
    lines.push(`⏳ Waiting for (${data.waitingFor.length})`);
    for (const t of data.waitingFor) {
      const who = t.waiting_on ? ` → ${t.waiting_on}` : "";
      lines.push(`  • ${t.content}${who}`);
    }
    lines.push("");
  }

  // Stale items
  if (data.staleTodos.length) {
    lines.push(`🕸 Stale (no update in 7+ days) (${data.staleTodos.length})`);
    for (const t of data.staleTodos) {
      const age = Math.floor(
        (Date.now() - new Date(t.updated_at).getTime()) / (1000 * 60 * 60 * 24),
      );
      const prio = t.priority ? ` [${t.priority}]` : "";
      lines.push(`  • ${t.content}${prio} — ${age}d stale`);
    }
    lines.push("");
  }

  // Open todos (non-stale, non-overdue)
  const staleIds = new Set(data.staleTodos.map((t) => t.id));
  const overdueIds = new Set(data.overdueTodos.map((t) => t.id));
  const activeTodos = data.openTodos.filter(
    (t) => !staleIds.has(t.id) && !overdueIds.has(t.id),
  );
  if (activeTodos.length) {
    lines.push(`📋 Active todos (${activeTodos.length})`);
    // Group by priority
    const high = activeTodos.filter((t) => t.priority === "high");
    const medium = activeTodos.filter((t) => t.priority === "medium");
    const rest = activeTodos.filter((t) => !t.priority || t.priority === "low");

    for (const t of [...high, ...medium, ...rest]) {
      const prio = t.priority ? ` [${t.priority}]` : "";
      const tags = t.tags?.length ? ` ${t.tags.join(" ")}` : "";
      lines.push(`  • ${t.content}${prio}${tags}`);
    }
    lines.push("");
  }

  // Active projects
  if (data.projects.length) {
    lines.push(`📂 Active projects (${data.projects.length})`);
    for (const p of data.projects) {
      const outcome = p.outcome ? ` — ${p.outcome}` : "";
      const isStale = data.staleProjects.some((sp) => sp.id === p.id);
      const staleFlag = isStale ? " 🕸" : "";
      lines.push(`  • ${p.name}${outcome}${staleFlag}`);
    }
    lines.push("");
  }

  // Someday/maybe (periodic review)
  if (data.somedayItems.length) {
    lines.push(`💭 Someday/Maybe (${data.somedayItems.length})`);
    for (const t of data.somedayItems.slice(0, 10)) {
      lines.push(`  • ${t.content}`);
    }
    if (data.somedayItems.length > 10) {
      lines.push(`  ... and ${data.somedayItems.length - 10} more`);
    }
    lines.push("");
  }

  // Plane issues
  if (data.planeIssues.length) {
    lines.push(`📌 Open Plane issues (${data.planeIssues.length})`);
    for (const i of data.planeIssues) {
      const prio = i.priority !== "none" ? ` [${i.priority}]` : "";
      lines.push(`  • ELLIE-${i.sequenceId}: ${i.name}${prio}`);
    }
    lines.push("");
  }

  // Suggestions
  const suggestions: string[] = [];
  if (data.inboxItems.length) {
    suggestions.push(`${data.inboxItems.length} inbox item(s) need processing — clarify and organize`);
  }
  if (data.staleTodos.length > 3) {
    suggestions.push("Consider archiving stale items or moving them to someday/maybe");
  }
  if (data.overdueTodos.length) {
    suggestions.push("Reschedule or complete overdue items");
  }
  if (data.staleProjects.length) {
    suggestions.push(`${data.staleProjects.length} project(s) haven't been updated in 14+ days — review or put on hold`);
  }
  const bigTodos = data.openTodos.filter((t) => t.content.length > 80);
  if (bigTodos.length) {
    suggestions.push(`${bigTodos.length} complex todo(s) might benefit from becoming projects`);
  }
  if (data.waitingFor.length > 5) {
    suggestions.push("Many blocked items — consider following up this week");
  }
  if (data.somedayItems.length > 20) {
    suggestions.push("Large someday list — prune items that are no longer relevant");
  }

  if (suggestions.length) {
    lines.push("💡 Suggestions");
    for (const s of suggestions) {
      lines.push(`  → ${s}`);
    }
    lines.push("");
  }

  // Summary line
  const total = data.openTodos.length + data.waitingFor.length;
  const parts = [`${total} active`, `${data.completedThisWeek.length} done this week`];
  if (data.inboxItems.length) parts.push(`${data.inboxItems.length} in inbox`);
  if (data.projects.length) parts.push(`${data.projects.length} projects`);
  if (data.somedayItems.length) parts.push(`${data.somedayItems.length} someday`);
  lines.push(`— ${parts.join(", ")}`);

  return lines.join("\n").trimEnd();
}

/**
 * POST /api/weekly-review/generate
 *
 * Generate a weekly review and send notifications.
 *
 * Body:
 * {
 *   "notify": true  // optional, send to Telegram + Google Chat (default: true)
 * }
 */
export async function generateWeeklyReview(
  req: ApiRequest,
  res: ApiResponse,
  supabase: SupabaseClient,
  bot: Bot,
) {
  try {
    const { notify = true } = req.body || {};

    console.log("[weekly-review] Generating weekly review");

    const data = await gatherReviewData(supabase);
    const text = formatReviewText(data);

    // Store in daily_rollups with a special identifier
    const { error: upsertError } = await supabase
      .from("daily_rollups")
      .upsert(
        {
          rollup_date: `review-${data.weekOf}`,
          sessions_count: data.openTodos.length + data.waitingFor.length,
          total_duration_min: 0,
          digest: {
            type: "weekly_review",
            inbox: data.inboxItems.length,
            openTodos: data.openTodos.length,
            waitingFor: data.waitingFor.length,
            stale: data.staleTodos.length,
            overdue: data.overdueTodos.length,
            someday: data.somedayItems.length,
            projects: data.projects.length,
            completedThisWeek: data.completedThisWeek.length,
            planeIssues: data.planeIssues.length,
          },
        },
        { onConflict: "rollup_date" },
      );

    if (upsertError) {
      logger.warn("Failed to store review", upsertError);
    }

    if (notify) {
      // Telegram: brief summary
      try {
        const inboxNote = data.inboxItems.length ? `, ${data.inboxItems.length} inbox` : "";
        const projectNote = data.projects.length ? `, ${data.projects.length} projects` : "";
        const tgSummary = `🔄 Weekly Review: ${data.openTodos.length} open, ${data.waitingFor.length} waiting, ${data.overdueTodos.length} overdue${inboxNote}${projectNote}, ${data.completedThisWeek.length} done this week. Full review sent to Google Chat.`;
        await bot.api.sendMessage(TELEGRAM_USER_ID, tgSummary);
      } catch (tgErr) {
        logger.warn("Telegram notification failed", tgErr);
      }

      // Google Chat: full review
      if (GOOGLE_CHAT_SPACE && isGoogleChatEnabled()) {
        try {
          await sendGoogleChatMessage(GOOGLE_CHAT_SPACE, text);
        } catch (gchatErr) {
          logger.warn("Google Chat notification failed", gchatErr);
        }
      }
    }

    console.log(
      `[weekly-review] Done: ${data.openTodos.length} open, ${data.waitingFor.length} waiting, ${data.staleTodos.length} stale`,
    );

    return res.json({
      success: true,
      weekOf: data.weekOf,
      summary: {
        inbox: data.inboxItems.length,
        openTodos: data.openTodos.length,
        waitingFor: data.waitingFor.length,
        stale: data.staleTodos.length,
        overdue: data.overdueTodos.length,
        someday: data.somedayItems.length,
        projects: data.projects.length,
        completedThisWeek: data.completedThisWeek.length,
        planeIssues: data.planeIssues.length,
      },
      text,
    });
  } catch (error) {
    logger.error("Generate failed", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
