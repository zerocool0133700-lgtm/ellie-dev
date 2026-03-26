/**
 * Content Hash — ELLIE-1031
 * SHA256-based content hashing for cross-channel deduplication.
 * Inspired by Keeper.sh packages/calendar/src/core/events/content-hash.ts
 */

import { createHash } from "node:crypto";

/**
 * Normalize text for hashing: lowercase, trim, collapse whitespace.
 * Ensures "Dave prefers async" from Telegram matches "dave prefers async" from Gmail.
 */
export function normalizeForHash(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Generate SHA256 content hash from text content.
 * Returns hex string suitable for database storage and indexing.
 */
export function contentHash(text: string): string {
  const normalized = normalizeForHash(text);
  return createHash("sha256").update(normalized).digest("hex");
}
