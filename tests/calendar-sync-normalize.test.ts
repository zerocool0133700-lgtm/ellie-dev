/**
 * Service Tests: Calendar Sync Normalization — ELLIE-713
 *
 * Tests Google and O365 event normalization (pure functions).
 */

import { describe, test, expect, mock } from "bun:test";

mock.module("../../ellie-forest/src/index.ts", () => ({
  sql: Object.assign(() => [], { json: (v: unknown) => v }),
}));
mock.module("../src/context-sources.ts", () => ({
  googleAccounts: [],
  getAccessTokenForAccount: mock(async () => ""),
}));
mock.module("../src/outlook.ts", () => ({
  isOutlookConfigured: mock(() => false),
}));
mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
mock.module("ical.js", () => ({
  default: { parse: () => [], Component: class {} },
}));
mock.module("../src/calendar-sync-state.ts", () => ({
  processSyncCycle: mock(async () => ({ recorded: 0, missesIncremented: 0, staleDetected: 0, deleted: 0 })),
  makeSyncStateDeps: mock(() => ({})),
}));
mock.module("../src/timezone.ts", () => ({
  USER_TIMEZONE: "America/Chicago",
  getToday: () => "2026-03-14",
  toDateString: (ts: number) => new Date(ts).toISOString().slice(0, 10),
}));

import { _testing } from "../src/calendar-sync.ts";
const { normalizeGoogleEvent, normalizeO365Event } = _testing;

describe("calendar sync normalization", () => {
  describe("normalizeGoogleEvent", () => {
    test("normalizes timed event", () => {
      const event = {
        id: "google-1",
        status: "confirmed",
        summary: "Team Standup",
        start: { dateTime: "2026-03-15T09:00:00-06:00", timeZone: "America/Chicago" },
        end: { dateTime: "2026-03-15T09:30:00-06:00" },
      };

      const result = normalizeGoogleEvent(event, "work", "primary");
      expect(result.external_id).toBe("google-1");
      expect(result.provider).toBe("google");
      expect(result.title).toBe("Team Standup");
      expect(result.all_day).toBe(false);
      expect(result.start_time).toBe("2026-03-15T09:00:00-06:00");
      expect(result.status).toBe("confirmed");
      expect(result.timezone).toBe("America/Chicago");
    });

    test("normalizes all-day event", () => {
      const event = {
        id: "google-2",
        summary: "Holiday",
        start: { date: "2026-03-20" },
        end: { date: "2026-03-21" },
      };

      const result = normalizeGoogleEvent(event, "personal", "primary");
      expect(result.all_day).toBe(true);
      expect(result.start_time).toContain("2026-03-20T00:00:00");
    });

    test("extracts meeting URL from conferenceData", () => {
      const event = {
        id: "google-3",
        summary: "Video Call",
        start: { dateTime: "2026-03-15T10:00:00Z" },
        end: { dateTime: "2026-03-15T11:00:00Z" },
        conferenceData: {
          entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-def" }],
        },
      };

      const result = normalizeGoogleEvent(event, "work", "primary");
      expect(result.meeting_url).toBe("https://meet.google.com/abc-def");
    });

    test("falls back to hangoutLink", () => {
      const event = {
        id: "google-4",
        summary: "Quick Call",
        start: { dateTime: "2026-03-15T10:00:00Z" },
        end: { dateTime: "2026-03-15T10:30:00Z" },
        hangoutLink: "https://hangouts.google.com/xyz",
      };

      const result = normalizeGoogleEvent(event, "work", "primary");
      expect(result.meeting_url).toBe("https://hangouts.google.com/xyz");
    });

    test("handles missing title", () => {
      const event = {
        id: "google-5",
        start: { dateTime: "2026-03-15T10:00:00Z" },
        end: { dateTime: "2026-03-15T11:00:00Z" },
      };

      const result = normalizeGoogleEvent(event, "work", "primary");
      expect(result.title).toBe("(no title)");
    });

    test("maps attendees", () => {
      const event = {
        id: "google-6",
        summary: "Meeting",
        start: { dateTime: "2026-03-15T10:00:00Z" },
        end: { dateTime: "2026-03-15T11:00:00Z" },
        attendees: [
          { displayName: "Alice", email: "alice@test.com", responseStatus: "accepted" },
          { email: "bob@test.com", responseStatus: "tentative" },
        ],
      };

      const result = normalizeGoogleEvent(event, "work", "primary");
      expect(result.attendees).toHaveLength(2);
      expect(result.attendees[0].name).toBe("Alice");
      expect(result.attendees[0].status).toBe("accepted");
    });

    test("detects recurring events", () => {
      const event = {
        id: "google-7",
        summary: "Weekly Sync",
        start: { dateTime: "2026-03-15T10:00:00Z" },
        end: { dateTime: "2026-03-15T11:00:00Z" },
        recurringEventId: "original-event-id",
        recurrence: ["RRULE:FREQ=WEEKLY"],
      };

      const result = normalizeGoogleEvent(event, "work", "primary");
      expect(result.recurring).toBe(true);
    });
  });

  describe("normalizeO365Event", () => {
    test("normalizes basic event", () => {
      const event = {
        id: "o365-1",
        subject: "Team Meeting",
        start: { dateTime: "2026-03-15T15:00:00.0000000", timeZone: "UTC" },
        end: { dateTime: "2026-03-15T16:00:00.0000000" },
      };

      const result = normalizeO365Event(event);
      expect(result.external_id).toBe("o365-1");
      expect(result.provider).toBe("outlook");
      expect(result.title).toBe("Team Meeting");
    });

    test("handles all-day event", () => {
      const event = {
        id: "o365-2",
        subject: "Holiday",
        isAllDay: true,
        start: { dateTime: "2026-03-20T00:00:00.0000000" },
        end: { dateTime: "2026-03-21T00:00:00.0000000" },
      };

      const result = normalizeO365Event(event);
      expect(result.all_day).toBe(true);
    });

    test("extracts meeting URL", () => {
      const event = {
        id: "o365-3",
        subject: "Teams Call",
        start: { dateTime: "2026-03-15T10:00:00.0000000" },
        end: { dateTime: "2026-03-15T11:00:00.0000000" },
        onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup/abc" },
      };

      const result = normalizeO365Event(event);
      expect(result.meeting_url).toBe("https://teams.microsoft.com/l/meetup/abc");
    });

    test("maps O365 attendees", () => {
      const event = {
        id: "o365-4",
        subject: "Meeting",
        start: { dateTime: "2026-03-15T10:00:00.0000000" },
        end: { dateTime: "2026-03-15T11:00:00.0000000" },
        attendees: [
          { emailAddress: { name: "Carol", address: "carol@test.com" }, status: { response: "accepted" } },
        ],
      };

      const result = normalizeO365Event(event);
      expect(result.attendees).toHaveLength(1);
      expect(result.attendees[0].name).toBe("Carol");
      expect(result.attendees[0].email).toBe("carol@test.com");
    });

    test("handles missing subject", () => {
      const event = {
        id: "o365-5",
        start: { dateTime: "2026-03-15T10:00:00.0000000" },
        end: { dateTime: "2026-03-15T11:00:00.0000000" },
      };

      const result = normalizeO365Event(event);
      expect(result.title).toBe("(no title)");
    });
  });
});
