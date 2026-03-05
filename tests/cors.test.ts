/**
 * Tests for ELLIE-547: CORS origin whitelist
 *
 * Covers:
 *   - getAllowedOrigin: whitelist membership, absent origin, unknown origin
 *   - corsHeader: returns proper header object or empty object
 *   - handlePreflight: non-OPTIONS passthrough, allowed origin → 204,
 *     unknown origin → 403, missing origin → 403
 *   - CORS_ALLOWED_ORIGINS: contains the expected defaults
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { IncomingMessage, ServerResponse } from "http";

// Import after resetting env so module-level constant can be tested via functions.
// We import here (module-level) but test the exported functions directly.
import {
  getAllowedOrigin,
  corsHeader,
  handlePreflight,
  CORS_ALLOWED_ORIGINS,
} from "../src/cors.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

interface MockResponse {
  statusCode: number | null;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
}

function mockRes(): { res: ServerResponse; state: MockResponse } {
  const state: MockResponse = { statusCode: null, headers: {}, body: "", ended: false };
  const res = {
    writeHead(code: number, headers?: Record<string, string>) {
      state.statusCode = code;
      Object.assign(state.headers, headers ?? {});
    },
    end(data?: string) {
      state.body = data ?? "";
      state.ended = true;
    },
  } as unknown as ServerResponse;
  return { res, state };
}

function mockReq(method: string, origin?: string): IncomingMessage {
  return {
    method,
    headers: origin ? { origin } : {},
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

// ── getAllowedOrigin ──────────────────────────────────────────────────────────

describe("getAllowedOrigin", () => {
  it("returns the origin for a whitelisted origin", () => {
    expect(getAllowedOrigin("https://dashboard.ellie-labs.dev")).toBe("https://dashboard.ellie-labs.dev");
    expect(getAllowedOrigin("https://ellie.ellie-labs.dev")).toBe("https://ellie.ellie-labs.dev");
    expect(getAllowedOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(getAllowedOrigin("http://localhost:3002")).toBe("http://localhost:3002");
  });

  it("returns null for an unknown origin", () => {
    expect(getAllowedOrigin("https://evil.example.com")).toBeNull();
    expect(getAllowedOrigin("https://example.com")).toBeNull();
    expect(getAllowedOrigin("http://localhost:4000")).toBeNull();
  });

  it("returns null for undefined origin", () => {
    expect(getAllowedOrigin(undefined)).toBeNull();
  });

  it("returns null for empty string origin", () => {
    expect(getAllowedOrigin("")).toBeNull();
  });

  it("is case-sensitive (does not allow different casing)", () => {
    expect(getAllowedOrigin("HTTPS://dashboard.ellie-labs.dev")).toBeNull();
    expect(getAllowedOrigin("HTTP://localhost:3000")).toBeNull();
  });

  it("does not allow wildcard origin string", () => {
    expect(getAllowedOrigin("*")).toBeNull();
  });
});

// ── corsHeader ────────────────────────────────────────────────────────────────

describe("corsHeader", () => {
  it("returns Access-Control-Allow-Origin with the origin for a whitelisted origin", () => {
    const headers = corsHeader("https://dashboard.ellie-labs.dev");
    expect(headers).toEqual({ "Access-Control-Allow-Origin": "https://dashboard.ellie-labs.dev" });
  });

  it("returns an empty object for an unknown origin", () => {
    expect(corsHeader("https://evil.example.com")).toEqual({});
  });

  it("returns an empty object for undefined", () => {
    expect(corsHeader(undefined)).toEqual({});
  });

  it("is safe to spread into a headers object", () => {
    const merged = { "Content-Type": "application/json", ...corsHeader("http://localhost:3000") };
    expect(merged["Content-Type"]).toBe("application/json");
    expect(merged["Access-Control-Allow-Origin"]).toBe("http://localhost:3000");
  });

  it("spreading unknown origin does not add Access-Control header", () => {
    const merged = { "Content-Type": "application/json", ...corsHeader("https://evil.com") };
    expect("Access-Control-Allow-Origin" in merged).toBe(false);
  });
});

// ── handlePreflight ───────────────────────────────────────────────────────────

describe("handlePreflight — non-OPTIONS passthrough", () => {
  it("returns false for GET requests", () => {
    const { res } = mockRes();
    expect(handlePreflight(mockReq("GET", "https://dashboard.ellie-labs.dev"), res)).toBe(false);
  });

  it("returns false for POST requests", () => {
    const { res } = mockRes();
    expect(handlePreflight(mockReq("POST", "http://localhost:3000"), res)).toBe(false);
  });

  it("returns false for DELETE requests", () => {
    const { res } = mockRes();
    expect(handlePreflight(mockReq("DELETE"), res)).toBe(false);
  });

  it("does not write any response for non-OPTIONS", () => {
    const { res, state } = mockRes();
    handlePreflight(mockReq("GET", "https://dashboard.ellie-labs.dev"), res);
    expect(state.statusCode).toBeNull();
    expect(state.ended).toBe(false);
  });
});

describe("handlePreflight — OPTIONS with allowed origin", () => {
  it("returns true", () => {
    const { res } = mockRes();
    expect(handlePreflight(mockReq("OPTIONS", "https://dashboard.ellie-labs.dev"), res)).toBe(true);
  });

  it("responds with 204", () => {
    const { res, state } = mockRes();
    handlePreflight(mockReq("OPTIONS", "http://localhost:3000"), res);
    expect(state.statusCode).toBe(204);
  });

  it("includes Access-Control-Allow-Origin with the exact origin", () => {
    const { res, state } = mockRes();
    handlePreflight(mockReq("OPTIONS", "https://ellie.ellie-labs.dev"), res);
    expect(state.headers["Access-Control-Allow-Origin"]).toBe("https://ellie.ellie-labs.dev");
  });

  it("includes Access-Control-Allow-Methods", () => {
    const { res, state } = mockRes();
    handlePreflight(mockReq("OPTIONS", "http://localhost:3000"), res);
    expect(state.headers["Access-Control-Allow-Methods"]).toContain("GET");
    expect(state.headers["Access-Control-Allow-Methods"]).toContain("POST");
    expect(state.headers["Access-Control-Allow-Methods"]).toContain("OPTIONS");
  });

  it("includes Access-Control-Allow-Headers", () => {
    const { res, state } = mockRes();
    handlePreflight(mockReq("OPTIONS", "http://localhost:3000"), res);
    expect(state.headers["Access-Control-Allow-Headers"]).toContain("Content-Type");
  });

  it("includes Access-Control-Max-Age", () => {
    const { res, state } = mockRes();
    handlePreflight(mockReq("OPTIONS", "http://localhost:3000"), res);
    expect(state.headers["Access-Control-Max-Age"]).toBeDefined();
  });

  it("ends the response", () => {
    const { res, state } = mockRes();
    handlePreflight(mockReq("OPTIONS", "https://dashboard.ellie-labs.dev"), res);
    expect(state.ended).toBe(true);
  });
});

describe("handlePreflight — OPTIONS with unknown/missing origin", () => {
  it("returns true when origin is missing", () => {
    const { res } = mockRes();
    expect(handlePreflight(mockReq("OPTIONS"), res)).toBe(true);
  });

  it("responds with 403 when origin is missing", () => {
    const { res, state } = mockRes();
    handlePreflight(mockReq("OPTIONS"), res);
    expect(state.statusCode).toBe(403);
  });

  it("returns true when origin is not whitelisted", () => {
    const { res } = mockRes();
    expect(handlePreflight(mockReq("OPTIONS", "https://evil.example.com"), res)).toBe(true);
  });

  it("responds with 403 for an unknown origin", () => {
    const { res, state } = mockRes();
    handlePreflight(mockReq("OPTIONS", "https://evil.example.com"), res);
    expect(state.statusCode).toBe(403);
  });

  it("does NOT include Access-Control-Allow-Origin for a rejected origin", () => {
    const { res, state } = mockRes();
    handlePreflight(mockReq("OPTIONS", "https://evil.example.com"), res);
    expect("Access-Control-Allow-Origin" in state.headers).toBe(false);
  });

  it("does NOT allow wildcard '*' as an origin string", () => {
    const { res, state } = mockRes();
    handlePreflight(mockReq("OPTIONS", "*"), res);
    expect(state.statusCode).toBe(403);
  });
});

// ── CORS_ALLOWED_ORIGINS set ──────────────────────────────────────────────────

describe("CORS_ALLOWED_ORIGINS default set", () => {
  it("contains the dashboard origin", () => {
    expect(CORS_ALLOWED_ORIGINS.has("https://dashboard.ellie-labs.dev")).toBe(true);
  });

  it("contains the ellie app origin", () => {
    expect(CORS_ALLOWED_ORIGINS.has("https://ellie.ellie-labs.dev")).toBe(true);
  });

  it("contains localhost:3000 for local development", () => {
    expect(CORS_ALLOWED_ORIGINS.has("http://localhost:3000")).toBe(true);
  });

  it("contains localhost:3002 for local ellie-app", () => {
    expect(CORS_ALLOWED_ORIGINS.has("http://localhost:3002")).toBe(true);
  });

  it("does NOT contain wildcard", () => {
    expect(CORS_ALLOWED_ORIGINS.has("*")).toBe(false);
  });
});
