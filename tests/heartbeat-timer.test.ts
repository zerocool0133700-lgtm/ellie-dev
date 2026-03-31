import { describe, it, expect } from "bun:test";
import { shouldSkipTick } from "../src/heartbeat/timer";

describe("heartbeat timer", () => {
  const baseOpts = {
    relayStartedAt: Date.now() - 120_000, // 2 minutes ago
    startupGraceMs: 60_000,                // 1 minute grace
    isProcessingMessage: false,
    isPhase2Running: false,
    isInActiveHours: true,
  };

  it("returns startup_grace when relay just started", () => {
    const result = shouldSkipTick({
      ...baseOpts,
      relayStartedAt: Date.now() - 10_000, // 10 seconds ago
      startupGraceMs: 60_000,               // 1 minute grace
    });
    expect(result).toBe("startup_grace");
  });

  it("returns outside_active_hours when not in window", () => {
    const result = shouldSkipTick({
      ...baseOpts,
      isInActiveHours: false,
    });
    expect(result).toBe("outside_active_hours");
  });

  it("returns message_processing when processing", () => {
    const result = shouldSkipTick({
      ...baseOpts,
      isProcessingMessage: true,
    });
    expect(result).toBe("message_processing");
  });

  it("returns phase2_running when phase 2 active", () => {
    const result = shouldSkipTick({
      ...baseOpts,
      isPhase2Running: true,
    });
    expect(result).toBe("phase2_running");
  });

  it("returns null when all clear", () => {
    const result = shouldSkipTick(baseOpts);
    expect(result).toBeNull();
  });
});
