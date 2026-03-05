/**
 * Tests for ELLIE-553: Webhook signature verification — GChat and Alexa
 *
 * Covers:
 *   verifyGoogleChatRequest:
 *     - token match → "allowed"
 *     - token mismatch → "unauthorized"
 *     - missing header → "unauthorized"
 *     - wrong prefix → "unauthorized"
 *     - empty token after prefix → "unauthorized"
 *     - no env token configured → "unconfigured"
 *     - length-mismatch (timing-safe) → "unauthorized"
 *
 *   hasAlexaSignatureHeaders:
 *     - both present → true
 *     - certUrl missing → false
 *     - signature missing → false
 *     - both missing → false
 *     - both empty strings → false
 *     - one empty string → false
 */

import { describe, it, expect } from "bun:test";
import {
  verifyGoogleChatRequest,
  type GChatVerifyResult,
} from "../src/channels/google-chat/verify.ts";
import { hasAlexaSignatureHeaders } from "../src/alexa.ts";

// ── verifyGoogleChatRequest ───────────────────────────────────────────────────

describe("verifyGoogleChatRequest — token matches", () => {
  const TOKEN = "super-secret-token-abc123";

  it("returns 'allowed' for correct Bearer token", () => {
    expect(verifyGoogleChatRequest(`Bearer ${TOKEN}`, TOKEN)).toBe("allowed");
  });

  it("returns 'allowed' for a long token", () => {
    const long = "a".repeat(128);
    expect(verifyGoogleChatRequest(`Bearer ${long}`, long)).toBe("allowed");
  });

  it("returns 'allowed' for a token with special characters", () => {
    const tok = "tok_abc!@#$%^&*()-_=+";
    expect(verifyGoogleChatRequest(`Bearer ${tok}`, tok)).toBe("allowed");
  });
});

describe("verifyGoogleChatRequest — token mismatch", () => {
  const TOKEN = "correct-token";

  it("returns 'unauthorized' for wrong token value", () => {
    expect(verifyGoogleChatRequest("Bearer wrong-token", TOKEN)).toBe("unauthorized");
  });

  it("returns 'unauthorized' for token that is a prefix of the correct one", () => {
    expect(verifyGoogleChatRequest(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN)).toBe("unauthorized");
  });

  it("returns 'unauthorized' for token that extends the correct one", () => {
    expect(verifyGoogleChatRequest(`Bearer ${TOKEN}x`, TOKEN)).toBe("unauthorized");
  });

  it("returns 'unauthorized' when last character is different", () => {
    const almost = TOKEN.slice(0, -1) + (TOKEN.endsWith("a") ? "b" : "a");
    expect(verifyGoogleChatRequest(`Bearer ${almost}`, TOKEN)).toBe("unauthorized");
  });

  it("returns 'unauthorized' for empty bearer token (only prefix)", () => {
    expect(verifyGoogleChatRequest("Bearer ", TOKEN)).toBe("unauthorized");
  });
});

describe("verifyGoogleChatRequest — missing or malformed header", () => {
  const TOKEN = "some-token";

  it("returns 'unauthorized' when Authorization header is missing", () => {
    expect(verifyGoogleChatRequest(undefined, TOKEN)).toBe("unauthorized");
  });

  it("returns 'unauthorized' when Authorization header is empty string", () => {
    expect(verifyGoogleChatRequest("", TOKEN)).toBe("unauthorized");
  });

  it("returns 'unauthorized' for Basic auth scheme instead of Bearer", () => {
    expect(verifyGoogleChatRequest(`Basic ${TOKEN}`, TOKEN)).toBe("unauthorized");
  });

  it("returns 'unauthorized' for token without Bearer prefix", () => {
    expect(verifyGoogleChatRequest(TOKEN, TOKEN)).toBe("unauthorized");
  });

  it("returns 'unauthorized' for bearer (lowercase) prefix", () => {
    expect(verifyGoogleChatRequest(`bearer ${TOKEN}`, TOKEN)).toBe("unauthorized");
  });
});

describe("verifyGoogleChatRequest — unconfigured", () => {
  it("returns 'unconfigured' when verificationToken is undefined", () => {
    expect(verifyGoogleChatRequest("Bearer some-token", undefined)).toBe("unconfigured");
  });

  it("returns 'unconfigured' when verificationToken is empty string", () => {
    // Empty string is falsy — treated as not configured
    expect(verifyGoogleChatRequest("Bearer some-token", "")).toBe("unconfigured");
  });

  it("returns 'unconfigured' even when no auth header is provided", () => {
    expect(verifyGoogleChatRequest(undefined, undefined)).toBe("unconfigured");
  });
});

describe("verifyGoogleChatRequest — return type is GChatVerifyResult", () => {
  it("all three result values are valid GChatVerifyResult strings", () => {
    const allowed: GChatVerifyResult = "allowed";
    const unauthorized: GChatVerifyResult = "unauthorized";
    const unconfigured: GChatVerifyResult = "unconfigured";
    expect(["allowed", "unauthorized", "unconfigured"]).toContain(allowed);
    expect(["allowed", "unauthorized", "unconfigured"]).toContain(unauthorized);
    expect(["allowed", "unauthorized", "unconfigured"]).toContain(unconfigured);
  });
});

// ── hasAlexaSignatureHeaders ──────────────────────────────────────────────────

describe("hasAlexaSignatureHeaders — both present", () => {
  it("returns true when both certUrl and signature are present", () => {
    expect(hasAlexaSignatureHeaders(
      "https://s3.amazonaws.com/echo.api/echo-api-cert-7.pem",
      "base64signaturehere==",
    )).toBe(true);
  });

  it("returns true for any non-empty string values", () => {
    expect(hasAlexaSignatureHeaders("cert", "sig")).toBe(true);
  });
});

describe("hasAlexaSignatureHeaders — missing headers", () => {
  it("returns false when certUrl is undefined", () => {
    expect(hasAlexaSignatureHeaders(undefined, "sig")).toBe(false);
  });

  it("returns false when signature is undefined", () => {
    expect(hasAlexaSignatureHeaders("cert", undefined)).toBe(false);
  });

  it("returns false when both are undefined", () => {
    expect(hasAlexaSignatureHeaders(undefined, undefined)).toBe(false);
  });

  it("returns false when certUrl is empty string", () => {
    expect(hasAlexaSignatureHeaders("", "sig")).toBe(false);
  });

  it("returns false when signature is empty string", () => {
    expect(hasAlexaSignatureHeaders("cert", "")).toBe(false);
  });

  it("returns false when both are empty strings", () => {
    expect(hasAlexaSignatureHeaders("", "")).toBe(false);
  });
});

describe("hasAlexaSignatureHeaders — guards against non-string types", () => {
  it("returns false for null values (cast to undefined-compatible)", () => {
    // TypeScript callers pass string | undefined, but test the boundary
    expect(hasAlexaSignatureHeaders(null as unknown as string, "sig")).toBe(false);
    expect(hasAlexaSignatureHeaders("cert", null as unknown as string)).toBe(false);
  });
});
