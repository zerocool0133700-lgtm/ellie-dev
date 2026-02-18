/**
 * Context Sources
 *
 * Fetches structured data to enrich the conversation context.
 * Each source returns a concise text block suitable for prompt injection.
 * Called on every conversation start (via buildPrompt in relay.ts).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { listOpenIssues, isPlaneConfigured } from "./plane.ts";

// ============================================================
// PLANE: Open Work Items
// ============================================================

/**
 * Fetch active issues from Plane and format as a compact list.
 * Shows backlog + in-progress items so the assistant knows what's on the plate.
 */
export async function getOpenWorkItems(): Promise<string> {
  if (!isPlaneConfigured()) return "";

  try {
    const issues = await listOpenIssues("ELLIE", 15);
    if (!issues.length) return "";

    const lines = issues.map((i) => {
      const priority = i.priority !== "none" ? ` [${i.priority}]` : "";
      return `- ELLIE-${i.sequenceId}: ${i.name}${priority}`;
    });

    return "OPEN WORK ITEMS:\n" + lines.join("\n");
  } catch (error) {
    console.error("[context] Failed to fetch open work items:", error);
    return "";
  }
}

// ============================================================
// WORK SESSIONS: Recent completed sessions with decisions
// ============================================================

interface SessionDigest {
  workItemId: string;
  title: string;
  completedAt: string;
  durationMin: number;
  decisions: string[];
  updates: string[];
}

/**
 * Fetch recently completed work sessions (last 3 days) with their
 * key decisions and progress updates. Gives the assistant awareness
 * of what was recently worked on and architectural choices made.
 */
export async function getRecentWorkSessions(
  supabase: SupabaseClient | null,
): Promise<string> {
  if (!supabase) return "";

  try {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    // Fetch completed sessions from the last 3 days
    const { data: sessions, error } = await supabase
      .from("work_sessions")
      .select("id, work_item_id, work_item_title, created_at, completed_at, state")
      .eq("state", "completed")
      .gte("completed_at", threeDaysAgo)
      .order("completed_at", { ascending: false })
      .limit(5);

    if (error || !sessions?.length) return "";

    // Filter out noise sessions (system prompts used as titles)
    const isNoise = (title: string): boolean => {
      const t = (title || "").toLowerCase();
      if (t.startsWith("you are a") || t.startsWith("you are an")) return true;
      if (t.startsWith("you are analyzing")) return true;
      if (t.startsWith("i think it may")) return true;
      if (title.length > 120) return true;
      return false;
    };
    const cleanSessions = sessions.filter((s: any) => !isNoise(s.work_item_title));
    if (!cleanSessions.length) return "";

    // Fetch updates for these sessions
    const sessionIds = cleanSessions.map((s: any) => s.id);
    const { data: updates } = await supabase
      .from("work_session_updates")
      .select("session_id, type, message")
      .in("session_id", sessionIds)
      .order("created_at", { ascending: true });

    // Build digests
    const digests: SessionDigest[] = cleanSessions.map((s: any) => {
      const sessionUpdates = (updates || []).filter((u: any) => u.session_id === s.id);
      const durationMs = new Date(s.completed_at).getTime() - new Date(s.created_at).getTime();

      return {
        workItemId: s.work_item_id,
        title: s.work_item_title,
        completedAt: s.completed_at,
        durationMin: Math.round(durationMs / 1000 / 60),
        decisions: sessionUpdates
          .filter((u: any) => u.type === "decision")
          .map((u: any) => u.message),
        updates: sessionUpdates
          .filter((u: any) => u.type === "progress")
          .map((u: any) => u.message),
      };
    });

    // Format concisely
    const lines = digests.map((d) => {
      const date = new Date(d.completedAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      const parts = [`- ${d.workItemId}: ${d.title} (${date}, ${d.durationMin}min)`];

      // Include up to 2 key decisions
      for (const dec of d.decisions.slice(0, 2)) {
        const short = dec.length > 120 ? dec.substring(0, 120) + "..." : dec;
        parts.push(`  ↳ ${short}`);
      }

      return parts.join("\n");
    });

    return "RECENT WORK SESSIONS:\n" + lines.join("\n");
  } catch (error) {
    console.error("[context] Failed to fetch work sessions:", error);
    return "";
  }
}

// ============================================================
// GOALS & KEY FACTS: From memory table
// ============================================================

/**
 * Fetch active goals and recent key facts from the memory table.
 * Goals give the assistant awareness of what Dave is working toward;
 * facts provide persistent personal context.
 */
export async function getGoalsAndFacts(
  supabase: SupabaseClient | null,
): Promise<string> {
  if (!supabase) return "";

  try {
    const [goalsResult, factsResult] = await Promise.all([
      supabase
        .from("memory")
        .select("content, deadline")
        .eq("type", "goal")
        .order("priority", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .from("memory")
        .select("content")
        .eq("type", "fact")
        .order("created_at", { ascending: false })
        .limit(15),
    ]);

    const parts: string[] = [];

    if (goalsResult.data?.length) {
      const goalLines = goalsResult.data.map((g: any) => {
        const deadline = g.deadline
          ? ` (by ${new Date(g.deadline).toLocaleDateString("en-US", { month: "short", day: "numeric" })})`
          : "";
        return `- ${g.content}${deadline}`;
      });
      parts.push("ACTIVE GOALS:\n" + goalLines.join("\n"));
    }

    if (factsResult.data?.length) {
      const factLines = factsResult.data.map((f: any) => `- ${f.content}`);
      parts.push("KEY FACTS:\n" + factLines.join("\n"));
    }

    return parts.join("\n\n");
  } catch (error) {
    console.error("[context] Failed to fetch goals/facts:", error);
    return "";
  }
}

// ============================================================
// RECENT CONVERSATIONS: Summaries of recent conversation sessions
// ============================================================

/**
 * Fetch recent conversation summaries (last 3 days).
 * Shows what topics were discussed recently across all channels,
 * giving the assistant continuity across sessions.
 */
export async function getRecentConversations(
  supabase: SupabaseClient | null,
): Promise<string> {
  if (!supabase) return "";

  try {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    const { data: convos, error } = await supabase
      .from("conversations")
      .select("channel, started_at, summary, message_count")
      .gte("started_at", threeDaysAgo)
      .order("started_at", { ascending: false })
      .limit(8);

    if (error || !convos?.length) return "";

    const lines = convos.map((c: any) => {
      const time = new Date(c.started_at).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Chicago",
      });
      const channel = c.channel || "telegram";
      const msgs = c.message_count ? `, ${c.message_count} msgs` : "";
      const summary = c.summary
        ? c.summary.length > 150
          ? c.summary.substring(0, 150) + "..."
          : c.summary
        : "No summary";
      return `- [${channel}, ${time}${msgs}] ${summary}`;
    });

    return "RECENT CONVERSATIONS:\n" + lines.join("\n");
  } catch (error) {
    console.error("[context] Failed to fetch recent conversations:", error);
    return "";
  }
}

// ============================================================
// ACTIVITY SNAPSHOT: Channel activity counts
// ============================================================

/**
 * Compact snapshot of recent activity across channels.
 * Helps the assistant understand communication patterns and recency.
 */
export async function getActivitySnapshot(
  supabase: SupabaseClient | null,
): Promise<string> {
  if (!supabase) return "";

  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from("messages")
      .select("channel, role")
      .gte("created_at", oneDayAgo);

    if (error || !data?.length) return "";

    // Count messages by channel
    const counts: Record<string, { user: number; assistant: number }> = {};
    for (const msg of data) {
      const ch = msg.channel || "telegram";
      if (!counts[ch]) counts[ch] = { user: 0, assistant: 0 };
      if (msg.role === "user") counts[ch].user++;
      else if (msg.role === "assistant") counts[ch].assistant++;
    }

    const lines = Object.entries(counts).map(
      ([ch, c]) => `- ${ch}: ${c.user} user / ${c.assistant} assistant messages`,
    );

    return "LAST 24H ACTIVITY:\n" + lines.join("\n");
  } catch (error) {
    console.error("[context] Failed to fetch activity snapshot:", error);
    return "";
  }
}

// ============================================================
// GOOGLE CALENDAR: Upcoming events
// ============================================================

const GCAL_CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CHAT_OAUTH_CLIENT_ID || "";
const GCAL_CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CHAT_OAUTH_CLIENT_SECRET || "";
const GCAL_REFRESH_TOKEN = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN || "";

let gcalTokenCache: { accessToken: string; expiresAt: number } | null = null;

async function getGcalAccessToken(): Promise<string | null> {
  if (!GCAL_CLIENT_ID || !GCAL_CLIENT_SECRET || !GCAL_REFRESH_TOKEN) return null;

  if (gcalTokenCache && Date.now() < gcalTokenCache.expiresAt - 60_000) {
    return gcalTokenCache.accessToken;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GCAL_CLIENT_ID,
      client_secret: GCAL_CLIENT_SECRET,
      refresh_token: GCAL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) return null;

  const data = await res.json();
  gcalTokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return gcalTokenCache.accessToken;
}

/**
 * Fetch upcoming Google Calendar events (next 3 days).
 * Requires GOOGLE_CALENDAR_REFRESH_TOKEN in .env with calendar.readonly scope.
 * Falls back to using GOOGLE_CHAT_OAUTH_CLIENT_ID/SECRET for the OAuth client.
 */
export async function getUpcomingCalendarEvents(): Promise<string> {
  try {
    const token = await getGcalAccessToken();
    if (!token) return "";

    const now = new Date();
    const threeDaysOut = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    const params = new URLSearchParams({
      timeMin: now.toISOString(),
      timeMax: threeDaysOut.toISOString(),
      maxResults: "10",
      singleEvents: "true",
      orderBy: "startTime",
    });

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!res.ok) {
      console.error("[context] Calendar API error:", res.status);
      return "";
    }

    const data = await res.json();
    const events = data.items || [];
    if (!events.length) return "";

    const lines = events.map((e: any) => {
      const start = e.start?.dateTime || e.start?.date || "";
      const isAllDay = !e.start?.dateTime;
      const time = isAllDay
        ? new Date(start).toLocaleDateString("en-US", {
            weekday: "short", month: "short", day: "numeric",
            timeZone: "America/Chicago",
          })
        : new Date(start).toLocaleString("en-US", {
            weekday: "short", month: "short", day: "numeric",
            hour: "numeric", minute: "2-digit",
            timeZone: "America/Chicago",
          });
      const location = e.location ? ` @ ${e.location}` : "";
      return `- ${time}: ${e.summary || "(no title)"}${location}`;
    });

    return "UPCOMING CALENDAR (next 3 days):\n" + lines.join("\n");
  } catch (error) {
    console.error("[context] Failed to fetch calendar events:", error);
    return "";
  }
}

// ============================================================
// PENDING ACTION ITEMS: Extracted from recent conversations
// ============================================================

/**
 * Fetch pending action items from the memory table (type: "action_item")
 * and any recent work session updates flagged as blockers.
 * Gives the assistant awareness of outstanding tasks.
 */
export async function getPendingActionItems(
  supabase: SupabaseClient | null,
): Promise<string> {
  if (!supabase) return "";

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Fetch incomplete action items from memory
    const { data: actionItems } = await supabase
      .from("memory")
      .select("content, created_at")
      .eq("type", "action_item")
      .is("completed_at", null)
      .order("created_at", { ascending: false })
      .limit(10);

    // Fetch recent blockers from work sessions
    const { data: blockers } = await supabase
      .from("work_session_updates")
      .select("message, created_at")
      .eq("type", "blocker")
      .gte("created_at", sevenDaysAgo)
      .order("created_at", { ascending: false })
      .limit(5);

    const parts: string[] = [];

    if (actionItems?.length) {
      const lines = actionItems.map((a: any) => {
        const date = new Date(a.created_at).toLocaleDateString("en-US", {
          month: "short", day: "numeric",
        });
        return `- ${a.content} (${date})`;
      });
      parts.push(...lines);
    }

    if (blockers?.length) {
      const lines = blockers.map((b: any) => {
        const date = new Date(b.created_at).toLocaleDateString("en-US", {
          month: "short", day: "numeric",
        });
        const short = b.message.length > 100 ? b.message.substring(0, 100) + "..." : b.message;
        return `- [BLOCKER] ${short} (${date})`;
      });
      parts.push(...lines);
    }

    if (!parts.length) return "";
    return "PENDING ACTION ITEMS:\n" + parts.join("\n");
  } catch (error) {
    console.error("[context] Failed to fetch action items:", error);
    return "";
  }
}

// ============================================================
// COMBINED: Fetch all context sources in parallel
// ============================================================

/**
 * Fetch all structured context sources in parallel.
 * Returns a single formatted string for prompt injection.
 */
export async function getStructuredContext(
  supabase: SupabaseClient | null,
): Promise<string> {
  const [workItems, workSessions, goalsAndFacts, recentConvos, activity, calendar, actionItems] = await Promise.all([
    getOpenWorkItems(),
    getRecentWorkSessions(supabase),
    getGoalsAndFacts(supabase),
    getRecentConversations(supabase),
    getActivitySnapshot(supabase),
    getUpcomingCalendarEvents(),
    getPendingActionItems(supabase),
  ]);

  const parts = [workItems, workSessions, goalsAndFacts, recentConvos, activity, calendar, actionItems].filter(Boolean);
  return parts.join("\n\n");
}
