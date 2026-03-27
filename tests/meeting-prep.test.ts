import { describe, it, expect } from "bun:test";

describe("ELLIE-1068: Meeting prep", () => {
  it("exports generateMeetingPrep", async () => {
    const mod = await import("../src/meeting-prep.ts");
    expect(typeof mod.generateMeetingPrep).toBe("function");
  });

  it("MeetingPrepBrief has required fields", () => {
    const brief = {
      personName: "Alex",
      relationship: { meetingCount: 5, lastSeen: "2026-03-20", channels: ["voice"], score: 3.5, status: "active" },
      commitments: { open: 2, overdue: 1, items: [] },
      topics: ["pricing", "roadmap"],
      talkingPoints: ["Follow up on overdue: Send pricing doc"],
      formatted: "## Prep: Meeting with Alex\n...",
    };
    expect(brief.personName).toBe("Alex");
    expect(brief.talkingPoints.length).toBe(1);
  });
});
