/**
 * ELLIE-514 — API layer tests: analytics pure functions.
 *
 * Tests parsePeriod() and aggregateMetrics() without hitting Supabase.
 * parsePeriod handles both single dates (YYYY-MM-DD) and ISO weeks (YYYY-Wnn).
 * aggregateMetrics sums 10 numeric fields across rows, averaging scores.
 */

import { describe, test, expect, mock } from "bun:test";

// ── Mock timezone — makes toDateString deterministic across environments ──────
//
// The real toDateString uses USER_TIMEZONE (America/Chicago) which can
// shift boundaries when running in UTC CI. We replace it with a UTC-based
// formatter so test expectations are environment-independent.

mock.module("../src/timezone.ts", () => ({
  getToday: () => "2026-03-04",
  toDateString: (ts: number) => new Date(ts).toISOString().slice(0, 10),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { parsePeriod, aggregateMetrics } from "../src/api/analytics-module.ts";

// ── parsePeriod — single date ─────────────────────────────────────────────────

describe("parsePeriod — single date", () => {
  test("start equals the input date", () => {
    expect(parsePeriod("2026-03-04").start).toBe("2026-03-04");
  });

  test("end is the next calendar day", () => {
    expect(parsePeriod("2026-03-04").end).toBe("2026-03-05");
  });

  test("month boundary: March 31 → April 1", () => {
    const r = parsePeriod("2026-03-31");
    expect(r.start).toBe("2026-03-31");
    expect(r.end).toBe("2026-04-01");
  });

  test("year boundary: Dec 31 → Jan 1", () => {
    const r = parsePeriod("2026-12-31");
    expect(r.start).toBe("2026-12-31");
    expect(r.end).toBe("2027-01-01");
  });

  test("returns object with start and end keys", () => {
    const r = parsePeriod("2026-01-15");
    expect(r).toHaveProperty("start");
    expect(r).toHaveProperty("end");
  });
});

// ── parsePeriod — ISO week ────────────────────────────────────────────────────

describe("parsePeriod — ISO week", () => {
  test("returns start and end as date strings", () => {
    const r = parsePeriod("2026-W08");
    expect(typeof r.start).toBe("string");
    expect(typeof r.end).toBe("string");
  });

  test("start and end match YYYY-MM-DD format", () => {
    const r = parsePeriod("2026-W08");
    expect(r.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("end is exactly 7 days after start", () => {
    const r = parsePeriod("2026-W08");
    const diff = new Date(r.end).getTime() - new Date(r.start).getTime();
    expect(diff).toBe(7 * 86_400_000);
  });

  test("different weeks produce different start dates", () => {
    const w8 = parsePeriod("2026-W08");
    const w9 = parsePeriod("2026-W09");
    expect(w8.start).not.toBe(w9.start);
  });

  test("consecutive weeks are adjacent — week N end === week N+1 start", () => {
    const w8 = parsePeriod("2026-W08");
    const w9 = parsePeriod("2026-W09");
    expect(w8.end).toBe(w9.start);
  });

  test("W01 start is in early January", () => {
    const r = parsePeriod("2026-W01");
    expect(r.start.startsWith("2026-0")).toBe(true);
  });
});

// ── aggregateMetrics ──────────────────────────────────────────────────────────

describe("aggregateMetrics — empty input", () => {
  test("returns all zero fields for empty array", () => {
    const r = aggregateMetrics([]);
    expect(r.total_min).toBe(0);
    expect(r.deep_work_min).toBe(0);
    expect(r.meetings_min).toBe(0);
    expect(r.communication_min).toBe(0);
    expect(r.admin_min).toBe(0);
    expect(r.personal_min).toBe(0);
    expect(r.focus_blocks).toBe(0);
    expect(r.context_switches).toBe(0);
    expect(r.avg_focus_score).toBe(0);
    expect(r.avg_balance_score).toBe(0);
  });
});

describe("aggregateMetrics — single row", () => {
  const row = {
    total_min: 480, deep_work_min: 120, meetings_min: 60,
    communication_min: 90, admin_min: 30, personal_min: 20,
    focus_blocks: 3, context_switches: 12,
    focus_score: 0.8, balance_score: 0.6,
  };

  test("total_min passes through correctly", () => {
    expect(aggregateMetrics([row]).total_min).toBe(480);
  });

  test("deep_work_min passes through correctly", () => {
    expect(aggregateMetrics([row]).deep_work_min).toBe(120);
  });

  test("focus_blocks passes through correctly", () => {
    expect(aggregateMetrics([row]).focus_blocks).toBe(3);
  });

  test("context_switches passes through correctly", () => {
    expect(aggregateMetrics([row]).context_switches).toBe(12);
  });

  test("avg_focus_score equals the single row's focus_score", () => {
    expect(aggregateMetrics([row]).avg_focus_score).toBeCloseTo(0.8);
  });

  test("avg_balance_score equals the single row's balance_score", () => {
    expect(aggregateMetrics([row]).avg_balance_score).toBeCloseTo(0.6);
  });
});

describe("aggregateMetrics — multiple rows", () => {
  test("total_min is summed across rows", () => {
    const rows = [{ total_min: 300 }, { total_min: 180 }];
    expect(aggregateMetrics(rows).total_min).toBe(480);
  });

  test("focus_blocks and context_switches are summed (not averaged)", () => {
    const rows = [
      { focus_blocks: 3, context_switches: 10 },
      { focus_blocks: 2, context_switches: 15 },
    ];
    const r = aggregateMetrics(rows);
    expect(r.focus_blocks).toBe(5);
    expect(r.context_switches).toBe(25);
  });

  test("avg_focus_score is an average, not a sum", () => {
    const rows = [{ focus_score: 0.8 }, { focus_score: 0.6 }];
    expect(aggregateMetrics(rows).avg_focus_score).toBeCloseTo(0.7);
  });

  test("avg_balance_score is an average, not a sum", () => {
    const rows = [{ balance_score: 1.0 }, { balance_score: 0.0 }];
    expect(aggregateMetrics(rows).avg_balance_score).toBeCloseTo(0.5);
  });

  test("missing numeric fields default to 0", () => {
    const rows = [{ total_min: 100 }]; // no deep_work_min etc.
    const r = aggregateMetrics(rows);
    expect(r.deep_work_min).toBe(0);
    expect(r.focus_blocks).toBe(0);
    expect(r.avg_focus_score).toBe(0);
  });

  test("sum values are rounded to integers", () => {
    const rows = [{ total_min: 100.3 }, { total_min: 200.7 }];
    expect(Number.isInteger(aggregateMetrics(rows).total_min)).toBe(true);
  });

  test("avg scores are rounded to at most 2 decimal places", () => {
    const rows = [{ focus_score: 1 / 3 }, { focus_score: 2 / 3 }];
    const r = aggregateMetrics(rows);
    const decimals = (r.avg_focus_score.toString().split(".")[1] ?? "").length;
    expect(decimals).toBeLessThanOrEqual(2);
  });

  test("all minute categories summed independently", () => {
    const rows = [
      { meetings_min: 60, communication_min: 30, admin_min: 20, personal_min: 10 },
      { meetings_min: 40, communication_min: 20, admin_min: 10, personal_min: 5 },
    ];
    const r = aggregateMetrics(rows);
    expect(r.meetings_min).toBe(100);
    expect(r.communication_min).toBe(50);
    expect(r.admin_min).toBe(30);
    expect(r.personal_min).toBe(15);
  });
});
