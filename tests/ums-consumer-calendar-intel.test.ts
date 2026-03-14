/**
 * UMS Consumer Tests: Calendar Intel — ELLIE-709
 */

import { describe, test, expect } from "bun:test";
import { _testing } from "../src/ums/consumers/calendar-intel.ts";

const { classifyMeeting, estimateEnergyCost, needsPrep } = _testing;

describe("calendar-intel consumer", () => {
  describe("classifyMeeting", () => {
    test("all-day events → personal", () => {
      expect(classifyMeeting("All-Day Workshop", 10, true)).toBe("personal");
    });

    test("standup → recurring_standup", () => {
      expect(classifyMeeting("Daily Standup", 5, false)).toBe("recurring_standup");
      expect(classifyMeeting("Morning Stand-up", 3, false)).toBe("recurring_standup");
      expect(classifyMeeting("Team Scrum", 4, false)).toBe("recurring_standup");
    });

    test("1:1 title → one_on_one", () => {
      expect(classifyMeeting("1:1 with Alice", 2, false)).toBe("one_on_one");
      expect(classifyMeeting("One-on-One", 2, false)).toBe("one_on_one");
    });

    test("focus time → focus_block", () => {
      expect(classifyMeeting("Focus Time", 1, false)).toBe("focus_block");
      expect(classifyMeeting("Deep Work Block", 1, false)).toBe("focus_block");
    });

    test("personal events → personal", () => {
      expect(classifyMeeting("Lunch with Dave", 2, false)).toBe("personal");
      expect(classifyMeeting("Dentist Appointment", 1, false)).toBe("personal");
      expect(classifyMeeting("Gym Session", 1, false)).toBe("personal");
    });

    test("large attendee count → large_meeting", () => {
      expect(classifyMeeting("Team Review", 8, false)).toBe("large_meeting");
    });

    test("3-4 attendees → small_group", () => {
      expect(classifyMeeting("Sprint Planning", 4, false)).toBe("small_group");
    });

    test("2 attendees → one_on_one", () => {
      expect(classifyMeeting("Chat with Bob", 2, false)).toBe("one_on_one");
    });

    test("unknown with 0-1 attendees → unknown", () => {
      expect(classifyMeeting("Something", 0, false)).toBe("unknown");
    });
  });

  describe("estimateEnergyCost", () => {
    test("large_meeting → high", () => {
      expect(estimateEnergyCost("large_meeting", 10)).toBe("high");
    });

    test("one_on_one → medium", () => {
      expect(estimateEnergyCost("one_on_one", 2)).toBe("medium");
    });

    test("recurring_standup → low", () => {
      expect(estimateEnergyCost("recurring_standup", 5)).toBe("low");
    });

    test("focus_block → low", () => {
      expect(estimateEnergyCost("focus_block", 1)).toBe("low");
    });

    test("personal → low", () => {
      expect(estimateEnergyCost("personal", 1)).toBe("low");
    });

    test("external → high", () => {
      expect(estimateEnergyCost("external", 3)).toBe("high");
    });

    test("unknown with many attendees → high", () => {
      expect(estimateEnergyCost("unknown", 10)).toBe("high");
    });

    test("unknown with few attendees → medium", () => {
      expect(estimateEnergyCost("unknown", 3)).toBe("medium");
    });
  });

  describe("needsPrep", () => {
    test("returns true for prep keywords", () => {
      expect(needsPrep("Quarterly Review", 3)).toBe(true);
      expect(needsPrep("Demo for Client", 3)).toBe(true);
      expect(needsPrep("Product Presentation", 3)).toBe(true);
      expect(needsPrep("Job Interview", 2)).toBe(true);
      expect(needsPrep("Sales Pitch", 2)).toBe(true);
      expect(needsPrep("Sprint Planning", 5)).toBe(true);
      expect(needsPrep("Weekly Retro", 4)).toBe(true);
    });

    test("returns true for large meetings (>= threshold)", () => {
      expect(needsPrep("Random Meeting", 5)).toBe(true);
      expect(needsPrep("Random Meeting", 10)).toBe(true);
    });

    test("returns false for small casual meetings", () => {
      expect(needsPrep("Coffee Chat", 2)).toBe(false);
      expect(needsPrep("Quick Sync", 3)).toBe(false);
    });

    test("case insensitive", () => {
      expect(needsPrep("DEMO SESSION", 2)).toBe(true);
      expect(needsPrep("sprint PLANNING", 2)).toBe(true);
    });

    test("returns true for 1:1 (keyword match)", () => {
      expect(needsPrep("1:1 with Manager", 2)).toBe(true);
    });

    test("returns true for standup (keyword match)", () => {
      expect(needsPrep("Daily Standup", 3)).toBe(true);
    });
  });
});
