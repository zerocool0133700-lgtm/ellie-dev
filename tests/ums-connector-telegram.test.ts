/**
 * UMS Connector Tests: Telegram — ELLIE-708
 */

import { describe, test, expect } from "bun:test";
import { telegramConnector } from "../src/ums/connectors/telegram.ts";
import { telegramFixtures as fx } from "./fixtures/ums-connector-payloads.ts";

describe("telegramConnector", () => {
  test("provider is 'telegram'", () => {
    expect(telegramConnector.provider).toBe("telegram");
  });

  // ── Happy paths ──────────────────────────────────────────

  test("normalizes a text message", () => {
    const result = telegramConnector.normalize(fx.textMessage);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("telegram");
    expect(result!.provider_id).toBe("12345:101");
    expect(result!.channel).toBe("telegram:12345");
    expect(result!.content).toBe("Hello from Telegram");
    expect(result!.content_type).toBe("text");
    expect(result!.sender).toEqual({ id: "99", name: "Dave", username: "davey" });
    expect(result!.provider_timestamp).toBe(new Date(1710400000 * 1000).toISOString());
    expect(result!.metadata).toMatchObject({
      chat_type: "private",
      message_id: 101,
      has_voice: false,
      has_photo: false,
      has_document: false,
    });
  });

  test("normalizes a voice message", () => {
    const result = telegramConnector.normalize(fx.voiceMessage);
    expect(result).not.toBeNull();
    expect(result!.content_type).toBe("voice");
    expect(result!.content).toBeNull();
    expect(result!.metadata).toMatchObject({
      has_voice: true,
      voice_duration: 12,
      chat_type: "group",
    });
  });

  test("normalizes a photo message with caption", () => {
    const result = telegramConnector.normalize(fx.photoMessage);
    expect(result).not.toBeNull();
    expect(result!.content_type).toBe("image");
    expect(result!.content).toBe("Check this out");
    expect(result!.metadata).toMatchObject({
      has_photo: true,
      has_voice: false,
    });
  });

  test("normalizes a document message", () => {
    const result = telegramConnector.normalize(fx.documentMessage);
    expect(result).not.toBeNull();
    expect(result!.content_type).toBe("text"); // document doesn't change content_type
    expect(result!.content).toBeNull();
    expect(result!.metadata).toMatchObject({
      has_document: true,
      document_name: "report.pdf",
    });
  });

  test("preserves reply_to_message_id in metadata", () => {
    const result = telegramConnector.normalize(fx.replyMessage);
    expect(result).not.toBeNull();
    expect(result!.metadata!.reply_to_message_id).toBe(101);
    expect(result!.content).toBe("Replying here");
  });

  test("preserves raw payload", () => {
    const result = telegramConnector.normalize(fx.textMessage);
    expect(result!.raw).toBe(fx.textMessage);
  });

  // ── Skip / error paths ──────────────────────────────────

  test("returns null for callback_query", () => {
    expect(telegramConnector.normalize(fx.callbackQuery)).toBeNull();
  });

  test("returns null for empty payload", () => {
    expect(telegramConnector.normalize(fx.empty)).toBeNull();
  });

  test("returns null for payload with no message", () => {
    expect(telegramConnector.normalize(fx.noMessage)).toBeNull();
  });

});
