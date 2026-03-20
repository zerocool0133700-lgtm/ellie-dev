/**
 * ELLIE-925: Advisory Lock Hash Tests
 *
 * Tests for consolidated hash functions used in PostgreSQL advisory locks.
 */

import { describe, test, expect } from "bun:test";
import { hashToInt32, hashToInt64 } from "../src/advisory-lock-hash.ts";

describe("hashToInt32", () => {
  test("produces consistent 32-bit signed integer", () => {
    const input = "checkpoint:abc-123:dev";
    const hash1 = hashToInt32(input);
    const hash2 = hashToInt32(input);

    // Should be deterministic
    expect(hash1).toBe(hash2);

    // Should be a valid 32-bit signed integer
    expect(hash1).toBeGreaterThanOrEqual(-2147483648);
    expect(hash1).toBeLessThanOrEqual(2147483647);
  });

  test("produces different hashes for different inputs", () => {
    const hash1 = hashToInt32("session-1:dev");
    const hash2 = hashToInt32("session-2:dev");

    expect(hash1).not.toBe(hash2);
  });

  test("handles empty string", () => {
    const hash = hashToInt32("");
    expect(typeof hash).toBe("number");
  });

  test("produces same hash as session-compaction FNV-1a implementation", () => {
    // Reference implementation from session-compaction.ts (before ELLIE-925)
    function oldHashStringToInt32(str: string): number {
      let hash = 2166136261; // FNV offset basis
      for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619); // FNV prime
      }
      return hash | 0; // Convert to signed 32-bit int
    }

    const inputs = [
      "checkpoint:abc-123:dev",
      "session:xyz-789:research",
      "",
      "a",
      "test-session-id-1234567890",
    ];

    for (const input of inputs) {
      expect(hashToInt32(input)).toBe(oldHashStringToInt32(input));
    }
  });
});

describe("hashToInt64", () => {
  test("produces consistent 64-bit bigint", () => {
    const input = "session-abc-123:dev";
    const hash1 = hashToInt64(input);
    const hash2 = hashToInt64(input);

    // Should be deterministic
    expect(hash1).toBe(hash2);

    // Should be a bigint
    expect(typeof hash1).toBe("bigint");

    // ELLIE-925: Should be within int64 range (negative values allowed)
    expect(hash1).toBeGreaterThanOrEqual(-9223372036854775808n); // Min int64
    expect(hash1).toBeLessThanOrEqual(9223372036854775807n); // Max int64
  });

  test("produces different hashes for different inputs", () => {
    const hash1 = hashToInt64("session-1:dev");
    const hash2 = hashToInt64("session-2:dev");

    expect(hash1).not.toBe(hash2);
  });

  test("handles empty string", () => {
    const hash = hashToInt64("");
    expect(typeof hash).toBe("bigint");
  });

  test("uses FNV-1a algorithm with 64-bit constants", () => {
    // Verify it uses the correct FNV-1a 64-bit offset basis
    const emptyHash = hashToInt64("");

    // For empty string, should return the FNV-1a 64-bit offset basis (unmasked)
    // ELLIE-925: Uses full int64 range (negative values allowed)
    const expectedOffsetBasis = 14695981039346656037n;
    expect(emptyHash).toBe(expectedOffsetBasis);
  });

  test("handles collision resistance between similar inputs", () => {
    // Test that similar session IDs produce different hashes
    const hashes = new Set([
      hashToInt64("session-1:dev"),
      hashToInt64("session-2:dev"),
      hashToInt64("session-11:dev"),
      hashToInt64("session-12:dev"),
      hashToInt64("session-1:research"),
    ]);

    // All should be unique
    expect(hashes.size).toBe(5);
  });
});

describe("hash compatibility (ELLIE-925)", () => {
  test("int32 and int64 produce different values from same input", () => {
    const input = "checkpoint:abc-123:dev";
    const hash32 = hashToInt32(input);
    const hash64 = hashToInt64(input);

    // They should differ (different algorithms/bit widths)
    expect(BigInt(hash32)).not.toBe(hash64);
  });

  test("both hash functions are collision-resistant", () => {
    // Generate many session IDs and verify no collisions
    const inputs = Array.from({ length: 1000 }, (_, i) => `session-${i}:dev`);

    const hashes32 = new Set(inputs.map(hashToInt32));
    const hashes64 = new Set(inputs.map(hashToInt64));

    // Should have no collisions in this sample
    expect(hashes32.size).toBe(1000);
    expect(hashes64.size).toBe(1000);
  });
});
