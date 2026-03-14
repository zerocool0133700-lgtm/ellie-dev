/**
 * API Route Tests: Gateway Intake — ELLIE-710
 *
 * Tests validation, sanitization, and error handling for gateway endpoints.
 */

import { describe, test, expect, mock } from "bun:test";

// ── Mocks ─────────────────────────────────────────────────────
mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));
mock.module("../src/notification-policy.ts", () => ({
  notify: mock(async () => {}),
}));
mock.module("../src/relay-state.ts", () => ({
  getNotifyCtx: mock(() => ({})),
  getRelayDeps: mock(() => ({})),
}));
mock.module("../src/calendar-sync.ts", () => ({
  syncAllCalendars: mock(async () => ({})),
}));
mock.module("../src/outlook.ts", () => ({
  getMessage: mock(async () => null),
}));
mock.module("../../../ellie-forest/src/hollow.ts", () => ({
  retrieveSecret: mock(async () => ""),
}));

import { _testing } from "../src/api/gateway-intake.ts";
const { validateEventPayload, validateAlertPayload, validateEmailPayload, sanitize, errorMessage } = _testing;

describe("gateway-intake", () => {
  // ── validateEventPayload ─────────────────────────────────

  describe("validateEventPayload", () => {
    test("accepts valid event payload", () => {
      expect(validateEventPayload({
        source: "github",
        category: "ci",
        summary: "Build passed",
      })).toBeNull();
    });

    test("accepts payload with optional fields", () => {
      expect(validateEventPayload({
        source: "github",
        category: "ci",
        summary: "Build passed",
        actor: "davey",
        payload: { url: "https://github.com/..." },
        envelope_id: "env-001",
      })).toBeNull();
    });

    test("rejects null/undefined", () => {
      expect(validateEventPayload(null)).toBe("Body must be an object");
      expect(validateEventPayload(undefined)).toBe("Body must be an object");
    });

    test("rejects non-object", () => {
      expect(validateEventPayload("string")).toBe("Body must be an object");
      expect(validateEventPayload(42)).toBe("Body must be an object");
    });

    test("rejects missing source", () => {
      expect(validateEventPayload({ category: "ci", summary: "test" })).toBe("Missing source");
    });

    test("rejects empty source", () => {
      expect(validateEventPayload({ source: "", category: "ci", summary: "test" })).toBe("Missing source");
    });

    test("rejects missing category", () => {
      expect(validateEventPayload({ source: "github", summary: "test" })).toBe("Missing category");
    });

    test("rejects missing summary", () => {
      expect(validateEventPayload({ source: "github", category: "ci" })).toBe("Missing summary");
    });

    test("rejects summary > 500 chars", () => {
      expect(validateEventPayload({
        source: "github",
        category: "ci",
        summary: "x".repeat(501),
      })).toBe("summary too long (max 500)");
    });

    test("accepts summary exactly 500 chars", () => {
      expect(validateEventPayload({
        source: "github",
        category: "ci",
        summary: "x".repeat(500),
      })).toBeNull();
    });

    test("rejects non-string envelope_id", () => {
      expect(validateEventPayload({
        source: "github",
        category: "ci",
        summary: "test",
        envelope_id: 123,
      })).toBe("envelope_id must be a string");
    });
  });

  // ── validateAlertPayload ─────────────────────────────────

  describe("validateAlertPayload", () => {
    test("accepts valid alert payload", () => {
      expect(validateAlertPayload({ source: "github", summary: "CI failed" })).toBeNull();
    });

    test("rejects null", () => {
      expect(validateAlertPayload(null)).toBe("Body must be an object");
    });

    test("rejects missing source", () => {
      expect(validateAlertPayload({ summary: "test" })).toBe("Missing source");
    });

    test("rejects missing summary", () => {
      expect(validateAlertPayload({ source: "github" })).toBe("Missing summary");
    });

    test("rejects summary > 500 chars", () => {
      expect(validateAlertPayload({
        source: "github",
        summary: "x".repeat(501),
      })).toBe("summary too long (max 500)");
    });
  });

  // ── validateEmailPayload ─────────────────────────────────

  describe("validateEmailPayload", () => {
    test("accepts valid email payload", () => {
      expect(validateEmailPayload({ message_id: "msg-001" })).toBeNull();
    });

    test("accepts with optional fields", () => {
      expect(validateEmailPayload({
        message_id: "msg-001",
        change_type: "created",
        envelope_id: "env-001",
      })).toBeNull();
    });

    test("rejects null", () => {
      expect(validateEmailPayload(null)).toBe("Body must be an object");
    });

    test("rejects missing message_id", () => {
      expect(validateEmailPayload({})).toBe("Missing message_id");
    });

    test("rejects empty message_id", () => {
      expect(validateEmailPayload({ message_id: "" })).toBe("Missing message_id");
    });

    test("rejects message_id > 500 chars", () => {
      expect(validateEmailPayload({ message_id: "x".repeat(501) })).toBe("message_id too long (max 500)");
    });

    test("rejects non-string change_type", () => {
      expect(validateEmailPayload({ message_id: "msg-001", change_type: 123 })).toBe("change_type must be a string");
    });
  });

  // ── sanitize ─────────────────────────────────────────────

  describe("sanitize", () => {
    test("strips HTML tags", () => {
      expect(sanitize("<b>bold</b> text")).toBe("bold text");
      expect(sanitize('<script>alert("xss")</script>')).toBe('alert("xss")');
    });

    test("strips control characters", () => {
      expect(sanitize("hello\x00world")).toBe("helloworld");
      expect(sanitize("test\x07\x08value")).toBe("testvalue");
    });

    test("preserves normal text", () => {
      expect(sanitize("Hello, World!")).toBe("Hello, World!");
    });

    test("preserves newlines and tabs", () => {
      expect(sanitize("line1\nline2\ttab")).toBe("line1\nline2\ttab");
    });

    test("handles empty string", () => {
      expect(sanitize("")).toBe("");
    });

    test("strips nested tags", () => {
      expect(sanitize("<div><p>nested</p></div>")).toBe("nested");
    });
  });

  // ── errorMessage ─────────────────────────────────────────

  describe("errorMessage", () => {
    test("extracts message from Error", () => {
      expect(errorMessage(new Error("test error"))).toBe("test error");
    });

    test("converts non-Error to string", () => {
      expect(errorMessage("string error")).toBe("string error");
      expect(errorMessage(42)).toBe("42");
    });

    test("handles null/undefined", () => {
      expect(errorMessage(null)).toBe("null");
      expect(errorMessage(undefined)).toBe("undefined");
    });
  });
});
