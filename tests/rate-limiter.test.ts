import { describe, it, expect } from "bun:test";
import { checkMessageRate, checkVoiceRate, checkApiRate, getRateLimitStatus } from "../src/rate-limiter.ts";

// Note: These tests use the exported convenience functions which operate on
// the module-level singleton limiters. Tests use unique keys to avoid
// cross-test interference.

describe("checkMessageRate", () => {
  it("allows first message", () => {
    const result = checkMessageRate("user-msg-1", "telegram");
    expect(result).toBeNull();
  });

  it("allows messages within rate limit", () => {
    for (let i = 0; i < 5; i++) {
      const result = checkMessageRate("user-msg-2", "telegram");
      expect(result).toBeNull();
    }
  });

  it("returns rate limit message when exceeded", () => {
    const userId = "user-msg-flood-" + Date.now();
    // Default is 30 per minute
    for (let i = 0; i < 30; i++) {
      checkMessageRate(userId, "telegram");
    }
    const result = checkMessageRate(userId, "telegram");
    expect(result).not.toBeNull();
    expect(result).toContain("breather");
    expect(result).toContain("Try again in");
  });

  it("uses channel:userId as the rate limit key", () => {
    const userId = "user-msg-channel-" + Date.now();
    // Same user, different channels should have independent limits
    const r1 = checkMessageRate(userId, "telegram");
    const r2 = checkMessageRate(userId, "gchat");
    expect(r1).toBeNull();
    expect(r2).toBeNull();
  });
});

describe("checkVoiceRate", () => {
  it("allows first voice call", () => {
    const result = checkVoiceRate("user-voice-1");
    expect(result).toBeNull();
  });

  it("returns rate limit message when exceeded", () => {
    const userId = "user-voice-flood-" + Date.now();
    // Default is 10 per minute
    for (let i = 0; i < 10; i++) {
      checkVoiceRate(userId);
    }
    const result = checkVoiceRate(userId);
    expect(result).not.toBeNull();
    expect(result).toContain("Voice calls are limited");
  });
});

describe("checkApiRate", () => {
  it("returns null when under limit", () => {
    const result = checkApiRate("api-key-1-" + Date.now());
    expect(result).toBeNull();
  });

  it("returns 429 Response when exceeded", () => {
    const key = "api-key-flood-" + Date.now();
    // Default is 60 per minute
    for (let i = 0; i < 60; i++) {
      checkApiRate(key);
    }
    const result = checkApiRate(key);
    expect(result).not.toBeNull();
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(429);
    expect(result!.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("getRateLimitStatus", () => {
  it("returns status object with all limiter categories", () => {
    const status = getRateLimitStatus();
    expect(status).toHaveProperty("message");
    expect(status).toHaveProperty("voice");
    expect(status).toHaveProperty("api");
    expect(status).toHaveProperty("tool");
    expect(status.message).toHaveProperty("activeKeys");
    expect(typeof status.message.activeKeys).toBe("number");
  });
});
