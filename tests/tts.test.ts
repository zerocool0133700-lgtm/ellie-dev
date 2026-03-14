/**
 * Service Tests: TTS — ELLIE-713
 *
 * Tests mulawEnergy (pure) and getTTSProviderInfo (env-based).
 */

import { describe, test, expect, mock } from "bun:test";

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
mock.module("../src/transcribe.ts", () => ({
  transcribeWav: mock(async () => ""),
}));

import { mulawEnergy, getTTSProviderInfo } from "../src/tts.ts";

describe("TTS", () => {
  describe("mulawEnergy", () => {
    test("returns 0 for empty buffer", () => {
      expect(mulawEnergy(Buffer.alloc(0))).toBe(0);
    });

    test("returns 0 for silence (0xFF bytes = mulaw positive zero)", () => {
      const silence = Buffer.alloc(100, 0xFF);
      expect(mulawEnergy(silence)).toBe(0);
    });

    test("returns 0 for negative zero (0x7F bytes)", () => {
      const negZero = Buffer.alloc(100, 0x7F);
      expect(mulawEnergy(negZero)).toBe(0);
    });

    test("returns positive energy for non-silent audio", () => {
      // Bytes far from both 0xFF and 0x7F have higher energy
      const loud = Buffer.alloc(100, 0x00);
      const energy = mulawEnergy(loud);
      expect(energy).toBeGreaterThan(0);
    });

    test("louder audio has higher energy", () => {
      const quiet = Buffer.alloc(100, 0xF0); // close to 0xFF
      const loud = Buffer.alloc(100, 0x40);  // far from both zeros
      expect(mulawEnergy(loud)).toBeGreaterThan(mulawEnergy(quiet));
    });

    test("handles single byte buffer", () => {
      const buf = Buffer.from([0x00]);
      expect(mulawEnergy(buf)).toBeGreaterThan(0);
    });
  });

  describe("getTTSProviderInfo", () => {
    test("returns provider info object", () => {
      const info = getTTSProviderInfo();
      expect(info).toHaveProperty("default");
      expect(info).toHaveProperty("current");
      expect(info).toHaveProperty("available");
      expect(info.available).toHaveProperty("elevenlabs");
      expect(info.available).toHaveProperty("openai");
    });

    test("available reflects env var presence", () => {
      const info = getTTSProviderInfo();
      // Both should be booleans
      expect(typeof info.available.elevenlabs).toBe("boolean");
      expect(typeof info.available.openai).toBe("boolean");
    });
  });
});
