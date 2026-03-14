/**
 * Calendar Sync State — Deletion Detection
 *
 * Tracks which events we expect to see each sync cycle.
 * Events missing from 2+ consecutive syncs are flagged as deleted.
 */

import { sql } from "../../ellie-forest/src/index.ts";
import { log } from "./logger.ts";

const logger = log.child("calendar-sync-state");

// ============================================================
// TYPES
// ============================================================

export interface SyncStateRecord {
  id: string;
  provider: string;
  calendar_id: string;
  external_id: string;
  last_seen_at: string;
  consecutive_misses: number;
  created_at: string;
}

export interface SyncStateDeps {
  /** Record all event IDs seen in this sync cycle */
  recordSeenEvents: (
    provider: string,
    calendarId: string,
    externalIds: string[]
  ) => Promise<void>;

  /** Increment miss count for events NOT seen this cycle */
  incrementMisses: (
    provider: string,
    calendarId: string,
    seenExternalIds: string[]
  ) => Promise<number>;

  /** Get all events that have missed 2+ consecutive syncs */
  getStaleEvents: (
    provider: string,
    calendarId: string,
    missThreshold?: number
  ) => Promise<SyncStateRecord[]>;

  /** Delete events from calendar_events by marking deleted_at */
  markEventsDeleted: (
    provider: string,
    externalIds: string[]
  ) => Promise<number>;

  /** Remove sync state entries for events that have been deleted */
  cleanupDeletedState: (
    provider: string,
    externalIds: string[]
  ) => Promise<void>;

  /** Reset miss count when an event reappears */
  resetMisses: (
    provider: string,
    calendarId: string,
    externalIds: string[]
  ) => Promise<void>;
}

// ============================================================
// DEFAULT IMPLEMENTATIONS (use real DB)
// ============================================================

async function recordSeenEvents(
  provider: string,
  calendarId: string,
  externalIds: string[]
): Promise<void> {
  if (!externalIds.length) return;

  for (const externalId of externalIds) {
    await sql`
      INSERT INTO calendar_sync_state (provider, calendar_id, external_id, last_seen_at, consecutive_misses)
      VALUES (${provider}, ${calendarId}, ${externalId}, NOW(), 0)
      ON CONFLICT (provider, calendar_id, external_id) DO UPDATE SET
        last_seen_at = NOW(),
        consecutive_misses = 0
    `;
  }
}

async function incrementMisses(
  provider: string,
  calendarId: string,
  seenExternalIds: string[]
): Promise<number> {
  if (!seenExternalIds.length) {
    // No events seen — increment ALL tracked events for this provider+calendar
    const result = await sql`
      UPDATE calendar_sync_state
      SET consecutive_misses = consecutive_misses + 1
      WHERE provider = ${provider}
        AND calendar_id = ${calendarId}
      RETURNING id
    `;
    return result.length;
  }

  const result = await sql`
    UPDATE calendar_sync_state
    SET consecutive_misses = consecutive_misses + 1
    WHERE provider = ${provider}
      AND calendar_id = ${calendarId}
      AND external_id NOT IN ${sql(seenExternalIds)}
    RETURNING id
  `;
  return result.length;
}

async function getStaleEvents(
  provider: string,
  calendarId: string,
  missThreshold = 2
): Promise<SyncStateRecord[]> {
  const rows = await sql`
    SELECT id, provider, calendar_id, external_id, last_seen_at, consecutive_misses, created_at
    FROM calendar_sync_state
    WHERE provider = ${provider}
      AND calendar_id = ${calendarId}
      AND consecutive_misses >= ${missThreshold}
  `;
  return rows as unknown as SyncStateRecord[];
}

async function markEventsDeleted(
  provider: string,
  externalIds: string[]
): Promise<number> {
  if (!externalIds.length) return 0;

  const result = await sql`
    UPDATE calendar_events
    SET deleted_at = NOW(), updated_at = NOW()
    WHERE provider = ${provider}
      AND external_id IN ${sql(externalIds)}
      AND deleted_at IS NULL
    RETURNING id
  `;
  return result.length;
}

async function cleanupDeletedState(
  provider: string,
  externalIds: string[]
): Promise<void> {
  if (!externalIds.length) return;

  await sql`
    DELETE FROM calendar_sync_state
    WHERE provider = ${provider}
      AND external_id IN ${sql(externalIds)}
  `;
}

async function resetMisses(
  provider: string,
  calendarId: string,
  externalIds: string[]
): Promise<void> {
  if (!externalIds.length) return;

  await sql`
    UPDATE calendar_sync_state
    SET consecutive_misses = 0, last_seen_at = NOW()
    WHERE provider = ${provider}
      AND calendar_id = ${calendarId}
      AND external_id IN ${sql(externalIds)}
  `;
}

// ============================================================
// DEFAULT DEPS
// ============================================================

export function makeSyncStateDeps(): SyncStateDeps {
  return {
    recordSeenEvents,
    incrementMisses,
    getStaleEvents,
    markEventsDeleted,
    cleanupDeletedState,
    resetMisses,
  };
}

// ============================================================
// CORE LOGIC
// ============================================================

export interface SyncCycleResult {
  recorded: number;
  missesIncremented: number;
  staleDetected: number;
  deleted: number;
}

/**
 * Process a sync cycle for a single provider+calendar combination.
 * Call this after fetching events from a provider.
 *
 * @param deps - Injectable dependencies
 * @param provider - Calendar provider (google, outlook, apple)
 * @param calendarId - Calendar identifier within the provider
 * @param seenExternalIds - Event external_ids returned by this sync cycle
 * @param missThreshold - Number of consecutive misses before marking deleted (default: 2)
 */
export async function processSyncCycle(
  deps: SyncStateDeps,
  provider: string,
  calendarId: string,
  seenExternalIds: string[],
  missThreshold = 2
): Promise<SyncCycleResult> {
  // 1. Record all events we saw this cycle (resets their miss count to 0)
  await deps.recordSeenEvents(provider, calendarId, seenExternalIds);

  // 2. Increment miss count for events we didn't see
  const missesIncremented = await deps.incrementMisses(
    provider,
    calendarId,
    seenExternalIds
  );

  // 3. Find events that have missed enough cycles
  const staleEvents = await deps.getStaleEvents(
    provider,
    calendarId,
    missThreshold
  );

  // 4. Mark stale events as deleted
  let deleted = 0;
  if (staleEvents.length) {
    const staleIds = staleEvents.map((e) => e.external_id);
    deleted = await deps.markEventsDeleted(provider, staleIds);

    // Clean up sync state for deleted events
    await deps.cleanupDeletedState(provider, staleIds);

    logger.info(
      `Deleted ${deleted} stale events for ${provider}/${calendarId}`,
      { staleIds }
    );
  }

  return {
    recorded: seenExternalIds.length,
    missesIncremented,
    staleDetected: staleEvents.length,
    deleted,
  };
}

// ============================================================
// MOCK HELPERS (for testing)
// ============================================================

export interface MockSyncStateStore {
  records: Map<string, SyncStateRecord>;
  deletedEvents: Set<string>;
}

function stateKey(provider: string, calendarId: string, externalId: string): string {
  return `${provider}:${calendarId}:${externalId}`;
}

export function _makeMockSyncStateStore(): MockSyncStateStore {
  return {
    records: new Map(),
    deletedEvents: new Set(),
  };
}

export function _makeMockSyncStateDeps(
  store?: MockSyncStateStore
): { deps: SyncStateDeps; store: MockSyncStateStore } {
  const s = store || _makeMockSyncStateStore();

  const deps: SyncStateDeps = {
    async recordSeenEvents(provider, calendarId, externalIds) {
      for (const externalId of externalIds) {
        const key = stateKey(provider, calendarId, externalId);
        const existing = s.records.get(key);
        if (existing) {
          existing.last_seen_at = new Date().toISOString();
          existing.consecutive_misses = 0;
        } else {
          s.records.set(key, {
            id: crypto.randomUUID(),
            provider,
            calendar_id: calendarId,
            external_id: externalId,
            last_seen_at: new Date().toISOString(),
            consecutive_misses: 0,
            created_at: new Date().toISOString(),
          });
        }
      }
    },

    async incrementMisses(provider, calendarId, seenExternalIds) {
      const seenSet = new Set(seenExternalIds);
      let count = 0;
      for (const [key, record] of s.records) {
        if (
          record.provider === provider &&
          record.calendar_id === calendarId &&
          !seenSet.has(record.external_id)
        ) {
          record.consecutive_misses++;
          count++;
        }
      }
      return count;
    },

    async getStaleEvents(provider, calendarId, missThreshold = 2) {
      const results: SyncStateRecord[] = [];
      for (const record of s.records.values()) {
        if (
          record.provider === provider &&
          record.calendar_id === calendarId &&
          record.consecutive_misses >= missThreshold
        ) {
          results.push({ ...record });
        }
      }
      return results;
    },

    async markEventsDeleted(provider, externalIds) {
      let count = 0;
      for (const id of externalIds) {
        const fullKey = `${provider}:${id}`;
        if (!s.deletedEvents.has(fullKey)) {
          s.deletedEvents.add(fullKey);
          count++;
        }
      }
      return count;
    },

    async cleanupDeletedState(provider, externalIds) {
      for (const externalId of externalIds) {
        // Remove from all calendar_ids
        for (const key of Array.from(s.records.keys())) {
          if (key.startsWith(`${provider}:`) && key.endsWith(`:${externalId}`)) {
            s.records.delete(key);
          }
        }
      }
    },

    async resetMisses(provider, calendarId, externalIds) {
      for (const externalId of externalIds) {
        const key = stateKey(provider, calendarId, externalId);
        const record = s.records.get(key);
        if (record) {
          record.consecutive_misses = 0;
          record.last_seen_at = new Date().toISOString();
        }
      }
    },
  };

  return { deps, store: s };
}
