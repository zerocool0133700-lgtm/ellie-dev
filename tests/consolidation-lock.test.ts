import { describe, it, expect } from "bun:test";
import { _lockKey } from "../src/ums/consolidation-lock.ts";

describe("ELLIE-1035: Consolidation lock", () => {
  it("generates consistent lock keys for same input", () => {
    const k1 = _lockKey("telegram", "2026-03-26T14:00:00Z");
    const k2 = _lockKey("telegram", "2026-03-26T14:00:00Z");
    expect(k1).toBe(k2);
  });

  it("generates different keys for different channels", () => {
    const k1 = _lockKey("telegram", "2026-03-26T14:00:00Z");
    const k2 = _lockKey("gmail", "2026-03-26T14:00:00Z");
    expect(k1).not.toBe(k2);
  });

  it("generates different keys for different windows", () => {
    const k1 = _lockKey("telegram", "2026-03-26T14:00:00Z");
    const k2 = _lockKey("telegram", "2026-03-26T15:00:00Z");
    expect(k1).not.toBe(k2);
  });

  it("returns a positive integer", () => {
    const key = _lockKey("test", "2026-01-01");
    expect(key).toBeGreaterThan(0);
    expect(Number.isInteger(key)).toBe(true);
  });
});
