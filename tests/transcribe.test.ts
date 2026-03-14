/**
 * Service Tests: Transcription — ELLIE-713
 *
 * Tests provider info (pure) and provider selection logic.
 */

import { describe, test, expect, mock } from "bun:test";

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

import { getTranscriptionProviderInfo } from "../src/transcribe.ts";

describe("transcription", () => {
  describe("getTranscriptionProviderInfo", () => {
    test("returns provider info object", () => {
      const info = getTranscriptionProviderInfo();
      expect(info).toHaveProperty("preferred");
      expect(info).toHaveProperty("groq_available");
      expect(info).toHaveProperty("local_available");
    });

    test("preferred is a string", () => {
      const info = getTranscriptionProviderInfo();
      expect(typeof info.preferred).toBe("string");
    });

    test("groq_available is boolean", () => {
      const info = getTranscriptionProviderInfo();
      expect(typeof info.groq_available).toBe("boolean");
    });

    test("local_available is boolean", () => {
      const info = getTranscriptionProviderInfo();
      expect(typeof info.local_available).toBe("boolean");
    });
  });
});
