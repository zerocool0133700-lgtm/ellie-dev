/**
 * UMS Connector: Google Calendar
 *
 * ELLIE-299: Normalizes calendar events into UnifiedMessage format.
 * Works with the normalized CalendarEvent shape from calendar-sync.ts.
 */

import type { UMSConnector } from "../connector.ts";
import type { UnifiedMessageInsert } from "../types.ts";

interface CalendarEvent {
  external_id: string;
  provider?: string;
  calendar_id?: string;
  calendar_name?: string;
  title?: string;
  description?: string;
  location?: string;
  start_time?: string;
  end_time?: string;
  timezone?: string;
  all_day?: boolean;
  status?: string;
  recurring?: boolean;
  attendees?: { email?: string; name?: string; status?: string }[];
  organizer?: string;
  meeting_url?: string;
  raw_data?: Record<string, unknown>;
}

export const calendarConnector: UMSConnector = {
  provider: "calendar",

  normalize(rawPayload: unknown): UnifiedMessageInsert | null {
    const event = rawPayload as CalendarEvent;
    if (!event.external_id) return null;
    if (event.status === "cancelled") return null;

    const attendeeNames = (event.attendees || [])
      .map(a => a.name || a.email)
      .filter(Boolean)
      .slice(0, 5);

    const timeStr = event.start_time
      ? new Date(event.start_time).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
      : "TBD";

    const parts = [`Meeting: ${event.title || "Untitled"}`];
    if (attendeeNames.length) parts.push(`with ${attendeeNames.join(", ")}`);
    parts.push(`at ${timeStr}`);
    if (event.location) parts.push(`@ ${event.location}`);

    return {
      provider: "calendar",
      provider_id: event.external_id,
      channel: event.calendar_id || "primary",
      sender: event.organizer ? { email: event.organizer } : null,
      content: parts.join(" "),
      content_type: "event",
      raw: (event.raw_data || rawPayload) as Record<string, unknown>,
      provider_timestamp: event.start_time || null,
      metadata: {
        title: event.title,
        start_time: event.start_time,
        end_time: event.end_time,
        timezone: event.timezone,
        all_day: event.all_day,
        status: event.status,
        recurring: event.recurring,
        location: event.location,
        meeting_url: event.meeting_url,
        attendees: event.attendees,
        calendar_name: event.calendar_name,
      },
    };
  },
};
