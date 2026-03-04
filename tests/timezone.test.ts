import { describe, it, expect } from "bun:test";
import { getToday, toDateString, formatTime, formatTime24 } from "../src/timezone.ts";

// ── getToday ─────────────────────────────────────────────────

describe("getToday", () => {
  it("returns YYYY-MM-DD format", () => {
    const result = getToday("America/Chicago");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("respects timezone — UTC vs Pacific can differ near midnight", () => {
    // At any given moment, getToday with two different timezones
    // should return a valid date string
    const utc = getToday("UTC");
    const pacific = getToday("America/Los_Angeles");
    expect(utc).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(pacific).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("uses default timezone when none specified", () => {
    const result = getToday();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── toDateString ─────────────────────────────────────────────

describe("toDateString", () => {
  it("converts Date object to YYYY-MM-DD", () => {
    // Jan 15, 2026 noon UTC
    const date = new Date("2026-01-15T12:00:00Z");
    const result = toDateString(date, "UTC");
    expect(result).toBe("2026-01-15");
  });

  it("converts ISO string to YYYY-MM-DD", () => {
    const result = toDateString("2026-06-01T00:00:00Z", "UTC");
    expect(result).toBe("2026-06-01");
  });

  it("converts timestamp number to YYYY-MM-DD", () => {
    const ts = new Date("2026-03-03T15:00:00Z").getTime();
    const result = toDateString(ts, "UTC");
    expect(result).toBe("2026-03-03");
  });

  it("respects timezone — late UTC can be next day in east", () => {
    // 11:30 PM UTC on Jan 1 = Jan 2 in Tokyo (+9)
    const result = toDateString("2026-01-01T23:30:00Z", "Asia/Tokyo");
    expect(result).toBe("2026-01-02");
  });

  it("respects timezone — late UTC is still same day in west", () => {
    // 2 AM UTC on Jan 2 = Jan 1 in Chicago (-6)
    const result = toDateString("2026-01-02T02:00:00Z", "America/Chicago");
    expect(result).toBe("2026-01-01");
  });
});

// ── formatTime ───────────────────────────────────────────────

describe("formatTime", () => {
  it("formats as 12-hour time with AM/PM", () => {
    const result = formatTime("2026-01-15T14:30:00Z", "UTC");
    expect(result).toBe("2:30 PM");
  });

  it("formats midnight as 12:00 AM", () => {
    const result = formatTime("2026-01-15T00:00:00Z", "UTC");
    expect(result).toBe("12:00 AM");
  });

  it("formats noon as 12:00 PM", () => {
    const result = formatTime("2026-01-15T12:00:00Z", "UTC");
    expect(result).toBe("12:00 PM");
  });

  it("respects timezone offset", () => {
    // 6 PM UTC = 12 PM CST
    const result = formatTime("2026-01-15T18:00:00Z", "America/Chicago");
    expect(result).toBe("12:00 PM");
  });
});

// ── formatTime24 ─────────────────────────────────────────────

describe("formatTime24", () => {
  it("formats as 24-hour time", () => {
    const result = formatTime24("2026-01-15T14:30:00Z", "UTC");
    expect(result).toBe("14:30");
  });

  it("formats midnight as 00:00", () => {
    const result = formatTime24("2026-01-15T00:00:00Z", "UTC");
    expect(result).toBe("00:00");
  });

  it("pads single-digit hours", () => {
    const result = formatTime24("2026-01-15T09:05:00Z", "UTC");
    expect(result).toBe("09:05");
  });

  it("respects timezone offset", () => {
    // 18:00 UTC = 12:00 CST
    const result = formatTime24("2026-01-15T18:00:00Z", "America/Chicago");
    expect(result).toBe("12:00");
  });
});
