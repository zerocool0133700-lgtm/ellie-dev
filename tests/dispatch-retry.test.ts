import { describe, it, expect } from "bun:test";
import { classifyError, calculateDelay } from "../src/dispatch-retry.ts";

// ── classifyError ────────────────────────────────────────────

describe("classifyError", () => {
  // Retryable: network errors
  it("classifies ECONNRESET as retryable", () => {
    const r = classifyError(new Error("ECONNRESET"));
    expect(r.errorClass).toBe("retryable");
    expect(r.reason).toContain("network");
  });

  it("classifies ECONNREFUSED as retryable", () => {
    const r = classifyError(new Error("ECONNREFUSED"));
    expect(r.errorClass).toBe("retryable");
    expect(r.reason).toContain("network");
  });

  it("classifies ETIMEDOUT as retryable", () => {
    const r = classifyError(new Error("ETIMEDOUT"));
    expect(r.errorClass).toBe("retryable");
    expect(r.reason).toContain("network");
  });

  it("classifies fetch failed as retryable", () => {
    const r = classifyError(new Error("fetch failed"));
    expect(r.errorClass).toBe("retryable");
    expect(r.reason).toContain("network");
  });

  it("classifies socket hang up as retryable", () => {
    const r = classifyError(new Error("socket hang up"));
    expect(r.errorClass).toBe("retryable");
    expect(r.reason).toContain("network");
  });

  // Retryable: timeouts
  it("classifies timeout as retryable", () => {
    const r = classifyError(new Error("Request timeout"));
    expect(r.errorClass).toBe("retryable");
    expect(r.reason).toBe("timeout");
  });

  it("classifies timed out as retryable", () => {
    const r = classifyError(new Error("Connection timed out"));
    expect(r.errorClass).toBe("retryable");
    expect(r.reason).toBe("timeout");
  });

  // Retryable: server errors
  it("classifies 500 as retryable", () => {
    const r = classifyError(new Error("HTTP 500 Internal Server Error"));
    expect(r.errorClass).toBe("retryable");
    expect(r.reason).toBe("server_error");
  });

  it("classifies 502 as retryable", () => {
    const r = classifyError(new Error("502 bad gateway"));
    expect(r.errorClass).toBe("retryable");
    expect(r.reason).toBe("server_error");
  });

  it("classifies 503 as retryable", () => {
    const r = classifyError(new Error("503 service unavailable"));
    expect(r.errorClass).toBe("retryable");
    expect(r.reason).toBe("server_error");
  });

  // Retryable: rate limit
  it("classifies 429 as retryable", () => {
    const r = classifyError(new Error("429 Too Many Requests"));
    expect(r.errorClass).toBe("retryable");
    expect(r.reason).toBe("rate_limited");
  });

  it("classifies rate limit text as retryable", () => {
    const r = classifyError(new Error("Rate limit exceeded"));
    expect(r.errorClass).toBe("retryable");
    expect(r.reason).toBe("rate_limited");
  });

  // Retryable: edge function
  it("classifies edge function error as retryable", () => {
    const r = classifyError(new Error("Edge function unavailable"));
    expect(r.errorClass).toBe("retryable");
    expect(r.reason).toBe("edge_unavailable");
  });

  // Retryable: overloaded
  it("classifies overloaded as retryable", () => {
    const r = classifyError(new Error("System overloaded"));
    expect(r.errorClass).toBe("retryable");
    expect(r.reason).toBe("overloaded");
  });

  // Permanent: auth failures
  it("classifies 401 as permanent", () => {
    const r = classifyError(new Error("401 Unauthorized"));
    expect(r.errorClass).toBe("permanent");
    expect(r.reason).toBe("auth_failure");
  });

  it("classifies 403 as permanent", () => {
    const r = classifyError(new Error("403 Forbidden"));
    expect(r.errorClass).toBe("permanent");
    expect(r.reason).toBe("auth_failure");
  });

  it("classifies invalid API key as permanent", () => {
    const r = classifyError(new Error("Invalid API key provided"));
    expect(r.errorClass).toBe("permanent");
    expect(r.reason).toBe("auth_failure");
  });

  // Permanent: not found
  it("classifies 404 as permanent", () => {
    const r = classifyError(new Error("404 Not Found"));
    expect(r.errorClass).toBe("permanent");
    expect(r.reason).toBe("not_found");
  });

  it("classifies agent not found as permanent", () => {
    const r = classifyError(new Error("Agent not found: ops"));
    expect(r.errorClass).toBe("permanent");
    expect(r.reason).toBe("not_found");
  });

  // Permanent: validation
  it("classifies cost exceeded as permanent", () => {
    const r = classifyError(new Error("Cost exceeded limit"));
    expect(r.errorClass).toBe("permanent");
    expect(r.reason).toBe("validation");
  });

  it("classifies validation error as permanent", () => {
    const r = classifyError(new Error("Validation failed: missing field"));
    expect(r.errorClass).toBe("permanent");
    expect(r.reason).toBe("validation");
  });

  // Default: unknown → retryable
  it("classifies unknown error as retryable", () => {
    const r = classifyError(new Error("Something went wrong"));
    expect(r.errorClass).toBe("retryable");
    expect(r.reason).toBe("unknown");
  });

  it("handles non-Error objects", () => {
    const r = classifyError("string error");
    expect(r.errorClass).toBe("retryable");
  });

  it("handles null/undefined", () => {
    const r = classifyError(null);
    expect(r.errorClass).toBe("retryable");
  });
});

// ── calculateDelay ───────────────────────────────────────────

describe("calculateDelay", () => {
  it("returns positive delay for attempt 0", () => {
    const delay = calculateDelay(0);
    // BASE_DELAY_MS * 4^0 = 1000, plus jitter 0-500
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(1500);
  });

  it("increases exponentially per attempt", () => {
    // Attempt 0: 1000 + jitter (1000-1500)
    // Attempt 1: 4000 + jitter (4000-4500)
    // Attempt 2: 16000 + jitter (16000-16500)
    const d0 = calculateDelay(0);
    const d1 = calculateDelay(1);
    const d2 = calculateDelay(2);
    // d1 should always be > d0 max possible
    expect(d1).toBeGreaterThanOrEqual(4000);
    expect(d2).toBeGreaterThanOrEqual(16000);
  });

  it("includes jitter (non-deterministic)", () => {
    // Run multiple times — at least two should differ
    const delays = new Set<number>();
    for (let i = 0; i < 20; i++) {
      delays.add(calculateDelay(0));
    }
    // With 500ms jitter range, we expect some variation over 20 attempts
    expect(delays.size).toBeGreaterThan(1);
  });
});
