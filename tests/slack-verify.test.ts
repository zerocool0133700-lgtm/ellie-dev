/**
 * ELLIE-508 — Slack request signature verification tests
 *
 * verifySlackRequest is a pure HMAC-SHA256 function — no mocking required.
 * Covers valid signatures, replay-attack protection, and request tampering.
 */

import { describe, test, expect } from "bun:test";
import { createHmac } from "crypto";
import { verifySlackRequest } from "../src/channels/slack/verify.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSignature(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

const SECRET = "test-signing-secret-abc123";
const BODY = '{"event":{"type":"message","text":"hello"}}';
const NOW = Math.floor(Date.now() / 1000);
const TS = String(NOW);

// ── Valid signatures ───────────────────────────────────────────────────────────

describe("verifySlackRequest — valid", () => {
  test("correct signature → true", () => {
    expect(verifySlackRequest(SECRET, BODY, TS, makeSignature(SECRET, TS, BODY))).toBe(true);
  });

  test("timestamp 200s ago (within 5-min window) → true", () => {
    const ts = String(NOW - 200);
    expect(verifySlackRequest(SECRET, BODY, ts, makeSignature(SECRET, ts, BODY))).toBe(true);
  });

  test("empty body → true", () => {
    expect(verifySlackRequest(SECRET, "", TS, makeSignature(SECRET, TS, ""))).toBe(true);
  });

  test("body with special characters → true", () => {
    const body = '{"text":"hello & <world> \\"quoted\\""}';
    expect(verifySlackRequest(SECRET, body, TS, makeSignature(SECRET, TS, body))).toBe(true);
  });
});

// ── Replay protection ──────────────────────────────────────────────────────────

describe("verifySlackRequest — replay protection", () => {
  test("timestamp 400s ago (> 5-min window) → false", () => {
    const ts = String(NOW - 400);
    expect(verifySlackRequest(SECRET, BODY, ts, makeSignature(SECRET, ts, BODY))).toBe(false);
  });

  test("timestamp 400s in the future → false", () => {
    const ts = String(NOW + 400);
    expect(verifySlackRequest(SECRET, BODY, ts, makeSignature(SECRET, ts, BODY))).toBe(false);
  });

  test("empty timestamp → false", () => {
    expect(verifySlackRequest(SECRET, BODY, "", makeSignature(SECRET, "", BODY))).toBe(false);
  });
});

// ── Tampering ──────────────────────────────────────────────────────────────────

describe("verifySlackRequest — tampering", () => {
  test("wrong signing secret → false", () => {
    expect(verifySlackRequest(SECRET, BODY, TS, makeSignature("wrong-secret", TS, BODY))).toBe(false);
  });

  test("tampered body → false", () => {
    expect(verifySlackRequest(SECRET, BODY + "x", TS, makeSignature(SECRET, TS, BODY))).toBe(false);
  });

  test("raw hash without v0= prefix → false", () => {
    const raw = createHmac("sha256", SECRET).update(`v0:${TS}:${BODY}`).digest("hex");
    expect(verifySlackRequest(SECRET, BODY, TS, raw)).toBe(false);
  });

  test("empty signature → false", () => {
    expect(verifySlackRequest(SECRET, BODY, TS, "")).toBe(false);
  });

  test("signature with last character flipped → false", () => {
    const sig = makeSignature(SECRET, TS, BODY);
    const flipped = sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a");
    expect(verifySlackRequest(SECRET, BODY, TS, flipped)).toBe(false);
  });
});
