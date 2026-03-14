/**
 * UMS Consumer Tests: Analytics — ELLIE-709
 */

import { describe, test, expect } from "bun:test";
import { _testing } from "../src/ums/consumers/analytics.ts";
import type { UnifiedMessage } from "../src/ums/types.ts";

const { categorizeMessage, mapActivityType, estimateDuration, buildTitle, DURATION_ESTIMATES } = _testing;

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

describe("analytics consumer", () => {
  describe("categorizeMessage", () => {
    test("calendar events → meetings", () => {
      expect(categorizeMessage(makeMsg({ provider: "calendar" }))).toBe("meetings");
    });

    test("event content_type → meetings", () => {
      expect(categorizeMessage(makeMsg({ content_type: "event" }))).toBe("meetings");
    });

    test("gmail → communication", () => {
      expect(categorizeMessage(makeMsg({ provider: "gmail" }))).toBe("communication");
    });

    test("imap → communication", () => {
      expect(categorizeMessage(makeMsg({ provider: "imap" }))).toBe("communication");
    });

    test("gmail task → admin", () => {
      expect(categorizeMessage(makeMsg({ provider: "gmail", content_type: "task" }))).toBe("admin");
    });

    test("telegram → communication", () => {
      expect(categorizeMessage(makeMsg({ provider: "telegram" }))).toBe("communication");
    });

    test("gchat → communication", () => {
      expect(categorizeMessage(makeMsg({ provider: "gchat" }))).toBe("communication");
    });

    test("voice → communication", () => {
      expect(categorizeMessage(makeMsg({ provider: "voice" }))).toBe("communication");
      expect(categorizeMessage(makeMsg({ content_type: "voice" }))).toBe("communication");
    });

    test("github → deep_work", () => {
      expect(categorizeMessage(makeMsg({ provider: "github" }))).toBe("deep_work");
    });

    test("google-tasks → admin", () => {
      expect(categorizeMessage(makeMsg({ provider: "google-tasks" }))).toBe("admin");
    });

    test("documents → deep_work", () => {
      expect(categorizeMessage(makeMsg({ provider: "documents" }))).toBe("deep_work");
    });

    test("task content_type → admin", () => {
      expect(categorizeMessage(makeMsg({ provider: "unknown", content_type: "task" }))).toBe("admin");
    });

    test("unknown defaults to communication", () => {
      expect(categorizeMessage(makeMsg({ provider: "unknown", content_type: "text" }))).toBe("communication");
    });
  });

  describe("mapActivityType", () => {
    test("calendar → calendar_event", () => {
      expect(mapActivityType(makeMsg({ provider: "calendar" }))).toBe("calendar_event");
    });

    test("gmail → email_received", () => {
      expect(mapActivityType(makeMsg({ provider: "gmail" }))).toBe("email_received");
    });

    test("github → code_session", () => {
      expect(mapActivityType(makeMsg({ provider: "github" }))).toBe("code_session");
    });

    test("google-tasks → task_created", () => {
      expect(mapActivityType(makeMsg({ provider: "google-tasks" }))).toBe("task_created");
    });

    test("task content_type → task_created", () => {
      expect(mapActivityType(makeMsg({ content_type: "task" }))).toBe("task_created");
    });

    test("default → message_received", () => {
      expect(mapActivityType(makeMsg({ provider: "telegram" }))).toBe("message_received");
    });
  });

  describe("estimateDuration", () => {
    test("uses event metadata duration_minutes", () => {
      expect(estimateDuration(makeMsg({
        content_type: "event",
        metadata: { duration_minutes: 60 },
      }))).toBe(60);
    });

    test("calculates from start/end for events", () => {
      const result = estimateDuration(makeMsg({
        content_type: "event",
        metadata: {
          start: "2026-03-14T09:00:00Z",
          end: "2026-03-14T09:30:00Z",
        },
      }));
      expect(result).toBe(30);
    });

    test("uses DURATION_ESTIMATES for text", () => {
      expect(estimateDuration(makeMsg({ content_type: "text" }))).toBe(DURATION_ESTIMATES.text);
    });

    test("uses DURATION_ESTIMATES for voice", () => {
      expect(estimateDuration(makeMsg({ content_type: "voice" }))).toBe(DURATION_ESTIMATES.voice);
    });

    test("defaults to 1 for unknown content_type", () => {
      expect(estimateDuration(makeMsg({ content_type: "unknown" }))).toBe(1);
    });
  });

  describe("buildTitle", () => {
    test("includes sender name", () => {
      const result = buildTitle(makeMsg({ sender: { name: "Dave" } }));
      expect(result).toContain("Dave");
    });

    test("includes channel", () => {
      const result = buildTitle(makeMsg({ channel: "telegram:12345" }));
      expect(result).toContain("#telegram:12345");
    });

    test("includes truncated content", () => {
      const result = buildTitle(makeMsg({ content: "A".repeat(100) }));
      expect(result.length).toBeLessThan(120);
    });

    test("falls back to content_type when no other info", () => {
      const result = buildTitle(makeMsg({
        sender: null,
        channel: null,
        content: null,
        content_type: "text",
      }));
      expect(result).toBe("text");
    });
  });

  describe("DURATION_ESTIMATES", () => {
    test("text is 1 minute", () => {
      expect(DURATION_ESTIMATES.text).toBe(1);
    });

    test("voice is 2 minutes", () => {
      expect(DURATION_ESTIMATES.voice).toBe(2);
    });

    test("event is 0 (duration from event itself)", () => {
      expect(DURATION_ESTIMATES.event).toBe(0);
    });
  });
});
