import { describe, it, expect } from "bun:test";

describe("heartbeat pre-check", () => {
  it("mergeSnapshots combines partial updates", async () => {
    const { mergeSnapshots } = await import("../src/heartbeat/pre-check");
    const base = { email_unread_count: 5, gtd_open_count: 10, captured_at: "" } as any;
    const updates = [{ email_unread_count: 7 }, { gtd_open_count: 12 }];
    const merged = mergeSnapshots(base, updates);
    expect(merged.email_unread_count).toBe(7);
    expect(merged.gtd_open_count).toBe(12);
    expect(merged.captured_at).toBeTruthy(); // auto-set
  });

  it("mergeSnapshots uses defaults when base is null", async () => {
    const { mergeSnapshots } = await import("../src/heartbeat/pre-check");
    const merged = mergeSnapshots(null, [{ email_unread_count: 3 }]);
    expect(merged.email_unread_count).toBe(3);
    expect(merged.ci_run_ids).toEqual([]);
    expect(merged.gtd_open_count).toBe(0);
  });

  it("filterCooledDown removes sources on cooldown", async () => {
    const { filterCooledDown } = await import("../src/heartbeat/pre-check");
    const deltas = [
      { source: "ci" as const, changed: true, summary: "1 failed", count: 1 },
      { source: "gtd" as const, changed: true, summary: "2 overdue", count: 2 },
      { source: "email" as const, changed: false, summary: "No change", count: 0 },
    ];
    const cooldowns = { ci: new Date().toISOString() }; // just triggered
    const filtered = filterCooledDown(deltas, cooldowns, 30 * 60 * 1000);
    expect(filtered.length).toBe(1);
    expect(filtered[0].source).toBe("gtd");
  });

  it("filterCooledDown keeps sources past cooldown", async () => {
    const { filterCooledDown } = await import("../src/heartbeat/pre-check");
    const deltas = [
      { source: "ci" as const, changed: true, summary: "1 failed", count: 1 },
    ];
    const cooldowns = { ci: new Date(Date.now() - 60 * 60 * 1000).toISOString() }; // 1 hour ago
    const filtered = filterCooledDown(deltas, cooldowns, 30 * 60 * 1000);
    expect(filtered.length).toBe(1);
  });
});
