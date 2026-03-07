/**
 * ELLIE-559 — relay-state.ts tests
 *
 * Tests active agent management and phone history sweep/touch.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  getActiveAgent,
  setActiveAgent,
  activeAgentByChannel,
  sweepPhoneHistories,
  touchPhoneHistory,
  ellieChatPhoneHistories,
} from "../src/relay-state.ts";

// ── Active agent ─────────────────────────────────────────────

describe("getActiveAgent / setActiveAgent", () => {
  beforeEach(() => {
    activeAgentByChannel.clear();
  });

  test("defaults to general for telegram", () => {
    expect(getActiveAgent("telegram")).toBe("general");
  });

  test("defaults to general when no channel specified", () => {
    expect(getActiveAgent()).toBe("general");
  });

  test("set and get roundtrip", () => {
    setActiveAgent("telegram", "dev");
    expect(getActiveAgent("telegram")).toBe("dev");
  });

  test("channels are independent", () => {
    setActiveAgent("telegram", "dev");
    setActiveAgent("google-chat", "research");
    expect(getActiveAgent("telegram")).toBe("dev");
    expect(getActiveAgent("google-chat")).toBe("research");
  });

  test("overwrite existing agent", () => {
    setActiveAgent("telegram", "dev");
    setActiveAgent("telegram", "strategy");
    expect(getActiveAgent("telegram")).toBe("strategy");
  });
});

// ── Phone history sweep ──────────────────────────────────────

describe("sweepPhoneHistories / touchPhoneHistory", () => {
  beforeEach(() => {
    ellieChatPhoneHistories.clear();
  });

  test("sweep removes nothing when empty", () => {
    expect(sweepPhoneHistories()).toBe(0);
  });

  test("fresh entries survive default TTL sweep", () => {
    const key = `fresh-${Date.now()}`;
    ellieChatPhoneHistories.set(key, [{ role: "user", content: "hello" }]);
    touchPhoneHistory(key);
    // Default TTL is 24h — entry just touched should survive
    expect(sweepPhoneHistories()).toBe(0);
    expect(ellieChatPhoneHistories.has(key)).toBe(true);
  });

  test("stale entries are removed with short TTL", async () => {
    const key = `stale-${Date.now()}`;
    ellieChatPhoneHistories.set(key, [{ role: "user", content: "hi" }]);
    touchPhoneHistory(key);
    await new Promise(r => setTimeout(r, 10));
    const removed = sweepPhoneHistories(5);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(ellieChatPhoneHistories.has(key)).toBe(false);
  });

  test("mixed fresh and stale entries", async () => {
    const staleKey = `mix-stale-${Date.now()}`;
    ellieChatPhoneHistories.set(staleKey, [{ role: "user", content: "old" }]);
    touchPhoneHistory(staleKey);

    await new Promise(r => setTimeout(r, 15));

    const freshKey = `mix-fresh-${Date.now()}`;
    ellieChatPhoneHistories.set(freshKey, [{ role: "user", content: "new" }]);
    touchPhoneHistory(freshKey);

    // 10ms TTL: staleKey was touched >15ms ago, freshKey was just touched
    sweepPhoneHistories(10);
    expect(ellieChatPhoneHistories.has(staleKey)).toBe(false);
    expect(ellieChatPhoneHistories.has(freshKey)).toBe(true);
  });
});
