/**
 * UMS Connector Tests: Gmail — ELLIE-708
 */

import { describe, test, expect } from "bun:test";
import { gmailConnector } from "../src/ums/connectors/gmail.ts";
import { gmailFixtures as fx } from "./fixtures/ums-connector-payloads.ts";

describe("gmailConnector", () => {
  test("provider is 'gmail'", () => {
    expect(gmailConnector.provider).toBe("gmail");
  });

  test("normalizes a full email", () => {
    const result = gmailConnector.normalize(fx.basicEmail);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("gmail");
    expect(result!.provider_id).toBe("msg-001");
    expect(result!.channel).toBe("conv-001");
    expect(result!.content).toBe("Weekly Report\n\nHere is the weekly summary...");
    expect(result!.content_type).toBe("text");
    expect(result!.sender).toEqual({ name: "Alice", email: "alice@example.com" });
    expect(result!.provider_timestamp).toBe("2026-03-14T10:00:00Z");
    expect(result!.metadata).toMatchObject({
      subject: "Weekly Report",
      is_read: false,
      has_attachments: true,
      conversation_id: "conv-001",
      web_link: "https://outlook.office.com/mail/id/msg-001",
    });
    expect(result!.metadata!.to).toEqual(["dave@example.com"]);
    expect(result!.metadata!.cc).toEqual(["team@example.com"]);
  });

  test("normalizes minimal email (id only)", () => {
    const result = gmailConnector.normalize(fx.minimalEmail);
    expect(result).not.toBeNull();
    expect(result!.provider_id).toBe("msg-002");
    expect(result!.content).toBe("(no subject)");
    expect(result!.channel).toBe("email:msg-002"); // no conversationId fallback
  });

  test("defaults subject to '(no subject)' when missing", () => {
    const result = gmailConnector.normalize(fx.noSubject);
    expect(result).not.toBeNull();
    expect(result!.metadata!.subject).toBe("(no subject)");
    expect(result!.content).toContain("(no subject)");
    expect(result!.content).toContain("Just a quick note");
  });

  test("returns null when id is missing", () => {
    expect(gmailConnector.normalize(fx.noId)).toBeNull();
  });

  test("returns null for empty payload", () => {
    expect(gmailConnector.normalize(fx.empty)).toBeNull();
  });

  test("preserves raw payload", () => {
    const result = gmailConnector.normalize(fx.basicEmail);
    expect(result!.raw).toBe(fx.basicEmail);
  });
});
