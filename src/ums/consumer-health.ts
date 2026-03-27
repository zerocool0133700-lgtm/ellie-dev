/**
 * Consumer Health Registry — ELLIE-1053
 * Tracks per-consumer lastProcessedAt and lastError for /health endpoint.
 * Stale = no activity for >60s. Stale consumers contribute to degraded status.
 * Inspired by MikroDash's per-collector state.lastXyzTs pattern.
 */

import { log } from "../logger.ts";

const logger = log.child("ums:health");

const STALE_THRESHOLD_MS = 60_000; // 60 seconds

interface ConsumerHealthEntry {
  lastProcessedAt: number;
  lastError: string | null;
  lastErrorAt: number | null;
  messagesProcessed: number;
}

const registry = new Map<string, ConsumerHealthEntry>();

/** Record successful processing */
export function recordProcessed(consumerName: string): void {
  const entry = registry.get(consumerName) || {
    lastProcessedAt: 0,
    lastError: null,
    lastErrorAt: null,
    messagesProcessed: 0,
  };
  entry.lastProcessedAt = Date.now();
  entry.messagesProcessed++;
  registry.set(consumerName, entry);
}

/** Record an error */
export function recordError(consumerName: string, error: string): void {
  const entry = registry.get(consumerName) || {
    lastProcessedAt: 0,
    lastError: null,
    lastErrorAt: null,
    messagesProcessed: 0,
  };
  entry.lastError = error.slice(0, 300);
  entry.lastErrorAt = Date.now();
  registry.set(consumerName, entry);
}

/** Check if a consumer is stale */
export function isStale(consumerName: string): boolean {
  const entry = registry.get(consumerName);
  if (!entry || entry.lastProcessedAt === 0) return false; // Never processed = not stale (just new)
  return Date.now() - entry.lastProcessedAt > STALE_THRESHOLD_MS;
}

/** Get health status for all consumers */
export function getConsumerHealthStatus(): Record<string, {
  lastProcessedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  messagesProcessed: number;
  stale: boolean;
}> {
  const result: Record<string, any> = {};
  for (const [name, entry] of registry) {
    result[name] = {
      lastProcessedAt: entry.lastProcessedAt ? new Date(entry.lastProcessedAt).toISOString() : null,
      lastError: entry.lastError,
      lastErrorAt: entry.lastErrorAt ? new Date(entry.lastErrorAt).toISOString() : null,
      messagesProcessed: entry.messagesProcessed,
      stale: isStale(name),
    };
  }
  return result;
}

/** Check if any consumer is stale (for overall health status) */
export function hasStaleConsumers(): boolean {
  for (const [name] of registry) {
    if (isStale(name)) return true;
  }
  return false;
}

/** Reset for testing */
export function _resetForTesting(): void {
  registry.clear();
}

export { STALE_THRESHOLD_MS };
