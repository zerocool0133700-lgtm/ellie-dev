/**
 * Channel Tests: Slack Handler — ELLIE-711
 *
 * Tests message filtering, mention stripping, and command parsing.
 */

import { describe, test, expect, mock } from "bun:test";

// ── Mocks ─────────────────────────────────────────────────────
mock.module("../../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));
mock.module("../../src/message-queue.ts", () => ({
  enqueue: mock(async (fn: Function) => fn()),
}));
mock.module("../../src/message-sender.ts", () => ({
  saveMessage: mock(async () => {}),
}));
mock.module("./send.ts", () => ({
  sendSlackMessage: mock(async () => ({ ts: "1234.5678" })),
  deleteSlackMessage: mock(async () => {}),
  sendSlackCommandResponse: mock(async () => {}),
}));
mock.module("./format.ts", () => ({
  markdownToMrkdwn: mock((t: string) => t),
}));
mock.module("../../src/relay-config.ts", () => ({
  RELAY_BASE_URL: "http://localhost:3001",
}));
mock.module("../../src/claude-cli.ts", () => ({
  callClaude: mock(async () => "mock response"),
}));

import {
  stripMentions,
  handleSlackEvent,
  handleSlackCommand,
  type SlackEventPayload,
  type SlackCommandPayload,
} from "../src/channels/slack/handler.ts";

describe("slack handler", () => {
  describe("stripMentions", () => {
    test("removes single mention", () => {
      expect(stripMentions("<@U12345> hello")).toBe("hello");
    });

    test("removes multiple mentions", () => {
      expect(stripMentions("<@U12345> <@U67890> hi there")).toBe("hi there");
    });

    test("handles text with no mentions", () => {
      expect(stripMentions("hello world")).toBe("hello world");
    });

    test("handles empty string", () => {
      expect(stripMentions("")).toBe("");
    });

    test("handles mention-only text", () => {
      expect(stripMentions("<@U12345>")).toBe("");
    });

    test("strips mentions from middle of text", () => {
      expect(stripMentions("hello <@U12345> world")).toBe("hello  world");
    });

    test("handles mention with alphanumeric IDs", () => {
      expect(stripMentions("<@UABC123DEF> test")).toBe("test");
    });
  });

  describe("handleSlackEvent", () => {
    const agentFor = () => "general";

    test("ignores bot messages", async () => {
      const event: SlackEventPayload = {
        type: "message",
        bot_id: "B12345",
        text: "bot message",
        channel: "C123",
      };
      // Should return without error
      await handleSlackEvent(event, agentFor);
    });

    test("ignores bot_message subtype", async () => {
      const event: SlackEventPayload = {
        type: "message",
        subtype: "bot_message",
        text: "bot subtype",
        channel: "C123",
      };
      await handleSlackEvent(event, agentFor);
    });

    test("ignores empty text with no files", async () => {
      const event: SlackEventPayload = {
        type: "message",
        user: "U123",
        text: "<@U99999>",  // becomes empty after stripping
        channel: "C123",
      };
      await handleSlackEvent(event, agentFor);
    });
  });

  describe("handleSlackCommand", () => {
    test("rejects unauthorized user", async () => {
      const original = process.env.SLACK_ALLOWED_USER_ID;
      process.env.SLACK_ALLOWED_USER_ID = "U_ALLOWED";
      try {
        const result = await handleSlackCommand({
          command: "/ellie",
          text: "test",
          user_id: "U_NOT_ALLOWED",
          channel_id: "C123",
          response_url: "https://hooks.slack.com/...",
          trigger_id: "t123",
        });
        expect(result).toBe("Unauthorized.");
      } finally {
        if (original) process.env.SLACK_ALLOWED_USER_ID = original;
        else delete process.env.SLACK_ALLOWED_USER_ID;
      }
    });

    test("returns usage for empty /forest query", async () => {
      const original = process.env.SLACK_ALLOWED_USER_ID;
      delete process.env.SLACK_ALLOWED_USER_ID;
      try {
        const result = await handleSlackCommand({
          command: "/forest",
          text: "",
          user_id: "U123",
          channel_id: "C123",
          response_url: "https://hooks.slack.com/...",
          trigger_id: "t123",
        });
        expect(result).toContain("Usage");
      } finally {
        if (original) process.env.SLACK_ALLOWED_USER_ID = original;
      }
    });
  });
});
