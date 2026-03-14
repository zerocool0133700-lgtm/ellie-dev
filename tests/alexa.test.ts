/**
 * Service Tests: Alexa Handler — ELLIE-713
 *
 * Tests request parsing, SSML generation, and response building (all pure).
 */

import { describe, test, expect, mock } from "bun:test";

mock.module("alexa-verifier", () => ({
  default: mock(async () => {}),
}));
mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

import {
  hasAlexaSignatureHeaders,
  parseAlexaRequest,
  textToSsml,
  buildAlexaResponse,
  buildAlexaErrorResponse,
  type AlexaRequest,
} from "../src/alexa.ts";

function makeAlexaRequest(overrides: Partial<AlexaRequest["request"]> = {}): AlexaRequest {
  return {
    version: "1.0",
    session: {
      sessionId: "sess-1",
      application: { applicationId: "app-1" },
      user: { userId: "user-1" },
      new: true,
    },
    request: {
      type: "IntentRequest",
      requestId: "req-1",
      timestamp: new Date().toISOString(),
      ...overrides,
    },
  };
}

describe("Alexa handler", () => {
  describe("hasAlexaSignatureHeaders", () => {
    test("returns true when both headers present", () => {
      expect(hasAlexaSignatureHeaders("https://cert.url", "sig123")).toBe(true);
    });

    test("returns false when certUrl missing", () => {
      expect(hasAlexaSignatureHeaders(undefined, "sig123")).toBe(false);
    });

    test("returns false when signature missing", () => {
      expect(hasAlexaSignatureHeaders("https://cert.url", undefined)).toBe(false);
    });

    test("returns false when certUrl empty", () => {
      expect(hasAlexaSignatureHeaders("", "sig123")).toBe(false);
    });

    test("returns false when signature empty", () => {
      expect(hasAlexaSignatureHeaders("https://cert.url", "")).toBe(false);
    });

    test("returns false when both missing", () => {
      expect(hasAlexaSignatureHeaders(undefined, undefined)).toBe(false);
    });
  });

  describe("parseAlexaRequest", () => {
    test("parses LaunchRequest", () => {
      const req = makeAlexaRequest({ type: "LaunchRequest" });
      const parsed = parseAlexaRequest(req);
      expect(parsed.type).toBe("LaunchRequest");
      expect(parsed.intentName).toBeNull();
      expect(parsed.text).toBe("Open Ellie");
    });

    test("parses AddTodoIntent with slot", () => {
      const req = makeAlexaRequest({
        intent: {
          name: "AddTodoIntent",
          slots: { todoText: { name: "todoText", value: "buy groceries" } },
        },
      });
      const parsed = parseAlexaRequest(req);
      expect(parsed.intentName).toBe("AddTodoIntent");
      expect(parsed.slots.todoText).toBe("buy groceries");
      expect(parsed.text).toContain("buy groceries");
    });

    test("parses GetTodosIntent", () => {
      const req = makeAlexaRequest({
        intent: { name: "GetTodosIntent" },
      });
      const parsed = parseAlexaRequest(req);
      expect(parsed.intentName).toBe("GetTodosIntent");
      expect(parsed.text).toContain("todo");
    });

    test("parses GetBriefingIntent", () => {
      const req = makeAlexaRequest({
        intent: { name: "GetBriefingIntent" },
      });
      const parsed = parseAlexaRequest(req);
      expect(parsed.text).toContain("briefing");
    });

    test("parses AskEllieIntent with query", () => {
      const req = makeAlexaRequest({
        intent: {
          name: "AskEllieIntent",
          slots: { query: { name: "query", value: "what's my schedule" } },
        },
      });
      const parsed = parseAlexaRequest(req);
      expect(parsed.text).toBe("what's my schedule");
    });

    test("extracts userId and sessionId", () => {
      const req = makeAlexaRequest();
      const parsed = parseAlexaRequest(req);
      expect(parsed.userId).toBe("user-1");
      expect(parsed.sessionId).toBe("sess-1");
    });

    test("handles unknown intent", () => {
      const req = makeAlexaRequest({
        intent: { name: "CustomUnknownIntent" },
      });
      const parsed = parseAlexaRequest(req);
      expect(parsed.text).toBe("CustomUnknownIntent");
    });

    test("handles empty slots", () => {
      const req = makeAlexaRequest({
        intent: { name: "AddTodoIntent", slots: {} },
      });
      const parsed = parseAlexaRequest(req);
      expect(Object.keys(parsed.slots)).toHaveLength(0);
    });
  });

  describe("textToSsml", () => {
    test("wraps in speak tags", () => {
      const ssml = textToSsml("Hello world");
      expect(ssml).toStartWith("<speak>");
      expect(ssml).toEndWith("</speak>");
    });

    test("converts bold to emphasis", () => {
      expect(textToSsml("**important**")).toContain("emphasis");
      expect(textToSsml("**important**")).toContain("important");
    });

    test("strips italic markers", () => {
      const ssml = textToSsml("*italic text*");
      expect(ssml).toContain("italic text");
      expect(ssml).not.toContain("*italic");
    });

    test("strips markdown links", () => {
      const ssml = textToSsml("[click here](https://example.com)");
      expect(ssml).toContain("click here");
      expect(ssml).not.toContain("https://");
    });

    test("strips headers", () => {
      const ssml = textToSsml("## Heading\nContent");
      expect(ssml).not.toContain("##");
      expect(ssml).toContain("Heading");
    });

    test("converts bullets to breaks", () => {
      const ssml = textToSsml("Items:\n- First\n- Second");
      expect(ssml).toContain("break");
    });

    test("handles multiple newlines", () => {
      const ssml = textToSsml("Para 1\n\nPara 2");
      expect(ssml).toContain("break");
    });
  });

  describe("buildAlexaResponse", () => {
    test("builds response with SSML output", () => {
      const resp = buildAlexaResponse("Hello");
      expect(resp.version).toBe("1.0");
      expect(resp.response.outputSpeech.type).toBe("SSML");
      expect(resp.response.outputSpeech.ssml).toContain("<speak>");
    });

    test("preserves pre-wrapped speak tags", () => {
      const resp = buildAlexaResponse("<speak>Already SSML</speak>");
      expect(resp.response.outputSpeech.ssml).toBe("<speak>Already SSML</speak>");
    });

    test("defaults shouldEndSession to true", () => {
      const resp = buildAlexaResponse("test");
      expect(resp.response.shouldEndSession).toBe(true);
    });

    test("respects shouldEndSession=false", () => {
      const resp = buildAlexaResponse("test", false);
      expect(resp.response.shouldEndSession).toBe(false);
    });

    test("includes card when title provided", () => {
      const resp = buildAlexaResponse("text", true, "Card Title", "Card body");
      expect(resp.response.card).toBeDefined();
      expect(resp.response.card!.title).toBe("Card Title");
      expect(resp.response.card!.content).toBe("Card body");
    });

    test("omits card when no title", () => {
      const resp = buildAlexaResponse("text");
      expect(resp.response.card).toBeUndefined();
    });
  });

  describe("buildAlexaErrorResponse", () => {
    test("returns error with default message", () => {
      const resp = buildAlexaErrorResponse();
      expect(resp.response.outputSpeech.ssml).toContain("Sorry");
      expect(resp.response.shouldEndSession).toBe(true);
    });

    test("returns error with custom message", () => {
      const resp = buildAlexaErrorResponse("Custom error");
      expect(resp.response.outputSpeech.ssml).toContain("Custom error");
    });
  });
});
