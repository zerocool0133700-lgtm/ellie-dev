import { describe, test, expect } from "bun:test";
import { filterAwarenessByMode } from "../src/prompt-layers/awareness";
import type { Awareness, LayeredMode } from "../src/prompt-layers/types";

const MOCK_AWARENESS: Awareness = {
  work: {
    active_items: [
      { id: "ELLIE-459", title: "Phase 2 structural improvements", priority: "high", state: "In Progress" },
      { id: "ELLIE-500", title: "Forest cleanup", priority: "medium", state: "Todo" },
    ],
    recent_sessions: [
      { work_item_id: "ELLIE-450", title: "Memory weight classification", completed_at: "2026-04-05", summary: "All 7 tasks complete" },
    ],
    blocked_items: [],
  },
  conversations: {
    last_conversation: { id: "conv-1", topic: "Forest cleanup", agent: "ellie", last_message_at: "2026-04-05T22:00:00Z" },
    open_threads: [
      { id: "t-1", agent: "james", topic: "ELLIE-459 review", last_message_at: "2026-04-05T20:00:00Z", stale: false },
    ],
  },
  system: {
    incidents: [],
    agent_status: [
      { name: "james", status: "idle" },
      { name: "brian", status: "active", current_task: "code review" },
    ],
    creatures: [],
  },
  calendar: {
    next_event: { title: "Team standup", start: "2026-04-06T09:00:00", end: "2026-04-06T09:30:00" },
    today_count: 3,
  },
  heartbeat: {
    overdue_items: [],
    stale_threads: [],
    signals: [],
  },
};

describe("Layer 2: Awareness", () => {
  test("filterAwarenessByMode — voice-casual strips work and system", () => {
    const filtered = filterAwarenessByMode(MOCK_AWARENESS, "voice-casual");
    expect(filtered).toContain("Forest cleanup");           // last conversation
    expect(filtered).toContain("Team standup");              // next event
    expect(filtered).not.toContain("ELLIE-459");             // no work items
    expect(filtered).not.toContain("james");                 // no agent status
  });

  test("filterAwarenessByMode — dev-session includes work and system", () => {
    const filtered = filterAwarenessByMode(MOCK_AWARENESS, "dev-session");
    expect(filtered).toContain("ELLIE-459");
    expect(filtered).toContain("brian");
    expect(filtered).toContain("code review");
    expect(filtered).not.toContain("Team standup");          // no calendar in dev
  });

  test("filterAwarenessByMode — heartbeat shows overdue and signals", () => {
    const withOverdue: Awareness = {
      ...MOCK_AWARENESS,
      heartbeat: {
        overdue_items: [{ id: "ELLIE-100", title: "Overdue task", priority: "high", state: "In Progress" }],
        stale_threads: [{ id: "t-2", agent: "kate", topic: "Research", last_message_at: "2026-04-04T10:00:00Z", stale: true }],
        signals: [{ type: "overdue", summary: "ELLIE-100 is 3 days overdue", priority: "high" }],
      },
    };
    const filtered = filterAwarenessByMode(withOverdue, "heartbeat");
    expect(filtered).toContain("Overdue task");
    expect(filtered).toContain("3 days overdue");
  });

  test("filterAwarenessByMode — personal is minimal", () => {
    const filtered = filterAwarenessByMode(MOCK_AWARENESS, "personal");
    expect(filtered).toContain("Forest cleanup");           // last conversation
    expect(filtered).toContain("Team standup");              // next event
    expect(filtered).not.toContain("ELLIE-459");
    expect(filtered).not.toContain("brian");
  });

  test("filterAwarenessByMode — planning includes work + overdue heartbeat", () => {
    const filtered = filterAwarenessByMode(MOCK_AWARENESS, "planning");
    expect(filtered).toContain("ELLIE-459");
    expect(filtered).toContain("Forest cleanup");            // last conversation
    expect(filtered).toContain("3 events today");            // calendar count
  });

  test("renderAwareness stays under 2KB for any mode", () => {
    const modes: LayeredMode[] = ["voice-casual", "dev-session", "planning", "personal", "heartbeat"];
    for (const mode of modes) {
      const rendered = filterAwarenessByMode(MOCK_AWARENESS, mode);
      expect(new TextEncoder().encode(rendered).length).toBeLessThan(2048);
    }
  });
});
