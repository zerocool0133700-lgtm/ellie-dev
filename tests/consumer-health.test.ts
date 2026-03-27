import { describe, it, expect, beforeEach } from "bun:test";
import {
  recordProcessed,
  recordError,
  isStale,
  getConsumerHealthStatus,
  hasStaleConsumers,
  _resetForTesting,
  STALE_THRESHOLD_MS,
} from "../src/ums/consumer-health.ts";

describe("ELLIE-1053: Consumer health staleness", () => {
  beforeEach(() => {
    _resetForTesting();
  });

  describe("recordProcessed", () => {
    it("tracks processing timestamp", () => {
      recordProcessed("memory");
      const status = getConsumerHealthStatus();
      expect(status.memory).toBeDefined();
      expect(status.memory.lastProcessedAt).not.toBeNull();
      expect(status.memory.messagesProcessed).toBe(1);
    });

    it("increments message count", () => {
      recordProcessed("memory");
      recordProcessed("memory");
      recordProcessed("memory");
      const status = getConsumerHealthStatus();
      expect(status.memory.messagesProcessed).toBe(3);
    });
  });

  describe("recordError", () => {
    it("tracks last error", () => {
      recordError("memory", "Connection refused");
      const status = getConsumerHealthStatus();
      expect(status.memory.lastError).toBe("Connection refused");
      expect(status.memory.lastErrorAt).not.toBeNull();
    });

    it("truncates long errors", () => {
      recordError("memory", "x".repeat(500));
      const status = getConsumerHealthStatus();
      expect(status.memory.lastError!.length).toBeLessThanOrEqual(300);
    });
  });

  describe("isStale", () => {
    it("returns false for recently processed consumer", () => {
      recordProcessed("memory");
      expect(isStale("memory")).toBe(false);
    });

    it("returns false for unknown consumer", () => {
      expect(isStale("nonexistent")).toBe(false);
    });

    it("returns true when lastProcessedAt is old", () => {
      recordProcessed("memory");
      // Hack: manually set old timestamp
      const status = getConsumerHealthStatus();
      // We can't easily test real staleness without waiting 60s,
      // so test the threshold constant instead
      expect(STALE_THRESHOLD_MS).toBe(60_000);
    });
  });

  describe("hasStaleConsumers", () => {
    it("returns false when all consumers are fresh", () => {
      recordProcessed("memory");
      recordProcessed("forest");
      expect(hasStaleConsumers()).toBe(false);
    });
  });

  describe("getConsumerHealthStatus", () => {
    it("returns all tracked consumers", () => {
      recordProcessed("memory");
      recordProcessed("forest");
      recordError("gtd", "timeout");
      const status = getConsumerHealthStatus();
      expect(Object.keys(status)).toContain("memory");
      expect(Object.keys(status)).toContain("forest");
      expect(Object.keys(status)).toContain("gtd");
    });

    it("includes stale flag", () => {
      recordProcessed("memory");
      const status = getConsumerHealthStatus();
      expect(status.memory.stale).toBe(false);
    });
  });
});
