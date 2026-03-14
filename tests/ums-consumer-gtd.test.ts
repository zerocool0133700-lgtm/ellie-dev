/**
 * UMS Consumer Tests: GTD — ELLIE-709
 */

import { describe, test, expect } from "bun:test";
import { _testing } from "../src/ums/consumers/gtd.ts";
import type { UnifiedMessage } from "../src/ums/types.ts";

const { detectActionableSignals, ACTIONABLE_TYPES, ACTIONABLE_PROVIDERS } = _testing;

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

describe("gtd consumer", () => {
  describe("ACTIONABLE_TYPES", () => {
    test("includes text, voice, task, notification", () => {
      expect(ACTIONABLE_TYPES.has("text")).toBe(true);
      expect(ACTIONABLE_TYPES.has("voice")).toBe(true);
      expect(ACTIONABLE_TYPES.has("task")).toBe(true);
      expect(ACTIONABLE_TYPES.has("notification")).toBe(true);
    });

    test("excludes events and images", () => {
      expect(ACTIONABLE_TYPES.has("event")).toBe(false);
      expect(ACTIONABLE_TYPES.has("image")).toBe(false);
    });
  });

  describe("ACTIONABLE_PROVIDERS", () => {
    test("includes telegram, gmail, gchat, voice, google-tasks", () => {
      expect(ACTIONABLE_PROVIDERS.has("telegram")).toBe(true);
      expect(ACTIONABLE_PROVIDERS.has("gmail")).toBe(true);
      expect(ACTIONABLE_PROVIDERS.has("gchat")).toBe(true);
      expect(ACTIONABLE_PROVIDERS.has("voice")).toBe(true);
      expect(ACTIONABLE_PROVIDERS.has("google-tasks")).toBe(true);
    });
  });

  describe("detectActionableSignals", () => {
    test("detects 'todo' keyword", () => {
      const result = detectActionableSignals(makeMsg({ content: "Todo: fix the login bug" }));
      expect(result.isActionable).toBe(true);
    });

    test("detects 'action item' keyword", () => {
      const result = detectActionableSignals(makeMsg({ content: "Action item from meeting: update docs" }));
      expect(result.isActionable).toBe(true);
    });

    test("detects 'follow up' keyword", () => {
      const result = detectActionableSignals(makeMsg({ content: "Follow up with client tomorrow" }));
      expect(result.isActionable).toBe(true);
    });

    test("detects 'reminder' keyword", () => {
      const result = detectActionableSignals(makeMsg({ content: "Reminder to send the invoice" }));
      expect(result.isActionable).toBe(true);
    });

    test("detects 'please do' pattern", () => {
      const result = detectActionableSignals(makeMsg({ content: "Please review the PR before EOD" }));
      expect(result.isActionable).toBe(true);
    });

    test("detects 'need to' pattern", () => {
      const result = detectActionableSignals(makeMsg({ content: "I need to finish the presentation" }));
      expect(result.isActionable).toBe(true);
    });

    test("detects 'don't forget' pattern", () => {
      const result = detectActionableSignals(makeMsg({ content: "Don't forget to submit the form" }));
      expect(result.isActionable).toBe(true);
    });

    test("detects urgent signals and adds tag", () => {
      const result = detectActionableSignals(makeMsg({ content: "URGENT: please fix the deployment ASAP" }));
      expect(result.isActionable).toBe(true);
      expect(result.tags).toContain("urgent");
      expect(result.priority).toBe("high");
    });

    test("detects mention notifications as actionable", () => {
      const result = detectActionableSignals(makeMsg({
        content: "You were mentioned",
        content_type: "notification",
        metadata: { change_type: "mention" },
      }));
      expect(result.isActionable).toBe(true);
    });

    test("detects share notifications as actionable", () => {
      const result = detectActionableSignals(makeMsg({
        content: "Document shared with you",
        content_type: "notification",
        metadata: { change_type: "share" },
      }));
      expect(result.isActionable).toBe(true);
    });

    test("returns not actionable for casual conversation", () => {
      const result = detectActionableSignals(makeMsg({ content: "Hey, how are you doing today?" }));
      expect(result.isActionable).toBe(false);
    });

    test("returns not actionable for empty content", () => {
      const result = detectActionableSignals(makeMsg({ content: "" }));
      expect(result.isActionable).toBe(false);
    });

    test("non-urgent actionable has null priority", () => {
      const result = detectActionableSignals(makeMsg({ content: "Todo: water the plants" }));
      expect(result.isActionable).toBe(true);
      expect(result.priority).toBeNull();
    });
  });
});
