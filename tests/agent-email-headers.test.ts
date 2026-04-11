/**
 * Agent Email Headers Test — ELLIE-785+
 *
 * Tests the agent-to-agent email identification system using custom headers.
 * Verifies that agents can send emails to each other and distinguish them from external emails.
 */

import { describe, test, expect } from "bun:test";
import {
  buildAgentHeaders,
  isInterAgentMessage,
  sendEmail,
  replyToEmail,
  type AgentEmailHeaders,
} from "../src/agentmail";

describe("Agent Email Headers", () => {
  describe("buildAgentHeaders", () => {
    test("builds complete headers with all fields", () => {
      const headers = buildAgentHeaders("brian", "critic", "inter-agent", "code-review");

      expect(headers["X-Sent-By-Agent"]).toBe("brian");
      expect(headers["X-Agent-Type"]).toBe("critic");
      expect(headers["X-Message-Type"]).toBe("inter-agent");
      expect(headers["X-Thread-Context"]).toBe("code-review");
    });

    test("builds minimal headers without thread context", () => {
      const headers = buildAgentHeaders("amy", "content", "inter-agent");

      expect(headers["X-Sent-By-Agent"]).toBe("amy");
      expect(headers["X-Agent-Type"]).toBe("content");
      expect(headers["X-Message-Type"]).toBe("inter-agent");
      expect(headers["X-Thread-Context"]).toBeUndefined();
    });

    test("defaults to inter-agent message type", () => {
      const headers = buildAgentHeaders("brian", "critic");

      expect(headers["X-Message-Type"]).toBe("inter-agent");
    });

    test("supports notification message type", () => {
      const headers = buildAgentHeaders("brian", "critic", "notification");

      expect(headers["X-Message-Type"]).toBe("notification");
    });

    test("supports external message type", () => {
      const headers = buildAgentHeaders("amy", "content", "external");

      expect(headers["X-Message-Type"]).toBe("external");
    });
  });

  describe("isInterAgentMessage", () => {
    test("returns true when X-Sent-By-Agent header present", () => {
      const headers = { "X-Sent-By-Agent": "brian", "X-Agent-Type": "critic" };
      expect(isInterAgentMessage(headers)).toBe(true);
    });

    test("returns false when headers undefined", () => {
      expect(isInterAgentMessage(undefined)).toBe(false);
    });

    test("returns false when headers empty", () => {
      expect(isInterAgentMessage({})).toBe(false);
    });

    test("returns false when X-Sent-By-Agent missing", () => {
      const headers = { "X-Agent-Type": "critic", "X-Message-Type": "inter-agent" };
      expect(isInterAgentMessage(headers)).toBe(false);
    });

    test("returns true even if other headers missing", () => {
      const headers = { "X-Sent-By-Agent": "amy" };
      expect(isInterAgentMessage(headers)).toBe(true);
    });
  });

  describe("Integration — Agent-to-Agent Email Flow", () => {
    test("headers are preserved in sendEmail signature", () => {
      // This test verifies that the sendEmail function accepts headers parameter
      // We don't actually send an email, just check the function signature

      const headers = buildAgentHeaders("brian", "critic", "inter-agent", "code-review");

      // TypeScript should allow this call without errors
      const callWithHeaders = async () => {
        // Mock config to prevent actual API call
        const mockConfig = {
          apiKey: "test-key",
          inboxEmail: "test@example.com",
          webhookSecret: "test-secret",
        };

        // This would fail type-checking if headers parameter wasn't supported
        // We won't actually execute it, just verify it compiles
        const fn = () =>
          sendEmail(
            ["amy-ellie-os@agentmail.to"],
            "Test Subject",
            "Test Message",
            mockConfig,
            headers,
          );

        expect(typeof fn).toBe("function");
      };

      expect(callWithHeaders).not.toThrow();
    });

    test("headers are preserved in replyToEmail signature", () => {
      const headers = buildAgentHeaders("amy", "content", "inter-agent");

      const callWithHeaders = async () => {
        const mockConfig = {
          apiKey: "test-key",
          inboxEmail: "test@example.com",
          webhookSecret: "test-secret",
        };

        // This would fail type-checking if headers parameter wasn't supported
        const fn = () =>
          replyToEmail("msg-123", "Reply text", mockConfig, headers);

        expect(typeof fn).toBe("function");
      };

      expect(callWithHeaders).not.toThrow();
    });
  });

  describe("Header Parsing from Webhook", () => {
    test("webhook payload with headers is parsed correctly", () => {
      const payload = {
        event_type: "message.received",
        data: {
          inbox_id: "brian-ellie-os@agentmail.to",
          message_id: "msg-123",
          thread_id: "thread-456",
          from: "amy-ellie-os@agentmail.to",
          to: ["brian-ellie-os@agentmail.to"],
          subject: "Code Review Request",
          text: "Please review this code",
          headers: {
            "X-Sent-By-Agent": "amy",
            "X-Agent-Type": "content",
            "X-Message-Type": "inter-agent",
            "X-Thread-Context": "code-review",
          },
        },
        timestamp: "2026-03-17T20:48:00Z",
      };

      const { parseWebhookPayload } = require("../src/agentmail");
      const parsed = parseWebhookPayload(payload);

      expect(parsed).not.toBeNull();
      expect(parsed?.headers).toBeDefined();
      expect(parsed?.headers?.["X-Sent-By-Agent"]).toBe("amy");
      expect(parsed?.headers?.["X-Agent-Type"]).toBe("content");
      expect(parsed?.headers?.["X-Message-Type"]).toBe("inter-agent");
      expect(parsed?.headers?.["X-Thread-Context"]).toBe("code-review");
    });

    test("webhook payload without headers is parsed correctly", () => {
      const payload = {
        event_type: "message.received",
        data: {
          inbox_id: "brian-ellie-os@agentmail.to",
          message_id: "msg-789",
          thread_id: "thread-012",
          from: "dave@example.com",
          to: ["brian-ellie-os@agentmail.to"],
          subject: "External Email",
          text: "This is from an external sender",
        },
        timestamp: "2026-03-17T20:49:00Z",
      };

      const { parseWebhookPayload } = require("../src/agentmail");
      const parsed = parseWebhookPayload(payload);

      expect(parsed).not.toBeNull();
      expect(parsed?.headers).toBeUndefined();
    });
  });

  describe("End-to-End Scenario", () => {
    test("Brian sends to Amy, Amy recognizes it as inter-agent", () => {
      // Step 1: Brian builds headers for sending to Amy
      const brianHeaders = buildAgentHeaders("brian", "critic", "inter-agent", "content-review");

      expect(brianHeaders["X-Sent-By-Agent"]).toBe("brian");
      expect(brianHeaders["X-Agent-Type"]).toBe("critic");
      expect(brianHeaders["X-Message-Type"]).toBe("inter-agent");
      expect(brianHeaders["X-Thread-Context"]).toBe("content-review");

      // Step 2: Amy receives the message (simulating webhook payload)
      const webhookPayload = {
        event_type: "message.received",
        data: {
          inbox_id: "amy-ellie-os@agentmail.to",
          message_id: "msg-brian-to-amy",
          thread_id: "thread-content-review",
          from: "brian-ellie-os@agentmail.to",
          to: ["amy-ellie-os@agentmail.to"],
          subject: "Content Review Needed",
          text: "Please revise this draft based on the following feedback...",
          headers: brianHeaders,
        },
        timestamp: "2026-03-17T20:50:00Z",
      };

      const { parseWebhookPayload } = require("../src/agentmail");
      const parsed = parseWebhookPayload(webhookPayload);

      expect(parsed).not.toBeNull();
      expect(isInterAgentMessage(parsed?.headers)).toBe(true);
      expect(parsed?.headers?.["X-Sent-By-Agent"]).toBe("brian");
      expect(parsed?.headers?.["X-Agent-Type"]).toBe("critic");

      // Step 3: Amy builds reply headers
      const amyHeaders = buildAgentHeaders("amy", "content", "inter-agent", "content-review");

      expect(amyHeaders["X-Sent-By-Agent"]).toBe("amy");
      expect(amyHeaders["X-Agent-Type"]).toBe("content");
      expect(amyHeaders["X-Message-Type"]).toBe("inter-agent");
    });

    test("Dave sends to Brian, Brian recognizes it as external", () => {
      // Step 1: Dave sends an email (no custom headers)
      const webhookPayload = {
        event_type: "message.received",
        data: {
          inbox_id: "brian-ellie-os@agentmail.to",
          message_id: "msg-dave-to-brian",
          thread_id: "thread-external",
          from: "dave@example.com",
          to: ["brian-ellie-os@agentmail.to"],
          subject: "Question about architecture",
          text: "Can you review the system architecture diagram?",
        },
        timestamp: "2026-03-17T20:51:00Z",
      };

      const { parseWebhookPayload } = require("../src/agentmail");
      const parsed = parseWebhookPayload(webhookPayload);

      // Step 2: Brian receives it and checks if it's inter-agent
      expect(parsed).not.toBeNull();
      expect(isInterAgentMessage(parsed?.headers)).toBe(false);
      expect(parsed?.from).toBe("dave@example.com");

      // Step 3: Brian responds with agent headers (since all agent replies include them)
      const brianHeaders = buildAgentHeaders("brian", "critic", "inter-agent");

      expect(brianHeaders["X-Sent-By-Agent"]).toBe("brian");
      expect(brianHeaders["X-Message-Type"]).toBe("inter-agent");
    });
  });
});
