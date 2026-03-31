/**
 * Heartbeat source adapter — gtd (ELLIE-1164)
 *
 * Tracks open tasks, overdue items, and recently completed todos.
 */

import { getRelayDeps } from "../../relay-state.ts";
import type { SourceDelta, HeartbeatSnapshot } from "../types.ts";

const SOURCE_TIMEOUT = 5000;

export async function check(snapshot: HeartbeatSnapshot | null): Promise<{
  delta: SourceDelta;
  snapshotUpdate: Partial<HeartbeatSnapshot>;
}> {
  try {
    const { supabase } = getRelayDeps();
    if (!supabase) throw new Error("Supabase not initialized");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT);

    let todos: any[] = [];
    try {
      const { data, error } = await supabase
        .from("todos")
        .select("id, status, due_date, completed_at, is_orchestration")
        .eq("is_orchestration", false)
        .in("status", ["open", "done"])
        .order("updated_at", { ascending: false })
        .limit(50);

      if (error) throw error;
      todos = data ?? [];
    } finally {
      clearTimeout(timer);
    }

    const now = new Date();
    const open = todos.filter((t) => t.status === "open");
    const overdue = open.filter((t) => t.due_date && new Date(t.due_date) <= now);
    const since = snapshot?.captured_at || new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const recentlyCompleted = todos.filter(
      (t) => t.status === "done" && t.completed_at && t.completed_at > since,
    );

    const openCount = open.length;
    const overdueIds = overdue.map((t) => t.id);
    const completedIds = recentlyCompleted.map((t) => t.id);

    const prevOpenCount = snapshot?.gtd_open_count ?? 0;
    const prevOverdueIds = new Set(snapshot?.gtd_overdue_ids ?? []);
    const prevCompletedIds = new Set(snapshot?.gtd_completed_ids ?? []);

    const newOverdue = overdueIds.filter((id) => !prevOverdueIds.has(id));
    const newCompleted = completedIds.filter((id) => !prevCompletedIds.has(id));
    const changed = newOverdue.length > 0 || newCompleted.length > 0 || openCount !== prevOpenCount;

    const parts: string[] = [];
    if (newCompleted.length > 0) parts.push(`${newCompleted.length} completed`);
    if (newOverdue.length > 0) parts.push(`${newOverdue.length} newly overdue`);
    if (openCount !== prevOpenCount) parts.push(`${openCount} open (was ${prevOpenCount})`);

    return {
      delta: {
        source: "gtd",
        changed,
        summary: parts.length > 0 ? parts.join(", ") : `${openCount} open tasks, ${overdue.length} overdue`,
        count: openCount,
        details: { open: openCount, overdue: overdue.length, recently_completed: newCompleted.length },
      },
      snapshotUpdate: {
        gtd_open_count: openCount,
        gtd_overdue_ids: overdueIds,
        gtd_completed_ids: completedIds,
      },
    };
  } catch (err) {
    return {
      delta: {
        source: "gtd",
        changed: false,
        summary: "Check failed",
        count: 0,
        error: (err as Error).message,
      },
      snapshotUpdate: {},
    };
  }
}
