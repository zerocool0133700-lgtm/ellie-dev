/**
 * ELLIE-508 — Google Chat module tests
 *
 * Covers three pure/near-pure exports:
 *   - parseGoogleChatEvent() — pure parser, both legacy and new webhook formats
 *   - isAllowedSender()      — reads GOOGLE_CHAT_ALLOWED_EMAIL env var
 *   - isGoogleChatEnabled()  — reflects module-level authMethod state
 *
 * initGoogleChat() (async, reads env/fs) is tested only for the OAuth env-var
 * path since that path is side-effect-free (no filesystem reads).
 * sendGoogleChatMessage() is not tested here — covered by delivery tests.
 */

import { describe, test, expect, mock, beforeAll, afterAll } from "bun:test";

// ── Mocks ─────────────────────────────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock() }) },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  parseGoogleChatEvent,
  isAllowedSender,
  isGoogleChatEnabled,
  initGoogleChat,
  type GoogleChatEventLegacy,
  type GoogleChatEventNew,
} from "../src/google-chat.ts";

// ── parseGoogleChatEvent — legacy format ──────────────────────────────────────

describe("parseGoogleChatEvent — legacy format", () => {
  const legacyMsg = (overrides: Partial<GoogleChatEventLegacy> = {}): GoogleChatEventLegacy => ({
    type: "MESSAGE",
    eventTime: "2025-01-01T00:00:00Z",
    space: { name: "spaces/AAA", type: "ROOM" },
    message: {
      name: "spaces/AAA/messages/1",
      text: "Hello Ellie",
      thread: { name: "spaces/AAA/threads/1" },
      sender: { name: "users/1", displayName: "Dave", email: "dave@example.com", type: "HUMAN" },
      createTime: "2025-01-01T00:00:00Z",
    },
    ...overrides,
  });

  test("MESSAGE event → returns ParsedGoogleChatMessage", () => {
    const result = parseGoogleChatEvent(legacyMsg());
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Hello Ellie");
    expect(result!.spaceName).toBe("spaces/AAA");
    expect(result!.threadName).toBe("spaces/AAA/threads/1");
    expect(result!.senderEmail).toBe("dave@example.com");
    expect(result!.senderName).toBe("Dave");
    expect(result!.messageName).toBe("spaces/AAA/messages/1");
  });

  test("non-MESSAGE event type → null", () => {
    expect(parseGoogleChatEvent(legacyMsg({ type: "ADDED_TO_SPACE" }))).toBeNull();
  });

  test("no message field → null", () => {
    const event: GoogleChatEventLegacy = {
      type: "MESSAGE",
      eventTime: "2025-01-01T00:00:00Z",
      space: { name: "spaces/AAA", type: "ROOM" },
    };
    expect(parseGoogleChatEvent(event)).toBeNull();
  });

  test("@mention prefix stripped from text", () => {
    const result = parseGoogleChatEvent(legacyMsg({
      message: {
        name: "spaces/AAA/messages/2",
        text: "@EllieBot what is the weather?",
        sender: { name: "users/1", displayName: "Dave", email: "dave@example.com", type: "HUMAN" },
        createTime: "2025-01-01T00:00:00Z",
      },
    }));
    expect(result!.text).toBe("what is the weather?");
  });

  test("text that becomes empty after @ strip → null", () => {
    const result = parseGoogleChatEvent(legacyMsg({
      message: {
        name: "spaces/AAA/messages/3",
        text: "@EllieBot",
        sender: { name: "users/1", displayName: "Dave", email: "dave@example.com", type: "HUMAN" },
        createTime: "2025-01-01T00:00:00Z",
      },
    }));
    expect(result).toBeNull();
  });

  test("no thread → threadName is null", () => {
    const result = parseGoogleChatEvent(legacyMsg({
      message: {
        name: "spaces/AAA/messages/4",
        text: "No thread",
        sender: { name: "users/1", displayName: "Dave", email: "dave@example.com", type: "HUMAN" },
        createTime: "2025-01-01T00:00:00Z",
      },
    }));
    expect(result!.threadName).toBeNull();
  });
});

// ── parseGoogleChatEvent — new Workspace Add-on format ───────────────────────

describe("parseGoogleChatEvent — new format", () => {
  const newMsg = (textOverride?: string): GoogleChatEventNew => ({
    commonEventObject: { hostApp: "CHAT", platform: "WEB" },
    chat: {
      eventTime: "2025-01-01T00:00:00Z",
      messagePayload: {
        space: { name: "spaces/BBB", type: "ROOM" },
        message: {
          name: "spaces/BBB/messages/10",
          text: textOverride ?? "Hello from add-on",
          thread: { name: "spaces/BBB/threads/2" },
          sender: { name: "users/2", displayName: "Alice", email: "alice@example.com", type: "HUMAN" },
          createTime: "2025-01-01T00:00:00Z",
        },
      },
    },
  });

  test("messagePayload present → returns ParsedGoogleChatMessage", () => {
    const result = parseGoogleChatEvent(newMsg());
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Hello from add-on");
    expect(result!.spaceName).toBe("spaces/BBB");
    expect(result!.senderEmail).toBe("alice@example.com");
    expect(result!.threadName).toBe("spaces/BBB/threads/2");
  });

  test("@ prefix stripped from text in new format", () => {
    const result = parseGoogleChatEvent(newMsg("@EllieBotHandle what time is it?"));
    expect(result!.text).toBe("what time is it?");
  });

  test("text empty after strip → null", () => {
    const result = parseGoogleChatEvent(newMsg("@EllieBotHandle"));
    expect(result).toBeNull();
  });

  test("no messagePayload → falls through to legacy handling (no text → null)", () => {
    const event: GoogleChatEventNew = {
      chat: {
        eventTime: "2025-01-01T00:00:00Z",
        addedToSpacePayload: { space: { name: "spaces/BBB", type: "ROOM" } },
      },
    };
    // No messagePayload, falls to legacy path which has no .message → null
    expect(parseGoogleChatEvent(event)).toBeNull();
  });
});

// ── isAllowedSender ────────────────────────────────────────────────────────────

describe("isAllowedSender", () => {
  const ORIGINAL = process.env.GOOGLE_CHAT_ALLOWED_EMAIL;

  afterAll(() => {
    if (ORIGINAL === undefined) {
      delete process.env.GOOGLE_CHAT_ALLOWED_EMAIL;
    } else {
      process.env.GOOGLE_CHAT_ALLOWED_EMAIL = ORIGINAL;
    }
  });

  test("env var not set → false (fail-closed)", () => {
    delete process.env.GOOGLE_CHAT_ALLOWED_EMAIL;
    expect(isAllowedSender("anyone@example.com")).toBe(false);
  });

  test("exact match → true", () => {
    process.env.GOOGLE_CHAT_ALLOWED_EMAIL = "dave@example.com";
    expect(isAllowedSender("dave@example.com")).toBe(true);
  });

  test("case-insensitive match → true", () => {
    process.env.GOOGLE_CHAT_ALLOWED_EMAIL = "Dave@Example.COM";
    expect(isAllowedSender("dave@example.com")).toBe(true);
  });

  test("different email → false", () => {
    process.env.GOOGLE_CHAT_ALLOWED_EMAIL = "dave@example.com";
    expect(isAllowedSender("other@example.com")).toBe(false);
  });
});

// ── isGoogleChatEnabled ────────────────────────────────────────────────────────

describe("isGoogleChatEnabled — not configured", () => {
  test("returns false before initGoogleChat is called", () => {
    // authMethod is null on fresh module load without any initGoogleChat call
    expect(isGoogleChatEnabled()).toBe(false);
  });
});

describe("isGoogleChatEnabled — OAuth configured", () => {
  beforeAll(async () => {
    process.env.GOOGLE_CHAT_OAUTH_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CHAT_OAUTH_CLIENT_SECRET = "test-client-secret";
    process.env.GOOGLE_CHAT_OAUTH_REFRESH_TOKEN = "test-refresh-token";
    await initGoogleChat();
  });

  afterAll(() => {
    delete process.env.GOOGLE_CHAT_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_CHAT_OAUTH_CLIENT_SECRET;
    delete process.env.GOOGLE_CHAT_OAUTH_REFRESH_TOKEN;
  });

  test("returns true after OAuth initGoogleChat", () => {
    expect(isGoogleChatEnabled()).toBe(true);
  });
});
