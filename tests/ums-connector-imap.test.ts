/**
 * UMS Connector Tests: IMAP — ELLIE-708
 */

import { describe, test, expect } from "bun:test";
import { imapConnector } from "../src/ums/connectors/imap.ts";
import { imapFixtures as fx } from "./fixtures/ums-connector-payloads.ts";

describe("imapConnector", () => {
  test("provider is 'imap'", () => {
    expect(imapConnector.provider).toBe("imap");
  });

  // ── Happy paths ──────────────────────────────────────────

  test("normalizes a full IMAP email", () => {
    const result = imapConnector.normalize(fx.basicEmail);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("imap");
    expect(result!.provider_id).toBe("<abc123@mail.yahoo.com>");
    expect(result!.channel).toBe("yahoo:dave@yahoo.com");
    expect(result!.content).toContain("Invoice attached");
    expect(result!.content).toContain("Please find the invoice attached.");
    expect(result!.content_type).toBe("text");
    expect(result!.sender).toEqual({ name: "Billing Dept", email: "billing@acme.com" });
    expect(result!.provider_timestamp).toBe("2026-03-14T08:00:00Z");
    expect(result!.metadata).toMatchObject({
      subject: "Invoice attached",
      mailbox: "INBOX",
      uid: 1234,
      is_read: true,
      is_flagged: true,
      is_answered: false,
      is_draft: false,
      has_attachments: true,
      provider_label: "yahoo",
      account: "dave@yahoo.com",
    });
    expect(result!.metadata!.to).toEqual(["dave@example.com"]);
    expect(result!.metadata!.cc).toEqual(["accounts@example.com"]);
    expect(result!.metadata!.attachments).toHaveLength(1);
    expect(result!.metadata!.attachments[0]).toMatchObject({ filename: "invoice.pdf" });
  });

  test("strips HTML and uses as body fallback", () => {
    const result = imapConnector.normalize(fx.htmlOnlyEmail);
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Newsletter");
    expect(result!.content).toContain("Big news!");
    expect(result!.content).not.toContain("<p>");
    expect(result!.content).not.toContain("<style");
    expect(result!.channel).toBe("protonmail:dave@proton.me");
  });

  test("falls back to preview when no text or html", () => {
    const result = imapConnector.normalize(fx.previewOnlyEmail);
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Just a snippet");
    expect(result!.channel).toBe("fastmail:INBOX"); // no account, fallback to mailbox
  });

  test("handles threaded email with references", () => {
    const result = imapConnector.normalize(fx.threadedEmail);
    expect(result).not.toBeNull();
    expect(result!.metadata!.thread_id).toBe("<thread-msg-1@mail.com>"); // first reference
    expect(result!.metadata!.in_reply_to).toBe("<thread-msg-2@mail.com>");
    expect(result!.metadata!.is_read).toBe(true);
    expect(result!.metadata!.is_answered).toBe(true);
    // from is an array — should pick first element
    expect(result!.sender).toEqual({ name: "Alice", email: "alice@example.com" });
  });

  test("handles draft flags", () => {
    const result = imapConnector.normalize(fx.draftEmail);
    expect(result).not.toBeNull();
    expect(result!.metadata!.is_draft).toBe(true);
    expect(result!.metadata!.is_read).toBe(false);
    expect(result!.metadata!.mailbox).toBe("Drafts");
  });

  test("caps content at 5000 chars", () => {
    const longEmail = {
      message_id: "<long@mail.com>",
      subject: "Long email",
      text: "x".repeat(6000),
      provider_label: "imap",
    };
    const result = imapConnector.normalize(longEmail);
    expect(result).not.toBeNull();
    expect(result!.content!.length).toBeLessThanOrEqual(5000);
  });

  // ── Error paths ──────────────────────────────────────────

  test("returns null when message_id is missing", () => {
    expect(imapConnector.normalize(fx.noMessageId)).toBeNull();
  });

  test("returns null for empty payload", () => {
    expect(imapConnector.normalize(fx.empty)).toBeNull();
  });
});
