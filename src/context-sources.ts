/**
 * Context Sources
 *
 * Fetches structured data to enrich the conversation context.
 * Each source returns a concise text block suitable for prompt injection.
 * Called on every conversation start (via buildPrompt in relay.ts).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { listOpenIssues, isPlaneConfigured } from "./plane.ts";

const USER_TIMEZONE = process.env.USER_TIMEZONE || "America/Chicago";

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
      .select("channel, started_at, summary, message_count, status, agent")
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
        timeZone: USER_TIMEZONE,
      });
      const channel = c.channel || "telegram";
      const status = c.status || "closed";
      const agentLabel = c.agent && c.agent !== "general" ? `, ${c.agent}` : "";
      const msgs = c.message_count ? `, ${c.message_count} msgs` : "";
      const summary = c.summary
        ? c.summary.length > 150
          ? c.summary.substring(0, 150) + "..."
          : c.summary
        : "No summary";
      return `- [${channel}, ${status}${agentLabel}, ${time}${msgs}] ${summary}`;
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

  const data = await res.json();
  account.tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
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

  const data = await res.json();
  const events = data.items || [];

  const lines = events.map((e: any) => {
    const start = e.start?.dateTime || e.start?.date || "";
    const isAllDay = !e.start?.dateTime;
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
    return `- ${time}: ${e.summary || "(no title)"}${location}`;
  });

  return { label: account.label, lines };
}

/**
 * Fetch upcoming Google Calendar events (next 3 days) across all configured accounts.
 */
export async function getUpcomingCalendarEvents(): Promise<string> {
  if (!googleAccounts.length) return "";
  try {
    const results = await Promise.all(googleAccounts.map(getCalendarForAccount));
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
    console.error("[context] Failed to fetch calendar events:", error);
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
  const labelData = await labelRes.json();
  const unreadCount = labelData.messagesUnread || 0;

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
  const listData = await listRes.json();
  const messageIds = (listData.messages || []).map((m: any) => m.id);

  // Fetch metadata for each (in parallel)
  const headerPromises = messageIds.map(async (id: string) => {
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!msgRes.ok) return null;
    return msgRes.json();
  });

  const messages = (await Promise.all(headerPromises)).filter(Boolean);

  const lines = messages.map((msg: any) => {
    const headers = msg.payload?.headers || [];
    const from = headers.find((h: any) => h.name === "From")?.value || "Unknown";
    const subject = headers.find((h: any) => h.name === "Subject")?.value || "(no subject)";
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
    const results = await Promise.all(googleAccounts.map(getGmailSignalForAccount));
    const parts = results.filter(Boolean);
    if (!parts.length) return "GMAIL: No unread messages.";
    return "GMAIL:\n" + parts.join("\n") + "\n(Use mcp__google-workspace tools for full email content)";
  } catch (error) {
    console.error("[context] Failed to fetch Gmail signal:", error);
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
    const [unreadCount, recentMessages] = await Promise.all([
      outlookGetUnreadCount(),
      outlookListUnread(5),
    ]);

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
    console.error("[context] Failed to fetch Outlook signal:", error);
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

  const data = await res.json();
  const tasks = data.items || [];
  if (!tasks.length) return "";

  const lines = tasks.map((t: any) => {
    const due = t.due
      ? ` (due ${new Date(t.due).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          timeZone: USER_TIMEZONE,
        })})`
      : "";
    const notes = t.notes ? ` — ${t.notes.substring(0, 50)}` : "";
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
    const results = await Promise.all(googleAccounts.map(getGoogleTasksForAccount));
    const parts = results.filter(Boolean);
    if (!parts.length) return "";
    return "GOOGLE TASKS (pending):\n" + parts.join("\n");
  } catch (error) {
    console.error("[context] Failed to fetch Google Tasks:", error);
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

  const data = await res.json();
  const items = data.items || [];

  return {
    label: account.label,
    tasks: items.map((t: any) => ({
      id: t.id,
      title: t.title,
      notes: t.notes || undefined,
      due: t.due || undefined,
      status: t.status,
      updated: t.updated,
    })),
  };
}

export async function getGoogleTasksJSON(): Promise<{ accounts: { label: string; tasks: GoogleTaskItem[] }[] }> {
  if (!googleAccounts.length) return { accounts: [] };
  try {
    const accounts = await Promise.all(googleAccounts.map(getGoogleTasksJSONForAccount));
    return { accounts };
  } catch (error) {
    console.error("[context] Failed to fetch Google Tasks JSON:", error);
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

/**
 * Fetch structured context filtered by an agent's context profile.
 * Profile controls which sources to fetch, priority ordering, and exclusions.
 */
export async function getAgentStructuredContext(
  supabase: SupabaseClient | null,
  agentName: string,
): Promise<string> {
  // Load agent profile from forest DB
  let profile: { sources?: string[] | 'all'; priority?: string[]; exclude?: string[] } = {};
  try {
    const { getAgent } = await import('../../ellie-forest/src/index');
    const agent = await getAgent(agentName);
    if (agent?.context_profile) {
      profile = agent.context_profile as typeof profile;
    }
  } catch {
    // If forest DB unavailable, use all sources (graceful degradation)
  }

  // Determine which sources to fetch
  let sourceNames: string[];
  if (Array.isArray(profile.sources)) {
    sourceNames = profile.sources.filter(s => s in SOURCE_REGISTRY);
  } else {
    sourceNames = [...ALL_SOURCE_NAMES];
  }

  // Apply exclusions
  if (profile.exclude?.length) {
    sourceNames = sourceNames.filter(s => !profile.exclude!.includes(s));
  }

  // Fetch all selected sources in parallel
  const entries = await Promise.all(
    sourceNames.map(async (name) => ({
      name,
      content: await SOURCE_REGISTRY[name](supabase),
    }))
  );

  // Apply priority ordering: priority sources first, then the rest
  if (profile.priority?.length) {
    const prioritySet = new Set(profile.priority);
    entries.sort((a, b) => {
      const aP = prioritySet.has(a.name) ? 0 : 1;
      const bP = prioritySet.has(b.name) ? 0 : 1;
      if (aP !== bP) return aP - bP;
      // Within same priority tier, maintain original order
      return sourceNames.indexOf(a.name) - sourceNames.indexOf(b.name);
    });
  }

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

// ============================================================
// AGENT MEMORY CONTEXT (ELLIE-136)
// ============================================================

/** Model-based memory limits — smaller models get fewer memories to stay within context */
export function getMaxMemoriesForModel(model?: string | null): number {
  if (!model) return 15;
  if (model.includes('haiku')) return 8;
  if (model.includes('sonnet')) return 15;
  return 20; // opus and other large models
}

/** Agent name → forest entity name mapping */
const AGENT_ENTITY_MAP: Record<string, string> = {
  dev: 'dev_agent', research: 'research_agent', critic: 'critic_agent',
  content: 'content_agent', finance: 'finance_agent', strategy: 'strategy_agent',
  general: 'general_agent',
};

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

  try {
    const {
      getAgentContext, getEntity, getWorkSessionByPlaneId,
      getCrossAgentContext, getOrGenerateDigest, getAgent,
    } = await import('../../ellie-forest/src/index');

    // Resolve entity
    const entityName = AGENT_ENTITY_MAP[agentName] ?? agentName;
    const entity = await getEntity(entityName);
    if (!entity) return empty;

    // Find active tree — prefer explicit work item ID, fall back to growing tree for this entity
    let tree: any = null;
    if (workItemId) {
      tree = await getWorkSessionByPlaneId(workItemId);
    }
    if (!tree) {
      // No explicit work item — check for a growing tree this agent is actively working on
      const { default: forestSql } = await import('../../ellie-forest/src/db');
      const [activeTree] = await forestSql`
        SELECT DISTINCT t.* FROM trees t
        JOIN creatures c ON c.tree_id = t.id
        WHERE t.type = 'work_session' AND t.state = 'growing'
          AND c.entity_id = ${entity.id}
        ORDER BY t.last_activity DESC LIMIT 1
      `;
      if (activeTree) {
        tree = activeTree;
        console.log(`[context] Found growing tree ${tree.id.slice(0, 8)} for ${entityName} (no explicit work item)`);
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

    // Retrieve memories
    const memories = await getAgentContext({
      tree_id: tree.id,
      branch_id: branch?.id,
      entity_id: entity.id,
      max_memories: maxMemories ?? 15,
      include_global: true,
    });

    // Format memories for prompt
    let memoryContext = '';
    if (memories.length > 0) {
      const lines = memories.map((m: any) => {
        const scope = m.scope === 'global' ? '[global]' : m.scope === 'tree' ? '[session]' : `[${m.scope}]`;
        const conf = m.confidence ? ` (confidence: ${m.confidence.toFixed(1)})` : '';
        return `  ${scope} ${m.content}${conf}`;
      });
      memoryContext =
        `\nAGENT MEMORY CONTEXT (${memories.length} memories from past sessions):` +
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
        const crossLines = crossMemories.map((m: any) => {
          const species = m.source_agent_species ? `[${m.source_agent_species}]` : '[agent]';
          const conf = m.confidence ? ` (confidence: ${m.confidence.toFixed(1)})` : '';
          return `  ${species} ${m.content}${conf}`;
        });
        memoryContext += `\n\nTEAM CONTEXT (what other agents have learned):\n${crossLines.join('\n')}`;
      }

      // Session digest (ELLIE-178 Layer 2)
      const digest = await getOrGenerateDigest({ tree_id: tree.id });
      if (digest) {
        const dc = digest.digest_content as any;
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
      console.warn(`[context] Cross-agent context failed for ${agentName}:`, err);
    }

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
    console.warn(`[context] Agent memory context failed for ${agentName}:`, err);
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
    const incidents = await listIncidents({ state: ["active", "investigating"] });
    if (!incidents.length) return "";

    const parts: string[] = [];
    for (const inc of incidents.slice(0, 3)) {
      const severity = (inc.metadata as any)?.severity || "unknown";
      const summary = await getIncidentSummary(inc.id);
      const desc = summary?.status || (inc.metadata as any)?.description || "Active incident";
      parts.push(`[${String(severity).toUpperCase()}] ${inc.name}: ${desc}`);
    }
    return `ACTIVE INCIDENTS (${incidents.length}):\n${parts.join("\n")}`;
  } catch (err) {
    console.warn("[context] Active incident context failed:", err);
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
    console.warn("[context] Contradiction context failed:", err);
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
      const entity = (c as any).entity_name || c.entity_id?.substring(0, 8) || "unassigned";
      return `- [${state}] ${c.intent || c.species} (${entity})`;
    });
    return `ACTIVE WORK (${creatures.length} creatures):\n${items.join("\n")}`;
  } catch (err) {
    console.warn("[context] Creature status context failed:", err);
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
      const groupNames = groups.map((g: any) => g.name).filter(Boolean).join(", ");
      const note = (person as any).notes || "";
      parts.push(`${person.name}${groupNames ? ` (${groupNames})` : ""}${note ? `: ${note}` : ""}`);
    }
    return `MENTIONED PEOPLE:\n${parts.join("\n")}`;
  } catch (err) {
    console.warn("[context] Person mention context failed:", err);
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
  const [incidents, contradictions, creatures, personMentions] = await Promise.all([
    getActiveIncidentContext(),
    getContradictionContext(),
    getCreatureStatusContext(),
    userMessage ? getPersonMentionContext(userMessage) : Promise.resolve(""),
  ]);

  const awarenessParts = [contradictions, creatures, personMentions].filter(Boolean);
  return {
    incidents,
    awareness: awarenessParts.join("\n\n"),
  };
}
