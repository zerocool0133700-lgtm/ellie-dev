/**
 * UMS Consumer: Summary State Aggregator
 *
 * ELLIE-315: Aggregates state from all module consumers into a single
 * compact summary for the Summary Bar in Ellie Chat.
 *
 * Pattern: pull-based — called by the /api/summary endpoint and
 * periodically pushed to WebSocket clients.
 *
 * Cross-ref: Each consumer module provides in-memory state or DB queries.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getActiveThreads, getStaleThreads } from "./comms.ts";
import { getCalendarInsights, getCalendarAlerts } from "./calendar-intel.ts";
import { getActiveAlertCount, getCachedRules } from "./alert.ts";
import { log } from "../../logger.ts";

const logger = log.child("ums-consumer-summary");

// ── Types ────────────────────────────────────────────────────

export type ModuleStatus = "green" | "white" | "red";

export interface ModuleSummary {
  module: string;
  label: string;
  icon: string;
  status: ModuleStatus;
  text: string;
  path: string;         // navigation target
  has_new: boolean;
  count?: number;        // primary count metric
}

export interface SummaryState {
  timestamp: string;
  modules: ModuleSummary[];
  update_count: number;  // how many modules have new activity
  has_urgent: boolean;   // any red indicators
}

// ── Internal tracking ────────────────────────────────────────

/** Track last-seen counts to detect "new" activity. */
const lastSeen: Record<string, number> = {};

/** ELLIE-317: Alert state from consumer (avoids circular deps with lazy reads). */
const alertState = {
  get activeCount() { try { return getActiveAlertCount(); } catch { return 0; } },
  get ruleCount() { try { return getCachedRules().length; } catch { return 0; } },
};

// ── Main aggregator ──────────────────────────────────────────

/**
 * Build the full summary state for the Summary Bar.
 * Queries DB for GTD/Memory counts, reads in-memory state from Comms/Calendar.
 */
export async function getSummaryState(supabase: SupabaseClient): Promise<SummaryState> {
  const modules: ModuleSummary[] = [];

  // Run independent queries in parallel
  const [gtd, memory, briefing, comms, calendar] = await Promise.allSettled([
    getGtdSummary(supabase),
    getMemorySummary(supabase),
    getBriefingSummary(supabase),
    getCommsSummary(),
    getCalendarSummary(),
  ]);

  if (gtd.status === "fulfilled") modules.push(gtd.value);
  else modules.push(fallback("gtd", "GTD", "/gtd"));

  if (comms.status === "fulfilled") modules.push(comms.value);
  else modules.push(fallback("comms", "Comms", "/conversations"));

  if (calendar.status === "fulfilled") modules.push(calendar.value);
  else modules.push(fallback("calendar", "Calendar", "/"));

  if (memory.status === "fulfilled") modules.push(memory.value);
  else modules.push(fallback("memory", "Memory", "/forest"));

  if (briefing.status === "fulfilled") modules.push(briefing.value);
  else modules.push(fallback("briefing", "Briefing", "/"));

  // Static modules — Forest, Alerts, Relationship, Analytics
  modules.push(await getForestSummary());
  modules.push(getAlertSummary());
  modules.push(await getRelationshipSummary(supabase));
  modules.push(await getAnalyticsSummary(supabase));

  // Calculate aggregate stats
  const update_count = modules.filter(m => m.has_new).length;
  const has_urgent = modules.some(m => m.status === "red");

  // Update lastSeen tracking
  for (const m of modules) {
    if (m.count !== undefined) lastSeen[m.module] = m.count;
  }

  return { timestamp: new Date().toISOString(), modules, update_count, has_urgent };
}

// ── Per-module summaries ─────────────────────────────────────

async function getGtdSummary(supabase: SupabaseClient): Promise<ModuleSummary> {
  const { count: inboxCount } = await supabase
    .from("todos")
    .select("*", { count: "exact", head: true })
    .eq("status", "inbox");

  const { count: dueTodayCount } = await supabase
    .from("todos")
    .select("*", { count: "exact", head: true })
    .in("status", ["next", "waiting", "project"])
    .lte("due_date", new Date().toISOString().split("T")[0])
    .not("due_date", "is", null);

  const inbox = inboxCount ?? 0;
  const due = dueTodayCount ?? 0;
  const hasNew = inbox > (lastSeen["gtd"] ?? 0);

  const parts: string[] = [];
  if (due > 0) parts.push(`${due} due today`);
  parts.push(`${inbox} in inbox`);

  return {
    module: "gtd",
    label: "GTD",
    icon: "&#127919;", // 🎯
    status: due > 0 ? "green" : "white",
    text: parts.join(", "),
    path: "/gtd",
    has_new: hasNew,
    count: inbox,
  };
}

async function getMemorySummary(supabase: SupabaseClient): Promise<ModuleSummary> {
  const { count } = await supabase
    .from("memory")
    .select("*", { count: "exact", head: true })
    .eq("visibility", "internal");

  const total = count ?? 0;

  // Check latest entry timestamp
  const { data: latest } = await supabase
    .from("memory")
    .select("created_at")
    .eq("visibility", "internal")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  let recency = "";
  if (latest?.created_at) {
    const hoursAgo = Math.round((Date.now() - new Date(latest.created_at).getTime()) / (1000 * 60 * 60));
    recency = hoursAgo < 1 ? ", last write <1h ago" : `, last write ${hoursAgo}h ago`;
  }

  return {
    module: "memory",
    label: "Memory",
    icon: "&#128065;", // 👁
    status: "white",
    text: `${total} memories${recency}`,
    path: "/forest",
    has_new: false,
    count: total,
  };
}

async function getBriefingSummary(supabase: SupabaseClient): Promise<ModuleSummary> {
  // Count messages in last 24h
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("unified_messages")
    .select("*", { count: "exact", head: true })
    .gte("received_at", since);

  const total = count ?? 0;

  return {
    module: "briefing",
    label: "Briefing",
    icon: "&#128203;", // 📋
    status: "white",
    text: total > 0 ? `${total} messages in last 24h` : "No recent activity",
    path: "/",
    has_new: false,
    count: total,
  };
}

function getCommsSummary(): Promise<ModuleSummary> {
  const active = getActiveThreads();
  const stale = getStaleThreads();
  const awaiting = active.filter(t => t.awaiting_reply);

  const parts: string[] = [];
  if (stale.length > 0) parts.push(`${stale.length} stale`);
  if (awaiting.length > 0) parts.push(`${awaiting.length} need replies`);
  if (parts.length === 0) parts.push("All caught up");

  const hasNew = active.length > (lastSeen["comms"] ?? 0);

  return Promise.resolve({
    module: "comms",
    label: "Comms",
    icon: "&#128172;", // 💬
    status: stale.length > 0 ? "green" : "white",
    text: parts.join(", "),
    path: "/conversations",
    has_new: hasNew,
    count: active.length,
  });
}

function getCalendarSummary(): Promise<ModuleSummary> {
  const insights = getCalendarInsights();
  const alerts = getCalendarAlerts();

  let text = "No calendar signals";
  if (insights.length > 0) {
    const prepCount = insights.filter(i => i.type === "prep_needed").length;
    const conflictCount = insights.filter(i => i.type === "conflict").length;
    const parts: string[] = [];
    if (conflictCount > 0) parts.push(`${conflictCount} conflicts`);
    if (prepCount > 0) parts.push(`${prepCount} need prep`);
    if (parts.length === 0) parts.push(`${insights.length} insights`);
    text = parts.join(", ");
  }

  return Promise.resolve({
    module: "calendar",
    label: "Calendar",
    icon: "&#128197;", // 📅
    status: alerts.length > 0 ? "red" : insights.length > 0 ? "green" : "white",
    text,
    path: "/",
    has_new: insights.length > 0,
    count: insights.length,
  });
}

async function getForestSummary(): Promise<ModuleSummary> {
  // Try to get recent findings count from Bridge
  try {
    const resp = await fetch("http://localhost:3001/api/bridge/read", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-key": "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a",
      },
      body: JSON.stringify({ query: "recent", scope_path: "2", limit: 1 }),
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      const data = await resp.json();
      const count = data.total ?? data.results?.length ?? 0;
      return {
        module: "forest",
        label: "Forest",
        icon: "&#127794;", // 🌲
        status: "white",
        text: `${count} findings`,
        path: "/forest",
        has_new: false,
        count,
      };
    }
  } catch {
    // Forest unavailable — show degraded
  }
  return fallback("forest", "Forest", "/forest");
}

function getAlertSummary(): ModuleSummary {
  // ELLIE-317: Live alert data from consumer
  try {
    const active = alertState.activeCount;
    const ruleCount = alertState.ruleCount;

    const parts: string[] = [];
    if (active > 0) parts.push(`${active} unacked`);
    parts.push(`${ruleCount} rules active`);

    const hasNew = active > (lastSeen["alerts"] ?? 0);

    return {
      module: "alerts",
      label: "Alerts",
      icon: "&#128680;", // 🚨
      status: active > 0 ? "red" : "white",
      text: parts.join(", "),
      path: "/incidents",
      has_new: hasNew,
      count: active,
    };
  } catch {
    return fallback("alerts", "Alerts", "/incidents");
  }
}

async function getRelationshipSummary(supabase: SupabaseClient): Promise<ModuleSummary> {
  // Count distinct senders in last 30 days
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const { data } = await supabase
      .from("unified_messages")
      .select("sender")
      .gte("received_at", since)
      .not("sender", "is", null)
      .limit(500);

    const unique = new Set((data || []).map(d => JSON.stringify(d.sender))).size;
    return {
      module: "relationship",
      label: "Relationships",
      icon: "&#128101;", // 👥
      status: "white",
      text: `${unique} contacts (30d)`,
      path: "/entities",
      has_new: false,
      count: unique,
    };
  } catch {
    return fallback("relationship", "Relationships", "/entities");
  }
}

async function getAnalyticsSummary(supabase: SupabaseClient): Promise<ModuleSummary> {
  // Count messages in last 7 days for daily average
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const { count } = await supabase
      .from("unified_messages")
      .select("*", { count: "exact", head: true })
      .gte("received_at", since);

    const total = count ?? 0;
    const daily = Math.round(total / 7);
    return {
      module: "analytics",
      label: "Analytics",
      icon: "&#128200;", // 📈
      status: "white",
      text: `~${daily} msgs/day (7d avg)`,
      path: "/analytics",
      has_new: false,
      count: daily,
    };
  } catch {
    return fallback("analytics", "Analytics", "/analytics");
  }
}

// ── Helpers ──────────────────────────────────────────────────

function fallback(module: string, label: string, path: string): ModuleSummary {
  return {
    module,
    label,
    icon: "&#9473;", // —
    status: "white",
    text: "—",
    path,
    has_new: false,
  };
}
