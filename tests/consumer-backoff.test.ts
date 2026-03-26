import { describe, it, expect } from "bun:test";
import {
  calculateBackoffMs,
  recordFailure,
  recordSuccess,
  shouldProcess,
  resetConsumer,
  getAllConsumerStates,
  BASE_DELAY_MS,
  DISABLE_THRESHOLD,
} from "../src/ums/consumer-backoff.ts";

describe("ELLIE-1034: Consumer failure tracking & backoff", () => {
  // Use unique consumer names per test to avoid state leaks
  const testConsumer = `test-${Date.now()}`;

  describe("calculateBackoffMs", () => {
    it("returns 0 for no failures", () => {
      expect(calculateBackoffMs(0)).toBe(0);
    });

    it("returns 5 min for first failure", () => {
      expect(calculateBackoffMs(1)).toBe(BASE_DELAY_MS);
    });

    it("returns 10 min for second failure", () => {
      expect(calculateBackoffMs(2)).toBe(BASE_DELAY_MS * 2);
    });

    it("returns 20 min for third failure", () => {
      expect(calculateBackoffMs(3)).toBe(BASE_DELAY_MS * 4);
    });

    it("caps at 24 hours", () => {
      expect(calculateBackoffMs(100)).toBe(24 * 60 * 60_000);
    });
  });

  describe("recordFailure + shouldProcess", () => {
    it("allows processing on first call", () => {
      const name = `${testConsumer}-1`;
      expect(shouldProcess(name).allowed).toBe(true);
    });

    it("blocks processing during backoff", () => {
      const name = `${testConsumer}-2`;
      recordFailure(name, "test error");
      const check = shouldProcess(name);
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("backing off");
    });

    it("auto-disables after threshold failures", () => {
      const name = `${testConsumer}-3`;
      for (let i = 0; i < DISABLE_THRESHOLD; i++) {
        recordFailure(name, `error ${i}`);
      }
      const check = shouldProcess(name);
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("auto-disabled");
    });
  });

  describe("recordSuccess", () => {
    it("resets failure count", () => {
      const name = `${testConsumer}-4`;
      recordFailure(name, "error");
      recordFailure(name, "error");
      recordSuccess(name);
      expect(shouldProcess(name).allowed).toBe(true);
    });
  });

  describe("resetConsumer", () => {
    it("re-enables disabled consumer", () => {
      const name = `${testConsumer}-5`;
      for (let i = 0; i < DISABLE_THRESHOLD; i++) recordFailure(name, "error");
      expect(shouldProcess(name).allowed).toBe(false);
      resetConsumer(name);
      expect(shouldProcess(name).allowed).toBe(true);
    });
  });

  describe("getAllConsumerStates", () => {
    it("returns all tracked consumers", () => {
      const name = `${testConsumer}-6`;
      recordFailure(name, "test");
      const states = getAllConsumerStates();
      expect(states[name]).toBeDefined();
      expect(states[name].failureCount).toBe(1);
    });
  });
});
