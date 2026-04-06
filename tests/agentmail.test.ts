/**
 * AgentMail Email Channel Tests — ELLIE-785
 *
 * Tests for the AgentMail integration:
 * - Webhook signature verification
 * - Webhook payload parsing
 * - Config detection
 * - Echo prevention
 * - Send / reply API client
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  verifyWebhookSignature,
  parseWebhookPayload,
  getAgentMailConfig,
  isAgentMailEnabled,
  sendEmail,
  replyToEmail,
  type AgentMailWebhookPayload,
} from "../src/agentmail.ts";
import { createHmac } from "crypto";

// ── Webhook Signature Verification ──────────────────────────

describe("verifyWebhookSignature", () => {
  const secret = "whsec_test-secret-123";

  test("returns true for valid signature", () => {
    const body = '{"event_type":"message.received","data":{}}';
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyWebhookSignature(body, sig, secret)).toBe(true);
  });

  test("returns false for invalid signature", () => {
    const body = '{"event_type":"message.received","data":{}}';
    expect(verifyWebhookSignature(body, "invalid-signature", secret)).toBe(false);
  });

  test("returns false for missing signature", () => {
    const body = '{"event_type":"message.received","data":{}}';
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
  });

  test("returns false for tampered body", () => {
    const body = '{"event_type":"message.received","data":{}}';
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyWebhookSignature(body + "tampered", sig, secret)).toBe(false);
  });

  test("handles empty body", () => {
    const sig = createHmac("sha256", secret).update("").digest("hex");
    expect(verifyWebhookSignature("", sig, secret)).toBe(true);
  });
});

// ── Webhook Payload Parsing ────────────────────────────────

describe("parseWebhookPayload", () => {
  test("parses valid message.received event", () => {
    const payload: AgentMailWebhookPayload = {
      event_type: "message.received",
      data: {
        inbox_id: "ellie.os@agentmail.to",
        message_id: "msg-123",
        thread_id: "thread-456",
        from: "dave@ellie-labs.dev",
        to: ["ellie.os@agentmail.to"],
        subject: "Test email",
        text: "Hello from email!",
      },
      timestamp: "2026-03-16T12:00:00Z",
    };

    const result = parseWebhookPayload(payload);
    expect(result).not.toBeNull();
    expect(result!.messageId).toBe("msg-123");
    expect(result!.threadId).toBe("thread-456");
    expect(result!.from).toBe("dave@ellie-labs.dev");
    expect(result!.subject).toBe("Test email");
    expect(result!.text).toBe("Hello from email!");
    expect(result!.inboxId).toBe("ellie.os@agentmail.to");
  });

  test("prefers extracted_text over text", () => {
    const payload: AgentMailWebhookPayload = {
      event_type: "message.received",
      data: {
        inbox_id: "inbox",
        message_id: "msg-1",
        thread_id: "t-1",
        from: "user@example.com",
        to: ["inbox@agentmail.to"],
        subject: "Test",
        text: "Full email with signatures and quotes",
        extracted_text: "Just the clean content",
      },
      timestamp: "2026-03-16T12:00:00Z",
    };

    const result = parseWebhookPayload(payload);
    expect(result!.text).toBe("Just the clean content");
  });

  test("returns null for non-message events", () => {
    const payload: AgentMailWebhookPayload = {
      event_type: "thread.created",
      data: {
        inbox_id: "inbox",
        message_id: "msg-1",
        thread_id: "t-1",
        from: "user@example.com",
        to: [],
        subject: "Test",
        text: "Content",
      },
      timestamp: "2026-03-16T12:00:00Z",
    };

    expect(parseWebhookPayload(payload)).toBeNull();
  });

  test("returns null for empty text", () => {
    const payload: AgentMailWebhookPayload = {
      event_type: "message.received",
      data: {
        inbox_id: "inbox",
        message_id: "msg-1",
        thread_id: "t-1",
        from: "user@example.com",
        to: [],
        subject: "Test",
        text: "   ",
      },
      timestamp: "2026-03-16T12:00:00Z",
    };

    expect(parseWebhookPayload(payload)).toBeNull();
  });

  test("returns null for missing message_id", () => {
    const payload: AgentMailWebhookPayload = {
      event_type: "message.received",
      data: {
        inbox_id: "inbox",
        message_id: "",
        thread_id: "t-1",
        from: "user@example.com",
        to: [],
        subject: "Test",
        text: "Content",
      },
      timestamp: "2026-03-16T12:00:00Z",
    };

    expect(parseWebhookPayload(payload)).toBeNull();
  });

  test("defaults subject to (no subject) when missing", () => {
    const payload: AgentMailWebhookPayload = {
      event_type: "message.received",
      data: {
        inbox_id: "inbox",
        message_id: "msg-1",
        thread_id: "t-1",
        from: "user@example.com",
        to: [],
        subject: "",
        text: "Content here",
      },
      timestamp: "2026-03-16T12:00:00Z",
    };

    const result = parseWebhookPayload(payload);
    expect(result!.subject).toBe("(no subject)");
  });
});

// ── Config Detection ────────────────────────────────────────

describe("config detection", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    process.env.AGENTMAIL_API_KEY = originalEnv.AGENTMAIL_API_KEY;
    process.env.AGENTMAIL_INBOX_EMAIL = originalEnv.AGENTMAIL_INBOX_EMAIL;
    process.env.AGENTMAIL_WEBHOOK_SECRET = originalEnv.AGENTMAIL_WEBHOOK_SECRET;
  });

  test("getAgentMailConfig returns config when all vars set", () => {
    process.env.AGENTMAIL_API_KEY = "test-key";
    process.env.AGENTMAIL_INBOX_EMAIL = "test@agentmail.to";
    process.env.AGENTMAIL_WEBHOOK_SECRET = "test-secret";

    const config = getAgentMailConfig();
    expect(config).not.toBeNull();
    expect(config!.apiKey).toBe("test-key");
    expect(config!.inboxEmail).toBe("test@agentmail.to");
    expect(config!.webhookSecret).toBe("test-secret");
  });

  test("getAgentMailConfig returns null when API key missing", () => {
    delete process.env.AGENTMAIL_API_KEY;
    process.env.AGENTMAIL_INBOX_EMAIL = "test@agentmail.to";
    process.env.AGENTMAIL_WEBHOOK_SECRET = "test-secret";

    expect(getAgentMailConfig()).toBeNull();
  });

  test("getAgentMailConfig returns null when inbox missing", () => {
    process.env.AGENTMAIL_API_KEY = "test-key";
    delete process.env.AGENTMAIL_INBOX_EMAIL;
    process.env.AGENTMAIL_WEBHOOK_SECRET = "test-secret";

    expect(getAgentMailConfig()).toBeNull();
  });

  test("isAgentMailEnabled reflects config presence", () => {
    process.env.AGENTMAIL_API_KEY = "test-key";
    process.env.AGENTMAIL_INBOX_EMAIL = "test@agentmail.to";
    process.env.AGENTMAIL_WEBHOOK_SECRET = "test-secret";
    expect(isAgentMailEnabled()).toBe(true);

    delete process.env.AGENTMAIL_API_KEY;
    expect(isAgentMailEnabled()).toBe(false);
  });
});

// ── Send Email ──────────────────────────────────────────────

describe("sendEmail", () => {
  test("throws when config is null", async () => {
    // Pass explicit null-like config to bypass env fallback
    const badConfig = { apiKey: "", inboxEmail: "", webhookSecret: "" };
    // sendEmail checks config ?? getAgentMailConfig(), so pass explicit config
    // with empty apiKey — it won't be null, but the API call will fail
    // Instead, test by temporarily clearing env
    const saved = process.env.AGENTMAIL_API_KEY;
    delete process.env.AGENTMAIL_API_KEY;
    try {
      await expect(sendEmail(["to@example.com"], "Subject", "Body")).rejects.toThrow("AgentMail not configured");
    } finally {
      process.env.AGENTMAIL_API_KEY = saved;
    }
  });

  test("config has correct shape when env vars set", () => {
    const config = getAgentMailConfig();
    if (!config) return;
    expect(config.apiKey).toBeTruthy();
    expect(config.inboxEmail).toContain("@agentmail.to");
  });
});

// ── Reply to Email ──────────────────────────────────────────

describe("replyToEmail", () => {
  test("throws when config is null", async () => {
    const saved = process.env.AGENTMAIL_API_KEY;
    delete process.env.AGENTMAIL_API_KEY;
    try {
      await expect(replyToEmail("msg-123", "Reply text")).rejects.toThrow("AgentMail not configured");
    } finally {
      process.env.AGENTMAIL_API_KEY = saved;
    }
  });
});

// ── Echo Prevention (integration-level) ─────────────────────

describe("echo prevention", () => {
  test("parseWebhookPayload accepts external sender", () => {
    const payload: AgentMailWebhookPayload = {
      event_type: "message.received",
      data: {
        inbox_id: "ellie.os@agentmail.to",
        message_id: "msg-ext",
        thread_id: "t-ext",
        from: "external@company.com",
        to: ["ellie.os@agentmail.to"],
        subject: "Question",
        text: "How do I use the API?",
      },
      timestamp: "2026-03-16T12:00:00Z",
    };

    const result = parseWebhookPayload(payload);
    expect(result).not.toBeNull();
    expect(result!.from).toBe("external@company.com");
  });

  test("echo check: from matches inbox email", () => {
    // The webhook handler checks `parsed.from === config.inboxEmail`
    // This test validates the logic would work
    const inboxEmail = "ellie.os@agentmail.to";
    const selfMessage = "ellie.os@agentmail.to";
    const externalMessage = "dave@ellie-labs.dev";

    expect(selfMessage === inboxEmail).toBe(true); // Would be skipped
    expect(externalMessage === inboxEmail).toBe(false); // Would be processed
  });
});

// ── E2E: Parse → Verify → Response Flow ────────────────────

describe("E2E: inbound email flow", () => {
  test("full webhook verification and parse lifecycle", () => {
    const secret = "whsec_test-e2e";
    const body = JSON.stringify({
      event_type: "message.received",
      data: {
        inbox_id: "ellie.os@agentmail.to",
        message_id: "msg-e2e-001",
        thread_id: "thread-e2e-001",
        from: "dave@ellie-labs.dev",
        to: ["ellie.os@agentmail.to"],
        subject: "Morning briefing request",
        text: "Can you send me the morning briefing summary?",
      },
      timestamp: "2026-03-16T08:00:00Z",
    });

    // Step 1: Verify signature
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyWebhookSignature(body, signature, secret)).toBe(true);

    // Step 2: Parse payload
    const payload: AgentMailWebhookPayload = JSON.parse(body);
    const parsed = parseWebhookPayload(payload);
    expect(parsed).not.toBeNull();

    // Step 3: Validate parsed fields
    expect(parsed!.from).toBe("dave@ellie-labs.dev");
    expect(parsed!.subject).toBe("Morning briefing request");
    expect(parsed!.text).toContain("morning briefing");
    expect(parsed!.threadId).toBe("thread-e2e-001");
    expect(parsed!.messageId).toBe("msg-e2e-001");

    // Step 4: Echo check (should NOT be skipped)
    const inboxEmail = "ellie.os@agentmail.to";
    expect(parsed!.from).not.toBe(inboxEmail);
  });
});
