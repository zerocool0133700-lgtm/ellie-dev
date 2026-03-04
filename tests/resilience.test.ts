import { describe, it, expect } from "bun:test";
import { CircuitBreaker, withRetry, isTransientError } from "../src/resilience.ts";

// ── CircuitBreaker ───────────────────────────────────────────

describe("CircuitBreaker", () => {
  it("starts in closed state", () => {
    const cb = new CircuitBreaker({ name: "test-closed" });
    expect(cb.getState().state).toBe("closed");
    expect(cb.getState().failures).toBe(0);
  });

  it("stays closed on successful calls", async () => {
    const cb = new CircuitBreaker({ name: "test-success" });
    const result = await cb.call(() => Promise.resolve("ok"), "fallback");
    expect(result).toBe("ok");
    expect(cb.getState().state).toBe("closed");
  });

  it("counts failures but stays closed under threshold", async () => {
    const cb = new CircuitBreaker({ name: "test-under-threshold", failureThreshold: 3 });
    await cb.call(() => Promise.reject(new Error("fail")), "fallback");
    await cb.call(() => Promise.reject(new Error("fail")), "fallback");
    expect(cb.getState().state).toBe("closed");
    expect(cb.getState().failures).toBe(2);
  });

  it("opens after reaching failure threshold", async () => {
    const cb = new CircuitBreaker({ name: "test-open", failureThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      await cb.call(() => Promise.reject(new Error("fail")), "fallback");
    }
    expect(cb.getState().state).toBe("open");
  });

  it("returns fallback when open", async () => {
    const cb = new CircuitBreaker({ name: "test-fallback", failureThreshold: 1 });
    await cb.call(() => Promise.reject(new Error("fail")), "fallback");
    expect(cb.getState().state).toBe("open");
    const result = await cb.call(() => Promise.resolve("should-not-run"), "fallback");
    expect(result).toBe("fallback");
  });

  it("returns fallback on call failure", async () => {
    const cb = new CircuitBreaker({ name: "test-fail-fallback" });
    const result = await cb.call(() => Promise.reject(new Error("boom")), "safe");
    expect(result).toBe("safe");
  });

  it("transitions to half-open after reset timeout", async () => {
    const cb = new CircuitBreaker({
      name: "test-half-open",
      failureThreshold: 1,
      resetTimeoutMs: 50,
    });
    await cb.call(() => Promise.reject(new Error("fail")), "fallback");
    expect(cb.getState().state).toBe("open");
    await new Promise(r => setTimeout(r, 60));
    expect(cb.getState().state).toBe("half_open");
  });

  it("closes after successful half-open call", async () => {
    const cb = new CircuitBreaker({
      name: "test-recover",
      failureThreshold: 1,
      resetTimeoutMs: 50,
    });
    await cb.call(() => Promise.reject(new Error("fail")), "fallback");
    await new Promise(r => setTimeout(r, 60));
    expect(cb.getState().state).toBe("half_open");
    const result = await cb.call(() => Promise.resolve("recovered"), "fallback");
    expect(result).toBe("recovered");
    expect(cb.getState().state).toBe("closed");
  });

  it("re-opens after failed half-open call", async () => {
    const cb = new CircuitBreaker({
      name: "test-reopen",
      failureThreshold: 1,
      resetTimeoutMs: 50,
    });
    await cb.call(() => Promise.reject(new Error("fail")), "fallback");
    await new Promise(r => setTimeout(r, 60));
    expect(cb.getState().state).toBe("half_open");
    await cb.call(() => Promise.reject(new Error("still failing")), "fallback");
    expect(cb.getState().state).toBe("open");
  });

  it("returns fallback on timeout", async () => {
    const cb = new CircuitBreaker({ name: "test-timeout", callTimeoutMs: 50 });
    const result = await cb.call(
      () => new Promise(resolve => setTimeout(() => resolve("slow"), 200)),
      "timed-out",
    );
    expect(result).toBe("timed-out");
  });

  it("resets to closed state", async () => {
    const cb = new CircuitBreaker({ name: "test-reset", failureThreshold: 1 });
    await cb.call(() => Promise.reject(new Error("fail")), "fallback");
    expect(cb.getState().state).toBe("open");
    cb.reset();
    expect(cb.getState().state).toBe("closed");
    expect(cb.getState().failures).toBe(0);
  });

  it("resets failure count on success", async () => {
    const cb = new CircuitBreaker({ name: "test-reset-count", failureThreshold: 3 });
    await cb.call(() => Promise.reject(new Error("fail")), "f");
    await cb.call(() => Promise.reject(new Error("fail")), "f");
    expect(cb.getState().failures).toBe(2);
    await cb.call(() => Promise.resolve("ok"), "f");
    expect(cb.getState().failures).toBe(0);
  });
});

// ── withRetry ────────────────────────────────────────────────

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const result = await withRetry(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
  });

  it("retries on failure and returns eventual success", async () => {
    let attempts = 0;
    const result = await withRetry(() => {
      attempts++;
      if (attempts < 3) throw new Error("not yet");
      return Promise.resolve("done");
    }, { baseDelayMs: 10, maxDelayMs: 20 });
    expect(result).toBe("done");
    expect(attempts).toBe(3);
  });

  it("throws after max retries", async () => {
    let attempts = 0;
    try {
      await withRetry(() => {
        attempts++;
        throw new Error("always fails");
      }, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 20 });
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect((err as Error).message).toBe("always fails");
      expect(attempts).toBe(3); // initial + 2 retries
    }
  });

  it("respects retryOn filter — skips non-retryable errors", async () => {
    let attempts = 0;
    try {
      await withRetry(() => {
        attempts++;
        throw new Error("permanent");
      }, {
        maxRetries: 3,
        baseDelayMs: 10,
        retryOn: (err) => (err as Error).message !== "permanent",
      });
    } catch (err) {
      expect((err as Error).message).toBe("permanent");
      expect(attempts).toBe(1); // no retries
    }
  });
});

// ── isTransientError ─────────────────────────────────────────

describe("isTransientError", () => {
  it("detects network errors as transient", () => {
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
    expect(isTransientError(new Error("ECONNREFUSED"))).toBe(true);
    expect(isTransientError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientError(new Error("ETIMEDOUT"))).toBe(true);
    expect(isTransientError(new Error("ENETUNREACH"))).toBe(true);
    expect(isTransientError(new Error("socket hang up"))).toBe(true);
  });

  it("detects HTTP 5xx as transient", () => {
    expect(isTransientError(new Error("Request failed with status 500"))).toBe(true);
    expect(isTransientError(new Error("502 Bad Gateway"))).toBe(true);
    expect(isTransientError(new Error("503 Service Unavailable"))).toBe(true);
  });

  it("detects 429 rate limit as transient", () => {
    expect(isTransientError(new Error("429 Too Many Requests"))).toBe(true);
  });

  it("defaults to true for unknown errors", () => {
    expect(isTransientError(new Error("something unknown"))).toBe(true);
    expect(isTransientError("string error")).toBe(true);
    expect(isTransientError(null)).toBe(true);
  });
});
