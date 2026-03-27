/**
 * Compression Cache — ELLIE-1062
 * Content-hash-keyed LRU cache for compression results.
 * Avoids re-compressing identical content (soul, archetype — rarely change).
 * Inspired by Context-Gateway's per-session caching.
 */

import { createHash } from "node:crypto";
import { log } from "./logger.ts";

const logger = log.child("compression:cache");

interface CacheEntry {
  compressed: string;
  originalTokens: number;
  compressedTokens: number;
  ratio: number;
  cachedAt: number;
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_TTL_MS = 30 * 60_000; // 30 minutes

// Time-sensitive sections that should never be cached
const BYPASS_LABELS = new Set([
  "conversation",
  "working-memory-full",
  "working-memory-resumption",
  "structured-context",
  "work-item",
  "queue",
  "orchestration-status",
  "health",
  "incidents",
]);

export class CompressionCache {
  private cache = new Map<string, CacheEntry>();
  private accessOrder: string[] = []; // LRU tracking
  private maxEntries: number;
  private ttlMs: number;

  // Metrics
  hits = 0;
  misses = 0;

  constructor(opts?: { maxEntries?: number; ttlMs?: number }) {
    this.maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Generate cache key from content + target ratio.
   * Same content at different ratios = different cache entries.
   */
  static cacheKey(content: string, targetRatio: number): string {
    return createHash("sha256")
      .update(`${targetRatio}:${content}`)
      .digest("hex")
      .slice(0, 24); // 24 chars is plenty for collision avoidance
  }

  /** Check if a section label should bypass the cache */
  shouldBypass(label: string): boolean {
    return BYPASS_LABELS.has(label);
  }

  /** Get cached compression result, or null if miss/expired */
  get(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    // Check TTL
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(key);
      this.accessOrder = this.accessOrder.filter(k => k !== key);
      this.misses++;
      return null;
    }

    // Update LRU order
    this.accessOrder = this.accessOrder.filter(k => k !== key);
    this.accessOrder.push(key);

    this.hits++;
    return entry;
  }

  /** Store a compression result */
  set(key: string, entry: CacheEntry): void {
    // Evict oldest if at capacity
    while (this.cache.size >= this.maxEntries && this.accessOrder.length > 0) {
      const evictKey = this.accessOrder.shift()!;
      this.cache.delete(evictKey);
    }

    this.cache.set(key, entry);
    this.accessOrder.push(key);
  }

  /** Get cache stats */
  stats(): { size: number; hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? Math.round((this.hits / total) * 100) / 100 : 0,
    };
  }

  /** Clear all entries */
  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
  }
}

// Singleton instance
export const compressionCache = new CompressionCache();
