/**
 * Heartbeat Pre-Check — ELLIE-1164
 * Phase 1: Query all sources via allSettled, compute deltas, apply cooldowns.
 */

import { log } from "../logger.ts";
import { isSourceOnCooldown } from "./state.ts";
import type { SourceDelta, HeartbeatSnapshot, HeartbeatSource } from "./types.ts";

const logger = log.child("heartbeat-precheck");

type SourceChecker = (snapshot: HeartbeatSnapshot | null) => Promise<{
  delta: SourceDelta;
  snapshotUpdate: Partial<HeartbeatSnapshot>;
}>;

const SOURCE_MODULES: Record<HeartbeatSource, string> = {
  email: "./sources/email.ts",
  ci: "./sources/ci.ts",
  plane: "./sources/plane.ts",
  calendar: "./sources/calendar.ts",
  forest: "./sources/forest.ts",
  gtd: "./sources/gtd.ts",
};

export async function runPreCheck(
  sources: HeartbeatSource[],
  snapshot: HeartbeatSnapshot | null,
): Promise<{ deltas: SourceDelta[]; newSnapshot: HeartbeatSnapshot }> {
  // Load source modules
  const checkers = await Promise.all(
    sources.map(async (s) => {
      const mod = await import(SOURCE_MODULES[s]) as { check: SourceChecker };
      return { source: s, check: mod.check };
    }),
  );

  // Run all sources via allSettled (one failure doesn't kill others)
  const results = await Promise.allSettled(
    checkers.map(({ check }) => check(snapshot)),
  );

  const deltas: SourceDelta[] = [];
  const snapshotUpdates: Partial<HeartbeatSnapshot>[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const source = sources[i];
    if (result.status === "fulfilled") {
      deltas.push(result.value.delta);
      snapshotUpdates.push(result.value.snapshotUpdate);
    } else {
      logger.warn("Source check failed", { source, error: result.reason?.message });
      deltas.push({ source, changed: false, summary: "Check failed", count: 0, error: result.reason?.message });
    }
  }

  const newSnapshot = mergeSnapshots(snapshot, snapshotUpdates);
  return { deltas, newSnapshot };
}

export function mergeSnapshots(
  base: HeartbeatSnapshot | null,
  updates: Partial<HeartbeatSnapshot>[],
): HeartbeatSnapshot {
  const defaults: HeartbeatSnapshot = {
    email_unread_count: 0,
    ci_run_ids: [],
    plane_last_updated_at: "",
    calendar_event_ids: [],
    forest_branch_ids: [],
    gtd_open_count: 0,
    gtd_overdue_ids: [],
    gtd_completed_ids: [],
    captured_at: new Date().toISOString(),
  };
  const merged = { ...defaults, ...base };
  for (const update of updates) {
    Object.assign(merged, update);
  }
  merged.captured_at = new Date().toISOString();
  return merged;
}

export function filterCooledDown(
  deltas: SourceDelta[],
  cooldowns: Record<string, string>,
  minIntervalMs: number,
): SourceDelta[] {
  return deltas.filter((d) => {
    if (!d.changed) return false;
    if (isSourceOnCooldown(d.source, cooldowns, minIntervalMs)) {
      logger.info("Source on cooldown, skipping Phase 2 trigger", { source: d.source });
      return false;
    }
    return true;
  });
}
