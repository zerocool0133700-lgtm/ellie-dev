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
import { getCalendarInsights, getCalendarAlerts, getUpcomingIntel, getEventsNeedingPrep, getConflictingEvents } from "./calendar-intel.ts";
import { getActiveAlertCount, getCachedRules } from "./alert.ts";
import { getProfileCount, getFollowUpProfiles, getHealthBreakdown as getRelHealthBreakdown } from "./relationship.ts";
import { getFactCount, getGoalCount, getConflictCount, getOverdueGoalCount, getMemoryHealth } from "./memory.ts";
import { getTodayMinutes, getTodayFocusMin, getTodayMeetingMin, getTodayMessages } from "./analytics.ts";
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

async function getMemorySummary(_supabase: SupabaseClient): Promise<ModuleSummary> {
  try {
    const facts = getFactCount();
    const goals = getGoalCount();
    const conflicts = getConflictCount();
    const overdue = getOverdueGoalCount();
    const health = getMemoryHealth();

    const parts: string[] = [];
    parts.push(`${facts} facts`);
    if (goals > 0) parts.push(`${goals} goals`);
    if (conflicts > 0) parts.push(`${conflicts} conflicts`);
    if (overdue > 0) parts.push(`${overdue} overdue`);
    if (health.staleFacts > 5) parts.push(`${health.staleFacts} stale`);

    const hasNew = conflicts > (lastSeen["memory"] ?? 0);

    // Red: contradictions or many overdue goals
    // Green: conflicts to review, stale facts, or health issues
    const status = conflicts > 3 || overdue > 3 ? "red"
      : conflicts > 0 || overdue > 0 || health.staleFacts > 10 ? "green"
      : "white";

    return {
      module: "memory",
      label: "Memory",
      icon: "&#128065;", // 👁
      status,
      text: parts.join(" | "),
      path: "/forest",
      has_new: hasNew,
      count: facts + goals,
    };
  } catch {
    return fallback("memory", "Memory", "/forest");
  }
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
  const alerts = getCalendarAlerts();
  const upcoming = getUpcomingIntel();
  const conflicts = getConflictingEvents();
  const needPrep = getEventsNeedingPrep();

  const parts: string[] = [];
  if (conflicts.length > 0) parts.push(`${conflicts.length} conflicts`);
  if (needPrep.length > 0) parts.push(`${needPrep.length} need prep`);
  if (upcoming.length > 0) parts.push(`${upcoming.length} upcoming`);
  const text = parts.length > 0 ? parts.join(", ") : "No upcoming events";

  const status = conflicts.length > 0 || alerts.length > 0 ? "red"
    : needPrep.length > 0 ? "green"
    : "white";

  return Promise.resolve({
    module: "calendar",
    label: "Calendar",
    icon: "&#128197;", // 📅
    status,
    text,
    path: "/",
    has_new: conflicts.length > 0 || needPrep.length > 0,
    count: upcoming.length,
  });
}

async function getForestSummary(): Promise<ModuleSummary> {
  try {
    const { getMemoryCount, listUnresolvedContradictions, sql } = await import("../../../ellie-forest/src/index");

    const [total, recentResult, contradictions] = await Promise.all([
      getMemoryCount(),
      sql`SELECT COUNT(*)::int AS count FROM shared_memories
          WHERE status = 'active' AND created_at >= NOW() - INTERVAL '24 hours'`,
      listUnresolvedContradictions().catch(() => []),
    ]);

    const recent = recentResult[0]?.count ?? 0;
    const contradictionCount = contradictions.length;

    const parts: string[] = [];
    if (recent > 0) parts.push(`${recent} new (24h)`);
    if (contradictionCount > 0) parts.push(`${contradictionCount} contradictions`);
    parts.push(`${total} total`);

    const hasNew = recent > (lastSeen["forest"] ?? 0);

    return {
      module: "forest",
      label: "Forest",
      icon: "&#127794;", // 🌲
      status: contradictionCount > 0 ? "green" : "white",
      text: parts.join(", "),
      path: "/forest",
      has_new: hasNew,
      count: total,
    };
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

async function getRelationshipSummary(_supabase: SupabaseClient): Promise<ModuleSummary> {
  try {
    const total = getProfileCount();
    const followUps = getFollowUpProfiles();
    const breakdown = getRelHealthBreakdown();
    const atRisk = breakdown["at_risk"] || 0;
    const declining = breakdown["declining"] || 0;

    const parts: string[] = [];
    if (followUps.length > 0) parts.push(`${followUps.length} need follow-up`);
    if (atRisk > 0) parts.push(`${atRisk} at risk`);
    if (declining > 0) parts.push(`${declining} declining`);
    if (parts.length === 0) parts.push(`${total} contacts tracked`);

    const hasNew = followUps.length > (lastSeen["relationship"] ?? 0);
    const status = followUps.length > 0 || atRisk > 0 ? "green" : "white";

    return {
      module: "relationship",
      label: "Relationships",
      icon: "&#128101;", // 👥
      status,
      text: parts.join(", "),
      path: "/entities",
      has_new: hasNew,
      count: total,
    };
  } catch {
    return fallback("relationship", "Relationships", "/entities");
  }
}

async function getAnalyticsSummary(_supabase: SupabaseClient): Promise<ModuleSummary> {
  try {
    const totalMin = getTodayMinutes();
    const focusMin = getTodayFocusMin();
    const meetingMin = getTodayMeetingMin();
    const messages = getTodayMessages();

    const hours = (min: number) => (min / 60).toFixed(1);

    const parts: string[] = [];
    parts.push(`${hours(totalMin)}h today`);
    if (focusMin > 0) parts.push(`${hours(focusMin)}h focus`);
    if (meetingMin > 0) parts.push(`${hours(meetingMin)}h meetings`);

    // Warnings
    let status: ModuleStatus = "white";
    if (totalMin > 0 && meetingMin / totalMin > 0.6) status = "red";
    else if (totalMin > 60 && focusMin === 0) status = "green";

    const hasNew = messages > (lastSeen["analytics"] ?? 0);

    return {
      module: "analytics",
      label: "Analytics",
      icon: "&#128200;", // 📈
      status,
      text: parts.join(" | "),
      path: "/analytics",
      has_new: hasNew,
      count: messages,
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
