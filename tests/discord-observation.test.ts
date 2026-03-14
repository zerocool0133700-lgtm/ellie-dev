/**
 * Channel Tests: Discord Observation — ELLIE-711
 *
 * Tests creature/job event posting behavior when no client is set (fire-and-forget).
 */

import { describe, test, expect, mock } from "bun:test";

// ── Mock discord.js ───────────────────────────────────────────
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

import {
  setObservationClient,
  initObservationChannels,
  postCreatureEvent,
  postJobEvent,
  type CreatureEventData,
  type JobEventData,
} from "../src/channels/discord/observation.ts";

describe("discord observation", () => {
  describe("postCreatureEvent", () => {
    test("does not throw when client is null", () => {
      setObservationClient(null);
      expect(() => postCreatureEvent("dispatched", {
        agentType: "dev",
        workItemId: "ELLIE-100",
      })).not.toThrow();
    });

    test("does not throw for completed event", () => {
      setObservationClient(null);
      expect(() => postCreatureEvent("completed", {
        agentType: "dev",
        workItemId: "ELLIE-100",
        durationMs: 60000,
        responsePreview: "Done building feature",
      })).not.toThrow();
    });

    test("does not throw for failed event", () => {
      setObservationClient(null);
      expect(() => postCreatureEvent("failed", {
        agentType: "dev",
        error: "Build failed: missing dependency",
      })).not.toThrow();
    });

    test("handles missing optional fields", () => {
      setObservationClient(null);
      expect(() => postCreatureEvent("dispatched", {
        agentType: "research",
      })).not.toThrow();
    });
  });

  describe("postJobEvent", () => {
    test("does not throw when client is null", () => {
      setObservationClient(null);
      expect(() => postJobEvent("created", {
        agentType: "dev",
        workItemId: "ELLIE-200",
      })).not.toThrow();
    });

    test("does not throw for completed job", () => {
      setObservationClient(null);
      expect(() => postJobEvent("completed", {
        agentType: "dev",
        durationMs: 120000,
        costUsd: "0.052",
      })).not.toThrow();
    });

    test("does not throw for responded job", () => {
      setObservationClient(null);
      expect(() => postJobEvent("responded", {
        agentType: "strategy",
      })).not.toThrow();
    });

    test("does not throw for failed job", () => {
      setObservationClient(null);
      expect(() => postJobEvent("failed", {
        agentType: "dev",
        error: "Timeout",
      })).not.toThrow();
    });
  });

  describe("initObservationChannels", () => {
    test("does not throw", () => {
      expect(() => initObservationChannels()).not.toThrow();
    });
  });
});
