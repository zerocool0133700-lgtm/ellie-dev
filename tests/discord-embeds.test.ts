/**
 * Channel Tests: Discord Embeds — ELLIE-711
 *
 * Tests embed builders and agent color mapping.
 */

import { describe, test, expect, mock } from "bun:test";

// ── Mock discord.js EmbedBuilder ──────────────────────────────
class MockEmbedBuilder {
  private _data: Record<string, unknown> = {};
  setTitle(t: string) { this._data.title = t; return this; }
  setDescription(d: string) { this._data.description = d; return this; }
  setColor(c: unknown) { this._data.color = c; return this; }
  setTimestamp() { this._data.timestamp = true; return this; }
  get data() { return this._data; }
}

mock.module("discord.js", () => ({
  EmbedBuilder: MockEmbedBuilder,
}));
mock.module("../../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

import { agentColor, responseEmbed, errorEmbed, statusEmbed } from "../src/channels/discord/embeds.ts";

describe("discord embeds", () => {
  describe("agentColor", () => {
    test("returns blurple for dev", () => {
      expect(agentColor("dev")).toBe(0x5865f2);
    });

    test("returns green for research", () => {
      expect(agentColor("research")).toBe(0x57f287);
    });

    test("returns yellow for strategy", () => {
      expect(agentColor("strategy")).toBe(0xfee75c);
    });

    test("returns pink for general", () => {
      expect(agentColor("general")).toBe(0xeb459e);
    });

    test("returns red for workflow", () => {
      expect(agentColor("workflow")).toBe(0xed4245);
    });

    test("returns grey for system", () => {
      expect(agentColor("system")).toBe(0x99aab5);
    });

    test("returns grey for unknown agent", () => {
      expect(agentColor("nonexistent")).toBe(0x99aab5);
    });

    test("is case-insensitive", () => {
      expect(agentColor("Dev")).toBe(0x5865f2);
      expect(agentColor("RESEARCH")).toBe(0x57f287);
    });
  });

  describe("responseEmbed", () => {
    test("creates embed with description and color", () => {
      const embed = responseEmbed("Hello world", "dev") as unknown as MockEmbedBuilder;
      expect(embed.data.description).toBe("Hello world");
      expect(embed.data.color).toBe(0x5865f2);
      expect(embed.data.timestamp).toBe(true);
    });

    test("truncates text at 4096 chars", () => {
      const longText = "x".repeat(5000);
      const embed = responseEmbed(longText, "dev") as unknown as MockEmbedBuilder;
      const desc = embed.data.description as string;
      expect(desc.length).toBeLessThanOrEqual(4096);
      expect(desc.endsWith("\u2026")).toBe(true);
    });

    test("preserves short text as-is", () => {
      const embed = responseEmbed("short", "dev") as unknown as MockEmbedBuilder;
      expect(embed.data.description).toBe("short");
    });
  });

  describe("errorEmbed", () => {
    test("creates red embed with error title", () => {
      const embed = errorEmbed("Something broke") as unknown as MockEmbedBuilder;
      expect(embed.data.title).toBe("Error");
      expect(embed.data.description).toBe("Something broke");
      expect(embed.data.color).toBe(0xed4245);
    });
  });

  describe("statusEmbed", () => {
    test("creates embed with title, body, and agent color", () => {
      const embed = statusEmbed("Progress", "Step 2 done", "strategy") as unknown as MockEmbedBuilder;
      expect(embed.data.title).toBe("Progress");
      expect(embed.data.description).toBe("Step 2 done");
      expect(embed.data.color).toBe(0xfee75c);
    });

    test("truncates long body", () => {
      const longBody = "y".repeat(5000);
      const embed = statusEmbed("Title", longBody, "dev") as unknown as MockEmbedBuilder;
      const desc = embed.data.description as string;
      expect(desc.length).toBeLessThanOrEqual(4096);
    });
  });
});
