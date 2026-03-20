/**
 * ELLIE-925: Shared advisory lock hash utilities
 *
 * Provides consistent hash functions for PostgreSQL advisory locks.
 * Consolidates previously duplicated hash logic from working-memory.ts
 * and session-compaction.ts to prevent potential hash collisions.
 */

/**
 * Hash a string to a 32-bit signed integer for PostgreSQL advisory locks.
 * Uses FNV-1a hash algorithm (same as session-compaction.ts).
 *
 * @param str - String to hash
 * @returns 32-bit signed integer suitable for pg_advisory_lock()
 */
export function hashToInt32(str: string): number {
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619); // FNV prime
  }
  return hash | 0; // Convert to signed 32-bit int
}

/**
 * Hash a string to a 64-bit bigint for PostgreSQL advisory locks.
 * Uses FNV-1a algorithm extended to 64-bit.
 *
 * @param str - String to hash
 * @returns 64-bit bigint suitable for pg_advisory_lock()
 */
export function hashToInt64(str: string): bigint {
  let hash = 14695981039346656037n; // FNV-1a 64-bit offset basis
  const prime = 1099511628211n; // FNV-1a 64-bit prime

  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    // ELLIE-925: Use full 64-bit range (PostgreSQL accepts negative lock keys)
    // Wrap to int64 range using BigInt.asIntN instead of masking sign bit
    hash = BigInt.asIntN(64, hash * prime);
  }

  return hash;
}
