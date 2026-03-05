/**
 * Tests for ELLIE-546: API auth middleware
 *
 * Covers:
 *   - requiresApiAuth() — pure gate function (path + IP → bool)
 *   - authenticateRequest() — JWT + legacy x-api-key paths
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { requiresApiAuth } from "../src/http-routes.ts";
import { authenticateRequest } from "../src/api/jwt-auth.ts";
import type { IncomingMessage } from "http";

// ── requiresApiAuth ───────────────────────────────────────────────────────────

const EXTERNAL_IP = "203.0.113.42";  // RFC 5737 test IP (external)
const LOCALHOST_V4 = "127.0.0.1";
const LOCALHOST_V6 = "::1";
const LOCALHOST_MAPPED = "::ffff:127.0.0.1";

describe("requiresApiAuth — non-api paths", () => {
  it("does not require auth for /health", () => {
    expect(requiresApiAuth("/health", EXTERNAL_IP)).toBe(false);
  });

  it("does not require auth for /queue-status", () => {
    expect(requiresApiAuth("/queue-status", EXTERNAL_IP)).toBe(false);
  });

  it("does not require auth for /voice webhook", () => {
    expect(requiresApiAuth("/voice", EXTERNAL_IP)).toBe(false);
  });

  it("does not require auth for /google-chat webhook", () => {
    expect(requiresApiAuth("/google-chat", EXTERNAL_IP)).toBe(false);
  });
});

describe("requiresApiAuth — exempt /api/* routes", () => {
  it("does not require auth for /api/auth/token", () => {
    expect(requiresApiAuth("/api/auth/token", EXTERNAL_IP)).toBe(false);
  });

  it("does not require auth for /api/bridge/read", () => {
    expect(requiresApiAuth("/api/bridge/read", EXTERNAL_IP)).toBe(false);
  });

  it("does not require auth for /api/bridge/write", () => {
    expect(requiresApiAuth("/api/bridge/write", EXTERNAL_IP)).toBe(false);
  });

  it("does not require auth for /api/bridge/river/write", () => {
    expect(requiresApiAuth("/api/bridge/river/write", EXTERNAL_IP)).toBe(false);
  });

  it("does not require auth for /api/app-auth/login", () => {
    expect(requiresApiAuth("/api/app-auth/login", EXTERNAL_IP)).toBe(false);
  });

  it("does not require auth for /api/app-auth/callback", () => {
    expect(requiresApiAuth("/api/app-auth/callback", EXTERNAL_IP)).toBe(false);
  });
});

describe("requiresApiAuth — localhost bypass", () => {
  const protectedPaths = [
    "/api/dead-letters",
    "/api/orchestration/dispatch",
    "/api/analytics/summary",
    "/api/memory/facts",
    "/api/calendar",
    "/api/jobs",
    "/api/token-health",
  ];

  for (const path of protectedPaths) {
    it(`does not require auth for ${path} from 127.0.0.1`, () => {
      expect(requiresApiAuth(path, LOCALHOST_V4)).toBe(false);
    });

    it(`does not require auth for ${path} from ::1`, () => {
      expect(requiresApiAuth(path, LOCALHOST_V6)).toBe(false);
    });

    it(`does not require auth for ${path} from ::ffff:127.0.0.1`, () => {
      expect(requiresApiAuth(path, LOCALHOST_MAPPED)).toBe(false);
    });
  }
});

describe("requiresApiAuth — protected routes from external IP", () => {
  const protectedPaths = [
    "/api/dead-letters",
    "/api/orchestration/status",
    "/api/orchestration/dispatch",
    "/api/jobs",
    "/api/jobs/metrics",
    "/api/analytics/summary",
    "/api/analytics/timeline",
    "/api/memory/facts",
    "/api/memory/search",
    "/api/calendar",
    "/api/calendar-sync",
    "/api/conversation/context",
    "/api/conversation/close",
    "/api/token-health",
    "/api/freshness",
    "/api/context-modes",
    "/api/ground-truth",
    "/api/accuracy",
    "/api/summary",
    "/api/tts",
    "/api/stt",
    "/api/harvest",
    "/api/extract-ideas",
    "/api/consolidate",
    "/api/agents",
    "/api/capabilities",
    "/api/skills/snapshot",
    "/api/briefing/generate",
    "/api/briefing/latest",
    "/api/forest/browse",
    "/api/forest/search",
    "/api/calendar-intel/upcoming",
    "/api/alerts/rules",
    "/api/weekly-review/generate",
    "/api/security-sweep",
    "/api/ellie-chat/send",
    "/api/comms/threads",
    "/api/relationships/profiles",
    "/api/work-session/start",
    "/api/work-session/update",
    "/api/audit/data-integrity",
  ];

  for (const path of protectedPaths) {
    it(`requires auth for ${path} from external IP`, () => {
      expect(requiresApiAuth(path, EXTERNAL_IP)).toBe(true);
    });
  }
});

// ── authenticateRequest ───────────────────────────────────────────────────────

/** Build a minimal IncomingMessage stub with given headers. */
function mockReq(headers: Record<string, string> = {}): IncomingMessage {
  return {
    headers,
    socket: { remoteAddress: EXTERNAL_IP },
  } as unknown as IncomingMessage;
}

describe("authenticateRequest — legacy x-api-key", () => {
  const VALID_KEY = "test-api-key-ellie-546";

  it("returns payload for valid x-api-key", async () => {
    const req = mockReq({ "x-api-key": VALID_KEY });
    const result = await authenticateRequest(req, "api", VALID_KEY);
    expect(result).not.toBeNull();
    expect(result!.sub).toBe("legacy-api-key");
  });

  it("returns null for wrong x-api-key", async () => {
    const req = mockReq({ "x-api-key": "wrong-key" });
    const result = await authenticateRequest(req, "api", VALID_KEY);
    expect(result).toBeNull();
  });

  it("returns null when x-api-key missing and no bearer token", async () => {
    const req = mockReq({});
    const result = await authenticateRequest(req, "api", VALID_KEY);
    expect(result).toBeNull();
  });

  it("returns null when legacyApiKey is undefined", async () => {
    const req = mockReq({ "x-api-key": VALID_KEY });
    const result = await authenticateRequest(req, "api", undefined);
    expect(result).toBeNull();
  });

  it("returns null for empty x-api-key string", async () => {
    const req = mockReq({ "x-api-key": "" });
    const result = await authenticateRequest(req, "api", VALID_KEY);
    expect(result).toBeNull();
  });
});

describe("authenticateRequest — bearer token", () => {
  it("returns null for malformed bearer token", async () => {
    const req = mockReq({ authorization: "Bearer not-a-valid-jwt" });
    const result = await authenticateRequest(req, "api", "any-key");
    expect(result).toBeNull();
  });

  it("returns null for non-Bearer Authorization header", async () => {
    const req = mockReq({ authorization: "Basic dXNlcjpwYXNz" });
    const result = await authenticateRequest(req, "api", "any-key");
    expect(result).toBeNull();
  });

  it("falls back to x-api-key when bearer is absent", async () => {
    const KEY = "fallback-key-test";
    const req = mockReq({ "x-api-key": KEY });
    const result = await authenticateRequest(req, "api", KEY);
    expect(result).not.toBeNull();
    expect(result!.sub).toBe("legacy-api-key");
  });
});
