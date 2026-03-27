/**
 * Shadow Context Store — ELLIE-1056
 * Stores original content when sections are compressed.
 * Enables on-demand expansion without losing information.
 * Dual-TTL: originals 5h, compressed 24h.
 * Inspired by Context-Gateway internal/store/store.go
 */

import { log } from "./logger.ts";
import { randomUUID } from "node:crypto";

const logger = log.child("shadow:store");

interface ShadowEntry {
  id: string;
  label: string;
  original: string;
  compressed: string;
  originalTokens: number;
  compressedTokens: number;
  createdAt: number;
  ttlMs: number;
}

const ORIGINAL_TTL_MS = 5 * 60 * 60_000;   // 5 hours
const COMPRESSED_TTL_MS = 24 * 60 * 60_000; // 24 hours
const MAX_ENTRIES = 500;

export class ShadowContextStore {
  private entries = new Map<string, ShadowEntry>();

  // Metrics
  expansions = 0;
  stores = 0;

  /**
   * Store a compressed section with its original content.
   * Returns a shadow ID that can be used for expansion.
   */
  store(opts: {
    label: string;
    original: string;
    compressed: string;
    originalTokens: number;
    compressedTokens: number;
  }): string {
    this.evictExpired();

    // LRU eviction if at capacity
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest) this.entries.delete(oldest);
    }

    const id = `shadow_${randomUUID().slice(0, 12)}`;
    this.entries.set(id, {
      id,
      label: opts.label,
      original: opts.original,
      compressed: opts.compressed,
      originalTokens: opts.originalTokens,
      compressedTokens: opts.compressedTokens,
      createdAt: Date.now(),
      ttlMs: ORIGINAL_TTL_MS,
    });

    this.stores++;
    logger.debug("Stored shadow context", {
      id,
      label: opts.label,
      originalTokens: opts.originalTokens,
      compressedTokens: opts.compressedTokens,
    });

    return id;
  }

  /**
   * Expand a shadow entry — return the original content.
   * Returns null if expired or not found.
   */
  expand(id: string): string | null {
    const entry = this.entries.get(id);
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.createdAt > entry.ttlMs) {
      this.entries.delete(id);
      return null;
    }

    this.expansions++;
    logger.debug("Expanded shadow context", { id, label: entry.label });

    // After expansion, keep compressed version with longer TTL
    entry.ttlMs = COMPRESSED_TTL_MS;

    return entry.original;
  }

  /** Get entry metadata without expanding */
  peek(id: string): { label: string; originalTokens: number; compressedTokens: number } | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > entry.ttlMs) {
      this.entries.delete(id);
      return null;
    }
    return {
      label: entry.label,
      originalTokens: entry.originalTokens,
      compressedTokens: entry.compressedTokens,
    };
  }

  /** List all active shadow entries */
  list(): Array<{ id: string; label: string; originalTokens: number; compressedTokens: number; ageMs: number }> {
    this.evictExpired();
    const result: Array<{ id: string; label: string; originalTokens: number; compressedTokens: number; ageMs: number }> = [];
    for (const entry of this.entries.values()) {
      result.push({
        id: entry.id,
        label: entry.label,
        originalTokens: entry.originalTokens,
        compressedTokens: entry.compressedTokens,
        ageMs: Date.now() - entry.createdAt,
      });
    }
    return result;
  }

  /** Get store stats */
  stats(): { size: number; stores: number; expansions: number; totalOriginalTokens: number; totalCompressedTokens: number } {
    this.evictExpired();
    let totalOriginal = 0;
    let totalCompressed = 0;
    for (const entry of this.entries.values()) {
      totalOriginal += entry.originalTokens;
      totalCompressed += entry.compressedTokens;
    }
    return {
      size: this.entries.size,
      stores: this.stores,
      expansions: this.expansions,
      totalOriginalTokens: totalOriginal,
      totalCompressedTokens: totalCompressed,
    };
  }

  /** Remove expired entries */
  private evictExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (now - entry.createdAt > entry.ttlMs) {
        this.entries.delete(id);
      }
    }
  }

  /** Clear all entries */
  clear(): void {
    this.entries.clear();
  }
}

// Singleton instance
export const shadowStore = new ShadowContextStore();
