/**
 * ELLIE-514 — API layer tests: briefing pure functions.
 *
 * Tests calculatePriority() and formatBriefingMarkdown() without
 * touching any I/O or external services.
 */

import { describe, test, expect, mock } from "bun:test";

// ── Mocks (must be before imports) ───────────────────────────────────────────

mock.module("grammy", () => ({
  InputFile: class {},
  Bot: class {},
}));

mock.module("../src/tts.ts", () => ({
  textToSpeechOgg: mock(async () => null),
  getTTSProviderInfo: mock(() => ({ current: null })),
}));

mock.module("../src/ums/consumers/calendar-intel.ts", () => ({
  getCalendarInsights: mock(() => []),
  clearInsights: mock(() => {}),
}));

mock.module("../src/google-chat.ts", () => ({
  sendGoogleChatMessage: mock(async () => {}),
  isGoogleChatEnabled: mock(() => false),
}));

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

mock.module("../src/timezone.ts", () => ({
  USER_TIMEZONE: "UTC",
  getToday: () => "2026-03-04",
  formatTime: (s: string) => s,
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import {
  calculatePriority,
  formatBriefingMarkdown,
  type BriefingSection,
} from "../src/api/briefing.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSection(
  items: Array<{ text: string; urgency?: "high" | "normal" | "low"; detail?: string }>,
  overrides: Partial<Omit<BriefingSection, "items">> = {},
): BriefingSection {
  return {
    key: "test",
    title: "Test Section",
    icon: "🔧",
    priority: 1,
    items,
    ...overrides,
  };
}

// ── calculatePriority ─────────────────────────────────────────────────────────

describe("calculatePriority", () => {
  test("returns 0 for empty sections array", () => {
    expect(calculatePriority([])).toBe(0);
  });

  test("returns 0 for sections with no items", () => {
    expect(calculatePriority([makeSection([])])).toBe(0);
  });

  test("scores high urgency items at 20 each", () => {
    const section = makeSection([
      { text: "A", urgency: "high" },
      { text: "B", urgency: "high" },
    ]);
    expect(calculatePriority([section])).toBe(40);
  });

  test("scores normal urgency items at 5 each", () => {
    const section = makeSection([
      { text: "A", urgency: "normal" },
      { text: "B", urgency: "normal" },
    ]);
    expect(calculatePriority([section])).toBe(10);
  });

  test("scores low urgency items at 1 each", () => {
    const section = makeSection([
      { text: "A", urgency: "low" },
      { text: "B", urgency: "low" },
      { text: "C", urgency: "low" },
    ]);
    expect(calculatePriority([section])).toBe(3);
  });

  test("scores undefined urgency as 1 (falls to else branch)", () => {
    const section = makeSection([{ text: "A" }]);
    expect(calculatePriority([section])).toBe(1);
  });

  test("sums across multiple sections", () => {
    const s1 = makeSection([{ text: "A", urgency: "high" }]);   // 20
    const s2 = makeSection([{ text: "B", urgency: "normal" }]); // 5
    expect(calculatePriority([s1, s2])).toBe(25);
  });

  test("caps total at 100", () => {
    // 10 high-urgency items × 20 = 200 → capped at 100
    const items = Array.from({ length: 10 }, (_, i) => ({
      text: `Item ${i}`,
      urgency: "high" as const,
    }));
    expect(calculatePriority([makeSection(items)])).toBe(100);
  });

  test("mixed urgencies sum correctly before cap", () => {
    const section = makeSection([
      { text: "A", urgency: "high" },   // 20
      { text: "B", urgency: "normal" }, //  5
      { text: "C", urgency: "low" },    //  1
    ]);
    expect(calculatePriority([section])).toBe(26);
  });

  test("empty items in a section contribute 0", () => {
    const s1 = makeSection([]);
    const s2 = makeSection([{ text: "X", urgency: "normal" }]);
    expect(calculatePriority([s1, s2])).toBe(5);
  });
});

// ── formatBriefingMarkdown ────────────────────────────────────────────────────

describe("formatBriefingMarkdown", () => {
  const DATE = "2026-03-04";

  test("starts with 'Daily Briefing' in the first line", () => {
    const out = formatBriefingMarkdown([], DATE);
    expect(out.split("\n")[0]).toContain("Daily Briefing");
  });

  test("header includes the month name", () => {
    const out = formatBriefingMarkdown([], DATE);
    expect(out).toContain("March");
  });

  test("skips sections with no items", () => {
    const section = makeSection([], { title: "Empty Section" });
    const out = formatBriefingMarkdown([section], DATE);
    expect(out).not.toContain("Empty Section");
  });

  test("includes non-empty section title in bold", () => {
    const section = makeSection(
      [{ text: "Item A", urgency: "normal" }],
      { title: "My Section", icon: "📋" },
    );
    const out = formatBriefingMarkdown([section], DATE);
    expect(out).toContain("**My Section**");
  });

  test("includes section icon", () => {
    const section = makeSection(
      [{ text: "task", urgency: "normal" }],
      { icon: "🎯" },
    );
    const out = formatBriefingMarkdown([section], DATE);
    expect(out).toContain("🎯");
  });

  test("uses 🔴 marker for high urgency items", () => {
    const section = makeSection([{ text: "urgent", urgency: "high" }]);
    const out = formatBriefingMarkdown([section], DATE);
    expect(out).toContain("\u{1F534}");
  });

  test("uses ▸ marker for normal urgency items", () => {
    const section = makeSection([{ text: "normal", urgency: "normal" }]);
    const out = formatBriefingMarkdown([section], DATE);
    expect(out).toContain("\u25B8");
  });

  test("uses ◦ marker for low urgency items", () => {
    const section = makeSection([{ text: "low", urgency: "low" }]);
    const out = formatBriefingMarkdown([section], DATE);
    expect(out).toContain("\u25E6");
  });

  test("includes item text in output", () => {
    const section = makeSection([{ text: "My important task", urgency: "normal" }]);
    const out = formatBriefingMarkdown([section], DATE);
    expect(out).toContain("My important task");
  });

  test("includes detail line when provided", () => {
    const section = makeSection([
      { text: "A task", detail: "Due tomorrow", urgency: "normal" },
    ]);
    const out = formatBriefingMarkdown([section], DATE);
    expect(out).toContain("Due tomorrow");
  });

  test("omits detail line when not provided", () => {
    const section = makeSection([{ text: "A task", urgency: "normal" }]);
    const out = formatBriefingMarkdown([section], DATE);
    // No 4-space-indented detail lines should appear
    const detailLines = out.split("\n").filter(l => l.startsWith("    "));
    expect(detailLines.length).toBe(0);
  });

  test("multiple sections all appear in output", () => {
    const s1 = makeSection([{ text: "Task A", urgency: "normal" }], { title: "Section One" });
    const s2 = makeSection([{ text: "Task B", urgency: "low" }], { title: "Section Two" });
    const out = formatBriefingMarkdown([s1, s2], DATE);
    expect(out).toContain("Section One");
    expect(out).toContain("Section Two");
  });

  test("output does not end with trailing whitespace", () => {
    const section = makeSection([{ text: "Task", urgency: "normal" }]);
    const out = formatBriefingMarkdown([section], DATE);
    expect(out).toBe(out.trimEnd());
  });

  test("sections with only empty items are omitted", () => {
    const empty = makeSection([], { title: "Skipped" });
    const filled = makeSection([{ text: "X", urgency: "low" }], { title: "Included" });
    const out = formatBriefingMarkdown([empty, filled], DATE);
    expect(out).not.toContain("Skipped");
    expect(out).toContain("Included");
  });
});
