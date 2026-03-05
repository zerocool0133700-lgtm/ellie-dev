/**
 * Tests for ELLIE-557: Replace hardcoded localhost:3001 with env var
 *
 * Covers:
 *   - RELAY_BASE_URL default value
 *   - getRelayBaseUrl() reads RELAY_URL env var at call time
 *   - URL construction for all affected endpoint paths
 *   - No wildcard or empty base URL accepted
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getRelayBaseUrl, RELAY_BASE_URL } from "../src/relay-config.ts";

// ── RELAY_BASE_URL constant ───────────────────────────────────────────────────

describe("RELAY_BASE_URL constant", () => {
  it("has the expected default value when RELAY_URL is not set", () => {
    // If no RELAY_URL env var, default is http://localhost:3001
    if (!process.env.RELAY_URL) {
      expect(RELAY_BASE_URL).toBe("http://localhost:3001");
    } else {
      expect(RELAY_BASE_URL).toBe(process.env.RELAY_URL);
    }
  });

  it("is a non-empty string", () => {
    expect(typeof RELAY_BASE_URL).toBe("string");
    expect(RELAY_BASE_URL.length).toBeGreaterThan(0);
  });

  it("starts with http:// or https://", () => {
    expect(RELAY_BASE_URL).toMatch(/^https?:\/\//);
  });

  it("does not contain a trailing slash", () => {
    expect(RELAY_BASE_URL.endsWith("/")).toBe(false);
  });
});

// ── getRelayBaseUrl() function ────────────────────────────────────────────────

describe("getRelayBaseUrl — default (no env var)", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.RELAY_URL;
    delete process.env.RELAY_URL;
  });

  afterEach(() => {
    if (original !== undefined) {
      process.env.RELAY_URL = original;
    } else {
      delete process.env.RELAY_URL;
    }
  });

  it("returns http://localhost:3001 when RELAY_URL is unset", () => {
    expect(getRelayBaseUrl()).toBe("http://localhost:3001");
  });

  it("returns a string that starts with http://", () => {
    expect(getRelayBaseUrl()).toMatch(/^http:\/\//);
  });

  it("does not return wildcard or empty string", () => {
    const url = getRelayBaseUrl();
    expect(url).not.toBe("*");
    expect(url).not.toBe("");
  });
});

describe("getRelayBaseUrl — RELAY_URL override", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.RELAY_URL;
  });

  afterEach(() => {
    if (original !== undefined) {
      process.env.RELAY_URL = original;
    } else {
      delete process.env.RELAY_URL;
    }
  });

  it("uses RELAY_URL when set", () => {
    process.env.RELAY_URL = "http://relay.internal:4000";
    expect(getRelayBaseUrl()).toBe("http://relay.internal:4000");
  });

  it("uses HTTPS RELAY_URL when set", () => {
    process.env.RELAY_URL = "https://relay.ellie-labs.dev";
    expect(getRelayBaseUrl()).toBe("https://relay.ellie-labs.dev");
  });

  it("falls back to http://localhost:3001 when RELAY_URL is deleted", () => {
    process.env.RELAY_URL = "http://custom:9000";
    expect(getRelayBaseUrl()).toBe("http://custom:9000");

    delete process.env.RELAY_URL;
    expect(getRelayBaseUrl()).toBe("http://localhost:3001");
  });
});

// ── URL construction — endpoint paths ────────────────────────────────────────

describe("URL construction with getRelayBaseUrl()", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.RELAY_URL;
    delete process.env.RELAY_URL;
  });

  afterEach(() => {
    if (original !== undefined) {
      process.env.RELAY_URL = original;
    } else {
      delete process.env.RELAY_URL;
    }
  });

  // Bridge endpoints (used by channel-health, slack/handler, forest consumer,
  // calendar-intel consumer, briefing)
  it("constructs /api/bridge/read URL correctly", () => {
    const url = `${getRelayBaseUrl()}/api/bridge/read`;
    expect(url).toBe("http://localhost:3001/api/bridge/read");
  });

  it("constructs /api/bridge/write URL correctly", () => {
    const url = `${getRelayBaseUrl()}/api/bridge/write`;
    expect(url).toBe("http://localhost:3001/api/bridge/write");
  });

  // Work-session endpoints (used by playbook, orchestration-dispatch)
  it("constructs /api/work-session/start URL correctly", () => {
    const url = `${getRelayBaseUrl()}/api/work-session/start`;
    expect(url).toBe("http://localhost:3001/api/work-session/start");
  });

  it("constructs /api/work-session/complete URL correctly", () => {
    const url = `${getRelayBaseUrl()}/api/work-session/complete`;
    expect(url).toBe("http://localhost:3001/api/work-session/complete");
  });

  it("constructs /api/work-session/update URL correctly", () => {
    const url = `${getRelayBaseUrl()}/api/work-session/update`;
    expect(url).toBe("http://localhost:3001/api/work-session/update");
  });

  it("constructs /api/work-session/pause URL correctly", () => {
    const url = `${getRelayBaseUrl()}/api/work-session/pause`;
    expect(url).toBe("http://localhost:3001/api/work-session/pause");
  });

  it("constructs /api/work-session/resume URL correctly", () => {
    const url = `${getRelayBaseUrl()}/api/work-session/resume`;
    expect(url).toBe("http://localhost:3001/api/work-session/resume");
  });

  it("uses RELAY_URL override for all endpoint constructions", () => {
    process.env.RELAY_URL = "https://relay.prod.example.com";
    const base = getRelayBaseUrl();
    expect(`${base}/api/bridge/read`).toBe("https://relay.prod.example.com/api/bridge/read");
    expect(`${base}/api/work-session/start`).toBe("https://relay.prod.example.com/api/work-session/start");
  });

  it("produces a valid URL that can be parsed by the URL constructor", () => {
    const url = `${getRelayBaseUrl()}/api/bridge/read`;
    expect(() => new URL(url)).not.toThrow();
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/bridge/read");
  });

  it("with custom RELAY_URL, produces a parseable URL", () => {
    process.env.RELAY_URL = "http://relay.internal:4000";
    const url = `${getRelayBaseUrl()}/api/bridge/write`;
    expect(() => new URL(url)).not.toThrow();
    const parsed = new URL(url);
    expect(parsed.host).toBe("relay.internal:4000");
    expect(parsed.pathname).toBe("/api/bridge/write");
  });
});
