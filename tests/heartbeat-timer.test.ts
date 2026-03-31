/**
 * Heartbeat timer tests — ELLIE-1165
 *
 * Tests for shouldSkipTick guard and isInActiveHours edge cases.
 */

import { describe, it, expect } from "bun:test";
import { shouldSkipTick } from "../src/heartbeat/timer.ts";
import { isInActiveHours } from "../src/heartbeat/state.ts";

// ── shouldSkipTick ──────────────────────────────────────────

describe("shouldSkipTick", () => {
  const defaults = {
    relayStartedAt: Date.now() - 300_000, // 5 min ago
    startupGraceMs: 120_000,              // 2 min grace
    isProcessingMessage: false,
    isPhase2Running: false,
    isInActiveHours: true,
  };

  it("returns null when all conditions are met", () => {
    expect(shouldSkipTick(defaults)).toBeNull();
  });

  it("returns startup_grace during startup window", () => {
    expect(shouldSkipTick({
      ...defaults,
      relayStartedAt: Date.now() - 30_000, // 30s ago, within 2-min grace
    })).toBe("startup_grace");
  });

  it("returns outside_active_hours when inactive", () => {
    expect(shouldSkipTick({
      ...defaults,
      isInActiveHours: false,
    })).toBe("outside_active_hours");
  });

  it("returns message_processing when message active", () => {
    expect(shouldSkipTick({
      ...defaults,
      isProcessingMessage: true,
    })).toBe("message_processing");
  });

  it("returns phase2_running when Phase 2 active", () => {
    expect(shouldSkipTick({
      ...defaults,
      isPhase2Running: true,
    })).toBe("phase2_running");
  });

  it("prioritizes startup_grace over other skip reasons", () => {
    expect(shouldSkipTick({
      relayStartedAt: Date.now() - 10_000,
      startupGraceMs: 120_000,
      isProcessingMessage: true,
      isPhase2Running: true,
      isInActiveHours: false,
    })).toBe("startup_grace");
  });

  it("prioritizes outside_active_hours over message/phase2", () => {
    expect(shouldSkipTick({
      ...defaults,
      isInActiveHours: false,
      isProcessingMessage: true,
      isPhase2Running: true,
    })).toBe("outside_active_hours");
  });
});

// ── isInActiveHours ─────────────────────────────────────────

describe("isInActiveHours", () => {
  // Helper: create a Date that, when converted to America/Chicago via
  // toLocaleString, yields the desired hour:minute. We compute the real
  // Chicago-to-UTC offset dynamically (handles CDT/CST automatically).
  function cstDate(hour: number, minute: number): Date {
    // Create a reference point and find Chicago's current UTC offset
    const ref = new Date();
    const chicagoNow = new Date(ref.toLocaleString("en-US", { timeZone: "America/Chicago" }));
    const offsetMs = ref.getTime() - chicagoNow.getTime();
    // Build a "Chicago local" date, then shift to real UTC
    const local = new Date(ref);
    local.setHours(hour, minute, 0, 0);
    return new Date(local.getTime() + offsetMs);
  }

  it("returns true within active window", () => {
    expect(isInActiveHours("08:00", "22:00", cstDate(12, 0))).toBe(true);
  });

  it("returns false before active start", () => {
    expect(isInActiveHours("08:00", "22:00", cstDate(7, 59))).toBe(false);
  });

  it("returns false at or after active end", () => {
    expect(isInActiveHours("08:00", "22:00", cstDate(22, 0))).toBe(false);
  });

  it("returns true at exact start boundary", () => {
    expect(isInActiveHours("08:00", "22:00", cstDate(8, 0))).toBe(true);
  });

  it("returns true one minute before end", () => {
    expect(isInActiveHours("08:00", "22:00", cstDate(21, 59))).toBe(true);
  });

  it("handles midnight-ish boundaries (late night window)", () => {
    // Window 20:00-23:59 — 22:00 should be active
    expect(isInActiveHours("20:00", "23:59", cstDate(22, 0))).toBe(true);
    // 19:59 should be inactive
    expect(isInActiveHours("20:00", "23:59", cstDate(19, 59))).toBe(false);
  });

  it("handles narrow window", () => {
    expect(isInActiveHours("09:00", "09:30", cstDate(9, 15))).toBe(true);
    expect(isInActiveHours("09:00", "09:30", cstDate(9, 30))).toBe(false);
  });
});
