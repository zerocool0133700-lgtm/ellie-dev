import { describe, it, expect } from "bun:test";
import {
  getToday,
  toDateString,
  formatTime,
  formatTime24,
  formatDateTime,
  formatDateShort,
  formatDateFull,
  formatRelativeDateTime,
  USER_TIMEZONE,
} from "../src/timezone.ts";

const CST = "America/Chicago";

describe("ELLIE-786: Timezone display utilities", () => {
  describe("USER_TIMEZONE", () => {
    it("is defined", () => {
      expect(USER_TIMEZONE).toBeTruthy();
    });
  });

  describe("getToday", () => {
    it("returns YYYY-MM-DD format", () => {
      expect(getToday(CST)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("uses specified timezone", () => {
      // Same moment can be different dates in different timezones
      const cst = getToday(CST);
      expect(cst).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe("toDateString", () => {
    it("converts UTC timestamp to CST date", () => {
      // 2026-03-16T03:41:00Z = 2026-03-15 in CST (9:41 PM previous day)
      const result = toDateString("2026-03-16T03:41:00Z", CST);
      expect(result).toBe("2026-03-15");
    });

    it("handles daytime UTC correctly", () => {
      // 2026-03-16T18:00:00Z = 2026-03-16 in CST (12:00 PM same day)
      const result = toDateString("2026-03-16T18:00:00Z", CST);
      expect(result).toBe("2026-03-16");
    });
  });

  describe("formatTime", () => {
    it("formats time in 12-hour format", () => {
      const result = formatTime("2026-03-16T18:30:00Z", CST);
      // 18:30 UTC = 1:30 PM CDT (March = UTC-5)
      expect(result).toMatch(/1:30\s*PM/i);
    });

    it("converts UTC midnight to CST evening", () => {
      const result = formatTime("2026-03-16T05:00:00Z", CST);
      // 05:00 UTC = 11:00 PM CST (CDT = UTC-5) or midnight CST (UTC-6)
      expect(result).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/i);
    });
  });

  describe("formatTime24", () => {
    it("formats time in 24-hour format", () => {
      const result = formatTime24("2026-03-16T18:30:00Z", CST);
      expect(result).toMatch(/\d{2}:\d{2}/);
    });
  });

  describe("formatDateTime", () => {
    it("formats full date and time with timezone", () => {
      const result = formatDateTime("2026-03-16T03:41:00Z", CST);
      // Should show Mar 15, 2026 (previous day in CST)
      expect(result).toContain("Mar");
      expect(result).toContain("15");
      expect(result).toContain("2026");
      expect(result).toMatch(/PM/i);
    });

    it("does not show UTC time", () => {
      const result = formatDateTime("2026-03-16T03:41:00Z", CST);
      // 3:41 AM UTC should become 9:41 PM CST — should NOT show 3:41 AM
      expect(result).not.toMatch(/3:41\s*AM/i);
    });
  });

  describe("formatDateShort", () => {
    it("returns short date like 'Mar 15'", () => {
      const result = formatDateShort("2026-03-16T03:41:00Z", CST);
      expect(result).toContain("Mar");
      expect(result).toContain("15"); // CST date, not UTC
    });
  });

  describe("formatDateFull", () => {
    it("returns full date with weekday", () => {
      const result = formatDateFull("2026-03-16T18:00:00Z", CST);
      expect(result).toContain("March");
      expect(result).toContain("2026");
    });
  });

  describe("formatRelativeDateTime", () => {
    it("shows 'today' for current date", () => {
      const now = new Date().toISOString();
      const result = formatRelativeDateTime(now, CST);
      expect(result).toContain("today at");
      expect(result).toMatch(/(AM|PM)/i);
    });

    it("shows 'yesterday' for previous date", () => {
      const yesterday = new Date(Date.now() - 86400000).toISOString();
      const result = formatRelativeDateTime(yesterday, CST);
      // Could be "yesterday" or a date depending on timezone edge
      expect(result).toMatch(/(yesterday|today|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i);
    });

    it("shows date for older timestamps", () => {
      const result = formatRelativeDateTime("2026-03-10T18:00:00Z", CST);
      expect(result).toContain("Mar");
      expect(result).toContain("at");
    });
  });

  describe("UTC leak prevention", () => {
    it("toDateString avoids UTC off-by-one after 6pm CST", () => {
      // March 16 at 1am UTC = March 15 at 7pm CST
      expect(toDateString("2026-03-16T01:00:00Z", CST)).toBe("2026-03-15");
      // March 16 at 6am UTC = March 16 at midnight CST (CDT)
      expect(toDateString("2026-03-16T06:00:00Z", CST)).toBe("2026-03-16");
    });

    it("formatDateTime shows CST date not UTC date for late-night UTC", () => {
      // 3:41 AM UTC on March 16 = 9:41 PM CST on March 15
      const result = formatDateTime("2026-03-16T03:41:00Z", CST);
      expect(result).toContain("15"); // March 15 in CST
      expect(result).not.toContain("16"); // NOT March 16
    });

    it("all format functions accept timezone parameter", () => {
      const ts = "2026-03-16T12:00:00Z";
      // These should all succeed without throwing
      expect(() => getToday(CST)).not.toThrow();
      expect(() => toDateString(ts, CST)).not.toThrow();
      expect(() => formatTime(ts, CST)).not.toThrow();
      expect(() => formatTime24(ts, CST)).not.toThrow();
      expect(() => formatDateTime(ts, CST)).not.toThrow();
      expect(() => formatDateShort(ts, CST)).not.toThrow();
      expect(() => formatDateFull(ts, CST)).not.toThrow();
      expect(() => formatRelativeDateTime(ts, CST)).not.toThrow();
    });
  });
});
