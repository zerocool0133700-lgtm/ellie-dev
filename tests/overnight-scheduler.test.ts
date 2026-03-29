/**
 * Overnight Scheduler — ELLIE-1136
 * Tests for pure functions: parseEndTime, shouldStop.
 */

import { describe, it, expect, mock } from "bun:test";

// ── Mocks (prevent import chain into ellie-forest) ──────────

// Prompt-builder is lazy-imported in scheduler, so no ellie-forest chain to worry about.

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock(), fatal: mock() }) },
}));

mock.module("../src/relay-state.ts", () => ({
  getRelayDeps: mock(() => ({ supabase: null, anthropic: null, bot: null })),
}));

mock.module("../src/trace.ts", () => ({
  getTraceId: mock(() => undefined),
}));

// ── Imports ─────────────────────────────────────────────────

import { parseEndTime, shouldStop } from "../src/overnight/scheduler.ts";

// ── parseEndTime ────────────────────────────────────────────

describe("parseEndTime", () => {
  // Fixed reference: 2026-03-29 at 11 PM
  const lateNight = new Date("2026-03-29T23:00:00");

  it("returns 6 AM next day by default", () => {
    const result = parseEndTime(undefined, lateNight);
    expect(result.getHours()).toBe(6);
    expect(result.getMinutes()).toBe(0);
    // Should be next day since 6 AM is before 11 PM
    expect(result.getDate()).toBe(30);
  });

  it("respects custom hour with 'am' suffix", () => {
    const result = parseEndTime("4am", lateNight);
    expect(result.getHours()).toBe(4);
    expect(result.getDate()).toBe(30);
  });

  it("handles '8am' format", () => {
    const result = parseEndTime("8am", lateNight);
    expect(result.getHours()).toBe(8);
    expect(result.getDate()).toBe(30);
  });

  it("handles space before am", () => {
    const result = parseEndTime("5 am", lateNight);
    expect(result.getHours()).toBe(5);
  });

  it("handles uppercase AM", () => {
    const result = parseEndTime("7AM", lateNight);
    expect(result.getHours()).toBe(7);
  });

  it("handles 24h format like '06:00'", () => {
    const result = parseEndTime("06:00", lateNight);
    expect(result.getHours()).toBe(6);
    expect(result.getDate()).toBe(30);
  });

  it("handles plain number input", () => {
    const result = parseEndTime("5", lateNight);
    expect(result.getHours()).toBe(5);
    expect(result.getDate()).toBe(30);
  });

  it("pushes to next day when time is before now", () => {
    const result = parseEndTime("3am", lateNight);
    expect(result.getTime()).toBeGreaterThan(lateNight.getTime());
    expect(result.getDate()).toBe(30);
  });

  it("does not push forward when time is after now", () => {
    const earlyMorning = new Date("2026-03-29T02:00:00");
    const result = parseEndTime("8am", earlyMorning);
    expect(result.getHours()).toBe(8);
    expect(result.getDate()).toBe(29); // same day
  });
});

// ── shouldStop ──────────────────────────────────────────────

describe("shouldStop", () => {
  it("returns 'time_limit' when past end time", () => {
    const pastEnd = new Date(Date.now() - 60_000);
    const result = shouldStop(pastEnd, false);
    expect(result).toBe("time_limit");
  });

  it("returns 'user_activity' when flag is set", () => {
    const futureEnd = new Date(Date.now() + 3_600_000);
    const result = shouldStop(futureEnd, true);
    expect(result).toBe("user_activity");
  });

  it("returns null when running normally", () => {
    const futureEnd = new Date(Date.now() + 3_600_000);
    const result = shouldStop(futureEnd, false);
    expect(result).toBeNull();
  });

  it("prioritizes user_activity over time_limit", () => {
    const pastEnd = new Date(Date.now() - 60_000);
    const result = shouldStop(pastEnd, true);
    expect(result).toBe("user_activity");
  });
});
