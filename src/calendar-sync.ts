/**
 * Calendar Sync Engine
 *
 * Fetches events from Google Calendar and O365, normalizes them,
 * and upserts into the ellie-forest calendar_events table.
 */

import { sql } from "../../ellie-forest/src/index.ts";
import { googleAccounts, getAccessTokenForAccount, type GoogleAccount } from "./context-sources.ts";
import { isOutlookConfigured } from "./outlook.ts";
import { log } from "./logger.ts";
import ICAL from "ical.js";

const logger = log.child("calendar");

// ============================================================
// TYPES
// ============================================================

export interface CalendarEvent {
  external_id: string;
  provider: "google" | "outlook" | "apple";
  calendar_id: string;
  calendar_name: string;
  account_label: string;
  title: string;
  description?: string;
  location?: string;
  start_time: string;
  end_time?: string;
  timezone: string;
  all_day: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  recurring: boolean;
  recurrence_rule?: string;
  attendees: Array<{ email?: string; name?: string; status?: string }>;
  organizer?: string;
  meeting_url?: string;
  color?: string;
  reminders: number[];
  raw_data: Record<string, unknown>;
  last_synced: string;
}

const USER_TIMEZONE = "America/Chicago";

/** Shape for a Google Calendar API event response (based on actual usage) */
interface GoogleCalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  hangoutLink?: string;
  recurringEventId?: string;
  recurrence?: string[];
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string };
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  attendees?: Array<{ displayName?: string; email?: string; responseStatus?: string }>;
  organizer?: { email?: string };
  reminders?: { overrides?: Array<{ minutes: number }> };
}

/** Shape for an O365/Microsoft Graph calendar event response (based on actual usage) */
interface O365CalendarEvent {
  id: string;
  subject?: string;
  body?: { content?: string };
  location?: { displayName?: string };
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string };
  isAllDay?: boolean;
  recurrence?: Record<string, unknown>;
  attendees?: Array<{ emailAddress?: { name?: string; address?: string }; status?: { response?: string } }>;
  organizer?: { emailAddress?: { address?: string } };
  onlineMeetingUrl?: string;
  onlineMeeting?: { joinUrl?: string };
}

// ============================================================
// GOOGLE CALENDAR
// ============================================================

async function fetchGoogleEvents(token: string, calendarId = "primary"): Promise<GoogleCalendarEvent[]> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: windowEnd.toISOString(),
    maxResults: "50",
    singleEvents: "true",
    orderBy: "startTime",
  });

  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!res.ok) {
      logger.error("Google fetch failed", { status: res.status, calendarId });
      return [];
    }

    const data = await res.json();
    return data.items || [];
  } catch (err: unknown) {
    logger.error("Google fetch error", err instanceof Error ? err.message : String(err));
    return [];
  }
}

function normalizeGoogleEvent(event: GoogleCalendarEvent, accountLabel: string, calendarId: string): CalendarEvent {
  const isAllDay = !event.start?.dateTime;
  const startRaw = event.start?.dateTime || event.start?.date || "";
  const endRaw = event.end?.dateTime || event.end?.date || "";

  // For all-day events, Google gives bare dates like "2026-02-22"
  // Append timezone offset to avoid UTC interpretation
  const startTime = isAllDay ? `${startRaw}T00:00:00-06:00` : startRaw;
  const endTime = endRaw ? (isAllDay ? `${endRaw}T00:00:00-06:00` : endRaw) : undefined;

  // Extract meeting URL
  const meetingUrl =
    event.conferenceData?.entryPoints?.find((e: { entryPointType?: string; uri?: string }) => e.entryPointType === "video")?.uri ||
    event.hangoutLink ||
    undefined;

  const statusMap: Record<string, "confirmed" | "tentative" | "cancelled"> = {
    confirmed: "confirmed",
    tentative: "tentative",
    cancelled: "cancelled",
  };

  return {
    external_id: event.id,
    provider: "google",
    calendar_id: calendarId,
    calendar_name: accountLabel,
    account_label: accountLabel,
    title: event.summary || "(no title)",
    description: event.description || undefined,
    location: event.location || undefined,
    start_time: startTime,
    end_time: endTime,
    timezone: event.start?.timeZone || USER_TIMEZONE,
    all_day: isAllDay,
    status: statusMap[event.status] || "confirmed",
    recurring: !!event.recurringEventId,
    recurrence_rule: event.recurrence?.[0] || undefined,
    attendees: (event.attendees || []).map((a: { displayName?: string; email?: string; responseStatus?: string }) => ({
      name: a.displayName,
      email: a.email,
      status: a.responseStatus,
    })),
    organizer: event.organizer?.email || undefined,
    meeting_url: meetingUrl,
    color: undefined,
    reminders: event.reminders?.overrides?.map((r: { minutes: number }) => r.minutes) || [],
    raw_data: event as unknown as Record<string, unknown>,
    last_synced: new Date().toISOString(),
  };
}

async function upsertEvents(events: CalendarEvent[]): Promise<number> {
  let count = 0;
  for (const e of events) {
    try {
      await sql`
        INSERT INTO calendar_events (
          external_id, provider, calendar_id, calendar_name, account_label,
          title, description, location, start_time, end_time, timezone,
          all_day, status, recurring, recurrence_rule, attendees, organizer,
          meeting_url, color, reminders, raw_data, last_synced
        ) VALUES (
          ${e.external_id}, ${e.provider}, ${e.calendar_id}, ${e.calendar_name}, ${e.account_label},
          ${e.title}, ${e.description || null}, ${e.location || null}, ${e.start_time}, ${e.end_time || null}, ${e.timezone},
          ${e.all_day}, ${e.status}, ${e.recurring}, ${e.recurrence_rule || null}, ${sql.json(e.attendees)}, ${e.organizer || null},
          ${e.meeting_url || null}, ${e.color || null}, ${sql.json(e.reminders)}, ${sql.json(e.raw_data)}, ${e.last_synced}
        )
        ON CONFLICT (provider, external_id) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          location = EXCLUDED.location,
          start_time = EXCLUDED.start_time,
          end_time = EXCLUDED.end_time,
          timezone = EXCLUDED.timezone,
          all_day = EXCLUDED.all_day,
          status = EXCLUDED.status,
          recurring = EXCLUDED.recurring,
          recurrence_rule = EXCLUDED.recurrence_rule,
          attendees = EXCLUDED.attendees,
          organizer = EXCLUDED.organizer,
          meeting_url = EXCLUDED.meeting_url,
          raw_data = EXCLUDED.raw_data,
          last_synced = EXCLUDED.last_synced,
          updated_at = NOW()
      `;
      count++;
    } catch (err: unknown) {
      logger.error("Upsert error", { external_id: e.external_id }, err instanceof Error ? err.message : String(err));
    }
  }
  return count;
}

async function syncGoogleAccount(account: GoogleAccount): Promise<number> {
  const token = await getAccessTokenForAccount(account);
  if (!token) {
    logger.error("No token for Google account", { account: account.label });
    return 0;
  }

  const rawEvents = await fetchGoogleEvents(token);
  if (!rawEvents.length) return 0;

  const normalized = rawEvents
    .filter((e: GoogleCalendarEvent) => e.status !== "cancelled")
    .map((e: GoogleCalendarEvent) => normalizeGoogleEvent(e, account.label, "primary"));

  if (!normalized.length) return 0;
  return upsertEvents(normalized);
}

// ============================================================
// O365 CALENDAR (Microsoft Graph)
// ============================================================

const MS_TOKEN_ENDPOINT = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";

interface MsCachedToken {
  accessToken: string;
  expiresAt: number;
}

let msCalendarToken: MsCachedToken | null = null;

function msEnv(key: string): string {
  return process.env[key] || "";
}

async function getMsCalendarToken(): Promise<string | null> {
  if (msCalendarToken && Date.now() < msCalendarToken.expiresAt - 60_000) {
    return msCalendarToken.accessToken;
  }

  try {
    const res = await fetch(MS_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: msEnv("MICROSOFT_CLIENT_ID"),
        client_secret: msEnv("MICROSOFT_CLIENT_SECRET"),
        refresh_token: msEnv("MICROSOFT_REFRESH_TOKEN"),
        grant_type: "refresh_token",
        scope: "Calendars.Read Mail.Read Mail.Send Mail.ReadWrite offline_access User.Read",
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error("O365 token refresh failed", { status: res.status, body: body.substring(0, 200) });
      return null;
    }

    const data = await res.json();
    msCalendarToken = {
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    };
    return msCalendarToken.accessToken;
  } catch (err: unknown) {
    logger.error("O365 token error", err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function fetchO365Events(token: string): Promise<O365CalendarEvent[]> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    startDateTime: now.toISOString(),
    endDateTime: windowEnd.toISOString(),
    $top: "50",
    $orderby: "start/dateTime",
    $select: "id,subject,body,location,start,end,isAllDay,showAs,recurrence,attendees,organizer,onlineMeeting,onlineMeetingUrl,webLink",
  });

  try {
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/me/calendarView?${params}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Prefer: `outlook.timezone="${USER_TIMEZONE}"`,
        },
      }
    );

    if (!res.ok) {
      logger.error("O365 fetch failed", { status: res.status });
      return [];
    }

    const data = await res.json();
    return data.value || [];
  } catch (err: unknown) {
    logger.error("O365 fetch error", err instanceof Error ? err.message : String(err));
    return [];
  }
}

function normalizeO365Event(event: O365CalendarEvent): CalendarEvent {
  return {
    external_id: event.id,
    provider: "outlook",
    calendar_id: "primary",
    calendar_name: "Outlook",
    account_label: "outlook",
    title: event.subject || "(no title)",
    description: event.body?.content || undefined,
    location: event.location?.displayName || undefined,
    start_time: event.start?.dateTime
      ? new Date(event.start.dateTime + "Z").toISOString()
      : "",
    end_time: event.end?.dateTime
      ? new Date(event.end.dateTime + "Z").toISOString()
      : undefined,
    timezone: event.start?.timeZone || USER_TIMEZONE,
    all_day: event.isAllDay || false,
    status: "confirmed",
    recurring: !!event.recurrence,
    recurrence_rule: event.recurrence ? JSON.stringify(event.recurrence) : undefined,
    attendees: (event.attendees || []).map((a: { emailAddress?: { name?: string; address?: string }; status?: { response?: string } }) => ({
      name: a.emailAddress?.name,
      email: a.emailAddress?.address,
      status: a.status?.response || "none",
    })),
    organizer: event.organizer?.emailAddress?.address || undefined,
    meeting_url: event.onlineMeetingUrl || event.onlineMeeting?.joinUrl || undefined,
    color: undefined,
    reminders: [],
    raw_data: event as unknown as Record<string, unknown>,
    last_synced: new Date().toISOString(),
  };
}

async function syncO365Calendar(): Promise<number> {
  if (!isOutlookConfigured()) return 0;

  const token = await getMsCalendarToken();
  if (!token) {
    logger.error("O365 token refresh failed");
    return 0;
  }

  const rawEvents = await fetchO365Events(token);
  if (!rawEvents.length) return 0;

  const normalized = rawEvents.map(normalizeO365Event);
  return upsertEvents(normalized);
}

// ============================================================
// APPLE CALENDAR (iCloud CalDAV)
// ============================================================

const APPLE_CALDAV_SERVER = "https://caldav.icloud.com";

// Calendars to skip (not real event calendars)
const APPLE_SKIP_CALENDARS = new Set(["Reminders ⚠️"]);

function isAppleConfigured(): boolean {
  return !!(process.env.APPLE_CALENDAR_USERNAME && process.env.APPLE_CALENDAR_APP_PASSWORD);
}

async function fetchAppleEvents(): Promise<CalendarEvent[]> {
  const { createDAVClient } = await import("tsdav");

  const client = await createDAVClient({
    serverUrl: APPLE_CALDAV_SERVER,
    credentials: {
      username: process.env.APPLE_CALENDAR_USERNAME!,
      password: process.env.APPLE_CALENDAR_APP_PASSWORD!,
    },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });

  const calendars = await client.fetchCalendars();
  const now = new Date();
  const windowEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const allEvents: CalendarEvent[] = [];

  for (const cal of calendars) {
    if (APPLE_SKIP_CALENDARS.has(cal.displayName || "")) continue;

    try {
      const objects = await client.fetchCalendarObjects({
        calendar: cal,
        timeRange: {
          start: now.toISOString(),
          end: windowEnd.toISOString(),
        },
      });

      for (const obj of objects) {
        if (!obj.data) continue;
        try {
          const events = parseICalEvents(obj.data, cal.displayName || "Apple");
          allEvents.push(...events);
        } catch (err: unknown) {
          logger.error("Apple iCal parse error", err instanceof Error ? err.message : String(err));
        }
      }
    } catch (err: unknown) {
      logger.error("Apple fetch error", { calendar: cal.displayName }, err instanceof Error ? err.message : String(err));
    }
  }

  return allEvents;
}

function parseICalEvents(icalData: string, calendarName: string): CalendarEvent[] {
  const jcal = ICAL.parse(icalData);
  const comp = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents("vevent");
  const results: CalendarEvent[] = [];

  for (const vevent of vevents) {
    const event = new ICAL.Event(vevent);
    const dtstart = vevent.getFirstProperty("dtstart");
    const isAllDay = dtstart?.type === "date";

    let startTime: string;
    let endTime: string | undefined;

    if (isAllDay) {
      // All-day: bare date → anchor to CST
      const startDate = event.startDate.toString(); // "YYYY-MM-DD"
      startTime = `${startDate}T00:00:00-06:00`;
      if (event.endDate) {
        endTime = `${event.endDate.toString()}T00:00:00-06:00`;
      }
    } else {
      startTime = event.startDate.toJSDate().toISOString();
      endTime = event.endDate ? event.endDate.toJSDate().toISOString() : undefined;
    }

    // Extract location (strip Apple's structured location artifacts)
    let location = vevent.getFirstPropertyValue("location") as string | null;
    if (location) {
      location = location.replace(/\\n/g, ", ").replace(/\\,/g, ",").trim();
    }

    // Check for meeting URL
    const urlProp = vevent.getFirstPropertyValue("url") as string | null;
    const meetingUrl = urlProp && urlProp.length > 5 ? urlProp : undefined;

    // Handle recurring events
    const rrule = vevent.getFirstPropertyValue("rrule");
    const isRecurring = !!rrule;

    // Attendees
    const attendees = vevent.getAllProperties("attendee").map((prop: ICAL.Property) => {
      const cn = prop.getParameter("cn") || "";
      const partstat = prop.getParameter("partstat") || "NEEDS-ACTION";
      const val = prop.getFirstValue() || "";
      const email = (val as string).replace(/^mailto:/i, "");
      return { name: cn as string, email, status: (partstat as string).toLowerCase() };
    });

    const organizer = vevent.getFirstProperty("organizer");
    const organizerEmail = organizer
      ? (organizer.getFirstValue() || "").replace(/^mailto:/i, "")
      : undefined;

    results.push({
      external_id: event.uid,
      provider: "apple",
      calendar_id: calendarName.toLowerCase().replace(/\s+/g, "-"),
      calendar_name: calendarName,
      account_label: "apple",
      title: event.summary || "(no title)",
      description: event.description || undefined,
      location: location || undefined,
      start_time: startTime,
      end_time: endTime,
      timezone: dtstart?.getParameter("tzid") || USER_TIMEZONE,
      all_day: isAllDay,
      status: "confirmed",
      recurring: isRecurring,
      recurrence_rule: rrule ? rrule.toString() : undefined,
      attendees,
      organizer: organizerEmail || undefined,
      meeting_url: meetingUrl,
      color: undefined,
      reminders: [],
      raw_data: { ical: icalData.substring(0, 2000) } as Record<string, unknown>,
      last_synced: new Date().toISOString(),
    });
  }

  return results;
}

async function syncAppleCalendar(): Promise<number> {
  if (!isAppleConfigured()) return 0;

  try {
    const events = await fetchAppleEvents();
    if (!events.length) return 0;
    return upsertEvents(events);
  } catch (err: unknown) {
    logger.error("Apple CalDAV error", err instanceof Error ? err.message : String(err));
    return 0;
  }
}

// ============================================================
// MASTER SYNC
// ============================================================

export async function syncAllCalendars(): Promise<void> {
  const startedAt = Date.now();
  let totalEvents = 0;

  // Google accounts
  for (const account of googleAccounts) {
    try {
      const count = await syncGoogleAccount(account);
      totalEvents += count;
    } catch (err: unknown) {
      logger.error("Google sync error", { account: account.label }, err instanceof Error ? err.message : String(err));
    }
  }

  // O365
  try {
    const count = await syncO365Calendar();
    totalEvents += count;
  } catch (err: unknown) {
    logger.error("O365 error", err instanceof Error ? err.message : String(err));
  }

  // Apple (iCloud CalDAV)
  try {
    const count = await syncAppleCalendar();
    totalEvents += count;
  } catch (err: unknown) {
    logger.error("Apple error", err instanceof Error ? err.message : String(err));
  }

  // Clean up old events (ended > 7 days ago)
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await sql`DELETE FROM calendar_events WHERE end_time < ${cutoff}`;
  } catch {
    // Non-critical
  }

  const elapsed = Date.now() - startedAt;
  console.log(`[calendar-sync] Synced ${totalEvents} events in ${elapsed}ms`);
}
