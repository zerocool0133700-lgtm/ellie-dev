/**
 * Consolidation Lock — ELLIE-1035
 * PostgreSQL advisory lock to prevent duplicate consolidation runs.
 * Inspired by Keeper.sh packages/sync/src/sync-lock.ts
 */

import { log } from "../logger.ts";

const logger = log.child("ums:lock");

const LOCK_TIMEOUT_MS = 120_000; // 2 minutes — auto-release

/**
 * Generate a stable integer lock key from a channel+window string.
 * PostgreSQL advisory locks use bigint keys.
 */
function lockKey(channel: string, windowStart: string): number {
  let hash = 0;
  const str = `consolidate:${channel}:${windowStart}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Try to acquire a PostgreSQL advisory lock for a consolidation block.
 * Returns true if lock acquired, false if already held.
 */
export async function tryAcquireConsolidationLock(
  forestSql: any,
  channel: string,
  windowStart: string
): Promise<boolean> {
  const key = lockKey(channel, windowStart);
  try {
    const result = await forestSql`SELECT pg_try_advisory_lock(${key}) as acquired`;
    const acquired = result[0]?.acquired === true;
    if (acquired) {
      logger.debug("Consolidation lock acquired", { channel, key });
      // Auto-release after timeout
      setTimeout(async () => {
        try {
          await forestSql`SELECT pg_advisory_unlock(${key})`;
          logger.debug("Consolidation lock auto-released (timeout)", { channel, key });
        } catch {}
      }, LOCK_TIMEOUT_MS);
    } else {
      logger.debug("Consolidation lock already held", { channel, key });
    }
    return acquired;
  } catch (err) {
    logger.error("Failed to acquire consolidation lock", { channel, error: String(err) });
    return false; // Fail open — allow processing if lock system is broken
  }
}

/**
 * Release a consolidation lock early (before timeout).
 */
export async function releaseConsolidationLock(
  forestSql: any,
  channel: string,
  windowStart: string
): Promise<void> {
  const key = lockKey(channel, windowStart);
  try {
    await forestSql`SELECT pg_advisory_unlock(${key})`;
    logger.debug("Consolidation lock released", { channel, key });
  } catch (err) {
    logger.error("Failed to release consolidation lock", { channel, error: String(err) });
  }
}

// Export for testing
export { lockKey as _lockKey };
