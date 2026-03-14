/**
 * UMS Consumer Tests: Briefing — ELLIE-709
 */

import { describe, test, expect } from "bun:test";
import { _testing } from "../src/ums/consumers/briefing.ts";
import type { UnifiedMessage } from "../src/ums/types.ts";

const { buildSections, formatSender, buildSummary } = _testing;

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

describe("briefing consumer", () => {
  describe("buildSections", () => {
    test("groups messages by provider", () => {
      const messages = [
        makeMsg({ provider: "telegram", content: "Hey" }),
        makeMsg({ provider: "telegram", content: "Hi" }),
        makeMsg({ provider: "gmail", content: "Email content" }),
        makeMsg({ provider: "github", content: "PR opened", content_type: "notification" }),
      ];
      const sections = buildSections(messages);
      expect(sections).toHaveLength(3);
      const telegram = sections.find(s => s.provider === "telegram");
      expect(telegram!.count).toBe(2);
      expect(telegram!.title).toBe("Telegram Messages");
    });

    test("sorts sections by count descending", () => {
      const messages = [
        makeMsg({ provider: "gmail" }),
        makeMsg({ provider: "telegram" }),
        makeMsg({ provider: "telegram" }),
        makeMsg({ provider: "telegram" }),
      ];
      const sections = buildSections(messages);
      expect(sections[0].provider).toBe("telegram");
      expect(sections[1].provider).toBe("gmail");
    });

    test("truncates content to 200 chars", () => {
      const messages = [makeMsg({ content: "x".repeat(300) })];
      const sections = buildSections(messages);
      expect(sections[0].items[0].content.length).toBeLessThanOrEqual(200);
    });

    test("handles messages with no content", () => {
      const messages = [makeMsg({ content: null })];
      const sections = buildSections(messages);
      expect(sections[0].items[0].content).toBe("(no content)");
    });

    test("caps items at 20 per provider", () => {
      const messages = Array.from({ length: 25 }, (_, i) =>
        makeMsg({ content: `Message ${i}` })
      );
      const sections = buildSections(messages);
      expect(sections[0].items).toHaveLength(20);
      expect(sections[0].count).toBe(25); // count reflects all messages
    });

    test("uses fallback title for unknown providers", () => {
      const messages = [makeMsg({ provider: "custom-provider" })];
      const sections = buildSections(messages);
      expect(sections[0].title).toBe("custom-provider Activity");
    });

    test("returns empty for no messages", () => {
      expect(buildSections([])).toEqual([]);
    });
  });

  describe("formatSender", () => {
    test("returns name first", () => {
      expect(formatSender(makeMsg({ sender: { name: "Dave", email: "d@x.com" } }))).toBe("Dave");
    });

    test("falls back to username", () => {
      expect(formatSender(makeMsg({ sender: { username: "davey" } }))).toBe("davey");
    });

    test("falls back to email", () => {
      expect(formatSender(makeMsg({ sender: { email: "d@x.com" } }))).toBe("d@x.com");
    });

    test("falls back to id", () => {
      expect(formatSender(makeMsg({ sender: { id: "123" } }))).toBe("123");
    });

    test("returns null when no sender", () => {
      expect(formatSender(makeMsg({ sender: null }))).toBeNull();
    });

    test("returns null when sender has no fields", () => {
      expect(formatSender(makeMsg({ sender: {} }))).toBeNull();
    });
  });

  describe("buildSummary", () => {
    test("returns no-activity message for zero total", () => {
      expect(buildSummary([], 0)).toBe("No activity in the past period.");
    });

    test("builds summary with section counts", () => {
      const sections = [
        { title: "Telegram Messages", provider: "telegram", items: [], count: 5 },
        { title: "Emails", provider: "gmail", items: [], count: 3 },
      ];
      const result = buildSummary(sections, 8);
      expect(result).toBe("8 total messages: 5 telegram messages, 3 emails.");
    });
  });
});
