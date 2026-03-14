/**
 * UMS Consumer Tests: Forest — ELLIE-709
 */

import { describe, test, expect } from "bun:test";
import { _testing } from "../src/ums/consumers/forest.ts";
import type { UnifiedMessage } from "../src/ums/types.ts";

const { buildFinding, buildGitHubFinding, buildDocumentFinding, buildEmailFinding, buildCalendarFinding, KNOWLEDGE_SOURCES } = _testing;

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

describe("forest consumer", () => {
  describe("KNOWLEDGE_SOURCES", () => {
    test("maps github to notification", () => {
      expect(KNOWLEDGE_SOURCES.github).toEqual(["notification"]);
    });

    test("maps documents to notification", () => {
      expect(KNOWLEDGE_SOURCES.documents).toEqual(["notification"]);
    });

    test("maps gmail to text", () => {
      expect(KNOWLEDGE_SOURCES.gmail).toEqual(["text"]);
    });

    test("maps calendar to event", () => {
      expect(KNOWLEDGE_SOURCES.calendar).toEqual(["event"]);
    });

    test("does not include telegram", () => {
      expect(KNOWLEDGE_SOURCES.telegram).toBeUndefined();
    });
  });

  describe("buildFinding", () => {
    test("routes github messages to buildGitHubFinding", () => {
      const msg = makeMsg({ provider: "github", content: "PR opened", content_type: "notification" });
      const result = buildFinding(msg);
      expect(result).not.toBeNull();
      expect(result!.scope_path).toBe("2/1");
      expect(result!.type).toBe("finding");
    });

    test("routes calendar messages to buildCalendarFinding", () => {
      const msg = makeMsg({ provider: "calendar", content: "Meeting at 2pm", content_type: "event" });
      const result = buildFinding(msg);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("fact");
      expect(result!.confidence).toBe(0.9);
    });

    test("routes document messages to buildDocumentFinding", () => {
      const msg = makeMsg({ provider: "documents", content: "Doc updated", content_type: "notification" });
      const result = buildFinding(msg);
      expect(result).not.toBeNull();
      expect(result!.scope_path).toBe("2");
    });

    test("routes gmail messages to buildEmailFinding", () => {
      const msg = makeMsg({
        provider: "gmail",
        content: "Important update about the quarterly budget review and planning session for next week",
        content_type: "text",
      });
      const result = buildFinding(msg);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("finding");
    });

    test("returns null for unknown providers", () => {
      expect(buildFinding(makeMsg({ provider: "telegram" }))).toBeNull();
    });
  });

  describe("buildGitHubFinding", () => {
    test("sets scope_path to 2/1 (ellie-dev)", () => {
      const msg = makeMsg({
        provider: "github",
        content: "CI failed",
        metadata: { event_type: "ci", repo: "ellie-labs/ellie-dev", url: "https://github.com/..." },
      });
      const result = buildGitHubFinding(msg);
      expect(result.scope_path).toBe("2/1");
      expect(result.confidence).toBe(0.8);
      expect(result.tags).toContain("github");
      expect(result.tags).toContain("ci");
      expect(result.metadata.source).toBe("ums-forest-consumer");
    });
  });

  describe("buildDocumentFinding", () => {
    test("sets scope_path to 2 (root)", () => {
      const msg = makeMsg({
        provider: "documents",
        content: "Comment on Q1 doc",
        metadata: { change_type: "comment", doc_id: "doc-1", doc_title: "Q1 Planning" },
      });
      const result = buildDocumentFinding(msg);
      expect(result.scope_path).toBe("2");
      expect(result.confidence).toBe(0.6);
      expect(result.tags).toContain("document");
      expect(result.tags).toContain("comment");
    });
  });

  describe("buildEmailFinding", () => {
    test("returns null for short emails (< 50 chars)", () => {
      const msg = makeMsg({ provider: "gmail", content: "Short" });
      expect(buildEmailFinding(msg)).toBeNull();
    });

    test("returns finding for substantive emails", () => {
      const msg = makeMsg({
        provider: "gmail",
        content: "This is a detailed email about the upcoming project timeline and milestones we need to hit",
        metadata: { subject: "Project Update", thread_id: "t-1" },
      });
      const result = buildEmailFinding(msg);
      expect(result).not.toBeNull();
      expect(result!.content).toContain("Email:");
      expect(result!.confidence).toBe(0.5);
      expect(result!.tags).toContain("email");
      expect(result!.tags).toContain("thread");
    });

    test("tags standalone emails (no thread)", () => {
      const msg = makeMsg({
        provider: "gmail",
        content: "A new standalone email about something with more than fifty characters for testing purposes",
        metadata: {},
      });
      const result = buildEmailFinding(msg);
      expect(result).not.toBeNull();
      expect(result!.tags).toContain("standalone");
    });

    test("caps content at 500 chars", () => {
      const msg = makeMsg({
        provider: "gmail",
        content: "x".repeat(600),
      });
      const result = buildEmailFinding(msg);
      expect(result).not.toBeNull();
      // "Email: " (7 chars) + 500 chars = 507
      expect(result!.content.length).toBeLessThanOrEqual(507);
    });
  });

  describe("buildCalendarFinding", () => {
    test("creates a fact with high confidence", () => {
      const msg = makeMsg({
        provider: "calendar",
        content: "Team standup at 9am",
        metadata: { start_time: "2026-03-14T09:00:00Z", status: "confirmed" },
      });
      const result = buildCalendarFinding(msg);
      expect(result.type).toBe("fact");
      expect(result.confidence).toBe(0.9);
      expect(result.tags).toContain("calendar");
      expect(result.tags).toContain("confirmed");
    });
  });
});
