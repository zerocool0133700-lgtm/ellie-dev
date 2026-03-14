/**
 * UMS Consumer Tests: Comms — ELLIE-709
 */

import { describe, test, expect } from "bun:test";
import { _testing, getStaleThresholds } from "../src/ums/consumers/comms.ts";
import type { UnifiedMessage } from "../src/ums/types.ts";

const { resolveThreadId, isOwner, THREADED_PROVIDERS } = _testing;

function makeMsg(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: crypto.randomUUID(),
    provider: "telegram",
    provider_id: "test-1",
    channel: "telegram:12345",
    sender: null,
    content: "Test message",
    content_type: "text",
    raw: {},
    received_at: new Date().toISOString(),
    provider_timestamp: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

describe("comms consumer", () => {
  describe("THREADED_PROVIDERS", () => {
    test("includes telegram, gchat, gmail", () => {
      expect(THREADED_PROVIDERS.has("telegram")).toBe(true);
      expect(THREADED_PROVIDERS.has("gchat")).toBe(true);
      expect(THREADED_PROVIDERS.has("gmail")).toBe(true);
    });

    test("excludes github, calendar", () => {
      expect(THREADED_PROVIDERS.has("github")).toBe(false);
      expect(THREADED_PROVIDERS.has("calendar")).toBe(false);
    });
  });

  describe("resolveThreadId", () => {
    test("uses thread_name from metadata when available", () => {
      const msg = makeMsg({
        provider: "gchat",
        metadata: { thread_name: "spaces/AAA/threads/t-001" },
      });
      expect(resolveThreadId(msg)).toBe("gchat:spaces/AAA/threads/t-001");
    });

    test("uses thread_id from metadata when available", () => {
      const msg = makeMsg({
        provider: "gmail",
        metadata: { thread_id: "thread-abc" },
      });
      expect(resolveThreadId(msg)).toBe("gmail:thread-abc");
    });

    test("uses conversation_id from metadata when available", () => {
      const msg = makeMsg({
        provider: "gmail",
        metadata: { conversation_id: "conv-123" },
      });
      expect(resolveThreadId(msg)).toBe("gmail:conv-123");
    });

    test("falls back to channel", () => {
      const msg = makeMsg({ provider: "telegram", channel: "telegram:12345", metadata: {} });
      expect(resolveThreadId(msg)).toBe("telegram:12345");
    });

    test("falls back to provider:provider_id when no channel", () => {
      const msg = makeMsg({ provider: "telegram", provider_id: "msg-99", channel: null, metadata: {} });
      expect(resolveThreadId(msg)).toBe("telegram:msg-99");
    });

    test("prefers thread_name over thread_id", () => {
      const msg = makeMsg({
        provider: "gchat",
        metadata: { thread_name: "preferred", thread_id: "fallback" },
      });
      expect(resolveThreadId(msg)).toBe("gchat:preferred");
    });
  });

  describe("isOwner", () => {
    // isOwner depends on ownerIdentities being loaded (module-level state).
    // With no identities loaded, it always returns false.
    test("returns false when no sender", () => {
      expect(isOwner(makeMsg({ sender: null }))).toBe(false);
    });

    test("returns false when no owner identities configured", () => {
      // Default state — no identities loaded
      expect(isOwner(makeMsg({ sender: { email: "dave@test.com" } }))).toBe(false);
    });
  });

  describe("getStaleThresholds", () => {
    test("returns default thresholds", () => {
      const thresholds = getStaleThresholds();
      expect(thresholds.telegram).toBe(4);
      expect(thresholds.gchat).toBe(4);
      expect(thresholds.gmail).toBe(48);
    });

    test("returns a copy (not mutable reference)", () => {
      const a = getStaleThresholds();
      a.telegram = 999;
      const b = getStaleThresholds();
      expect(b.telegram).toBe(4);
    });
  });
});
