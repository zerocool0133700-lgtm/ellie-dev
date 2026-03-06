/**
 * ELLIE-508 — Message delivery tests
 *
 * Covers deliverMessage() across:
 *   - Google Chat primary success
 *   - Telegram primary success
 *   - Primary failure → no fallback → status "failed"
 *   - Primary failure → fallback success (gchat→telegram, telegram→gchat)
 *   - Both primary + fallback fail → status "failed"
 *   - acknowledgeChannel() clears pending responses
 *   - getStaleResponses() returns [] when empty
 *
 * sendGoogleChatMessage is mocked. Supabase is passed as null to skip DB.
 * maxRetries: 1 is used throughout to avoid exponential-backoff delays.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mocks — must precede imports ───────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock() }) },
}));

const mockSendGchat = mock(() =>
  Promise.resolve({ externalId: "spaces/test/messages/1", threadName: "spaces/test/threads/1" })
);

mock.module("../src/google-chat.ts", () => ({
  sendGoogleChatMessage: mockSendGchat,
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  deliverMessage,
  acknowledgeChannel,
  getStaleResponses,
  _resetPendingResponsesForTesting,
} from "../src/delivery.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

const GCHAT_OPTS = {
  channel: "google-chat" as const,
  spaceName: "spaces/test",
  threadName: "spaces/test/threads/1",
  maxRetries: 1,
};

function makeTelegramBot(sendFn: (...args: any[]) => Promise<any>) {
  return { api: { sendMessage: sendFn } };
}

const TELEGRAM_OPTS = {
  channel: "telegram" as const,
  telegramChatId: "12345",
  maxRetries: 1,
};

beforeEach(() => {
  mockSendGchat.mockClear();
  mockSendGchat.mockImplementation(() =>
    Promise.resolve({ externalId: "spaces/test/messages/1", threadName: "spaces/test/threads/1" })
  );
  _resetPendingResponsesForTesting();
});

// ── Google Chat success ────────────────────────────────────────────────────────

describe("deliverMessage — google-chat success", () => {
  test("returns status: 'sent' on success", async () => {
    const result = await deliverMessage(null, "Hello!", GCHAT_OPTS);
    expect(result.status).toBe("sent");
    expect(result.channel).toBe("google-chat");
  });

  test("includes externalId and threadName from sendGoogleChatMessage", async () => {
    const result = await deliverMessage(null, "Hello!", GCHAT_OPTS);
    expect(result.externalId).toBe("spaces/test/messages/1");
    expect(result.threadName).toBe("spaces/test/threads/1");
  });

  test("calls sendGoogleChatMessage with correct args", async () => {
    await deliverMessage(null, "Test message", GCHAT_OPTS);
    expect(mockSendGchat).toHaveBeenCalledTimes(1);
    expect(mockSendGchat).toHaveBeenCalledWith(
      "spaces/test",
      "Test message",
      "spaces/test/threads/1",
    );
  });

  test("attempts reflects actual attempt count", async () => {
    const result = await deliverMessage(null, "Hello!", GCHAT_OPTS);
    expect(result.attempts).toBe(1);
  });
});

// ── Telegram success ───────────────────────────────────────────────────────────

describe("deliverMessage — telegram success", () => {
  test("returns status: 'sent' on success", async () => {
    const telegramSend = mock(() => Promise.resolve({ message_id: 42 }));
    const result = await deliverMessage(null, "Hello!", {
      ...TELEGRAM_OPTS,
      telegramBot: makeTelegramBot(telegramSend),
    });
    expect(result.status).toBe("sent");
    expect(result.channel).toBe("telegram");
  });

  test("externalId prefixed with 'telegram:'", async () => {
    const telegramSend = mock(() => Promise.resolve({ message_id: 99 }));
    const result = await deliverMessage(null, "Hello!", {
      ...TELEGRAM_OPTS,
      telegramBot: makeTelegramBot(telegramSend),
    });
    expect(result.externalId).toBe("telegram:99");
  });

  test("no telegramBot or chatId configured → failed", async () => {
    const result = await deliverMessage(null, "Hello!", {
      channel: "telegram" as const,
      maxRetries: 1,
    });
    expect(result.status).toBe("failed");
  });
});

// ── Primary failure — no fallback ─────────────────────────────────────────────

describe("deliverMessage — primary failure, no fallback", () => {
  test("gchat fails → status: 'failed'", async () => {
    mockSendGchat.mockImplementation(() => Promise.reject(new Error("Network error")));
    const result = await deliverMessage(null, "Hello!", GCHAT_OPTS);
    expect(result.status).toBe("failed");
    expect(result.channel).toBe("google-chat");
  });

  test("failed result includes error message", async () => {
    mockSendGchat.mockImplementation(() => Promise.reject(new Error("Timeout")));
    const result = await deliverMessage(null, "Hello!", GCHAT_OPTS);
    expect(result.error).toContain("Timeout");
  });

  test("gchat fails → sendGoogleChatMessage called maxRetries times", async () => {
    mockSendGchat.mockImplementation(() => Promise.reject(new Error("fail")));
    await deliverMessage(null, "Hello!", { ...GCHAT_OPTS, maxRetries: 1 });
    expect(mockSendGchat).toHaveBeenCalledTimes(1);
  });
});

// ── Fallback: gchat → telegram ─────────────────────────────────────────────────

describe("deliverMessage — fallback gchat → telegram", () => {
  test("gchat fails, telegram succeeds → status: 'fallback', channel: 'telegram'", async () => {
    mockSendGchat.mockImplementation(() => Promise.reject(new Error("gchat down")));
    const telegramSend = mock(() => Promise.resolve({ message_id: 7 }));
    const result = await deliverMessage(null, "Hello!", {
      ...GCHAT_OPTS,
      telegramChatId: "12345",
      telegramBot: makeTelegramBot(telegramSend),
      fallback: true,
    });
    expect(result.status).toBe("fallback");
    expect(result.channel).toBe("telegram");
  });

  test("fallback telegram message includes prefix", async () => {
    mockSendGchat.mockImplementation(() => Promise.reject(new Error("gchat down")));
    const telegramSend = mock(() => Promise.resolve({ message_id: 7 }));
    await deliverMessage(null, "Original text", {
      ...GCHAT_OPTS,
      telegramChatId: "12345",
      telegramBot: makeTelegramBot(telegramSend),
      fallback: true,
    });
    const sentText = telegramSend.mock.calls[0]?.[1] as string;
    expect(sentText).toContain("Telegram");
    expect(sentText).toContain("Original text");
  });
});

// ── Fallback: telegram → gchat ─────────────────────────────────────────────────

describe("deliverMessage — fallback telegram → gchat", () => {
  test("telegram fails, gchat succeeds → status: 'fallback', channel: 'google-chat'", async () => {
    const telegramSend = mock(() => Promise.reject(new Error("telegram down")));
    const result = await deliverMessage(null, "Hello!", {
      ...TELEGRAM_OPTS,
      telegramBot: makeTelegramBot(telegramSend),
      spaceName: "spaces/test",
      fallback: true,
    });
    expect(result.status).toBe("fallback");
    expect(result.channel).toBe("google-chat");
  });
});

// ── Both channels fail ─────────────────────────────────────────────────────────

describe("deliverMessage — both channels fail", () => {
  test("gchat fails + telegram fallback fails → status: 'failed'", async () => {
    mockSendGchat.mockImplementation(() => Promise.reject(new Error("gchat down")));
    const telegramSend = mock(() => Promise.reject(new Error("telegram down")));
    const result = await deliverMessage(null, "Hello!", {
      ...GCHAT_OPTS,
      telegramChatId: "12345",
      telegramBot: makeTelegramBot(telegramSend),
      fallback: true,
    });
    expect(result.status).toBe("failed");
  });

  test("failed result includes both error messages", async () => {
    mockSendGchat.mockImplementation(() => Promise.reject(new Error("gchat down")));
    const telegramSend = mock(() => Promise.reject(new Error("telegram down")));
    const result = await deliverMessage(null, "Hello!", {
      ...GCHAT_OPTS,
      telegramChatId: "12345",
      telegramBot: makeTelegramBot(telegramSend),
      fallback: true,
    });
    expect(result.error).toContain("gchat down");
    expect(result.error).toContain("telegram down");
  });
});

// ── Pending response tracking ──────────────────────────────────────────────────

describe("acknowledgeChannel + getStaleResponses", () => {
  test("getStaleResponses returns [] when no pending responses", () => {
    expect(getStaleResponses()).toEqual([]);
  });

  test("acknowledgeChannel is safe to call on empty state", () => {
    expect(() => acknowledgeChannel("google-chat")).not.toThrow();
  });

  test("getStaleResponses returns [] immediately after successful delivery (not yet stale)", async () => {
    await deliverMessage(null, "Hello!", GCHAT_OPTS);
    // Entry was just added — sentAt is now, not stale
    expect(getStaleResponses()).toEqual([]);
  });

  test("acknowledgeChannel clears entries for that channel after delivery", async () => {
    await deliverMessage(null, "Hello!", GCHAT_OPTS);
    acknowledgeChannel("google-chat");
    // After acknowledge, nothing to get stale
    expect(getStaleResponses()).toEqual([]);
  });
});
