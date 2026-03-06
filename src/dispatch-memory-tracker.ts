/**
 * Dispatch Memory Tracker — ELLIE-632
 *
 * In-memory accumulator that tracks Forest memory IDs produced during
 * a work session. Used to cross-reference dispatch journal entries
 * with the Forest memories they generated.
 *
 * Lifecycle:
 *  - trackMemoryId(workItemId, memoryId) — called after each Forest write
 *  - getTrackedMemoryIds(workItemId) — called at dispatch end to snapshot
 *  - clearTrackedMemoryIds(workItemId) — called after journal end entry written
 *
 * Pure in-memory — no persistence, no side effects.
 */

const _tracked = new Map<string, string[]>();

/** Record a Forest memory ID produced during a work session. */
export function trackMemoryId(workItemId: string, memoryId: string): void {
  const ids = _tracked.get(workItemId);
  if (ids) {
    ids.push(memoryId);
  } else {
    _tracked.set(workItemId, [memoryId]);
  }
}

/** Get all tracked memory IDs for a work item. Returns empty array if none. */
export function getTrackedMemoryIds(workItemId: string): string[] {
  return _tracked.get(workItemId) ?? [];
}

/** Clear tracked memory IDs for a work item (call after journal end). */
export function clearTrackedMemoryIds(workItemId: string): void {
  _tracked.delete(workItemId);
}

/** Reset all tracking state — for unit tests only. */
export function _resetForTesting(): void {
  _tracked.clear();
}
