/**
 * Daily Rollup Generation
 *
 * Mines completed work sessions into structured daily digests.
 * Each digest entry captures: ticket ID, title, decisions, progress updates, duration.
 *
 * ELLIE-27: Work session daily rollups
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Bot } from "grammy";
import type { ApiRequest, ApiResponse } from "./types.ts";
import { sendGoogleChatMessage, isGoogleChatEnabled } from "../google-chat.ts";
import { log } from "../logger.ts";

const logger = log.child("rollup");

const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID!;
const GOOGLE_CHAT_SPACE = process.env.GOOGLE_CHAT_SPACE_NAME || "";

interface SessionRow {
  id: string;
  work_item_id: string;
  work_item_title: string;
  agent: string | null;
  created_at: string;
  completed_at: string;
}

interface UpdateRow {
  session_id: string;
  type: string;
  message: string;
  created_at: string;
}

interface SessionEntry {
  workItemId: string;
  title: string;
  agent: string | null;
  startedAt: string;
  completedAt: string;
  durationMin: number;
  decisions: string[];
  progressUpdates: string[];
}

interface DailyDigest {
  date: string;
  sessionsCount: number;
  totalDurationMin: number;
  sessions: SessionEntry[];
}

/**
 * Build a structured digest for all completed sessions on a given date.
 */
async function buildDigestForDate(
  supabase: SupabaseClient,
  date: string, // YYYY-MM-DD in UTC
): Promise<DailyDigest | null> {
  const dayStart = `${date}T00:00:00Z`;
  const dayEnd = `${date}T23:59:59.999Z`;

  // Fetch completed sessions for this date (by completed_at)
  const { data: sessions, error } = await supabase
    .from("work_sessions")
    .select("id, work_item_id, work_item_title, agent, created_at, completed_at")
    .eq("state", "completed")
    .gte("completed_at", dayStart)
    .lte("completed_at", dayEnd)
    .order("completed_at", { ascending: true });

  if (error) {
    logger.error("Failed to fetch sessions", error);
    return null;
  }

  if (!sessions?.length) return null;

  // Filter out noise sessions (system prompts, memory extraction, etc.)
  const isNoiseTitle = (title: string): boolean => {
    const t = title.toLowerCase();
    // System prompts accidentally recorded as titles
    if (t.startsWith("you are a") || t.startsWith("you are an")) return true;
    if (t.startsWith("you are analyzing")) return true;
    if (t.startsWith("i think it may")) return true;
    // Very long titles are usually pasted prompts, not work item titles
    if (title.length > 120) return true;
    return false;
  };

  // Separate clean sessions from noise, but keep noise if it has updates/decisions
  // (we'll merge its updates into the real session for that work item)
  const cleanSessions = sessions.filter((s: SessionRow) => !isNoiseTitle(s.work_item_title || ""));
  const noiseSessions = sessions.filter((s: SessionRow) => isNoiseTitle(s.work_item_title || ""));

  if (!cleanSessions.length && !noiseSessions.length) return null;

  // Fetch all updates for ALL sessions (clean + noise) in one query
  const allSessionIds = sessions.map((s: SessionRow) => s.id);
  const { data: updates } = await supabase
    .from("work_session_updates")
    .select("session_id, type, message, created_at")
    .in("session_id", allSessionIds)
    .order("created_at", { ascending: true });

  // Helper: build an entry from a session row
  const buildEntry = (s: SessionRow): SessionEntry => {
    const sessionUpdates = ((updates || []) as UpdateRow[]).filter((u: UpdateRow) => u.session_id === s.id);
    const durationMs = new Date(s.completed_at).getTime() - new Date(s.created_at).getTime();
    return {
      workItemId: s.work_item_id,
      title: s.work_item_title,
      agent: s.agent || null,
      startedAt: s.created_at,
      completedAt: s.completed_at,
      durationMin: Math.round(durationMs / 1000 / 60),
      decisions: sessionUpdates.filter((u: UpdateRow) => u.type === "decision").map((u: UpdateRow) => u.message),
      progressUpdates: sessionUpdates.filter((u: UpdateRow) => u.type === "progress").map((u: UpdateRow) => u.message),
    };
  };

  // Merge all sessions (clean + noise) by work item ID
  // Clean sessions provide the title; noise sessions contribute updates/decisions
  const byWorkItem = new Map<string, SessionEntry>();

  // Process clean sessions first so they set the correct title
  for (const s of cleanSessions) {
    const entry = buildEntry(s);
    const existing = byWorkItem.get(entry.workItemId);
    if (!existing) {
      byWorkItem.set(entry.workItemId, entry);
    } else {
      if (entry.startedAt < existing.startedAt) existing.startedAt = entry.startedAt;
      if (entry.completedAt > existing.completedAt) existing.completedAt = entry.completedAt;
      existing.durationMin += entry.durationMin;
      existing.decisions.push(...entry.decisions);
      existing.progressUpdates.push(...entry.progressUpdates);
      // Prefer the more descriptive non-noise title
      if (!isNoiseTitle(entry.title) && (isNoiseTitle(existing.title) || entry.title.length > existing.title.length)) {
        existing.title = entry.title;
      }
    }
  }

  // Then fold in noise sessions — only their updates/decisions, not their titles
  for (const s of noiseSessions) {
    const entry = buildEntry(s);
    const existing = byWorkItem.get(entry.workItemId);
    if (existing) {
      // Merge updates from noise session into the real entry
      existing.decisions.push(...entry.decisions);
      existing.progressUpdates.push(...entry.progressUpdates);
      // Don't update title, startedAt, completedAt, or durationMin from noise
    }
    // If no clean session exists for this work item, skip it entirely
  }

  const entries = [...byWorkItem.values()];
  const totalDuration = entries.reduce((sum, e) => sum + e.durationMin, 0);

  return {
    date,
    sessionsCount: entries.length,
    totalDurationMin: totalDuration,
    sessions: entries,
  };
}

/**
 * Format a digest as a human-readable text block (for Telegram/Google Chat).
 */
function formatDigestText(digest: DailyDigest): string {
  const dateLabel = new Date(digest.date + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const lines: string[] = [
    `📊 Daily Rollup — ${dateLabel}`,
    `${digest.sessionsCount} session${digest.sessionsCount !== 1 ? "s" : ""}, ${digest.totalDurationMin} min total`,
    "",
  ];

  for (const s of digest.sessions) {
    lines.push(`▸ ${s.workItemId}: ${s.title}`);
    lines.push(`  ⏱ ${s.durationMin} min${s.agent ? ` (agent: ${s.agent})` : ""}`);

    if (s.decisions.length) {
      for (const d of s.decisions) {
        const short = d.length > 150 ? d.substring(0, 150) + "…" : d;
        lines.push(`  ⚡ ${short}`);
      }
    }

    if (s.progressUpdates.length) {
      for (const p of s.progressUpdates) {
        const short = p.length > 150 ? p.substring(0, 150) + "…" : p;
        lines.push(`  📝 ${short}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/**
 * POST /api/rollup/generate
 *
 * Generate a daily rollup for a specific date (or today).
 * Stores the digest in Supabase and optionally sends to Telegram.
 *
 * Body:
 * {
 *   "date": "2026-02-18",   // optional, defaults to today (UTC)
 *   "notify": true           // optional, send Telegram summary (default: true)
 * }
 */
export async function generateRollup(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient, bot: Bot) {
  try {
    const { date, notify = true } = req.body || {};

    // Default to today in UTC
    const rollupDate = (typeof date === "string" ? date : "") || new Date().toISOString().split("T")[0];

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rollupDate)) {
      return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
    }

    console.log(`[rollup] Generating digest for ${rollupDate}`);

    const digest = await buildDigestForDate(supabase, rollupDate);

    if (!digest) {
      return res.json({
        success: true,
        message: `No completed sessions found for ${rollupDate}`,
        digest: null,
      });
    }

    // Upsert into daily_rollups (replace if regenerating)
    const { error: upsertError } = await supabase
      .from("daily_rollups")
      .upsert(
        {
          rollup_date: rollupDate,
          sessions_count: digest.sessionsCount,
          total_duration_min: digest.totalDurationMin,
          digest: digest.sessions,
        },
        { onConflict: "rollup_date" },
      );

    if (upsertError) {
      logger.error("Failed to store digest", upsertError);
      return res.status(500).json({ error: "Failed to store rollup" });
    }

    // Send notifications — short summary to Telegram, full digest to Google Chat
    if (notify) {
      const text = formatDigestText(digest);

      // Telegram: brief summary
      try {
        const tgSummary = `\u{1F4CA} Daily Rollup — ${digest.sessionsCount} sessions, ${digest.totalDurationMin} min total. Full digest sent to Google Chat.`;
        await bot.api.sendMessage(TELEGRAM_USER_ID, tgSummary);
      } catch (tgErr) {
        logger.warn("Telegram notification failed", tgErr);
      }

      // Google Chat: full digest (better formatting for longer content)
      if (GOOGLE_CHAT_SPACE && isGoogleChatEnabled()) {
        try {
          await sendGoogleChatMessage(GOOGLE_CHAT_SPACE, text);
        } catch (gchatErr) {
          logger.warn("Google Chat notification failed", gchatErr);
        }
      }
    }

    console.log(
      `[rollup] Stored digest for ${rollupDate}: ${digest.sessionsCount} sessions, ${digest.totalDurationMin} min`,
    );

    return res.json({
      success: true,
      rollup_date: rollupDate,
      sessions_count: digest.sessionsCount,
      total_duration_min: digest.totalDurationMin,
      digest: digest.sessions,
    });
  } catch (error) {
    logger.error("Generate failed", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * GET /api/rollup/latest
 *
 * Fetch the most recent daily rollup from Supabase.
 */
export async function getLatestRollup(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient) {
  try {
    const { data, error } = await supabase
      .from("daily_rollups")
      .select("*")
      .order("rollup_date", { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      return res.json({ success: true, rollup: null });
    }

    return res.json({ success: true, rollup: data });
  } catch (error) {
    logger.error("Failed to fetch latest rollup", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * GET /api/rollup/:date
 *
 * Fetch rollup for a specific date.
 */
export async function getRollupByDate(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient) {
  try {
    const date = req.params?.date ?? "";

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
    }

    const { data, error } = await supabase
      .from("daily_rollups")
      .select("*")
      .eq("rollup_date", date)
      .single();

    if (error || !data) {
      return res.json({ success: true, rollup: null });
    }

    return res.json({ success: true, rollup: data });
  } catch (error) {
    logger.error("Failed to fetch rollup by date", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
