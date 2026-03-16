/**
 * Context Sources
 *
 * Fetches structured data to enrich the conversation context.
 * Each source returns a concise text block suitable for prompt injection.
 * Called on every conversation start (via buildPrompt in relay.ts).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { listOpenIssues, isPlaneConfigured } from "./plane.ts";
import { log } from "./logger.ts";
import { freshnessTracker } from "./context-freshness.ts";

const logger = log.child("context");

import { USER_TIMEZONE } from "./timezone.ts";

// ── ELLIE-458/465: Resilience helpers ────────────────────────

/** Race a promise against a timeout; resolves to fallback on timeout. Exported for tests. */
export function _withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}
// Internal alias (unchanged callers inside this file use the private name)
const withTimeout = _withTimeout;

/** Extract fulfilled values from Promise.allSettled, logging rejections. Exported for tests. */
export function _settledValues<T>(
  results: PromiseSettledResult<T>[],
  label: string,
): T[] {
  return results.map((r, i) => {
    if (r.status === "rejected") {
      logger.warn(`${label}[${i}] failed`, { error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
    }
    return r.status === "fulfilled" ? r.value : undefined;
  }).filter((v): v is T => v !== undefined);
}
const settledValues = _settledValues;

// ELLIE-465: Per-source timeout map — Forest and Google APIs can legitimately need 5-8s
const SOURCE_TIMEOUTS: Record<string, number> = {
  // Forest-backed sources
  forest:    6_000,
  incidents: 6_000,
  // Google API sources
  calendar:  6_000,
  gmail:     6_000,
  tasks:     6_000,
  // River (QMD) — local CLI, should be fast
  river:     3_000,
};
const DEFAULT_SOURCE_TIMEOUT_MS = 3_000;

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
    logger.error("Failed to fetch open work items", error);
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
    const cleanSessions = sessions.filter((s: Record<string, unknown>) => !isNoise(s.work_item_title as string));
    if (!cleanSessions.length) return "";

    // Fetch updates for these sessions
    const sessionIds = cleanSessions.map((s: Record<string, unknown>) => s.id);
    const { data: updates } = await supabase
      .from("work_session_updates")
      .select("session_id, type, message")
      .in("session_id", sessionIds)
      .order("created_at", { ascending: true });

    // Build digests
    const digests: SessionDigest[] = cleanSessions.map((s: Record<string, unknown>) => {
      const sessionUpdates = (updates || []).filter((u: Record<string, unknown>) => u.session_id === s.id);
      const durationMs = new Date(s.completed_at as string).getTime() - new Date(s.created_at as string).getTime();

      return {
        workItemId: s.work_item_id as string,
        title: s.work_item_title as string,
        completedAt: s.completed_at as string,
        durationMin: Math.round(durationMs / 1000 / 60),
        decisions: sessionUpdates
          .filter((u: Record<string, unknown>) => u.type === "decision")
          .map((u: Record<string, unknown>) => u.message as string),
        updates: sessionUpdates
          .filter((u: Record<string, unknown>) => u.type === "progress")
          .map((u: Record<string, unknown>) => u.message as string),
      };
    });

    // Format concisely
    const lines = digests.map((d) => {
      const date = new Date(d.completedAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: USER_TIMEZONE,
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
    logger.error("Failed to fetch work sessions", error);
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
    const [goalsSettled, factsSettled] = await Promise.allSettled([
      withTimeout(supabase
        .from("memory")
        .select("content, deadline")
        .eq("type", "goal")
        .order("priority", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(10), 3000, { data: null, error: new Error("timeout") }),
      withTimeout(supabase
        .from("memory")
        .select("content")
        .eq("type", "fact")
        .order("created_at", { ascending: false })
        .limit(15), 3000, { data: null, error: new Error("timeout") }),
    ]);
    const goalsResult = goalsSettled.status === "fulfilled" ? goalsSettled.value : { data: null, error: null };
    const factsResult = factsSettled.status === "fulfilled" ? factsSettled.value : { data: null, error: null };

    const parts: string[] = [];

    if (goalsResult.data?.length) {
      const goalLines = goalsResult.data.map((g: Record<string, unknown>) => {
        const deadline = g.deadline
          ? ` (by ${new Date(g.deadline as string).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: USER_TIMEZONE })})`
          : "";
        return `- ${g.content}${deadline}`;
      });
      parts.push("ACTIVE GOALS:\n" + goalLines.join("\n"));
    }

    if (factsResult.data?.length) {
      const factLines = factsResult.data.map((f: Record<string, unknown>) => `- ${f.content}`);
      parts.push("KEY FACTS:\n" + factLines.join("\n"));
    }

    return parts.join("\n\n");
  } catch (error) {
    logger.error("Failed to fetch goals/facts", error);
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
      .select("channel, started_at, summary, message_count, status, agent")
      .gte("started_at", threeDaysAgo)
      .order("started_at", { ascending: false })
      .limit(3); // ELLIE-627: Cap at 3 to reduce context bloat

    if (error || !convos?.length) return "";

    const lines = convos.map((c: Record<string, unknown>) => {
      const time = new Date(c.started_at as string).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: USER_TIMEZONE,
      });
      const channel = (c.channel as string) || "telegram";
      const status = (c.status as string) || "closed";
      const agent = c.agent as string | undefined;
      const agentLabel = agent && agent !== "general" ? `, ${agent}` : "";
      const msgs = c.message_count ? `, ${c.message_count} msgs` : "";
      const summaryRaw = c.summary as string | undefined;
      const summary = summaryRaw
        ? summaryRaw.length > 150
          ? summaryRaw.substring(0, 150) + "..."
          : summaryRaw
        : "No summary";
      return `- [${channel}, ${status}${agentLabel}, ${time}${msgs}] ${summary}`;
    });

    return "RECENT CONVERSATIONS:\n" + lines.join("\n");
  } catch (error) {
    logger.error("Failed to fetch recent conversations", error);
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
    logger.error("Failed to fetch activity snapshot", error);
    return "";
  }
}

// ============================================================
// GOOGLE API: Shared OAuth for Calendar, Gmail, Tasks
// Supports two accounts (personal + workspace)
// ============================================================

const GAPI_CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CHAT_OAUTH_CLIENT_ID || "";
const GAPI_CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CHAT_OAUTH_CLIENT_SECRET || "";

export interface GoogleAccount {
  label: string;
  refreshToken: string;
  tokenCache: { accessToken: string; expiresAt: number } | null;
}

export const googleAccounts: GoogleAccount[] = [];

const personalToken = process.env.GOOGLE_API_REFRESH_TOKEN || process.env.GOOGLE_CALENDAR_REFRESH_TOKEN || "";
if (personalToken) {
  googleAccounts.push({ label: "personal", refreshToken: personalToken, tokenCache: null });
}

const workspaceToken = process.env.GOOGLE_API_REFRESH_TOKEN_WORKSPACE || "";
if (workspaceToken) {
  googleAccounts.push({ label: "workspace", refreshToken: workspaceToken, tokenCache: null });
}

export async function getAccessTokenForAccount(account: GoogleAccount): Promise<string | null> {
  if (!GAPI_CLIENT_ID || !GAPI_CLIENT_SECRET) return null;

  if (account.tokenCache && Date.now() < account.tokenCache.expiresAt - 60_000) {
    return account.tokenCache.accessToken;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GAPI_CLIENT_ID,
      client_secret: GAPI_CLIENT_SECRET,
      refresh_token: account.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) return null;

  const data = (await res.json()) as Record<string, unknown>;
  account.tokenCache = {
    accessToken: data.access_token as string,
    expiresAt: Date.now() + ((data.expires_in as number) || 3600) * 1000,
  };
  return account.tokenCache.accessToken;
}

/** Get access token for the first configured account (backwards compat) */
async function getGoogleApiAccessToken(): Promise<string | null> {
  if (!googleAccounts.length) return null;
  return getAccessTokenForAccount(googleAccounts[0]);
}

// ============================================================
// GOOGLE CALENDAR: Upcoming events
// ============================================================

/**
 * Fetch calendar events for a single account.
 */
async function getCalendarForAccount(account: GoogleAccount): Promise<{ label: string; lines: string[] }> {
  const token = await getAccessTokenForAccount(account);
  if (!token) return { label: account.label, lines: [] };

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

  if (!res.ok) return { label: account.label, lines: [] };

  const data = (await res.json()) as Record<string, unknown>;
  const events = (data.items || []) as Record<string, unknown>[];

  const lines = events.map((e: Record<string, unknown>) => {
    const startObj = e.start as Record<string, unknown> | undefined;
    const start = (startObj?.dateTime as string) || (startObj?.date as string) || "";
    const isAllDay = !startObj?.dateTime;
    const time = isAllDay
      ? new Date(start).toLocaleDateString("en-US", {
          weekday: "short", month: "short", day: "numeric",
          timeZone: USER_TIMEZONE,
        })
      : new Date(start).toLocaleString("en-US", {
          weekday: "short", month: "short", day: "numeric",
          hour: "numeric", minute: "2-digit",
          timeZone: USER_TIMEZONE,
        });
    const location = e.location ? ` @ ${e.location}` : "";
    return `- ${time}: ${(e.summary as string) || "(no title)"}${location}`;
  });

  return { label: account.label, lines };
}

/**
 * Fetch upcoming Google Calendar events (next 3 days) across all configured accounts.
 */
export async function getUpcomingCalendarEvents(): Promise<string> {
  if (!googleAccounts.length) return "";
  try {
    const results = settledValues(
      await Promise.allSettled(googleAccounts.map(a => withTimeout(getCalendarForAccount(a), 6_000, { label: a.label, lines: [] }))),
      "calendar",
    );
    // Merge all events, tag with account label if multiple accounts
    const multi = googleAccounts.length > 1;
    const allLines: string[] = [];
    for (const r of results) {
      if (!r.lines.length) continue;
      if (multi) allLines.push(`[${r.label}]`);
      allLines.push(...r.lines);
    }
    if (!allLines.length) return "";
    return "UPCOMING CALENDAR (next 3 days):\n" + allLines.join("\n");
  } catch (error) {
    logger.error("Failed to fetch calendar events", error);
    return "";
  }
}

// ============================================================
// GMAIL: Unread email signal
// ============================================================

/**
 * Fetch Gmail signal for a single account.
 */
async function getGmailSignalForAccount(account: GoogleAccount): Promise<string> {
  const token = await getAccessTokenForAccount(account);
  if (!token) return "";

  const labelRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!labelRes.ok) return "";
  const labelData = (await labelRes.json()) as Record<string, unknown>;
  const unreadCount = (labelData.messagesUnread as number) || 0;

  if (unreadCount === 0) return "";

  // Fetch recent unread message headers (up to 5)
  const listRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?" +
      new URLSearchParams({
        q: "is:unread in:inbox",
        maxResults: "5",
      }),
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!listRes.ok) return `${account.label}: ${unreadCount} unread`;
  const listData = (await listRes.json()) as Record<string, unknown>;
  const messageIds = ((listData.messages || []) as Record<string, unknown>[]).map((m) => m.id as string);

  // Fetch metadata for each (in parallel)
  const headerPromises = messageIds.map(async (id: string) => {
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!msgRes.ok) return null;
    return (await msgRes.json()) as Record<string, unknown>;
  });

  const messages = settledValues(await Promise.allSettled(headerPromises), "gmail-headers").filter(Boolean);

  const lines = messages.map((msg: Record<string, unknown>) => {
    const payload = msg.payload as Record<string, unknown> | undefined;
    const headers = (payload?.headers || []) as Record<string, unknown>[];
    const from = (headers.find((h) => h.name === "From")?.value as string) || "Unknown";
    const subject = (headers.find((h) => h.name === "Subject")?.value as string) || "(no subject)";
    const fromName = from.replace(/<.*>/, "").trim() || from;
    const shortSubject = subject.length > 60 ? subject.substring(0, 57) + "..." : subject;
    return `- ${fromName}: ${shortSubject}`;
  });

  return `${account.label} (${unreadCount} unread):\n${lines.join("\n")}`;
}

/**
 * Fetch Gmail signal across all configured accounts.
 * Keeps payload small — Claude uses MCP tools for full email content.
 */
export async function getGmailSignal(): Promise<string> {
  if (!googleAccounts.length) return "";
  try {
    const results = settledValues(
      await Promise.allSettled(googleAccounts.map(a => withTimeout(getGmailSignalForAccount(a), 6_000, ""))),
      "gmail",
    );
    const parts = results.filter(Boolean);
    if (!parts.length) return "GMAIL: No unread messages.";
    return "GMAIL:\n" + parts.join("\n") + "\n(Use mcp__google-workspace tools for full email content)";
  } catch (error) {
    logger.error("Failed to fetch Gmail signal", error);
    return "";
  }
}

// ============================================================
// OUTLOOK: Unread email signal (Microsoft Graph)
// ============================================================

import {
  isOutlookConfigured,
  getOutlookEmail,
  listUnread as outlookListUnread,
  getUnreadCount as outlookGetUnreadCount,
} from "./outlook.ts";

/**
 * Fetch Outlook signal — unread count + recent message headers.
 * Mirrors getGmailSignal() structure.
 */
export async function getOutlookSignal(): Promise<string> {
  if (!isOutlookConfigured()) return "";

  try {
    const [unreadResult, messagesResult] = await Promise.allSettled([
      outlookGetUnreadCount(),
      outlookListUnread(5),
    ]);

    if (unreadResult.status === "rejected") {
      logger.warn("Outlook unread count failed", { error: unreadResult.reason instanceof Error ? unreadResult.reason.message : String(unreadResult.reason) });
      return "";
    }
    const unreadCount = unreadResult.value;
    const recentMessages = messagesResult.status === "fulfilled" ? messagesResult.value : [];
    if (messagesResult.status === "rejected") {
      logger.warn("Outlook message list failed", { error: messagesResult.reason instanceof Error ? messagesResult.reason.message : String(messagesResult.reason) });
    }

    if (unreadCount === 0) return "OUTLOOK: No unread messages.";

    const lines = recentMessages.map((msg) => {
      const fromName = msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || "Unknown";
      const subject = msg.subject || "(no subject)";
      const shortSubject = subject.length > 60 ? subject.substring(0, 57) + "..." : subject;
      return `- ${fromName}: ${shortSubject}`;
    });

    const email = getOutlookEmail();
    const label = email || "outlook";
    return `OUTLOOK (${label}, ${unreadCount} unread):\n${lines.join("\n")}\n(Use /api/outlook/* endpoints via curl for full email content)`;
  } catch (error) {
    logger.error("Failed to fetch Outlook signal", error);
    return "";
  }
}

// ============================================================
// GOOGLE TASKS: Pending tasks
// ============================================================

/**
 * Fetch pending Google Tasks for a single account.
 */
async function getGoogleTasksForAccount(account: GoogleAccount): Promise<string> {
  const token = await getAccessTokenForAccount(account);
  if (!token) return "";

  const res = await fetch(
    "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks?" +
      new URLSearchParams({
        showCompleted: "false",
        showHidden: "false",
        maxResults: "15",
      }),
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) return "";

  const data = (await res.json()) as Record<string, unknown>;
  const tasks = (data.items || []) as Record<string, unknown>[];
  if (!tasks.length) return "";

  const lines = tasks.map((t: Record<string, unknown>) => {
    const due = t.due
      ? ` (due ${new Date(t.due as string).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          timeZone: USER_TIMEZONE,
        })})`
      : "";
    const notes = t.notes ? ` — ${(t.notes as string).substring(0, 50)}` : "";
    return `- ${t.title}${due}${notes}`;
  });

  return `${account.label}:\n${lines.join("\n")}`;
}

/**
 * Fetch pending Google Tasks across all configured accounts.
 */
export async function getGoogleTasks(): Promise<string> {
  if (!googleAccounts.length) return "";
  try {
    const results = settledValues(
      await Promise.allSettled(googleAccounts.map(a => withTimeout(getGoogleTasksForAccount(a), 6_000, ""))),
      "tasks",
    );
    const parts = results.filter(Boolean);
    if (!parts.length) return "";
    return "GOOGLE TASKS (pending):\n" + parts.join("\n");
  } catch (error) {
    logger.error("Failed to fetch Google Tasks", error);
    return "";
  }
}

export interface GoogleTaskItem {
  id: string;
  title: string;
  notes?: string;
  due?: string;
  status: string;
  updated: string;
}

/**
 * Fetch pending Google Tasks as structured JSON for the /gtd command.
 */
async function getGoogleTasksJSONForAccount(account: GoogleAccount): Promise<{ label: string; tasks: GoogleTaskItem[] }> {
  const token = await getAccessTokenForAccount(account);
  if (!token) return { label: account.label, tasks: [] };

  const res = await fetch(
    "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks?" +
      new URLSearchParams({
        showCompleted: "false",
        showHidden: "false",
        maxResults: "20",
      }),
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) return { label: account.label, tasks: [] };

  const data = (await res.json()) as Record<string, unknown>;
  const items = (data.items || []) as Record<string, unknown>[];

  return {
    label: account.label,
    tasks: items.map((t: Record<string, unknown>) => ({
      id: t.id as string,
      title: t.title as string,
      notes: (t.notes as string) || undefined,
      due: (t.due as string) || undefined,
      status: t.status as string,
      updated: t.updated as string,
    })),
  };
}

export async function getGoogleTasksJSON(): Promise<{ accounts: { label: string; tasks: GoogleTaskItem[] }[] }> {
  if (!googleAccounts.length) return { accounts: [] };
  try {
    const accounts = settledValues(
      await Promise.allSettled(googleAccounts.map(a => withTimeout(getGoogleTasksJSONForAccount(a), 6_000, { label: a.label, tasks: [] }))),
      "tasks-json",
    );
    return { accounts };
  } catch (error) {
    logger.error("Failed to fetch Google Tasks JSON", error);
    return { accounts: [] };
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
      const lines = actionItems.map((a: Record<string, unknown>) => {
        const date = new Date(a.created_at as string).toLocaleDateString("en-US", {
          month: "short", day: "numeric", timeZone: USER_TIMEZONE,
        });
        return `- ${a.content} (${date})`;
      });
      parts.push(...lines);
    }

    if (blockers?.length) {
      const lines = blockers.map((b: Record<string, unknown>) => {
        const date = new Date(b.created_at as string).toLocaleDateString("en-US", {
          month: "short", day: "numeric", timeZone: USER_TIMEZONE,
        });
        const msg = b.message as string;
        const short = msg.length > 100 ? msg.substring(0, 100) + "..." : msg;
        return `- [BLOCKER] ${short} (${date})`;
      });
      parts.push(...lines);
    }

    if (!parts.length) return "";
    return "PENDING ACTION ITEMS:\n" + parts.join("\n");
  } catch (error) {
    logger.error("Failed to fetch action items", error);
    return "";
  }
}

// ============================================================
// COMBINED: Fetch all context sources in parallel
// ============================================================

// Source registry: maps source names to fetch functions
type SourceFetcher = (supabase: SupabaseClient | null) => Promise<string>;

const SOURCE_REGISTRY: Record<string, SourceFetcher> = {
  work_items:    (_sb) => getOpenWorkItems(),
  work_sessions: (sb) => getRecentWorkSessions(sb),
  goals:         (sb) => getGoalsAndFacts(sb),
  conversations: (sb) => getRecentConversations(sb),
  activity:      (sb) => getActivitySnapshot(sb),
  calendar:      (_sb) => getUpcomingCalendarEvents(),
  action_items:  (sb) => getPendingActionItems(sb),
  gmail:         (_sb) => getGmailSignal(),
  outlook:       (_sb) => getOutlookSignal(),
  google_tasks:  (_sb) => getGoogleTasks(),
};

const ALL_SOURCE_NAMES = Object.keys(SOURCE_REGISTRY);

// ── ELLIE-261: Context strategy presets ─────────────────────
// Each strategy defines default sources, priority, and excluded sections.
// Explicit profile settings (sources/exclude/priority) override the strategy.

import type { ContextStrategy, Tree, MemorySearchResult, AgentDigest } from '../../ellie-forest/src/types';

interface StrategyPreset {
  sources: string[] | 'all';
  priority: string[];
  exclude: string[];
  /** Prompt section labels to exclude (applied in buildPrompt) */
  excludeSections: string[];
  /** Token budget override */
  budget: 'minimal' | 'default' | 'extended';
  /** Per-section priority overrides (label → priority number) */
  sectionPriorities?: Record<string, number>;
}

const STRATEGY_PRESETS: Record<ContextStrategy, StrategyPreset> = {
  full: {
    sources: 'all',
    priority: [],
    exclude: [],
    excludeSections: [],
    budget: 'default',
    // Soul at priority 2 — full personality in conversational modes
    sectionPriorities: { soul: 2 },
  },
  focused: {
    sources: ['work_items', 'work_sessions', 'action_items', 'goals', 'river'],
    priority: ['work_items', 'work_sessions'],
    exclude: [],
    excludeSections: ['context-docket'],
    budget: 'default',
    // Soul at priority 7 — condensed identity in deep-work modes
    sectionPriorities: { soul: 7, archetype: 8 },
  },
  minimal: {
    sources: [],  // No structured context at all
    priority: [],
    exclude: [],
    excludeSections: ['structured-context', 'context-docket', 'search', 'forest-awareness', 'skills', 'queue'],
    budget: 'minimal',
    // Soul at priority 7 — minimal but still present
    sectionPriorities: { soul: 7, archetype: 8 },
  },
  voice: {
    sources: ['calendar', 'action_items', 'google_tasks'],
    priority: ['calendar'],
    exclude: [],
    excludeSections: ['memory-protocol', 'confirm-protocol', 'forest-memory-writes', 'dev-protocol',
                      'playbook-commands', 'work-commands', 'context-docket', 'search'],
    budget: 'minimal',
    // Soul at priority 7 — voice is tight on tokens
    sectionPriorities: { soul: 7, archetype: 8 },
  },
  briefing: {
    sources: 'all',
    priority: ['calendar', 'gmail', 'outlook', 'action_items', 'google_tasks', 'activity'],
    exclude: [],
    excludeSections: [],
    budget: 'extended',
    // Soul at priority 5 — present but situational context takes priority
    sectionPriorities: { soul: 5 },
  },
};

/** Get the strategy preset for a given strategy name. */
export function getStrategyPreset(strategy: ContextStrategy | undefined): StrategyPreset {
  return STRATEGY_PRESETS[strategy || 'full'];
}

/** Get excluded section labels for the active strategy (used by buildPrompt). */
export function getStrategyExcludedSections(strategy: ContextStrategy | undefined): Set<string> {
  const preset = getStrategyPreset(strategy);
  return new Set(preset.excludeSections);
}

const BUDGET_TOKEN_MAP: Record<string, number> = {
  minimal: 60_000,
  default: 150_000,
  extended: 190_000,
};

/** Get the token budget for a strategy (used by applyTokenBudget in buildPrompt). */
export function getStrategyTokenBudget(strategy: ContextStrategy | undefined): number {
  const preset = getStrategyPreset(strategy);
  return BUDGET_TOKEN_MAP[preset.budget] || BUDGET_TOKEN_MAP.default;
}

/** Get per-section priority overrides for the active strategy (used by buildPrompt). */
export function getStrategySectionPriorities(strategy: ContextStrategy | undefined): Record<string, number> {
  const preset = getStrategyPreset(strategy);
  return preset.sectionPriorities || {};
}

// Last resolved strategy — cached so buildPrompt can read it without extra DB call
let _lastResolvedStrategy: ContextStrategy = 'full';

/** Get the strategy that was resolved on the last getAgentStructuredContext call. */
export function getLastResolvedStrategy(): ContextStrategy {
  return _lastResolvedStrategy;
}

/**
 * Fetch structured context filtered by an agent's context profile.
 * Profile controls which sources to fetch, priority ordering, and exclusions.
 * Strategy mode (ELLIE-261) provides high-level presets; explicit settings override.
 */
export async function getAgentStructuredContext(
  supabase: SupabaseClient | null,
  agentName: string,
): Promise<string> {
  // Load agent profile from forest DB
  let profile: {
    sources?: string[] | 'all';
    priority?: string[];
    exclude?: string[];
    strategy?: ContextStrategy;
  } = {};
  try {
    const { getAgent } = await import('../../ellie-forest/src/index');
    const agent = await getAgent(agentName);
    if (agent?.context_profile) {
      profile = agent.context_profile as typeof profile;
    }
  } catch {
    // If forest DB unavailable, use all sources (graceful degradation)
  }

  const strategy = profile.strategy || 'full';
  const preset = getStrategyPreset(strategy);

  // Determine which sources to fetch:
  // Explicit sources > strategy sources > all
  // 'river' is a special source handled separately (needs agentName, not in SOURCE_REGISTRY)
  const SPECIAL_SOURCES = new Set(['river']);
  let sourceNames: string[];
  if (Array.isArray(profile.sources)) {
    sourceNames = profile.sources.filter(s => s in SOURCE_REGISTRY || SPECIAL_SOURCES.has(s));
  } else if (Array.isArray(preset.sources)) {
    sourceNames = preset.sources.filter(s => s in SOURCE_REGISTRY || SPECIAL_SOURCES.has(s));
  } else {
    sourceNames = [...ALL_SOURCE_NAMES, ...SPECIAL_SOURCES];
  }

  // Apply exclusions: merge strategy + explicit
  const allExclusions = new Set([
    ...(preset.exclude || []),
    ...(profile.exclude || []),
  ]);
  if (allExclusions.size > 0) {
    sourceNames = sourceNames.filter(s => !allExclusions.has(s));
  }

  // Split registry sources from special sources
  const registryNames = sourceNames.filter(s => s in SOURCE_REGISTRY);
  const includeRiver = sourceNames.includes('river');

  // Fetch all selected sources in parallel (ELLIE-327: with freshness tracking)
  // ELLIE-458/465: allSettled + per-source timeout so slow/failing sources never kill context
  // ELLIE-477: River fetched in parallel as special source (needs agentName)
  const rawEntries = await Promise.allSettled([
    ...registryNames.map(async (name) => {
      const start = Date.now();
      const timeoutMs = SOURCE_TIMEOUTS[name] ?? DEFAULT_SOURCE_TIMEOUT_MS;
      const content = await withTimeout(SOURCE_REGISTRY[name](supabase), timeoutMs, "");
      const latencyMs = Date.now() - start;
      freshnessTracker.recordFetch(name, latencyMs);
      return { name, content };
    }),
    // ELLIE-477: River context — agent-aware QMD search
    ...(includeRiver ? [
      (async () => {
        const start = Date.now();
        const content = await withTimeout(getRiverContextForAgent(agentName), SOURCE_TIMEOUTS.river ?? DEFAULT_SOURCE_TIMEOUT_MS, "");
        freshnessTracker.recordFetch("river", Date.now() - start);
        return { name: "river", content };
      })(),
    ] : []),
  ]);
  const allSourceNames = [...registryNames, ...(includeRiver ? ['river'] : [])];
  const entries = rawEntries.map((r, i) => {
    if (r.status === "rejected") {
      logger.warn(`Context source '${allSourceNames[i]}' failed`, { error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
      return { name: allSourceNames[i], content: "" };
    }
    return r.value;
  });

  // Apply priority ordering: explicit > strategy > default order
  const priorityList = profile.priority?.length ? profile.priority : preset.priority;
  if (priorityList?.length) {
    const prioritySet = new Set(priorityList);
    entries.sort((a, b) => {
      const aP = prioritySet.has(a.name) ? 0 : 1;
      const bP = prioritySet.has(b.name) ? 0 : 1;
      if (aP !== bP) return aP - bP;
      return sourceNames.indexOf(a.name) - sourceNames.indexOf(b.name);
    });
  }

  _lastResolvedStrategy = strategy;

  // ELLIE-327: Track the aggregate structured-context section freshness
  freshnessTracker.recordFetch("structured-context", 0);

  return entries.map(e => e.content).filter(Boolean).join("\n\n");
}

/**
 * Fetch all structured context sources in parallel.
 * Returns a single formatted string for prompt injection.
 * Backward-compatible wrapper — uses the general agent's profile (all sources).
 */
export async function getStructuredContext(
  supabase: SupabaseClient | null,
): Promise<string> {
  return getAgentStructuredContext(supabase, 'general');
}

/**
 * ELLIE-327: Refresh a single source by name and return its content.
 * Used by auto-refresh when a critical source is stale.
 */
export async function refreshSource(
  name: string,
  supabase: SupabaseClient | null,
): Promise<string> {
  const fetcher = SOURCE_REGISTRY[name];
  if (!fetcher) return "";

  const start = Date.now();
  const content = await fetcher(supabase);
  const latencyMs = Date.now() - start;
  freshnessTracker.recordFetch(name, latencyMs);
  freshnessTracker.logRefreshComplete(name, latencyMs);
  return content;
}

// ============================================================
// AGENT MEMORY CONTEXT (ELLIE-136)
// ============================================================

/** Model-based memory limits — capped at 5 to reduce context bloat (ELLIE-627) */
export function getMaxMemoriesForModel(model?: string | null): number {
  if (!model) return 5;
  if (model.includes('haiku')) return 3;
  if (model.includes('sonnet')) return 5;
  return 5; // opus and other large models
}

import { resolveEntityName } from './agent-entity-map.ts';

export interface AgentSessionContext {
  /** Formatted memory text for prompt injection */
  memoryContext: string;
  /** Active session IDs for memory write protocol */
  sessionIds?: {
    tree_id: string;
    branch_id?: string;
    creature_id?: string;
    entity_id?: string;
    work_item_id?: string;
  };
}

/**
 * Retrieve agent memory context from the forest for prompt injection.
 * Looks up the agent's entity, finds active forest tree (by work item or most recent),
 * calls getAgentContext() for compounding memories, and returns session IDs for writes.
 */
export async function getAgentMemoryContext(
  agentName: string,
  workItemId?: string,
  maxMemories?: number,
): Promise<AgentSessionContext> {
  const empty: AgentSessionContext = { memoryContext: '' };
  const fetchStart = Date.now();

  try {
    const {
      getAgentContext, getEntity, getWorkSessionByPlaneId,
      getCrossAgentContext, getOrGenerateDigest, getAgent,
    } = await import('../../ellie-forest/src/index');

    // Resolve entity
    const entityName = resolveEntityName(agentName);
    const entity = await getEntity(entityName);
    if (!entity) return empty;

    // Find active tree — prefer explicit work item ID, fall back to growing tree for this entity
    let tree: Tree | null = null;
    if (workItemId) {
      tree = await getWorkSessionByPlaneId(workItemId);
    }
    if (!tree) {
      // No explicit work item — check for a growing tree this agent is actively working on
      const { default: forestSql } = await import('../../ellie-forest/src/db');
      const [activeTree] = await forestSql<Tree[]>`
        SELECT DISTINCT t.* FROM trees t
        JOIN creatures c ON c.tree_id = t.id
        WHERE t.type = 'work_session' AND t.state = 'growing'
          AND c.entity_id = ${entity.id}
        ORDER BY t.last_activity DESC LIMIT 1
      `;
      if (activeTree) {
        tree = activeTree;
        logger.info("Found growing tree for entity (no explicit work item)", { treeId: tree.id.slice(0, 8), entityName });
      }
    }
    if (!tree) return empty;

    // Find this agent's branch and creature on the tree
    const { default: sql } = await import('../../ellie-forest/src/db');
    const [branch] = await sql<{ id: string }[]>`
      SELECT id FROM branches WHERE tree_id = ${tree.id} AND entity_id = ${entity.id} AND state = 'open' LIMIT 1
    `;
    const [creature] = await sql<{ id: string }[]>`
      SELECT id FROM creatures WHERE tree_id = ${tree.id} AND entity_id = ${entity.id} AND state IN ('pending', 'dispatched', 'working') LIMIT 1
    `;

    // ELLIE-640: Tier-aware memory retrieval
    const { getCoreMemories, getActiveGoals } = await import('../../ellie-forest/src/index');

    // Tier 1: Core memories — always injected (identity, constraints, preferences)
    let memoryContext = '';
    try {
      const coreMemories = await getCoreMemories({ limit: 50 });
      if (coreMemories.length > 0) {
        const coreLines = coreMemories.map((m: { content: string; category: string }) => {
          return `  [${m.category}] ${m.content}`;
        });
        memoryContext = `\nCORE MEMORY (always-loaded identity & preferences — ${coreMemories.length} facts):\n${coreLines.join('\n')}`;
      }
    } catch (err) {
      logger.warn("Core memory fetch failed", { agent: agentName }, err);
    }

    // Tier 3: Active goals — injected alongside Core
    try {
      const activeGoals = await getActiveGoals({ limit: 20 });
      if (activeGoals.length > 0) {
        const goalLines = activeGoals.map((g: { content: string; goal_status: string | null; goal_progress: number | null; goal_deadline: Date | null }) => {
          const status = g.goal_status ? `[${g.goal_status}]` : '';
          const progress = g.goal_progress != null ? ` ${Math.round(g.goal_progress * 100)}%` : '';
          const deadline = g.goal_deadline ? ` (due: ${new Date(g.goal_deadline).toISOString().slice(0, 10)})` : '';
          return `  ${status} ${g.content}${progress}${deadline}`;
        });
        memoryContext += `\n\nACTIVE GOALS (${activeGoals.length}):\n${goalLines.join('\n')}`;
      }
    } catch (err) {
      logger.warn("Active goals fetch failed", { agent: agentName }, err);
    }

    // Tier 2: Extended memories — session-scoped, retrieved on-demand
    const memories = await getAgentContext({
      tree_id: tree.id,
      branch_id: branch?.id,
      entity_id: entity.id,
      max_memories: maxMemories ?? 15,
      include_global: true,
    });

    if (memories.length > 0) {
      const lines = memories.map((m: MemorySearchResult) => {
        const scope = m.scope === 'global' ? '[global]' : m.scope === 'tree' ? '[session]' : `[${m.scope}]`;
        const conf = m.confidence ? ` (confidence: ${m.confidence.toFixed(1)})` : '';
        return `  ${scope} ${m.content}${conf}`;
      });
      memoryContext +=
        `\n\nSESSION MEMORY (${memories.length} extended memories from past sessions):` +
        `\n${lines.join('\n')}`;
    }

    // Cross-agent pull (ELLIE-178)
    try {
      const agent = await getAgent(agentName);
      const crossMemories = await getCrossAgentContext({
        tree_id: tree.id,
        entity_id: entity.id,
        species: agent?.species,
        max_memories: 10,
      });

      if (crossMemories.length > 0) {
        const crossLines = crossMemories.map((m: MemorySearchResult & { source_agent_species?: string }) => {
          const species = m.source_agent_species ? `[${m.source_agent_species}]` : '[agent]';
          const conf = m.confidence ? ` (confidence: ${m.confidence.toFixed(1)})` : '';
          return `  ${species} ${m.content}${conf}`;
        });
        memoryContext += `\n\nTEAM CONTEXT (what other agents have learned):\n${crossLines.join('\n')}`;
      }

      // Session digest (ELLIE-178 Layer 2)
      const digest = await getOrGenerateDigest({ tree_id: tree.id });
      if (digest) {
        const dc = digest.digest_content as AgentDigest['digest_content'];
        const parts: string[] = [];
        if (dc.decisions?.length) parts.push(`  Decisions: ${dc.decisions.join('; ')}`);
        if (dc.facts_learned?.length) parts.push(`  Facts learned: ${dc.facts_learned.join('; ')}`);
        if (dc.hypotheses?.length) parts.push(`  Hypotheses: ${dc.hypotheses.join('; ')}`);
        if (dc.active_threads?.length) parts.push(`  Active threads: ${dc.active_threads.slice(0, 5).join('; ')}`);
        if (parts.length > 0) {
          memoryContext += `\n\nSESSION DIGEST (recent team activity):\n${parts.join('\n')}`;
        }
      }
    } catch (err) {
      logger.warn("Cross-agent context failed", { agent: agentName }, err);
    }

    // ELLIE-327: Track agent memory freshness
    freshnessTracker.recordFetch("agent-memory", Date.now() - fetchStart);

    return {
      memoryContext,
      sessionIds: {
        tree_id: tree.id,
        branch_id: branch?.id,
        creature_id: creature?.id,
        entity_id: entity.id,
        work_item_id: tree.work_item_id ?? workItemId,
      },
    };
  } catch (err) {
    logger.warn("Agent memory context failed", { agent: agentName }, err);
    return empty;
  }
}

// ============================================================
// LIVE FOREST CONTEXT — Active incidents, contradictions,
// creature status, person mentions
// ============================================================

/**
 * Active incidents (P0/P1/P2). Surfaced at high priority so
 * every agent knows when something is on fire.
 */
export async function getActiveIncidentContext(): Promise<string> {
  try {
    const { listIncidents, getIncidentSummary } = await import("../../ellie-forest/src/incidents");
    const incidents = await listIncidents({ state: ["seedling", "growing"] });
    if (!incidents.length) return "";

    const parts: string[] = [];
    for (const inc of incidents.slice(0, 3)) {
      const severity = inc.metadata?.severity || "unknown";
      const summary = await getIncidentSummary(inc.id);
      const desc = (summary as Record<string, unknown> | null)?.status || inc.metadata?.description || "Active incident";
      parts.push(`[${String(severity).toUpperCase()}] ${inc.title || "Untitled"}: ${desc}`);
    }
    return `ACTIVE INCIDENTS (${incidents.length}):\n${parts.join("\n")}`;
  } catch (err) {
    logger.warn("Active incident context failed", err);
    return "";
  }
}

/**
 * Unresolved contradictions in the forest knowledge graph.
 * Helps agents avoid repeating conflicting information.
 */
export async function getContradictionContext(): Promise<string> {
  try {
    const { listUnresolvedContradictions } = await import("../../ellie-forest/src/shared-memory");
    const contradictions = await listUnresolvedContradictions();
    if (!contradictions.length) return "";

    const items = contradictions.slice(0, 5).map(
      (c) => `- ${c.content} (confidence: ${c.confidence ?? "?"})`
    );
    return `UNRESOLVED CONTRADICTIONS (${contradictions.length} total):\n${items.join("\n")}`;
  } catch (err) {
    logger.warn("Contradiction context failed", err);
    return "";
  }
}

/**
 * Active creatures — tasks currently being worked on across the forest.
 * Gives the agent awareness of what's in flight.
 */
export async function getCreatureStatusContext(): Promise<string> {
  try {
    const { getActiveCreatures } = await import("../../ellie-forest/src/creatures");
    const creatures = await getActiveCreatures();
    if (!creatures.length) return "";

    const items = creatures.slice(0, 8).map((c) => {
      const state = c.state || "unknown";
      const entity = (c as Record<string, unknown>).entity_name || c.entity_id?.substring(0, 8) || "unassigned";
      return `- [${state}] ${c.intent || c.species} (${entity})`;
    });
    return `ACTIVE WORK (${creatures.length} creatures):\n${items.join("\n")}`;
  } catch (err) {
    logger.warn("Creature status context failed", err);
    return "";
  }
}

/**
 * Detect person names mentioned in the user message and pull their
 * forest context (groups, notes). Only fires if a known person
 * name appears in the text.
 */
export async function getPersonMentionContext(text: string): Promise<string> {
  try {
    const { listPeople, getPersonGroups } = await import("../../ellie-forest/src/people");
    const people = await listPeople();
    if (!people.length) return "";

    const lower = text.toLowerCase();
    const mentioned = people.filter(
      (p) => p.name && p.name.length > 2 && lower.includes(p.name.toLowerCase())
    );
    if (!mentioned.length) return "";

    const parts: string[] = [];
    for (const person of mentioned.slice(0, 3)) {
      const groups = await getPersonGroups(person.id);
      const groupNames = groups.map((g: Record<string, unknown>) => g.name).filter(Boolean).join(", ");
      const note = person.notes || "";
      parts.push(`${person.name}${groupNames ? ` (${groupNames})` : ""}${note ? `: ${note}` : ""}`);
    }
    return `MENTIONED PEOPLE:\n${parts.join("\n")}`;
  } catch (err) {
    logger.warn("Person mention context failed", err);
    return "";
  }
}

/**
 * Combined live forest context. Fetches all four sources in parallel.
 * Returns { incidents, awareness } so callers can inject at different priorities.
 *   - incidents: P0/P1 alerts → high priority (always visible)
 *   - awareness: contradictions + creatures + person mentions → normal priority
 */
export async function getLiveForestContext(
  userMessage?: string,
): Promise<{ incidents: string; awareness: string }> {
  const start = Date.now();
  // ELLIE-458: allSettled so one failing Forest call doesn't kill all awareness context
  // ELLIE-465: Forest lookups get 6s — they can legitimately take longer
  const [incidentsR, contradictionsR, creaturesR, personMentionsR] = await Promise.allSettled([
    withTimeout(getActiveIncidentContext(), 6_000, ""),
    withTimeout(getContradictionContext(), 6_000, ""),
    withTimeout(getCreatureStatusContext(), 6_000, ""),
    userMessage ? withTimeout(getPersonMentionContext(userMessage), 6_000, "") : Promise.resolve(""),
  ]);
  const incidents = incidentsR.status === "fulfilled" ? incidentsR.value : "";
  const contradictions = contradictionsR.status === "fulfilled" ? contradictionsR.value : "";
  const creatures = creaturesR.status === "fulfilled" ? creaturesR.value : "";
  const personMentions = personMentionsR.status === "fulfilled" ? personMentionsR.value : "";

  // ELLIE-327: Track forest awareness freshness
  const latencyMs = Date.now() - start;
  if (incidents) freshnessTracker.recordFetch("incidents", latencyMs);
  freshnessTracker.recordFetch("forest-awareness", latencyMs);

  const awarenessParts = [contradictions, creatures, personMentions].filter(Boolean);
  return {
    incidents,
    awareness: awarenessParts.join("\n\n"),
  };
}

// ============================================================
// RIVER CONTEXT — ELLIE-150: Role-relevant QMD docs at dispatch
// ============================================================

const RIVER_QUERIES_BY_AGENT: Record<string, string> = {
  dev:      'architecture code implementation ellie-dev system design',
  strategy: 'goals projects planning strategy overview',
  research: 'research analysis findings insights knowledge',
  content:  'content writing communication messaging',
  finance:  'finance budget costs tracking',
  general:  'system overview architecture documentation',
}

/**
 * Query the River (QMD) for documents relevant to the agent's role
 * and optional work item context. Returns a formatted context block
 * for injection as forestContext in buildPrompt().
 *
 * Non-fatal — returns '' on any failure.
 */
export async function getRiverContextForAgent(
  agentType: string,
  workItemDescription?: string,
): Promise<string> {
  try {
    const { searchRiver } = await import('./api/bridge-river.ts');

    const roleQuery = RIVER_QUERIES_BY_AGENT[agentType] ?? 'system architecture documentation';

    // Run both queries in parallel; role-based + work-item-specific
    const [roleSettled, itemSettled] = await Promise.allSettled([
      searchRiver(roleQuery, 3),
      workItemDescription
        ? searchRiver(workItemDescription.slice(0, 120), 3)
        : Promise.resolve([]),
    ]);
    const roleResults = roleSettled.status === "fulfilled" ? roleSettled.value : [];
    const itemResults = itemSettled.status === "fulfilled" ? itemSettled.value : [];

    // Merge, dedupe by docid, take top 4
    const seen = new Set<string>();
    const combined = [...roleResults, ...itemResults].filter(r => {
      if (seen.has(r.docid)) return false;
      seen.add(r.docid);
      return true;
    }).slice(0, 4);

    if (combined.length === 0) return '';

    const lines = combined.map(r => {
      const path = r.file.replace('qmd://ellie-river/', '');
      const snippet = r.snippet.replace(/@@ .+ @@\n/, '').slice(0, 200).trim();
      return `• ${r.title || path}\n  ${snippet}`;
    });

    return `\nRIVER CONTEXT (relevant docs from Obsidian vault):\n${lines.join('\n\n')}\n`;
  } catch {
    return '';
  }
}
