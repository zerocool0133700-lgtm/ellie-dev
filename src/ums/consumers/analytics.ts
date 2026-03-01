/**
 * UMS Consumer: Analytics Module
 *
 * ELLIE-321: Activity patterns and time intelligence.
 *
 * Push subscriber: ingests every UMS message into activity_log with
 * auto-categorization (communication, meetings, deep_work, admin, personal).
 *
 * Pull functions:
 *   - generateAnalyticsReport: 7-day activity report (legacy)
 *   - getDailySummary: today/any-date summary with category breakdown
 *   - getTimeDistribution: category breakdown for a range
 *   - getPatterns: weekly patterns from 30-day window
 *   - getFocusBlocks: focus block analysis
 *   - rollupDay: nightly job to compute productivity_metrics
 *
 * In-memory cache: today's stats for summary bar.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UnifiedMessage } from "../types.ts";
import { subscribe, queryMessages } from "../events.ts";
import { log } from "../../logger.ts";

const logger = log.child("ums-consumer-analytics");

// ── Types ─────────────────────────────────────────────────────

type ActivityCategory = "communication" | "meetings" | "deep_work" | "admin" | "personal";

type ActivityType =
  | "message_sent" | "message_received" | "meeting" | "calendar_event"
  | "task_completed" | "task_created" | "focus_block" | "email_sent"
  | "email_received" | "code_session" | "admin" | "other";

export interface ChannelVolume {
  provider: string;
  count: number;
  percentage: number;
}

export interface HourlyDistribution {
  hour: number;
  count: number;
}

export interface ContentTypeBreakdown {
  content_type: string;
  count: number;
  percentage: number;
}

export interface ActivityReport {
  generated_at: string;
  period_start: string;
  period_end: string;
  total_messages: number;
  channel_volume: ChannelVolume[];
  hourly_distribution: HourlyDistribution[];
  content_types: ContentTypeBreakdown[];
  busiest_hour: number | null;
  busiest_provider: string | null;
  daily_average: number;
}

export interface DaySummary {
  date: string;
  total_minutes: number;
  categories: Record<ActivityCategory, number>;  // minutes per category
  message_count: number;
  meeting_count: number;
  focus_blocks: number;
  longest_focus_min: number;
  context_switches: number;
  first_activity: string | null;
  last_activity: string | null;
  work_hours: number;
}

export interface TimeDistribution {
  period_start: string;
  period_end: string;
  categories: Record<ActivityCategory, { minutes: number; percentage: number }>;
  total_minutes: number;
}

export interface WeeklyPattern {
  day_of_week: number;  // 0=Sun, 6=Sat
  day_name: string;
  avg_focus_min: number;
  avg_meeting_min: number;
  avg_communication_min: number;
  avg_total_min: number;
}

export interface FocusBlock {
  started_at: string;
  ended_at: string;
  duration_min: number;
  category: string;
}

// ── In-memory stats for summary bar ───────────────────────────

interface AnalyticsStats {
  todayMinutes: number;
  todayFocusMin: number;
  todayMeetingMin: number;
  todayMessages: number;
  todayContextSwitches: number;
  lastCategory: ActivityCategory | null;
  lastActivityAt: string | null;
}

const stats: AnalyticsStats = {
  todayMinutes: 0,
  todayFocusMin: 0,
  todayMeetingMin: 0,
  todayMessages: 0,
  todayContextSwitches: 0,
  lastCategory: null,
  lastActivityAt: null,
};

let supabaseRef: SupabaseClient | null = null;

// ── Public getters ────────────────────────────────────────────

export function getTodayMinutes(): number { return stats.todayMinutes; }
export function getTodayFocusMin(): number { return stats.todayFocusMin; }
export function getTodayMeetingMin(): number { return stats.todayMeetingMin; }
export function getTodayMessages(): number { return stats.todayMessages; }
export function getAnalyticsStats(): AnalyticsStats { return { ...stats }; }

// ── Estimated duration for message types ──────────────────────

const DURATION_ESTIMATES: Record<string, number> = {
  // content_type → estimated minutes
  text: 1,
  voice: 2,
  email: 3,
  document: 5,
  task: 2,
  event: 0, // duration comes from event itself
  image: 0.5,
  file: 1,
};

// ── Init ──────────────────────────────────────────────────────

export function initAnalyticsConsumer(supabase: SupabaseClient): void {
  supabaseRef = supabase;

  // Push subscriber: log every message as an activity
  subscribe("consumer:analytics", {}, async (message) => {
    try {
      await ingestActivity(supabase, message);
    } catch (err) {
      logger.error("Analytics consumer failed", { messageId: message.id, err });
    }
  });

  // Load today's stats
  refreshTodayStats(supabase).catch(() => {});

  // Daily rollup at midnight + stats refresh every 5 min
  setInterval(() => refreshTodayStats(supabase).catch(() => {}), 5 * 60 * 1000);

  // Nightly rollup — check every hour if yesterday needs rolling up
  setInterval(() => rollupYesterdayIfNeeded(supabase).catch(() => {}), 60 * 60 * 1000);

  logger.info("Analytics consumer initialized (ELLIE-321)");
}

// ── Activity ingestion ────────────────────────────────────────

async function ingestActivity(supabase: SupabaseClient, message: UnifiedMessage): Promise<void> {
  const category = categorizeMessage(message);
  const activityType = mapActivityType(message);
  const duration = estimateDuration(message);
  const ts = message.provider_timestamp || message.received_at;

  const { error } = await supabase.from("activity_log").insert({
    activity_type: activityType,
    category,
    started_at: ts,
    ended_at: duration > 0 ? new Date(new Date(ts).getTime() + duration * 60000).toISOString() : null,
    duration_minutes: duration,
    source: message.provider,
    source_id: message.provider_id || message.id,
    title: buildTitle(message),
    metadata: {
      content_type: message.content_type,
      channel: message.channel,
      sender: message.sender?.name || message.sender?.email,
    },
  });

  if (error && error.code !== "23505") {
    logger.error("Activity log insert failed", { error: error.message });
    return;
  }

  // Update in-memory stats
  const today = new Date().toISOString().split("T")[0];
  const activityDay = new Date(ts).toISOString().split("T")[0];
  if (activityDay === today) {
    stats.todayMinutes += duration;
    stats.todayMessages++;
    if (category === "deep_work") stats.todayFocusMin += duration;
    if (category === "meetings") stats.todayMeetingMin += duration;
    if (stats.lastCategory && stats.lastCategory !== category) {
      stats.todayContextSwitches++;
    }
    stats.lastCategory = category;
    stats.lastActivityAt = ts;
  }
}

// ── Categorization ────────────────────────────────────────────

function categorizeMessage(message: UnifiedMessage): ActivityCategory {
  const provider = message.provider;
  const contentType = message.content_type;
  const channel = message.channel?.toLowerCase() || "";

  // Calendar events → meetings
  if (provider === "calendar" || contentType === "event") return "meetings";

  // Email → communication (unless it's a task/notification)
  if (provider === "gmail" || provider === "imap" || provider === "outlook") {
    if (contentType === "task") return "admin";
    return "communication";
  }

  // Chat messages → communication
  if (provider === "telegram" || provider === "gchat") return "communication";

  // Voice → communication
  if (provider === "voice" || contentType === "voice") return "communication";

  // GitHub → deep_work
  if (provider === "github") return "deep_work";

  // Google Tasks → admin
  if (provider === "google-tasks") return "admin";

  // Documents → deep_work
  if (provider === "documents" || contentType === "document") return "deep_work";

  // GTD/task content
  if (contentType === "task") return "admin";

  return "communication";
}

function mapActivityType(message: UnifiedMessage): ActivityType {
  const provider = message.provider;
  const contentType = message.content_type;

  if (provider === "calendar" || contentType === "event") return "calendar_event";
  if (provider === "gmail" || provider === "imap" || provider === "outlook") {
    return message.sender?.is_self ? "email_sent" : "email_received";
  }
  if (provider === "github") return "code_session";
  if (provider === "google-tasks") return "task_created";
  if (contentType === "task") return "task_created";
  return message.sender?.is_self ? "message_sent" : "message_received";
}

function estimateDuration(message: UnifiedMessage): number {
  // Calendar events have actual duration
  if (message.content_type === "event" && message.metadata) {
    const meta = message.metadata as Record<string, unknown>;
    if (meta.duration_minutes) return Number(meta.duration_minutes);
    if (meta.start && meta.end) {
      const start = new Date(meta.start as string).getTime();
      const end = new Date(meta.end as string).getTime();
      if (end > start) return (end - start) / 60000;
    }
  }

  return DURATION_ESTIMATES[message.content_type] || 1;
}

function buildTitle(message: UnifiedMessage): string {
  const parts: string[] = [];
  if (message.sender?.name) parts.push(message.sender.name);
  if (message.channel) parts.push(`#${message.channel}`);
  if (message.content) parts.push(message.content.slice(0, 60));
  return parts.join(" — ") || message.content_type;
}

// ── Today's stats refresh ─────────────────────────────────────

async function refreshTodayStats(supabase: SupabaseClient): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const [totalResult, categoryResult, countResult] = await Promise.allSettled([
    supabase.from("activity_log")
      .select("duration_minutes")
      .gte("started_at", today)
      .lt("started_at", tomorrow),

    supabase.from("activity_log")
      .select("category, duration_minutes")
      .gte("started_at", today)
      .lt("started_at", tomorrow),

    supabase.from("activity_log")
      .select("*", { count: "exact", head: true })
      .gte("started_at", today)
      .lt("started_at", tomorrow),
  ]);

  if (totalResult.status === "fulfilled" && totalResult.value.data) {
    stats.todayMinutes = totalResult.value.data.reduce(
      (sum, r) => sum + (r.duration_minutes || 0), 0,
    );
  }

  if (categoryResult.status === "fulfilled" && categoryResult.value.data) {
    let focusMin = 0;
    let meetingMin = 0;
    for (const row of categoryResult.value.data) {
      if (row.category === "deep_work") focusMin += row.duration_minutes || 0;
      if (row.category === "meetings") meetingMin += row.duration_minutes || 0;
    }
    stats.todayFocusMin = focusMin;
    stats.todayMeetingMin = meetingMin;
  }

  if (countResult.status === "fulfilled") {
    stats.todayMessages = countResult.value.count ?? 0;
  }
}

// ── Daily rollup ──────────────────────────────────────────────

async function rollupYesterdayIfNeeded(supabase: SupabaseClient): Promise<void> {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const dateStr = yesterday.toISOString().split("T")[0];

  // Check if already rolled up
  const { data: existing } = await supabase
    .from("productivity_metrics")
    .select("id")
    .eq("metric_date", dateStr)
    .single();

  if (existing) return;

  await rollupDay(supabase, dateStr);
}

/**
 * Compute daily productivity metrics from activity_log.
 * Rolls up a single day into the productivity_metrics table.
 */
export async function rollupDay(supabase: SupabaseClient, dateStr: string): Promise<void> {
  const nextDay = new Date(new Date(dateStr).getTime() + 24 * 60 * 60 * 1000)
    .toISOString().split("T")[0];

  const { data: activities, error } = await supabase
    .from("activity_log")
    .select("*")
    .gte("started_at", dateStr)
    .lt("started_at", nextDay)
    .order("started_at", { ascending: true });

  if (error || !activities || activities.length === 0) return;

  // Aggregate by category
  const catMinutes: Record<ActivityCategory, number> = {
    communication: 0, meetings: 0, deep_work: 0, admin: 0, personal: 0,
  };
  let messageCount = 0;
  let meetingCount = 0;
  let taskCount = 0;
  let emailCount = 0;

  for (const a of activities) {
    catMinutes[a.category as ActivityCategory] += a.duration_minutes || 0;
    if (a.activity_type === "message_sent" || a.activity_type === "message_received") messageCount++;
    if (a.activity_type === "meeting" || a.activity_type === "calendar_event") meetingCount++;
    if (a.activity_type === "task_completed") taskCount++;
    if (a.activity_type === "email_sent" || a.activity_type === "email_received") emailCount++;
  }

  const totalMin = Object.values(catMinutes).reduce((s, v) => s + v, 0);

  // Focus block detection: consecutive deep_work activities within 5min gaps
  const focusBlocks = detectFocusBlocks(activities);
  const longestFocus = focusBlocks.reduce((max, b) => Math.max(max, b.duration_min), 0);

  // Context switches: count category changes
  let contextSwitches = 0;
  let lastCat: string | null = null;
  for (const a of activities) {
    if (lastCat && a.category !== lastCat) contextSwitches++;
    lastCat = a.category;
  }

  // Work hours
  const firstActivity = activities[0]?.started_at || null;
  const lastActivity = activities[activities.length - 1]?.started_at || null;
  let workHours = 0;
  if (firstActivity && lastActivity) {
    workHours = (new Date(lastActivity).getTime() - new Date(firstActivity).getTime()) / (1000 * 60 * 60);
  }

  // Focus score: ratio of deep_work to total, weighted by block quality
  const focusScore = totalMin > 0
    ? Math.min(1, (catMinutes.deep_work / totalMin) * (longestFocus > 60 ? 1.2 : 1))
    : 0;

  // Balance score: penalize >9h work days and >50% meetings
  let balanceScore = 1;
  if (workHours > 9) balanceScore -= 0.3;
  if (totalMin > 0 && catMinutes.meetings / totalMin > 0.5) balanceScore -= 0.3;
  if (catMinutes.deep_work < 60) balanceScore -= 0.2;
  balanceScore = Math.max(0, Math.min(1, balanceScore));

  const { error: insertErr } = await supabase.from("productivity_metrics").upsert({
    metric_date: dateStr,
    communication_min: catMinutes.communication,
    meetings_min: catMinutes.meetings,
    deep_work_min: catMinutes.deep_work,
    admin_min: catMinutes.admin,
    personal_min: catMinutes.personal,
    total_min: totalMin,
    message_count: messageCount,
    meeting_count: meetingCount,
    task_completed_count: taskCount,
    email_count: emailCount,
    focus_blocks: focusBlocks.length,
    longest_focus_min: longestFocus,
    context_switches: contextSwitches,
    first_activity_at: firstActivity,
    last_activity_at: lastActivity,
    work_hours: Math.round(workHours * 10) / 10,
    focus_score: Math.round(focusScore * 100) / 100,
    balance_score: Math.round(balanceScore * 100) / 100,
  }, { onConflict: "metric_date" });

  if (insertErr) {
    logger.error("Daily rollup insert failed", { date: dateStr, error: insertErr.message });
    return;
  }

  logger.info("Daily rollup complete", {
    date: dateStr,
    totalMin,
    focus: catMinutes.deep_work,
    meetings: catMinutes.meetings,
    focusBlocks: focusBlocks.length,
    balanceScore,
  });
}

// ── Focus block detection ─────────────────────────────────────

function detectFocusBlocks(
  activities: Array<{ started_at: string; ended_at?: string; duration_minutes?: number; category: string }>,
): FocusBlock[] {
  const blocks: FocusBlock[] = [];
  let blockStart: string | null = null;
  let blockEnd: string | null = null;
  let blockDuration = 0;

  for (const a of activities) {
    if (a.category === "deep_work") {
      if (!blockStart) {
        blockStart = a.started_at;
      }
      blockEnd = a.ended_at || a.started_at;
      blockDuration += a.duration_minutes || 0;
    } else {
      // Non-deep-work activity breaks the block
      if (blockStart && blockDuration >= 30) {
        blocks.push({
          started_at: blockStart,
          ended_at: blockEnd!,
          duration_min: blockDuration,
          category: "deep_work",
        });
      }
      blockStart = null;
      blockEnd = null;
      blockDuration = 0;
    }
  }

  // Final block
  if (blockStart && blockDuration >= 30) {
    blocks.push({
      started_at: blockStart,
      ended_at: blockEnd!,
      duration_min: blockDuration,
      category: "deep_work",
    });
  }

  return blocks;
}

// ── Legacy report (backward compat) ───────────────────────────

export async function generateAnalyticsReport(
  supabase: SupabaseClient,
  daysBack = 7,
): Promise<ActivityReport> {
  const now = new Date();
  const since = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);

  const messages = await queryMessages(supabase, {
    since: since.toISOString(),
    before: now.toISOString(),
    limit: 500,
  });

  const total = messages.length;
  const channelVolume = computeChannelVolume(messages, total);
  const hourlyDistribution = computeHourlyDistribution(messages);
  const contentTypes = computeContentTypes(messages, total);

  const busiestHourEntry = hourlyDistribution.reduce(
    (max, entry) => entry.count > max.count ? entry : max,
    { hour: -1, count: 0 },
  );

  const busiestChannel = channelVolume[0] || null;

  return {
    generated_at: now.toISOString(),
    period_start: since.toISOString(),
    period_end: now.toISOString(),
    total_messages: total,
    channel_volume: channelVolume,
    hourly_distribution: hourlyDistribution,
    content_types: contentTypes,
    busiest_hour: busiestHourEntry.hour >= 0 ? busiestHourEntry.hour : null,
    busiest_provider: busiestChannel?.provider || null,
    daily_average: daysBack > 0 ? Math.round((total / daysBack) * 10) / 10 : 0,
  };
}

function computeChannelVolume(messages: UnifiedMessage[], total: number): ChannelVolume[] {
  const counts = new Map<string, number>();
  for (const msg of messages) counts.set(msg.provider, (counts.get(msg.provider) || 0) + 1);
  return [...counts.entries()]
    .map(([provider, count]) => ({
      provider, count,
      percentage: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.count - a.count);
}

function computeHourlyDistribution(messages: UnifiedMessage[]): HourlyDistribution[] {
  const hours = new Array(24).fill(0);
  for (const msg of messages) {
    const ts = msg.provider_timestamp || msg.received_at;
    hours[new Date(ts).getHours()]++;
  }
  return hours.map((count, hour) => ({ hour, count }));
}

function computeContentTypes(messages: UnifiedMessage[], total: number): ContentTypeBreakdown[] {
  const counts = new Map<string, number>();
  for (const msg of messages) counts.set(msg.content_type, (counts.get(msg.content_type) || 0) + 1);
  return [...counts.entries()]
    .map(([content_type, count]) => ({
      content_type, count,
      percentage: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.count - a.count);
}

// ── Pull functions for API ────────────────────────────────────

/**
 * Get summary for a specific date with category breakdown.
 */
export async function getDailySummary(supabase: SupabaseClient, dateStr?: string): Promise<DaySummary> {
  const date = dateStr || new Date().toISOString().split("T")[0];

  // Try metrics table first (for past days)
  const { data: metrics } = await supabase
    .from("productivity_metrics")
    .select("*")
    .eq("metric_date", date)
    .single();

  if (metrics) {
    return {
      date,
      total_minutes: metrics.total_min,
      categories: {
        communication: metrics.communication_min,
        meetings: metrics.meetings_min,
        deep_work: metrics.deep_work_min,
        admin: metrics.admin_min,
        personal: metrics.personal_min,
      },
      message_count: metrics.message_count,
      meeting_count: metrics.meeting_count,
      focus_blocks: metrics.focus_blocks,
      longest_focus_min: metrics.longest_focus_min,
      context_switches: metrics.context_switches,
      first_activity: metrics.first_activity_at,
      last_activity: metrics.last_activity_at,
      work_hours: metrics.work_hours,
    };
  }

  // Live computation for today
  const nextDay = new Date(new Date(date).getTime() + 24 * 60 * 60 * 1000)
    .toISOString().split("T")[0];

  const { data: activities } = await supabase
    .from("activity_log")
    .select("category, duration_minutes, activity_type, started_at, ended_at")
    .gte("started_at", date)
    .lt("started_at", nextDay)
    .order("started_at", { ascending: true });

  if (!activities || activities.length === 0) {
    return {
      date, total_minutes: 0,
      categories: { communication: 0, meetings: 0, deep_work: 0, admin: 0, personal: 0 },
      message_count: 0, meeting_count: 0, focus_blocks: 0,
      longest_focus_min: 0, context_switches: 0,
      first_activity: null, last_activity: null, work_hours: 0,
    };
  }

  const cats: Record<ActivityCategory, number> = {
    communication: 0, meetings: 0, deep_work: 0, admin: 0, personal: 0,
  };
  let msgCount = 0, mtgCount = 0, switches = 0;
  let lastCat: string | null = null;

  for (const a of activities) {
    cats[a.category as ActivityCategory] += a.duration_minutes || 0;
    if (a.activity_type?.includes("message")) msgCount++;
    if (a.activity_type?.includes("meeting") || a.activity_type?.includes("calendar")) mtgCount++;
    if (lastCat && a.category !== lastCat) switches++;
    lastCat = a.category;
  }

  const focusBlocks = detectFocusBlocks(activities);
  const totalMin = Object.values(cats).reduce((s, v) => s + v, 0);
  const first = activities[0]?.started_at;
  const last = activities[activities.length - 1]?.started_at;
  const workHours = first && last
    ? (new Date(last).getTime() - new Date(first).getTime()) / (1000 * 60 * 60) : 0;

  return {
    date, total_minutes: totalMin, categories: cats,
    message_count: msgCount, meeting_count: mtgCount,
    focus_blocks: focusBlocks.length,
    longest_focus_min: focusBlocks.reduce((max, b) => Math.max(max, b.duration_min), 0),
    context_switches: switches,
    first_activity: first || null, last_activity: last || null,
    work_hours: Math.round(workHours * 10) / 10,
  };
}

/**
 * Get time distribution by category for a date range.
 */
export async function getTimeDistribution(
  supabase: SupabaseClient, days = 7,
): Promise<TimeDistribution> {
  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const sinceStr = since.toISOString().split("T")[0];

  const { data: metrics } = await supabase
    .from("productivity_metrics")
    .select("communication_min, meetings_min, deep_work_min, admin_min, personal_min")
    .gte("metric_date", sinceStr);

  const cats: Record<ActivityCategory, number> = {
    communication: 0, meetings: 0, deep_work: 0, admin: 0, personal: 0,
  };

  for (const m of metrics || []) {
    cats.communication += m.communication_min || 0;
    cats.meetings += m.meetings_min || 0;
    cats.deep_work += m.deep_work_min || 0;
    cats.admin += m.admin_min || 0;
    cats.personal += m.personal_min || 0;
  }

  const totalMin = Object.values(cats).reduce((s, v) => s + v, 0);

  const result: Record<ActivityCategory, { minutes: number; percentage: number }> = {} as never;
  for (const [cat, min] of Object.entries(cats)) {
    result[cat as ActivityCategory] = {
      minutes: Math.round(min),
      percentage: totalMin > 0 ? Math.round((min / totalMin) * 1000) / 10 : 0,
    };
  }

  return {
    period_start: since.toISOString(),
    period_end: now.toISOString(),
    categories: result,
    total_minutes: Math.round(totalMin),
  };
}

/**
 * Get weekly patterns from 30-day window of productivity_metrics.
 */
export async function getPatterns(supabase: SupabaseClient): Promise<WeeklyPattern[]> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const { data: metrics } = await supabase
    .from("productivity_metrics")
    .select("metric_date, deep_work_min, meetings_min, communication_min, total_min")
    .gte("metric_date", since);

  if (!metrics || metrics.length === 0) return [];

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const byDay: Record<number, { focus: number[]; meetings: number[]; comm: number[]; total: number[] }> = {};

  for (let d = 0; d < 7; d++) {
    byDay[d] = { focus: [], meetings: [], comm: [], total: [] };
  }

  for (const m of metrics) {
    const dow = new Date(m.metric_date).getDay();
    byDay[dow].focus.push(m.deep_work_min || 0);
    byDay[dow].meetings.push(m.meetings_min || 0);
    byDay[dow].comm.push(m.communication_min || 0);
    byDay[dow].total.push(m.total_min || 0);
  }

  const avg = (arr: number[]) => arr.length > 0 ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : 0;

  return Object.entries(byDay).map(([d, data]) => ({
    day_of_week: Number(d),
    day_name: dayNames[Number(d)],
    avg_focus_min: avg(data.focus),
    avg_meeting_min: avg(data.meetings),
    avg_communication_min: avg(data.comm),
    avg_total_min: avg(data.total),
  }));
}

/**
 * Get focus blocks for a date range.
 */
export async function getFocusBlocks(
  supabase: SupabaseClient, dateStr?: string,
): Promise<FocusBlock[]> {
  const date = dateStr || new Date().toISOString().split("T")[0];
  const nextDay = new Date(new Date(date).getTime() + 24 * 60 * 60 * 1000)
    .toISOString().split("T")[0];

  const { data: activities } = await supabase
    .from("activity_log")
    .select("started_at, ended_at, duration_minutes, category")
    .gte("started_at", date)
    .lt("started_at", nextDay)
    .order("started_at", { ascending: true });

  if (!activities) return [];
  return detectFocusBlocks(activities);
}

// ── Phase 2: Intelligence Layer ──────────────────────────────

// ── Types ────────────────────────────────────────────────────

export interface TrendPoint {
  date: string;
  value: number;
}

export interface TrendAnalysis {
  metric: string;
  points: TrendPoint[];
  slope: number;          // positive = increasing
  direction: "up" | "down" | "flat";
  change_pct: number;     // % change over period
  avg: number;
}

export interface AnomalyDay {
  date: string;
  type: "long_day" | "short_day" | "weekend_work" | "no_focus" | "meeting_heavy" | "high_switches";
  severity: "info" | "warning";
  detail: string;
  value: number;
  avg: number;
}

export interface HourlyEnergy {
  hour: number;
  avg_activities: number;
  avg_focus_min: number;
  primary_category: ActivityCategory;
  quality_score: number;  // 0-1: ratio of deep_work in that hour
}

export interface BurnoutSignals {
  risk_level: "low" | "moderate" | "high";
  score: number;          // 0-1
  signals: string[];
  trend_direction: "improving" | "stable" | "worsening";
}

// ── Trend analysis (linear regression over rolling window) ──

function linearRegression(points: number[]): { slope: number; intercept: number } {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: points[0] ?? 0 };

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += points[i];
    sumXY += i * points[i];
    sumX2 += i * i;
  }

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

/**
 * Compute trends for key metrics over a rolling window.
 */
export async function getTrends(
  supabase: SupabaseClient, days = 14,
): Promise<TrendAnalysis[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const { data: metrics } = await supabase
    .from("productivity_metrics")
    .select("metric_date, deep_work_min, meetings_min, communication_min, total_min, focus_blocks, context_switches, focus_score, balance_score, work_hours")
    .gte("metric_date", since)
    .order("metric_date", { ascending: true });

  if (!metrics || metrics.length < 3) return [];

  const buildTrend = (name: string, extract: (m: Record<string, number>) => number): TrendAnalysis => {
    const points = metrics.map(m => ({ date: m.metric_date, value: extract(m as Record<string, number>) }));
    const values = points.map(p => p.value);
    const { slope } = linearRegression(values);
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    const first = values[0] || 0;
    const last = values[values.length - 1] || 0;
    const changePct = first > 0 ? Math.round(((last - first) / first) * 100) : 0;

    return {
      metric: name,
      points,
      slope: Math.round(slope * 100) / 100,
      direction: Math.abs(slope) < 0.5 ? "flat" : slope > 0 ? "up" : "down",
      change_pct: changePct,
      avg: Math.round(avg),
    };
  };

  return [
    buildTrend("deep_work", m => m.deep_work_min || 0),
    buildTrend("meetings", m => m.meetings_min || 0),
    buildTrend("communication", m => m.communication_min || 0),
    buildTrend("total_active", m => m.total_min || 0),
    buildTrend("focus_blocks", m => m.focus_blocks || 0),
    buildTrend("context_switches", m => m.context_switches || 0),
    buildTrend("focus_score", m => (m.focus_score || 0) * 100),
    buildTrend("balance_score", m => (m.balance_score || 0) * 100),
    buildTrend("work_hours", m => m.work_hours || 0),
  ];
}

// ── Anomaly detection ────────────────────────────────────────

/**
 * Detect outlier days from productivity_metrics.
 */
export async function detectAnomalies(
  supabase: SupabaseClient, days = 30,
): Promise<AnomalyDay[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const { data: metrics } = await supabase
    .from("productivity_metrics")
    .select("*")
    .gte("metric_date", since)
    .order("metric_date", { ascending: true });

  if (!metrics || metrics.length < 5) return [];

  const anomalies: AnomalyDay[] = [];

  // Compute averages
  const avgWorkHours = metrics.reduce((s, m) => s + (m.work_hours || 0), 0) / metrics.length;
  const avgMeetingPct = metrics.reduce((s, m) => {
    const total = m.total_min || 1;
    return s + (m.meetings_min || 0) / total;
  }, 0) / metrics.length;
  const avgSwitches = metrics.reduce((s, m) => s + (m.context_switches || 0), 0) / metrics.length;
  const avgFocus = metrics.reduce((s, m) => s + (m.deep_work_min || 0), 0) / metrics.length;

  for (const m of metrics) {
    const date = m.metric_date;
    const dow = new Date(date).getDay();

    // Long day (>1.5x average)
    if (m.work_hours > avgWorkHours * 1.5 && m.work_hours > 9) {
      anomalies.push({
        date, type: "long_day", severity: "warning",
        detail: `${m.work_hours.toFixed(1)}h work span (avg ${avgWorkHours.toFixed(1)}h)`,
        value: m.work_hours, avg: avgWorkHours,
      });
    }

    // Weekend work
    if ((dow === 0 || dow === 6) && m.total_min > 30) {
      anomalies.push({
        date, type: "weekend_work", severity: "info",
        detail: `${Math.round(m.total_min)} min tracked on ${dow === 0 ? "Sunday" : "Saturday"}`,
        value: m.total_min, avg: 0,
      });
    }

    // No focus time on workdays
    if (dow >= 1 && dow <= 5 && m.deep_work_min < 15 && m.total_min > 60) {
      anomalies.push({
        date, type: "no_focus", severity: "warning",
        detail: `Only ${Math.round(m.deep_work_min)} min deep work (avg ${Math.round(avgFocus)} min)`,
        value: m.deep_work_min, avg: avgFocus,
      });
    }

    // Meeting heavy (>60% of tracked time)
    const meetingPct = m.total_min > 0 ? m.meetings_min / m.total_min : 0;
    if (meetingPct > 0.6 && m.total_min > 60) {
      anomalies.push({
        date, type: "meeting_heavy", severity: "warning",
        detail: `${Math.round(meetingPct * 100)}% meetings (avg ${Math.round(avgMeetingPct * 100)}%)`,
        value: meetingPct, avg: avgMeetingPct,
      });
    }

    // High context switches (>2x average)
    if (m.context_switches > avgSwitches * 2 && m.context_switches > 10) {
      anomalies.push({
        date, type: "high_switches", severity: "info",
        detail: `${m.context_switches} switches (avg ${Math.round(avgSwitches)})`,
        value: m.context_switches, avg: avgSwitches,
      });
    }
  }

  return anomalies.sort((a, b) => b.date.localeCompare(a.date));
}

// ── Hourly energy curve ──────────────────────────────────────

/**
 * Compute hourly productivity patterns from activity_log.
 * Shows which hours tend to have the most deep work vs. meetings vs. communication.
 */
export async function getEnergyCurve(
  supabase: SupabaseClient, days = 14,
): Promise<HourlyEnergy[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data: activities } = await supabase
    .from("activity_log")
    .select("started_at, category, duration_minutes")
    .gte("started_at", since);

  if (!activities || activities.length === 0) return [];

  const hourData: Record<number, { count: number; focusMin: number; totalMin: number; cats: Record<string, number> }> = {};
  for (let h = 0; h < 24; h++) {
    hourData[h] = { count: 0, focusMin: 0, totalMin: 0, cats: {} };
  }

  for (const a of activities) {
    const hour = new Date(a.started_at).getHours();
    const d = hourData[hour];
    d.count++;
    d.totalMin += a.duration_minutes || 0;
    if (a.category === "deep_work") d.focusMin += a.duration_minutes || 0;
    d.cats[a.category] = (d.cats[a.category] || 0) + 1;
  }

  const daysInRange = Math.max(1, days);

  return Object.entries(hourData).map(([h, d]) => {
    const hour = Number(h);
    const topCat = Object.entries(d.cats).sort((a, b) => b[1] - a[1])[0];
    return {
      hour,
      avg_activities: Math.round((d.count / daysInRange) * 10) / 10,
      avg_focus_min: Math.round((d.focusMin / daysInRange) * 10) / 10,
      primary_category: (topCat?.[0] || "communication") as ActivityCategory,
      quality_score: d.totalMin > 0 ? Math.round((d.focusMin / d.totalMin) * 100) / 100 : 0,
    };
  });
}

// ── Burnout risk assessment ──────────────────────────────────

/**
 * Composite burnout risk signal from recent trends.
 */
export async function assessBurnoutRisk(
  supabase: SupabaseClient,
): Promise<BurnoutSignals> {
  const signals: string[] = [];
  let score = 0;

  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const { data: metrics } = await supabase
    .from("productivity_metrics")
    .select("*")
    .gte("metric_date", since)
    .order("metric_date", { ascending: true });

  if (!metrics || metrics.length < 3) {
    return { risk_level: "low", score: 0, signals: ["Insufficient data"], trend_direction: "stable" };
  }

  // Check for consistently long days
  const longDays = metrics.filter(m => m.work_hours > 9).length;
  if (longDays > metrics.length * 0.5) {
    score += 0.25;
    signals.push(`${longDays}/${metrics.length} days over 9h`);
  }

  // Weekend work
  const weekendWork = metrics.filter(m => {
    const dow = new Date(m.metric_date).getDay();
    return (dow === 0 || dow === 6) && m.total_min > 30;
  }).length;
  if (weekendWork >= 2) {
    score += 0.2;
    signals.push(`${weekendWork} weekend days with work`);
  }

  // Declining balance score
  const balanceScores = metrics.map(m => m.balance_score || 0);
  const { slope: balanceSlope } = linearRegression(balanceScores);
  if (balanceSlope < -0.02) {
    score += 0.2;
    signals.push("Balance score declining");
  }

  // High meeting density (avg >50%)
  const avgMeetingPct = metrics.reduce((s, m) =>
    s + (m.total_min > 0 ? m.meetings_min / m.total_min : 0), 0) / metrics.length;
  if (avgMeetingPct > 0.5) {
    score += 0.15;
    signals.push(`Avg ${Math.round(avgMeetingPct * 100)}% meetings`);
  }

  // Low focus time
  const avgFocus = metrics.reduce((s, m) => s + (m.deep_work_min || 0), 0) / metrics.length;
  if (avgFocus < 60) {
    score += 0.15;
    signals.push(`Avg ${Math.round(avgFocus)} min deep work/day`);
  }

  // Rising context switches
  const switchValues = metrics.map(m => m.context_switches || 0);
  const { slope: switchSlope } = linearRegression(switchValues);
  if (switchSlope > 0.5) {
    score += 0.1;
    signals.push("Context switches trending up");
  }

  score = Math.min(1, score);

  // Trend direction from balance score slope
  const trendDir = balanceSlope > 0.01 ? "improving" as const
    : balanceSlope < -0.01 ? "worsening" as const
    : "stable" as const;

  return {
    risk_level: score >= 0.6 ? "high" : score >= 0.3 ? "moderate" : "low",
    score: Math.round(score * 100) / 100,
    signals,
    trend_direction: trendDir,
  };
}

// ── Cross-module intelligence exports ────────────────────────

/**
 * For Calendar Intel: best focus windows based on hourly energy.
 */
export async function getBestFocusWindows(
  supabase: SupabaseClient,
): Promise<Array<{ start_hour: number; end_hour: number; quality_score: number }>> {
  const curve = await getEnergyCurve(supabase, 30);
  if (curve.length === 0) return [];

  // Find consecutive hours with high quality scores
  const windows: Array<{ start_hour: number; end_hour: number; quality_score: number }> = [];
  let windowStart: number | null = null;
  let windowScoreSum = 0;
  let windowCount = 0;

  for (const h of curve) {
    if (h.quality_score > 0.3 && h.avg_activities > 0.5 && h.hour >= 6 && h.hour <= 22) {
      if (windowStart === null) windowStart = h.hour;
      windowScoreSum += h.quality_score;
      windowCount++;
    } else {
      if (windowStart !== null && windowCount >= 2) {
        windows.push({
          start_hour: windowStart,
          end_hour: windowStart + windowCount,
          quality_score: Math.round((windowScoreSum / windowCount) * 100) / 100,
        });
      }
      windowStart = null;
      windowScoreSum = 0;
      windowCount = 0;
    }
  }
  // Final window
  if (windowStart !== null && windowCount >= 2) {
    windows.push({
      start_hour: windowStart,
      end_hour: windowStart + windowCount,
      quality_score: Math.round((windowScoreSum / windowCount) * 100) / 100,
    });
  }

  return windows.sort((a, b) => b.quality_score - a.quality_score);
}

/**
 * For Relationship Tracker: time spent on communication by source.
 */
export async function getCommTimeBySource(
  supabase: SupabaseClient, days = 7,
): Promise<Record<string, number>> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from("activity_log")
    .select("source, duration_minutes")
    .in("category", ["communication", "meetings"])
    .gte("started_at", since);

  const bySource: Record<string, number> = {};
  for (const a of data || []) {
    bySource[a.source] = (bySource[a.source] || 0) + (a.duration_minutes || 0);
  }
  return bySource;
}
