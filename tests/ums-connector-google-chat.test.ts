/**
 * UMS Connector Tests: Google Chat — ELLIE-708
 */

import { describe, test, expect } from "bun:test";
import { googleChatConnector } from "../src/ums/connectors/google-chat.ts";
import { googleChatFixtures as fx } from "./fixtures/ums-connector-payloads.ts";

describe("googleChatConnector", () => {
  test("provider is 'gchat'", () => {
    expect(googleChatConnector.provider).toBe("gchat");
  });

  // ── Legacy format ────────────────────────────────────────

  test("normalizes legacy format MESSAGE", () => {
    const result = googleChatConnector.normalize(fx.legacyMessage);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("gchat");
    expect(result!.provider_id).toBe("spaces/AAA/messages/msg-001");
    expect(result!.channel).toBe("spaces/AAA");
    expect(result!.content).toBe("Hello from GChat");
    expect(result!.content_type).toBe("text");
    expect(result!.sender).toEqual({ name: "Dave", email: "dave@example.com" });
    expect(result!.provider_timestamp).toBe("2026-03-14T10:00:00Z");
    expect(result!.metadata).toMatchObject({
      thread_name: "spaces/AAA/threads/thread-001",
      space_type: "DM",
      is_direct: true,
      message_name: "spaces/AAA/messages/msg-001",
    });
  });

  test("returns null for legacy non-MESSAGE type", () => {
    expect(googleChatConnector.normalize(fx.legacyNonMessage)).toBeNull();
  });

  // ── New format ───────────────────────────────────────────

  test("normalizes new format message", () => {
    const result = googleChatConnector.normalize(fx.newFormatMessage);
    expect(result).not.toBeNull();
    expect(result!.provider_id).toBe("spaces/BBB/messages/msg-002");
    expect(result!.channel).toBe("spaces/BBB");
    expect(result!.content).toBe("New format message");
    expect(result!.sender).toEqual({ name: "Alice", email: "alice@example.com" });
    expect(result!.metadata!.space_type).toBe("ROOM");
    expect(result!.metadata!.is_direct).toBe(false);
  });

  // ── Error paths ──────────────────────────────────────────

  test("returns null when new format has no text", () => {
    expect(googleChatConnector.normalize(fx.newFormatNoText)).toBeNull();
  });

  test("returns null for empty payload", () => {
    expect(googleChatConnector.normalize(fx.empty)).toBeNull();
  });
});
