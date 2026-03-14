/**
 * UMS Connector Tests: Calendar — ELLIE-708
 */

import { describe, test, expect } from "bun:test";
import { calendarConnector } from "../src/ums/connectors/calendar.ts";
import { calendarFixtures as fx } from "./fixtures/ums-connector-payloads.ts";

describe("calendarConnector", () => {
  test("provider is 'calendar'", () => {
    expect(calendarConnector.provider).toBe("calendar");
  });

  test("normalizes a full calendar event", () => {
    const result = calendarConnector.normalize(fx.basicEvent);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("calendar");
    expect(result!.provider_id).toBe("evt-001");
    expect(result!.channel).toBe("primary");
    expect(result!.content_type).toBe("event");
    expect(result!.content).toContain("Meeting: Team Standup");
    expect(result!.content).toContain("with Dave, Alice");
    expect(result!.content).toContain("@ Room 5A");
    expect(result!.sender).toEqual({ email: "dave@example.com" });
    expect(result!.provider_timestamp).toBe("2026-03-14T09:00:00Z");
    expect(result!.metadata).toMatchObject({
      title: "Team Standup",
      timezone: "America/Chicago",
      all_day: false,
      status: "confirmed",
      recurring: true,
      location: "Room 5A",
      meeting_url: "https://meet.google.com/abc-def",
      calendar_name: "Work Calendar",
    });
    expect(result!.metadata!.attendees).toHaveLength(2);
  });

  test("skips cancelled events", () => {
    expect(calendarConnector.normalize(fx.cancelledEvent)).toBeNull();
  });

  test("normalizes minimal event (id only)", () => {
    const result = calendarConnector.normalize(fx.minimalEvent);
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Meeting: Untitled");
    expect(result!.channel).toBe("primary"); // no calendar_id fallback
    expect(result!.sender).toBeNull(); // no organizer
  });

  test("normalizes event with no attendees", () => {
    const result = calendarConnector.normalize(fx.noAttendees);
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Meeting: Focus Time");
    expect(result!.content).not.toContain("with ");
  });

  test("returns null when external_id is missing", () => {
    expect(calendarConnector.normalize(fx.noId)).toBeNull();
  });

  test("returns null for empty payload", () => {
    expect(calendarConnector.normalize(fx.empty)).toBeNull();
  });
});
