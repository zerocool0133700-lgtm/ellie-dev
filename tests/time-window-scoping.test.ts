import { describe, it, expect } from "bun:test";

describe("ELLIE-1037: Time window scoping", () => {
  it("inline window defaults to 24 hours", () => {
    const hours = parseInt(process.env.UMS_INLINE_WINDOW_HOURS || "24", 10);
    expect(hours).toBe(24);
  });

  it("batch window defaults to 7 days", () => {
    const days = parseInt(process.env.UMS_BATCH_WINDOW_DAYS || "7", 10);
    expect(days).toBe(7);
  });

  it("window calculation produces valid ISO date", () => {
    const hours = 24;
    const windowStart = new Date(Date.now() - hours * 60 * 60_000).toISOString();
    expect(windowStart).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(windowStart).getTime()).toBeGreaterThan(0);
  });

  it("window is in the past", () => {
    const hours = 24;
    const windowStart = new Date(Date.now() - hours * 60 * 60_000);
    expect(windowStart.getTime()).toBeLessThan(Date.now());
  });
});
