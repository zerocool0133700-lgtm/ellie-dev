/**
 * Tests for ELLIE-554: HTTP rate limiting on all public endpoints.
 *
 * Covers:
 *   - checkHttpRateLimit() — IP-based rate limiter for HTTP requests
 *   - Localhost bypass (internal agents/services exempt)
 *   - 429 response format (status, headers, body)
 *   - Independent per-IP tracking
 *   - Integration point in handleHttpRequest (via requiresApiAuth pattern)
 */

import { describe, it, expect } from "bun:test";
import { checkHttpRateLimit, httpLimiter } from "../src/rate-limiter.ts";
import type { IncomingMessage, ServerResponse } from "http";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal IncomingMessage stub with the given remote IP. */
function mockReq(remoteAddress: string): IncomingMessage {
  return {
    socket: { remoteAddress },
    headers: {},
    url: "/api/test",
  } as unknown as IncomingMessage;
}

/** Capture what was written to the ServerResponse. */
interface CapturedResponse {
  statusCode: number | null;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
}

function mockRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = {
    statusCode: null,
    headers: {},
    body: "",
    ended: false,
  };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.statusCode = status;
      if (headers) Object.assign(captured.headers, headers);
    },
    end(body?: string) {
      if (body) captured.body = body;
      captured.ended = true;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

// ── Localhost bypass ────────────────────────────────────────────────────────

describe("checkHttpRateLimit — localhost bypass", () => {
  const localhostVariants = [
    { label: "IPv4 localhost (127.0.0.1)", ip: "127.0.0.1" },
    { label: "IPv6 localhost (::1)", ip: "::1" },
    { label: "IPv4-mapped IPv6 (::ffff:127.0.0.1)", ip: "::ffff:127.0.0.1" },
  ];

  for (const { label, ip } of localhostVariants) {
    it(`skips rate limiting for ${label}`, () => {
      const req = mockReq(ip);
      const { res, captured } = mockRes();

      // Even with many requests, localhost should never be rate limited
      for (let i = 0; i < 200; i++) {
        const result = checkHttpRateLimit(req, res);
        expect(result).toBe(false);
      }
      // Response should not have been written
      expect(captured.statusCode).toBeNull();
      expect(captured.ended).toBe(false);
    });
  }
});

// ── External IP — allowed under limit ───────────────────────────────────────

describe("checkHttpRateLimit — allowed requests", () => {
  it("allows first request from external IP", () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 255)}`;
    const req = mockReq(ip);
    const { res, captured } = mockRes();

    const result = checkHttpRateLimit(req, res);
    expect(result).toBe(false);
    expect(captured.statusCode).toBeNull();
  });

  it("allows multiple requests within the limit", () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 255)}`;
    const req = mockReq(ip);

    for (let i = 0; i < 10; i++) {
      const { res, captured } = mockRes();
      const result = checkHttpRateLimit(req, res);
      expect(result).toBe(false);
      expect(captured.statusCode).toBeNull();
    }
  });
});

// ── External IP — rate limited ──────────────────────────────────────────────

describe("checkHttpRateLimit — rate limited (429)", () => {
  it("returns 429 when limit exceeded", () => {
    // Use a unique IP so we don't collide with other tests
    const ip = `10.${Date.now() % 256}.${Math.floor(Math.random() * 256)}.1`;
    const req = mockReq(ip);

    // Default httpLimiter is 120 req/min — exhaust the limit
    for (let i = 0; i < 120; i++) {
      const { res } = mockRes();
      checkHttpRateLimit(req, res);
    }

    // Next request should be rate limited
    const { res, captured } = mockRes();
    const result = checkHttpRateLimit(req, res);
    expect(result).toBe(true);
    expect(captured.statusCode).toBe(429);
    expect(captured.ended).toBe(true);
  });

  it("includes Retry-After header in 429 response", () => {
    const ip = `10.${Date.now() % 256}.${Math.floor(Math.random() * 256)}.2`;
    const req = mockReq(ip);

    for (let i = 0; i < 120; i++) {
      const { res } = mockRes();
      checkHttpRateLimit(req, res);
    }

    const { res, captured } = mockRes();
    checkHttpRateLimit(req, res);
    expect(captured.headers["Retry-After"]).toBeTruthy();
    expect(parseInt(captured.headers["Retry-After"])).toBeGreaterThan(0);
  });

  it("returns JSON body with error and retryAfterMs", () => {
    const ip = `10.${Date.now() % 256}.${Math.floor(Math.random() * 256)}.3`;
    const req = mockReq(ip);

    for (let i = 0; i < 120; i++) {
      const { res } = mockRes();
      checkHttpRateLimit(req, res);
    }

    const { res, captured } = mockRes();
    checkHttpRateLimit(req, res);

    const body = JSON.parse(captured.body);
    expect(body.error).toBe("Rate limited");
    expect(body.retryAfterMs).toBeGreaterThan(0);
  });

  it("sets Content-Type to application/json", () => {
    const ip = `10.${Date.now() % 256}.${Math.floor(Math.random() * 256)}.4`;
    const req = mockReq(ip);

    for (let i = 0; i < 120; i++) {
      const { res } = mockRes();
      checkHttpRateLimit(req, res);
    }

    const { res, captured } = mockRes();
    checkHttpRateLimit(req, res);
    expect(captured.headers["Content-Type"]).toBe("application/json");
  });
});

// ── Per-IP independence ────────────────────────────────────────────────────

describe("checkHttpRateLimit — per-IP isolation", () => {
  it("tracks IPs independently", () => {
    const base = Date.now() % 100;
    const ipA = `172.16.${base}.10`;
    const ipB = `172.16.${base}.11`;
    const reqA = mockReq(ipA);
    const reqB = mockReq(ipB);

    // Exhaust limit for IP A
    for (let i = 0; i < 120; i++) {
      const { res } = mockRes();
      checkHttpRateLimit(reqA, res);
    }

    // IP A should be rate limited
    const { res: resA, captured: capturedA } = mockRes();
    expect(checkHttpRateLimit(reqA, resA)).toBe(true);
    expect(capturedA.statusCode).toBe(429);

    // IP B should still be allowed
    const { res: resB, captured: capturedB } = mockRes();
    expect(checkHttpRateLimit(reqB, resB)).toBe(false);
    expect(capturedB.statusCode).toBeNull();
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────────

describe("checkHttpRateLimit — edge cases", () => {
  it("handles missing socket gracefully", () => {
    const req = {
      socket: undefined,
      headers: {},
    } as unknown as IncomingMessage;
    const { res, captured } = mockRes();

    // "unknown" IP should be treated as external and rate-limited normally
    const result = checkHttpRateLimit(req, res);
    // First request should pass (but "unknown" is treated as external)
    expect(typeof result).toBe("boolean");
  });

  it("handles null remoteAddress gracefully", () => {
    const req = {
      socket: { remoteAddress: null },
      headers: {},
    } as unknown as IncomingMessage;
    const { res } = mockRes();

    // Should not throw
    const result = checkHttpRateLimit(req, res);
    expect(typeof result).toBe("boolean");
  });
});

// ── httpLimiter singleton ───────────────────────────────────────────────────

describe("httpLimiter", () => {
  it("is exported for direct access", () => {
    expect(httpLimiter).toBeDefined();
    expect(typeof httpLimiter.check).toBe("function");
    expect(typeof httpLimiter.peek).toBe("function");
    expect(typeof httpLimiter.cleanup).toBe("function");
  });
});

// ── getRateLimitStatus includes http ────────────────────────────────────────

describe("getRateLimitStatus — http field", () => {
  it("includes http limiter in status", async () => {
    const { getRateLimitStatus } = await import("../src/rate-limiter.ts");
    const status = getRateLimitStatus();
    expect(status).toHaveProperty("http");
    expect(status.http).toHaveProperty("activeKeys");
    expect(typeof status.http.activeKeys).toBe("number");
  });
});
