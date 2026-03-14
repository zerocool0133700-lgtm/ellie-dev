/**
 * UMS Connector Registry Tests — ELLIE-708
 *
 * Tests the base connector registry: register, lookup, list, normalizePayload.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  registerConnector,
  getConnector,
  listProviders,
  normalizePayload,
  type UMSConnector,
} from "../src/ums/connector.ts";

// Import all connectors to verify they can be registered
import { telegramConnector } from "../src/ums/connectors/telegram.ts";
import { gmailConnector } from "../src/ums/connectors/gmail.ts";
import { googleChatConnector } from "../src/ums/connectors/google-chat.ts";
import { googleTasksConnector } from "../src/ums/connectors/google-tasks.ts";
import { calendarConnector } from "../src/ums/connectors/calendar.ts";
import { voiceConnector } from "../src/ums/connectors/voice.ts";
import { githubConnector } from "../src/ums/connectors/github.ts";
import { imapConnector } from "../src/ums/connectors/imap.ts";
import { documentsConnector } from "../src/ums/connectors/documents.ts";
import { microsoftGraphConnector } from "../src/ums/connectors/microsoft-graph.ts";

describe("UMS Connector Registry", () => {
  // ── Registration ─────────────────────────────────────────

  describe("registerConnector / getConnector", () => {
    test("registers and retrieves a connector", () => {
      const mock: UMSConnector = {
        provider: "test-provider",
        normalize: () => null,
      };
      registerConnector(mock);
      expect(getConnector("test-provider")).toBe(mock);
    });

    test("overwrites existing registration", () => {
      const first: UMSConnector = { provider: "overwrite-test", normalize: () => null };
      const second: UMSConnector = {
        provider: "overwrite-test",
        normalize: (raw) => ({
          provider: "overwrite-test",
          provider_id: "test-1",
          content_type: "text",
          raw: raw as Record<string, unknown>,
        }),
      };
      registerConnector(first);
      registerConnector(second);
      expect(getConnector("overwrite-test")).toBe(second);
    });

    test("returns undefined for unknown provider", () => {
      expect(getConnector("nonexistent-provider-xyz")).toBeUndefined();
    });
  });

  // ── listProviders ────────────────────────────────────────

  describe("listProviders", () => {
    test("includes registered providers", () => {
      registerConnector(telegramConnector);
      registerConnector(gmailConnector);
      const providers = listProviders();
      expect(providers).toContain("telegram");
      expect(providers).toContain("gmail");
    });
  });

  // ── normalizePayload ─────────────────────────────────────

  describe("normalizePayload", () => {
    test("delegates to the correct connector", () => {
      registerConnector(telegramConnector);
      const result = normalizePayload("telegram", {
        message: {
          message_id: 1,
          date: 1710400000,
          text: "test",
          chat: { id: 1, type: "private" },
          from: { id: 1, first_name: "Test" },
        },
      });
      expect(result).not.toBeNull();
      expect(result!.provider).toBe("telegram");
      expect(result!.content).toBe("test");
    });

    test("returns null for unregistered provider", () => {
      expect(normalizePayload("unknown-xyz", { data: "test" })).toBeNull();
    });

    test("returns null when connector skips the payload", () => {
      registerConnector(telegramConnector);
      // callback_query — telegramConnector returns null for this
      expect(normalizePayload("telegram", { callback_query: { data: "x", from: { id: 1 } } })).toBeNull();
    });
  });

  // ── All connectors register correctly ────────────────────

  describe("all 10 connectors", () => {
    const allConnectors = [
      telegramConnector,
      gmailConnector,
      googleChatConnector,
      googleTasksConnector,
      calendarConnector,
      voiceConnector,
      githubConnector,
      imapConnector,
      documentsConnector,
      microsoftGraphConnector,
    ];

    test("each has a unique provider name", () => {
      const names = allConnectors.map(c => c.provider);
      expect(new Set(names).size).toBe(names.length);
    });

    test("all can be registered without error", () => {
      for (const c of allConnectors) {
        registerConnector(c);
      }
      const providers = listProviders();
      for (const c of allConnectors) {
        expect(providers).toContain(c.provider);
      }
    });

    test("each implements normalize as a function", () => {
      for (const c of allConnectors) {
        expect(typeof c.normalize).toBe("function");
      }
    });

    test("each returns null for empty object", () => {
      for (const c of allConnectors) {
        const result = c.normalize({});
        expect(result).toBeNull();
      }
    });
  });
});
