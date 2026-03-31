import { describe, it, expect } from "bun:test";

describe("heartbeat state", () => {
  it("isInActiveHours returns true during active window", async () => {
    const { isInActiveHours } = await import("../src/heartbeat/state");
    // 10 AM CST is within 07:00–22:00
    const date = new Date("2026-03-31T10:00:00-06:00");
    expect(isInActiveHours("07:00", "22:00", date)).toBe(true);
  });

  it("isInActiveHours returns false outside active window", async () => {
    const { isInActiveHours } = await import("../src/heartbeat/state");
    // 11 PM CST is outside 07:00–22:00
    const date = new Date("2026-03-31T23:00:00-06:00");
    expect(isInActiveHours("07:00", "22:00", date)).toBe(false);
  });

  it("isSourceOnCooldown returns true within cooldown window", async () => {
    const { isSourceOnCooldown } = await import("../src/heartbeat/state");
    // Last triggered 10 minutes ago, cooldown is 30 minutes → still on cooldown
    const cooldowns = { ci: new Date(Date.now() - 10 * 60 * 1000).toISOString() };
    expect(isSourceOnCooldown("ci", cooldowns, 30 * 60 * 1000)).toBe(true);
  });

  it("isSourceOnCooldown returns false after cooldown expires", async () => {
    const { isSourceOnCooldown } = await import("../src/heartbeat/state");
    // Last triggered 60 minutes ago, cooldown is 30 minutes → cooldown expired
    const cooldowns = { ci: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
    expect(isSourceOnCooldown("ci", cooldowns, 30 * 60 * 1000)).toBe(false);
  });

  it("isSourceOnCooldown returns false for source with no prior cooldown entry", async () => {
    const { isSourceOnCooldown } = await import("../src/heartbeat/state");
    expect(isSourceOnCooldown("email", {}, 30 * 60 * 1000)).toBe(false);
  });

  it("isInActiveHours treats boundary start as inclusive", async () => {
    const { isInActiveHours } = await import("../src/heartbeat/state");
    // Exactly 07:00 CST — should be included
    const date = new Date("2026-03-31T07:00:00-06:00");
    expect(isInActiveHours("07:00", "22:00", date)).toBe(true);
  });

  it("isInActiveHours treats boundary end as exclusive", async () => {
    const { isInActiveHours } = await import("../src/heartbeat/state");
    // Exactly 22:00 CST — should be excluded (end is exclusive)
    const date = new Date("2026-03-31T22:00:00-06:00");
    expect(isInActiveHours("07:00", "22:00", date)).toBe(false);
  });
});
