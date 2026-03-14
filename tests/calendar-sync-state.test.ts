/**
 * Calendar Sync State Tests — ELLIE-706
 *
 * Tests deletion detection via sync state tracking.
 * Uses injectable mock deps — no real DB calls.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  processSyncCycle,
  _makeMockSyncStateDeps,
  _makeMockSyncStateStore,
  type MockSyncStateStore,
  type SyncStateDeps,
} from "../src/calendar-sync-state.ts";

// ── Helpers ─────────────────────────────────────────────────

let store: MockSyncStateStore;
let deps: SyncStateDeps;

function stateKey(provider: string, calendarId: string, externalId: string): string {
  return `${provider}:${calendarId}:${externalId}`;
}

beforeEach(() => {
  const mock = _makeMockSyncStateDeps();
  store = mock.store;
  deps = mock.deps;
});

// ── Normal sync ─────────────────────────────────────────────

describe("normal sync — all events present", () => {
  test("first sync records all events with zero misses", async () => {
    const result = await processSyncCycle(
      deps,
      "google",
      "primary",
      ["evt-1", "evt-2", "evt-3"]
    );

    expect(result.recorded).toBe(3);
    expect(result.missesIncremented).toBe(0);
    expect(result.staleDetected).toBe(0);
    expect(result.deleted).toBe(0);
    expect(store.records.size).toBe(3);
  });

  test("subsequent sync with same events keeps miss count at zero", async () => {
    await processSyncCycle(deps, "google", "primary", ["evt-1", "evt-2"]);
    const result = await processSyncCycle(deps, "google", "primary", ["evt-1", "evt-2"]);

    expect(result.recorded).toBe(2);
    expect(result.missesIncremented).toBe(0);
    expect(result.deleted).toBe(0);

    for (const record of store.records.values()) {
      expect(record.consecutive_misses).toBe(0);
    }
  });

  test("new events added in later sync are tracked", async () => {
    await processSyncCycle(deps, "google", "primary", ["evt-1"]);
    await processSyncCycle(deps, "google", "primary", ["evt-1", "evt-2", "evt-3"]);

    expect(store.records.size).toBe(3);
    expect(store.records.get(stateKey("google", "primary", "evt-2"))).toBeDefined();
    expect(store.records.get(stateKey("google", "primary", "evt-3"))).toBeDefined();
  });
});

// ── Deletion detection ──────────────────────────────────────

describe("deletion detection", () => {
  test("event missing from 1 sync increments miss count but does not delete", async () => {
    // Sync 1: all present
    await processSyncCycle(deps, "google", "primary", ["evt-1", "evt-2", "evt-3"]);

    // Sync 2: evt-2 missing
    const result = await processSyncCycle(deps, "google", "primary", ["evt-1", "evt-3"]);

    expect(result.missesIncremented).toBe(1);
    expect(result.staleDetected).toBe(0);
    expect(result.deleted).toBe(0);

    const evt2 = store.records.get(stateKey("google", "primary", "evt-2"));
    expect(evt2?.consecutive_misses).toBe(1);
  });

  test("event missing from 2 consecutive syncs is deleted", async () => {
    // Sync 1: all present
    await processSyncCycle(deps, "google", "primary", ["evt-1", "evt-2", "evt-3"]);

    // Sync 2: evt-2 missing (miss count = 1)
    await processSyncCycle(deps, "google", "primary", ["evt-1", "evt-3"]);

    // Sync 3: evt-2 still missing (miss count = 2 → delete)
    const result = await processSyncCycle(deps, "google", "primary", ["evt-1", "evt-3"]);

    expect(result.staleDetected).toBe(1);
    expect(result.deleted).toBe(1);
    expect(store.deletedEvents.has("google:evt-2")).toBe(true);
    // Sync state cleaned up
    expect(store.records.has(stateKey("google", "primary", "evt-2"))).toBe(false);
  });

  test("multiple events deleted in same cycle", async () => {
    await processSyncCycle(deps, "google", "primary", ["evt-1", "evt-2", "evt-3", "evt-4"]);
    // Miss 1
    await processSyncCycle(deps, "google", "primary", ["evt-1"]);
    // Miss 2 → delete evt-2, evt-3, evt-4
    const result = await processSyncCycle(deps, "google", "primary", ["evt-1"]);

    expect(result.staleDetected).toBe(3);
    expect(result.deleted).toBe(3);
    expect(store.deletedEvents.has("google:evt-2")).toBe(true);
    expect(store.deletedEvents.has("google:evt-3")).toBe(true);
    expect(store.deletedEvents.has("google:evt-4")).toBe(true);
    // Only evt-1 remains in tracking
    expect(store.records.size).toBe(1);
  });

  test("custom miss threshold is respected", async () => {
    await processSyncCycle(deps, "google", "primary", ["evt-1", "evt-2"]);

    // Miss 1
    await processSyncCycle(deps, "google", "primary", ["evt-1"], 3);
    // Miss 2
    await processSyncCycle(deps, "google", "primary", ["evt-1"], 3);
    // Miss 2 with threshold 3: not deleted yet
    expect(store.deletedEvents.has("google:evt-2")).toBe(false);

    // Miss 3 → delete
    const result = await processSyncCycle(deps, "google", "primary", ["evt-1"], 3);
    expect(result.deleted).toBe(1);
    expect(store.deletedEvents.has("google:evt-2")).toBe(true);
  });
});

// ── Re-appearing events ─────────────────────────────────────

describe("re-appearing events", () => {
  test("event returns after 1 miss — miss count resets to 0", async () => {
    await processSyncCycle(deps, "google", "primary", ["evt-1", "evt-2"]);

    // Miss 1
    await processSyncCycle(deps, "google", "primary", ["evt-1"]);
    const evt2After1 = store.records.get(stateKey("google", "primary", "evt-2"));
    expect(evt2After1?.consecutive_misses).toBe(1);

    // Re-appears
    const result = await processSyncCycle(deps, "google", "primary", ["evt-1", "evt-2"]);
    const evt2After2 = store.records.get(stateKey("google", "primary", "evt-2"));
    expect(evt2After2?.consecutive_misses).toBe(0);
    expect(result.deleted).toBe(0);
  });

  test("event that reappears is not deleted even after prior misses", async () => {
    await processSyncCycle(deps, "google", "primary", ["evt-1", "evt-2"]);

    // Miss 1
    await processSyncCycle(deps, "google", "primary", ["evt-1"]);

    // Reappears before threshold
    await processSyncCycle(deps, "google", "primary", ["evt-1", "evt-2"]);

    // Miss again (fresh miss count, so only 1)
    await processSyncCycle(deps, "google", "primary", ["evt-1"]);

    // Still only 1 miss — should not delete
    const evt2 = store.records.get(stateKey("google", "primary", "evt-2"));
    expect(evt2?.consecutive_misses).toBe(1);
    expect(store.deletedEvents.has("google:evt-2")).toBe(false);
  });
});

// ── Multi-provider isolation ────────────────────────────────

describe("multi-provider isolation", () => {
  test("sync state is isolated between providers", async () => {
    // Google sees evt-1
    await processSyncCycle(deps, "google", "primary", ["evt-1"]);
    // Apple sees evt-2
    await processSyncCycle(deps, "apple", "work", ["evt-2"]);

    expect(store.records.size).toBe(2);

    // Google misses evt-1 twice
    await processSyncCycle(deps, "google", "primary", []);
    await processSyncCycle(deps, "google", "primary", []);

    // Google evt-1 deleted
    expect(store.deletedEvents.has("google:evt-1")).toBe(true);
    // Apple evt-2 untouched
    expect(store.records.has(stateKey("apple", "work", "evt-2"))).toBe(true);
    expect(store.deletedEvents.has("apple:evt-2")).toBe(false);
  });

  test("same external_id across providers tracked independently", async () => {
    await processSyncCycle(deps, "google", "primary", ["shared-id"]);
    await processSyncCycle(deps, "apple", "personal", ["shared-id"]);

    // Miss from google only
    await processSyncCycle(deps, "google", "primary", []);
    await processSyncCycle(deps, "apple", "personal", ["shared-id"]);

    const googleRecord = store.records.get(stateKey("google", "primary", "shared-id"));
    const appleRecord = store.records.get(stateKey("apple", "personal", "shared-id"));

    expect(googleRecord?.consecutive_misses).toBe(1);
    expect(appleRecord?.consecutive_misses).toBe(0);
  });
});

// ── Multi-calendar isolation ────────────────────────────────

describe("multi-calendar isolation", () => {
  test("different calendar IDs within same provider are tracked separately", async () => {
    await processSyncCycle(deps, "apple", "work", ["evt-1"]);
    await processSyncCycle(deps, "apple", "personal", ["evt-2"]);

    // Miss from work calendar
    await processSyncCycle(deps, "apple", "work", []);
    await processSyncCycle(deps, "apple", "work", []);

    // Work evt-1 deleted
    expect(store.deletedEvents.has("apple:evt-1")).toBe(true);
    // Personal evt-2 untouched
    expect(store.records.has(stateKey("apple", "personal", "evt-2"))).toBe(true);
  });
});

// ── Edge cases ──────────────────────────────────────────────

describe("edge cases", () => {
  test("empty sync cycle with no prior state is a no-op", async () => {
    const result = await processSyncCycle(deps, "google", "primary", []);

    expect(result.recorded).toBe(0);
    expect(result.missesIncremented).toBe(0);
    expect(result.staleDetected).toBe(0);
    expect(result.deleted).toBe(0);
  });

  test("all events disappear at once — all deleted after threshold", async () => {
    await processSyncCycle(deps, "google", "primary", ["a", "b", "c"]);

    // All disappear — miss 1
    await processSyncCycle(deps, "google", "primary", []);
    expect(store.deletedEvents.size).toBe(0);

    // All disappear — miss 2 → delete all
    const result = await processSyncCycle(deps, "google", "primary", []);
    expect(result.deleted).toBe(3);
    expect(store.records.size).toBe(0);
  });

  test("single event lifecycle: appear → persist → disappear → delete", async () => {
    // Appear
    await processSyncCycle(deps, "google", "primary", ["evt-lifecycle"]);
    expect(store.records.size).toBe(1);

    // Persist for several cycles
    for (let i = 0; i < 5; i++) {
      await processSyncCycle(deps, "google", "primary", ["evt-lifecycle"]);
    }
    const record = store.records.get(stateKey("google", "primary", "evt-lifecycle"));
    expect(record?.consecutive_misses).toBe(0);

    // Disappear — miss 1
    await processSyncCycle(deps, "google", "primary", []);
    // Disappear — miss 2 → deleted
    const result = await processSyncCycle(deps, "google", "primary", []);
    expect(result.deleted).toBe(1);
    expect(store.deletedEvents.has("google:evt-lifecycle")).toBe(true);
  });

  test("large number of events handled correctly", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `evt-${i}`);
    await processSyncCycle(deps, "google", "primary", ids);
    expect(store.records.size).toBe(100);

    // Remove half
    const kept = ids.slice(0, 50);
    await processSyncCycle(deps, "google", "primary", kept);
    await processSyncCycle(deps, "google", "primary", kept);

    expect(store.deletedEvents.size).toBe(50);
    expect(store.records.size).toBe(50);
  });

  test("processSyncCycle returns correct counts at each step", async () => {
    // Cycle 1: 3 new events
    const r1 = await processSyncCycle(deps, "google", "primary", ["a", "b", "c"]);
    expect(r1).toEqual({ recorded: 3, missesIncremented: 0, staleDetected: 0, deleted: 0 });

    // Cycle 2: "c" missing
    const r2 = await processSyncCycle(deps, "google", "primary", ["a", "b"]);
    expect(r2).toEqual({ recorded: 2, missesIncremented: 1, staleDetected: 0, deleted: 0 });

    // Cycle 3: "c" still missing → stale + deleted
    const r3 = await processSyncCycle(deps, "google", "primary", ["a", "b"]);
    expect(r3).toEqual({ recorded: 2, missesIncremented: 1, staleDetected: 1, deleted: 1 });

    // Cycle 4: after cleanup, "c" is gone — only a,b tracked
    const r4 = await processSyncCycle(deps, "google", "primary", ["a", "b"]);
    expect(r4).toEqual({ recorded: 2, missesIncremented: 0, staleDetected: 0, deleted: 0 });
  });
});

// ── Outlook provider ────────────────────────────────────────

describe("outlook provider support", () => {
  test("outlook events tracked and deleted like other providers", async () => {
    await processSyncCycle(deps, "outlook", "primary", ["o365-1", "o365-2"]);

    await processSyncCycle(deps, "outlook", "primary", ["o365-1"]);
    await processSyncCycle(deps, "outlook", "primary", ["o365-1"]);

    expect(store.deletedEvents.has("outlook:o365-2")).toBe(true);
    expect(store.records.has(stateKey("outlook", "primary", "o365-1"))).toBe(true);
  });
});

// ── Concurrent providers in single session ──────────────────

describe("concurrent providers in single session", () => {
  test("full multi-provider sync simulation", async () => {
    // Cycle 1: all providers sync
    await processSyncCycle(deps, "google", "primary", ["g1", "g2"]);
    await processSyncCycle(deps, "outlook", "primary", ["o1"]);
    await processSyncCycle(deps, "apple", "work", ["a1", "a2"]);
    await processSyncCycle(deps, "apple", "personal", ["a3"]);

    expect(store.records.size).toBe(6);

    // Cycle 2: g2 deleted from Google, a2 deleted from Apple work
    await processSyncCycle(deps, "google", "primary", ["g1"]);
    await processSyncCycle(deps, "outlook", "primary", ["o1"]);
    await processSyncCycle(deps, "apple", "work", ["a1"]);
    await processSyncCycle(deps, "apple", "personal", ["a3"]);

    // Cycle 3: second miss → deletions
    await processSyncCycle(deps, "google", "primary", ["g1"]);
    await processSyncCycle(deps, "outlook", "primary", ["o1"]);
    await processSyncCycle(deps, "apple", "work", ["a1"]);
    await processSyncCycle(deps, "apple", "personal", ["a3"]);

    expect(store.deletedEvents.has("google:g2")).toBe(true);
    expect(store.deletedEvents.has("apple:a2")).toBe(true);
    expect(store.deletedEvents.size).toBe(2);
    // Remaining: g1, o1, a1, a3
    expect(store.records.size).toBe(4);
  });
});
