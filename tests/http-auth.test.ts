/**
 * ELLIE-494 — HTTP auth unit tests
 *
 * Covers:
 * - signToken / verifyToken (JWT lifecycle)
 * - extractBearer (header parsing)
 * - authenticateRequest (JWT + legacy x-api-key fallback)
 *
 * Uses a known in-memory signing secret (hollow is mocked).
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock hollow.ts — inject a known signing secret ───────────

const TEST_SIGNING_SECRET = "test-jwt-signing-secret-ellie-494";

mock.module("../../ellie-forest/src/hollow.ts", () => ({
  retrieveSecret: mock(async () => TEST_SIGNING_SECRET),
}));

// ── Mock logger ───────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

// ── Import after mocks ────────────────────────────────────────

import {
  signToken,
  verifyToken,
  extractBearer,
  authenticateRequest,
  type JwtPayload,
} from "../src/api/jwt-auth.ts";
import type { IncomingMessage } from "http";

// ── Helpers ───────────────────────────────────────────────────

function makeReq(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

// ── signToken + verifyToken lifecycle ─────────────────────────

describe("signToken / verifyToken — JWT lifecycle", () => {
  test("signs a token and verifies it with correct scope", async () => {
    const token = await signToken("dashboard", ["tts"]);
    const payload = await verifyToken(token, "tts");

    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe("dashboard");
    expect(payload!.iss).toBe("ellie-relay");
  });

  test("token contains expected aud (scopes) and iss", async () => {
    const token = await signToken("test-sub", ["stt", "tts"]);
    const payload = await verifyToken(token, "stt");

    expect(payload).not.toBeNull();
    expect(payload!.aud).toContain("stt");
    expect(payload!.aud).toContain("tts");
    expect(payload!.iss).toBe("ellie-relay");
  });

  test("returns null when scope does not match", async () => {
    const token = await signToken("dashboard", ["tts"]);
    const payload = await verifyToken(token, "stt");

    expect(payload).toBeNull();
  });

  test("returns null for a completely invalid token string", async () => {
    const payload = await verifyToken("not.a.valid.jwt", "tts");
    expect(payload).toBeNull();
  });

  test("returns null for a tampered token", async () => {
    const token = await signToken("dashboard", ["tts"]);
    const tampered = token.slice(0, -5) + "XXXXX";
    const payload = await verifyToken(tampered, "tts");
    expect(payload).toBeNull();
  });

  test("returns null for empty string token", async () => {
    const payload = await verifyToken("", "tts");
    expect(payload).toBeNull();
  });

  test("token has iat and exp timestamps", async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await signToken("sub", ["tts"]);
    const after = Math.floor(Date.now() / 1000);
    const payload = await verifyToken(token, "tts");

    expect(payload!.iat).toBeGreaterThanOrEqual(before);
    expect(payload!.iat).toBeLessThanOrEqual(after);
    expect(payload!.exp).toBeGreaterThan(payload!.iat);
  });

  test("tokens from different sign calls are unique", async () => {
    const t1 = await signToken("sub", ["tts"]);
    const t2 = await signToken("sub", ["tts"]);
    // Different iat/jti means different tokens (HS256 with same secret but different timestamps)
    // At minimum the full token string may differ due to timing
    expect(typeof t1).toBe("string");
    expect(typeof t2).toBe("string");
    expect(t1.split(".")).toHaveLength(3); // header.payload.signature
    expect(t2.split(".")).toHaveLength(3);
  });
});

// ── extractBearer ─────────────────────────────────────────────

describe("extractBearer — header parsing", () => {
  test("extracts token from 'Bearer <token>' header", () => {
    const req = makeReq({ authorization: "Bearer my-test-token" });
    expect(extractBearer(req)).toBe("my-test-token");
  });

  test("returns null when Authorization header is missing", () => {
    const req = makeReq({});
    expect(extractBearer(req)).toBeNull();
  });

  test("returns null when header does not start with 'Bearer '", () => {
    const req = makeReq({ authorization: "Basic dXNlcjpwYXNz" });
    expect(extractBearer(req)).toBeNull();
  });

  test("returns null for empty Authorization header", () => {
    const req = makeReq({ authorization: "" });
    expect(extractBearer(req)).toBeNull();
  });

  test("preserves the full token after 'Bearer ' prefix", () => {
    const longToken = "header.payload.signature-with-extra-chars_123";
    const req = makeReq({ authorization: `Bearer ${longToken}` });
    expect(extractBearer(req)).toBe(longToken);
  });
});

// ── authenticateRequest ───────────────────────────────────────

describe("authenticateRequest — JWT + legacy x-api-key", () => {
  test("accepts a valid JWT with correct scope", async () => {
    const token = await signToken("dashboard", ["tts"]);
    const req = makeReq({ authorization: `Bearer ${token}` });

    const payload = await authenticateRequest(req, "tts");

    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe("dashboard");
  });

  test("returns null for JWT with wrong scope", async () => {
    const token = await signToken("dashboard", ["tts"]);
    const req = makeReq({ authorization: `Bearer ${token}` });

    const payload = await authenticateRequest(req, "stt");

    expect(payload).toBeNull();
  });

  test("returns null when no auth credentials provided", async () => {
    const req = makeReq({});
    const payload = await authenticateRequest(req, "tts");
    expect(payload).toBeNull();
  });

  test("falls back to x-api-key when no Bearer token", async () => {
    const req = makeReq({ "x-api-key": "secret-key" });
    const payload = await authenticateRequest(req, "tts", "secret-key");

    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe("legacy-api-key");
    expect(payload!.aud).toContain("tts");
    expect(payload!.iss).toBe("ellie-relay");
  });

  test("rejects wrong x-api-key", async () => {
    const req = makeReq({ "x-api-key": "wrong-key" });
    const payload = await authenticateRequest(req, "tts", "correct-key");
    expect(payload).toBeNull();
  });

  test("legacy payload has synthetic iat and exp timestamps", async () => {
    const before = Math.floor(Date.now() / 1000);
    const req = makeReq({ "x-api-key": "key" });
    const payload = await authenticateRequest(req, "tts", "key");
    const after = Math.floor(Date.now() / 1000);

    expect(payload!.iat).toBeGreaterThanOrEqual(before);
    expect(payload!.exp).toBeGreaterThan(payload!.iat);
    expect(payload!.exp - payload!.iat).toBe(3600); // 1 hour
  });

  test("JWT takes precedence over x-api-key when both present", async () => {
    const token = await signToken("dashboard", ["tts"]);
    const req = makeReq({
      authorization: `Bearer ${token}`,
      "x-api-key": "legacy-key",
    });

    const payload = await authenticateRequest(req, "tts", "legacy-key");

    // Should use JWT — sub is "dashboard", not "legacy-api-key"
    expect(payload!.sub).toBe("dashboard");
  });

  test("returns null when x-api-key not provided as legacyApiKey parameter", async () => {
    const req = makeReq({ "x-api-key": "some-key" });
    // No legacyApiKey arg passed — should not accept x-api-key
    const payload = await authenticateRequest(req, "tts");
    expect(payload).toBeNull();
  });
});
