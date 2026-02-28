/**
 * Briefing Generator — Daily AI-generated context summaries
 *
 * ELLIE-316: Multi-source briefing that pulls from calendar, GTD, work sessions,
 * UMS messages, and Forest findings to produce a structured daily briefing.
 *
 * Pattern: follows rollup.ts — generate + store + notify
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Bot } from "grammy";
import type { ApiRequest, ApiResponse } from "./types.ts";
import { getCalendarInsights, clearInsights } from "../ums/consumers/calendar-intel.ts";
import { sendGoogleChatMessage, isGoogleChatEnabled } from "../google-chat.ts";
import { log } from "../logger.ts";

const logger = log.child("briefing");

const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID!;
const GOOGLE_CHAT_SPACE = process.env.GOOGLE_CHAT_SPACE_NAME || "";
const BRIDGE_KEY = "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";

// ── Types ────────────────────────────────────────────────────

interface BriefingSection {
  key: string;
  title: string;
  icon: string;
  priority: number;       // sort order (lower = higher priority)
  items: BriefingItem[];
}

interface BriefingItem {
  text: string;
  detail?: string;
  urgency?: "high" | "normal" | "low";
  metadata?: Record<string, unknown>;
}

interface Briefing {
  briefing_date: string;
  generated_at: string;
  content: { sections: BriefingSection[] };
  formatted_text: string;
  priority_score: number;
  source_counts: Record<string, number>;
}

// ── Data Fetchers ────────────────────────────────────────────

async function fetchCalendarEvents(today: string): Promise<BriefingSection> {
  const items: BriefingItem[] = [];
  try {
    const { sql } = await import("../../../ellie-forest/src/index.ts");
    const dayStart = `${today}T00:00:00`;
    const dayEnd = `${today}T23:59:59`;
    const events = await sql`
      SELECT title, start_time, end_time, location, status, attendees
      FROM calendar_events
      WHERE start_time >= ${dayStart} AND start_time <= ${dayEnd} AND status != 'cancelled'
      ORDER BY start_time ASC
    `;

    for (const ev of events) {
      const start = new Date(ev.start_time).toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
      });
      const end = new Date(ev.end_time).toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
      });
      let text = `${start}–${end}: ${ev.title}`;
      if (ev.location) text += ` (${ev.location})`;
      const attendeeCount = Array.isArray(ev.attendees) ? ev.attendees.length : 0;
      items.push({
        text,
        urgency: "normal",
        metadata: { attendees: attendeeCount, event_id: ev.id },
      });
    }

    // Add calendar insights (conflicts, prep needed)
    const insights = getCalendarInsights();
    for (const insight of insights) {
      items.push({
        text: insight.message,
        urgency: insight.severity === "alert" ? "high" : "normal",
        metadata: { insight_type: insight.type },
      });
    }
  } catch (err) {
    logger.warn("Calendar fetch failed", err);
  }

  return {
    key: "calendar",
    title: "Today's Schedule",
    icon: "\u{1F4C5}",
    priority: 1,
    items,
  };
}

async function fetchGtdState(supabase: SupabaseClient): Promise<BriefingSection> {
  const items: BriefingItem[] = [];
  try {
    // Inbox count
    const { count: inboxCount } = await supabase
      .from("todos")
      .select("*", { count: "exact", head: true })
      .eq("status", "inbox");

    if ((inboxCount ?? 0) > 0) {
      items.push({ text: `${inboxCount} items in inbox`, urgency: "normal" });
    }

    // Overdue items
    const today = new Date().toISOString().split("T")[0];
    const { data: overdue } = await supabase
      .from("todos")
      .select("content, due_date, priority")
      .eq("status", "open")
      .lt("due_date", today)
      .not("due_date", "is", null)
      .order("due_date", { ascending: true })
      .limit(5);

    for (const t of overdue || []) {
      items.push({
        text: `OVERDUE: ${t.content}`,
        detail: `Due ${t.due_date}`,
        urgency: "high",
      });
    }

    // Due today
    const { data: dueToday } = await supabase
      .from("todos")
      .select("content, priority")
      .eq("status", "open")
      .eq("due_date", today)
      .order("created_at", { ascending: true })
      .limit(5);

    for (const t of dueToday || []) {
      items.push({
        text: `Due today: ${t.content}`,
        urgency: "normal",
      });
    }

    // Top next actions (by priority)
    const { data: nextActions } = await supabase
      .from("todos")
      .select("content, tags, priority")
      .eq("status", "open")
      .is("due_date", null)
      .order("created_at", { ascending: true })
      .limit(5);

    if ((nextActions || []).length > 0 && items.length < 3) {
      for (const t of (nextActions || []).slice(0, 3)) {
        const tags = Array.isArray(t.tags) && t.tags.length > 0 ? ` [${t.tags.join(", ")}]` : "";
        items.push({ text: `Next: ${t.content}${tags}`, urgency: "low" });
      }
    }

    // Waiting-for items with age
    const { data: waiting } = await supabase
      .from("todos")
      .select("content, waiting_on, waiting_since, updated_at")
      .eq("status", "waiting_for")
      .order("updated_at", { ascending: true })
      .limit(5);

    for (const t of waiting || []) {
      const since = t.waiting_since || t.updated_at;
      const days = Math.floor((Date.now() - new Date(since).getTime()) / (1000 * 60 * 60 * 24));
      const age = days > 0 ? ` (${days}d)` : "";
      items.push({
        text: `Waiting on ${t.waiting_on || "someone"}: ${t.content}${age}`,
        urgency: days >= 7 ? "high" : "normal",
      });
    }
  } catch (err) {
    logger.warn("GTD fetch failed", err);
  }

  return {
    key: "gtd",
    title: "Tasks & Actions",
    icon: "\u{1F3AF}",
    priority: 2,
    items,
  };
}

async function fetchWorkSessions(supabase: SupabaseClient): Promise<BriefingSection> {
  const items: BriefingItem[] = [];
  try {
    // Active/recent work sessions
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: sessions } = await supabase
      .from("work_sessions")
      .select("work_item_id, work_item_title, state, created_at, completed_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(10);

    const active = (sessions || []).filter((s: Record<string, unknown>) => s.state === "active");
    const completed = (sessions || []).filter((s: Record<string, unknown>) => s.state === "completed");

    for (const s of active) {
      items.push({
        text: `In progress: ${s.work_item_title || s.work_item_id}`,
        urgency: "normal",
      });
    }

    if (completed.length > 0) {
      items.push({
        text: `${completed.length} session${completed.length !== 1 ? "s" : ""} completed in last 24h`,
        urgency: "low",
      });
    }
  } catch (err) {
    logger.warn("Work sessions fetch failed", err);
  }

  return {
    key: "work",
    title: "Work Sessions",
    icon: "\u{1F4BB}",
    priority: 3,
    items,
  };
}

async function fetchMessages(supabase: SupabaseClient): Promise<BriefingSection> {
  const items: BriefingItem[] = [];
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Count by provider
    const { data: messages } = await supabase
      .from("unified_messages")
      .select("provider, content_type, sender")
      .gte("received_at", since)
      .limit(500);

    if (messages && messages.length > 0) {
      const counts: Record<string, number> = {};
      for (const m of messages) {
        const p = m.provider || "unknown";
        counts[p] = (counts[p] || 0) + 1;
      }
      const parts = Object.entries(counts)
        .sort(([, a], [, b]) => b - a)
        .map(([provider, count]) => `${count} ${provider}`);
      items.push({
        text: `${messages.length} messages: ${parts.join(", ")}`,
        urgency: "low",
      });
    }
  } catch (err) {
    logger.warn("Messages fetch failed", err);
  }

  return {
    key: "messages",
    title: "Message Volume",
    icon: "\u{1F4E8}",
    priority: 5,
    items,
  };
}

async function fetchForestFindings(): Promise<BriefingSection> {
  const items: BriefingItem[] = [];
  try {
    const resp = await fetch("http://localhost:3001/api/bridge/read", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-key": BRIDGE_KEY,
      },
      body: JSON.stringify({ query: "recent decisions and findings", scope_path: "2", limit: 5 }),
      signal: AbortSignal.timeout(5000),
    });

    if (resp.ok) {
      const data = await resp.json() as { results?: Array<{ content: string; type: string; confidence: number }> };
      for (const finding of data.results || []) {
        const prefix = finding.type === "decision" ? "Decision" : "Finding";
        items.push({
          text: `${prefix}: ${finding.content.slice(0, 150)}`,
          urgency: "low",
          metadata: { type: finding.type, confidence: finding.confidence },
        });
      }
    }
  } catch (err) {
    logger.warn("Forest fetch failed", err);
  }

  return {
    key: "forest",
    title: "Recent Decisions",
    icon: "\u{1F332}",
    priority: 6,
    items,
  };
}

// ELLIE-318 Phase 2: Comms section for briefing
async function fetchCommsState(supabase: SupabaseClient): Promise<BriefingSection> {
  const items: BriefingItem[] = [];
  try {
    const { getStaleThreads, getActiveThreads } = await import("../ums/consumers/comms.ts");
    const stale = getStaleThreads();
    const active = getActiveThreads();
    const awaiting = active.filter(t => t.awaiting_reply);

    if (stale.length > 0) {
      for (const t of stale.slice(0, 5)) {
        const hours = Math.round((Date.now() - new Date(t.last_message_at).getTime()) / (1000 * 60 * 60));
        const who = t.last_sender || t.provider;
        const subject = t.subject ? `: ${t.subject.slice(0, 60)}` : "";
        items.push({
          text: `Stale (${hours}h): ${who} on ${t.provider}${subject}`,
          urgency: hours >= 48 ? "high" : "normal",
          metadata: { thread_id: t.thread_id, provider: t.provider },
        });
      }
      if (stale.length > 5) {
        items.push({ text: `...and ${stale.length - 5} more stale threads`, urgency: "low" });
      }
    }

    if (awaiting.length > 0 && stale.length === 0) {
      items.push({ text: `${awaiting.length} threads awaiting reply (not yet stale)`, urgency: "low" });
    }

    if (active.length > 0 && items.length === 0) {
      items.push({ text: `${active.length} active threads, all caught up`, urgency: "low" });
    }
  } catch (err) {
    logger.warn("Comms fetch failed", err);
  }

  return {
    key: "comms",
    title: "Conversations",
    icon: "\u{1F4AC}",
    priority: 3, // between work sessions and messages
    items,
  };
}

// ── Generator ────────────────────────────────────────────────

function calculatePriority(sections: BriefingSection[]): number {
  let score = 0;
  for (const section of sections) {
    for (const item of section.items) {
      if (item.urgency === "high") score += 20;
      else if (item.urgency === "normal") score += 5;
      else score += 1;
    }
  }
  return Math.min(score, 100);
}

function formatBriefingMarkdown(sections: BriefingSection[], date: string): string {
  const dateLabel = new Date(date + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const lines: string[] = [
    `\u{1F4CB} Daily Briefing — ${dateLabel}`,
    "",
  ];

  for (const section of sections) {
    if (section.items.length === 0) continue;
    lines.push(`${section.icon} **${section.title}**`);
    for (const item of section.items) {
      const marker = item.urgency === "high" ? "\u{1F534}" : item.urgency === "normal" ? "\u25B8" : "\u25E6";
      lines.push(`  ${marker} ${item.text}`);
      if (item.detail) lines.push(`    ${item.detail}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

async function fetchGardenerSuggestions(supabase: SupabaseClient): Promise<BriefingSection> {
  const items: BriefingItem[] = [];
  try {
    const { data } = await supabase
      .from("channel_gardener_suggestions")
      .select("id, title, description, suggestion_type, confidence")
      .eq("status", "pending")
      .order("confidence", { ascending: false })
      .limit(5);

    for (const s of data || []) {
      items.push({
        text: s.title,
        detail: s.description,
        urgency: s.confidence >= 0.8 ? "high" : "normal",
        metadata: { suggestion_id: s.id, suggestion_type: s.suggestion_type },
      });
    }
  } catch (err) {
    logger.warn("Gardener suggestions fetch failed", err);
  }
  return { key: "gardener", title: "Channel Garden", icon: "~", priority: 6, items };
}

async function buildBriefing(supabase: SupabaseClient, date: string): Promise<Briefing> {
  // Fetch all sources in parallel with graceful degradation
  const [calendar, gtd, work, comms, messages, forest, gardener] = await Promise.allSettled([
    fetchCalendarEvents(date),
    fetchGtdState(supabase),
    fetchWorkSessions(supabase),
    fetchCommsState(supabase),
    fetchMessages(supabase),
    fetchForestFindings(),
    fetchGardenerSuggestions(supabase),
  ]);

  const sections: BriefingSection[] = [];
  const extract = (result: PromiseSettledResult<BriefingSection>): BriefingSection | null =>
    result.status === "fulfilled" ? result.value : null;

  for (const result of [calendar, gtd, work, comms, messages, forest, gardener]) {
    const section = extract(result);
    if (section && section.items.length > 0) sections.push(section);
  }

  // Sort by priority
  sections.sort((a, b) => a.priority - b.priority);

  const source_counts: Record<string, number> = {};
  for (const s of sections) {
    source_counts[s.key] = s.items.length;
  }

  const priority_score = calculatePriority(sections);
  const formatted_text = formatBriefingMarkdown(sections, date);

  return {
    briefing_date: date,
    generated_at: new Date().toISOString(),
    content: { sections },
    formatted_text,
    priority_score,
    source_counts,
  };
}

// ── API Handlers ─────────────────────────────────────────────

/**
 * POST /api/briefing/generate
 *
 * Generate a daily briefing for a specific date (or today).
 * Body: { "date": "2026-02-27", "notify": true }
 */
export async function generateBriefingHandler(
  req: ApiRequest,
  res: ApiResponse,
  supabase: SupabaseClient,
  bot: Bot,
): Promise<void> {
  try {
    const { date, notify = false } = req.body || {};
    const briefingDate = (typeof date === "string" ? date : "") || new Date().toISOString().split("T")[0];

    if (!/^\d{4}-\d{2}-\d{2}$/.test(briefingDate)) {
      res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
      return;
    }

    logger.info("Generating briefing", { date: briefingDate });

    const briefing = await buildBriefing(supabase, briefingDate);

    // Upsert into briefings table
    const { error: upsertError } = await supabase
      .from("briefings")
      .upsert(
        {
          briefing_date: briefing.briefing_date,
          content: briefing.content,
          formatted_text: briefing.formatted_text,
          priority_score: briefing.priority_score,
          source_counts: briefing.source_counts,
        },
        { onConflict: "briefing_date" },
      );

    if (upsertError) {
      logger.error("Failed to store briefing", upsertError);
      res.status(500).json({ error: "Failed to store briefing" });
      return;
    }

    // Clear calendar insights after consuming them
    clearInsights();

    // Send notifications if requested
    if (notify) {
      await deliverBriefing(briefing, supabase, bot);
    }

    logger.info("Briefing generated", { date: briefingDate, priority: briefing.priority_score, sections: Object.keys(briefing.source_counts) });

    res.json({
      success: true,
      briefing_date: briefing.briefing_date,
      priority_score: briefing.priority_score,
      source_counts: briefing.source_counts,
      formatted_text: briefing.formatted_text,
    });
  } catch (error) {
    logger.error("Briefing generation failed", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * GET /api/briefing/latest
 */
export async function getLatestBriefing(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  try {
    const { data, error } = await supabase
      .from("briefings")
      .select("*")
      .order("briefing_date", { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      res.json({ success: true, briefing: null });
      return;
    }

    res.json({ success: true, briefing: data });
  } catch (error) {
    logger.error("Failed to fetch latest briefing", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * GET /api/briefing/history?days=7
 */
export async function getBriefingHistory(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  try {
    const days = Math.min(Number(req.query?.days) || 7, 30);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const { data, error } = await supabase
      .from("briefings")
      .select("id, briefing_date, priority_score, source_counts, delivered_at, generated_at")
      .gte("briefing_date", since)
      .order("briefing_date", { ascending: false });

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ success: true, briefings: data || [] });
  } catch (error) {
    logger.error("Failed to fetch briefing history", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── Delivery (Phase 2) ──────────────────────────────────────

async function deliverBriefing(briefing: Briefing, supabase: SupabaseClient, bot: Bot): Promise<void> {
  const channels: string[] = [];

  // Telegram: brief summary
  try {
    const lines = briefing.formatted_text.split("\n");
    const tgText = lines.slice(0, 15).join("\n") + (lines.length > 15 ? "\n\n…full briefing in Google Chat" : "");
    await bot.api.sendMessage(TELEGRAM_USER_ID, tgText);
    channels.push("telegram");
  } catch (err) {
    logger.warn("Telegram briefing delivery failed", err);
  }

  // Google Chat: full briefing
  if (GOOGLE_CHAT_SPACE && isGoogleChatEnabled()) {
    try {
      await sendGoogleChatMessage(GOOGLE_CHAT_SPACE, briefing.formatted_text);
      channels.push("google-chat");
    } catch (err) {
      logger.warn("Google Chat briefing delivery failed", err);
    }
  }

  // Update delivery status
  if (channels.length > 0) {
    await supabase
      .from("briefings")
      .update({
        delivered_at: new Date().toISOString(),
        delivery_channels: channels,
      })
      .eq("briefing_date", briefing.briefing_date);
  }
}

/**
 * Called by relay.ts cron to auto-generate and deliver the morning briefing.
 */
export async function runMorningBriefing(supabase: SupabaseClient, bot: Bot): Promise<void> {
  const today = new Date().toISOString().split("T")[0];

  // Check if already generated today
  const { data: existing } = await supabase
    .from("briefings")
    .select("id, delivered_at")
    .eq("briefing_date", today)
    .single();

  if (existing?.delivered_at) {
    logger.info("Morning briefing already delivered today, skipping");
    return;
  }

  logger.info("Running morning briefing", { date: today });

  const briefing = await buildBriefing(supabase, today);

  // Store
  await supabase
    .from("briefings")
    .upsert(
      {
        briefing_date: briefing.briefing_date,
        content: briefing.content,
        formatted_text: briefing.formatted_text,
        priority_score: briefing.priority_score,
        source_counts: briefing.source_counts,
      },
      { onConflict: "briefing_date" },
    );

  clearInsights();

  // Deliver
  await deliverBriefing(briefing, supabase, bot);

  logger.info("Morning briefing delivered", { date: today, priority: briefing.priority_score });
}
