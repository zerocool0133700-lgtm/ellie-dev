/**
 * Service Tests: Calendar Linker — ELLIE-713
 *
 * Tests event keyword extraction and mention detection (pure functions).
 */

import { describe, test, expect, mock } from "bun:test";

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

import { _testing } from "../src/calendar-linker.ts";
const { eventKeywords, findEventMentions, STOP_WORDS } = _testing;

describe("calendar linker", () => {
  describe("eventKeywords", () => {
    test("extracts meaningful words", () => {
      const kw = eventKeywords("Team Sprint Planning Session");
      expect(kw).toContain("team");
      expect(kw).toContain("sprint");
      expect(kw).toContain("planning");
      expect(kw).toContain("session");
    });

    test("filters stop words", () => {
      const kw = eventKeywords("Meeting with the team");
      expect(kw).not.toContain("meeting");
      expect(kw).not.toContain("with");
      expect(kw).not.toContain("the");
      expect(kw).toContain("team");
    });

    test("filters short words (< 3 chars)", () => {
      const kw = eventKeywords("AI ML Dev Ops");
      expect(kw).not.toContain("ai");
      expect(kw).not.toContain("ml");
      expect(kw).toContain("dev");
      expect(kw).toContain("ops");
    });

    test("handles special characters", () => {
      const kw = eventKeywords("Q1 Budget — Review (Final)");
      expect(kw).toContain("budget");
      expect(kw).toContain("final");
    });

    test("returns empty for all-stop-word title", () => {
      const kw = eventKeywords("Meeting Call");
      expect(kw).toHaveLength(0);
    });

    test("lowercases all keywords", () => {
      const kw = eventKeywords("DevOps Platform");
      expect(kw.every(w => w === w.toLowerCase())).toBe(true);
    });
  });

  describe("findEventMentions", () => {
    const events = [
      {
        external_id: "e1",
        title: "Sprint Planning",
        start_time: "2026-03-15T10:00:00Z",
        end_time: null,
        attendees: null,
        location: null,
      },
      {
        external_id: "e2",
        title: "Product Design Review",
        start_time: "2026-03-15T14:00:00Z",
        end_time: null,
        attendees: [{ name: "Sarah", email: "sarah@test.com" }],
        location: null,
      },
      {
        external_id: "e3",
        title: "1:1 with James",
        start_time: "2026-03-16T09:00:00Z",
        end_time: null,
        attendees: [{ name: "James", email: "james@test.com" }],
        location: null,
      },
    ];

    test("matches exact title substring", () => {
      const matches = findEventMentions("Let's prepare for Sprint Planning tomorrow", events);
      expect(matches.length).toBe(1);
      expect(matches[0].event.external_id).toBe("e1");
      expect(matches[0].matchedOn).toContain("title");
    });

    test("matches by keyword overlap (2+ keywords)", () => {
      const matches = findEventMentions("We need to discuss the product design changes before tomorrow", events);
      expect(matches.some(m => m.event.external_id === "e2")).toBe(true);
    });

    test("matches attendee name with meeting context", () => {
      const matches = findEventMentions("I have a meeting with James today", events);
      expect(matches.some(m => m.event.external_id === "e3")).toBe(true);
      expect(matches.find(m => m.event.external_id === "e3")!.matchedOn).toContain("attendee");
    });

    test("does not match attendee without meeting context", () => {
      const matches = findEventMentions("James sent me an email about the report", events);
      expect(matches.some(m => m.matchedOn.includes("attendee"))).toBe(false);
    });

    test("skips events with empty titles", () => {
      const eventsWithEmpty = [...events, {
        external_id: "e4",
        title: "",
        start_time: "2026-03-15T10:00:00Z",
        end_time: null,
        attendees: null,
        location: null,
      }];
      const matches = findEventMentions("some random text", eventsWithEmpty);
      expect(matches.every(m => m.event.title !== "")).toBe(true);
    });

    test("returns empty for no matches", () => {
      const matches = findEventMentions("nothing relevant here", events);
      expect(matches).toHaveLength(0);
    });

    test("case-insensitive matching", () => {
      const matches = findEventMentions("sprint planning is important", events);
      expect(matches.length).toBeGreaterThan(0);
    });

    test("title match requires >= 5 chars", () => {
      const shortEvents = [{
        external_id: "e5",
        title: "Sync",  // only 4 chars — won't match as exact title
        start_time: "2026-03-15T10:00:00Z",
        end_time: null,
        attendees: null,
        location: null,
      }];
      const matches = findEventMentions("sync the data", shortEvents);
      expect(matches).toHaveLength(0);
    });
  });

  describe("STOP_WORDS", () => {
    test("contains generic meeting terms", () => {
      expect(STOP_WORDS.has("meeting")).toBe(true);
      expect(STOP_WORDS.has("call")).toBe(true);
      expect(STOP_WORDS.has("sync")).toBe(true);
    });

    test("contains common English articles", () => {
      expect(STOP_WORDS.has("the")).toBe(true);
      expect(STOP_WORDS.has("a")).toBe(true);
      expect(STOP_WORDS.has("an")).toBe(true);
    });
  });
});
