/**
 * Heartbeat source adapter — forest (ELLIE-1164)
 *
 * Detects newly written Forest branches (knowledge nodes).
 */

import type { SourceDelta, HeartbeatSnapshot } from "../types.ts";

const SOURCE_TIMEOUT = 5000;

export async function check(snapshot: HeartbeatSnapshot | null): Promise<{
  delta: SourceDelta;
  snapshotUpdate: Partial<HeartbeatSnapshot>;
}> {
  try {
    const bridgeKey = process.env.BRIDGE_KEY || "";
    const RELAY_URL = process.env.RELAY_URL || "http://localhost:3001";

    const res = await fetch(`${RELAY_URL}/api/bridge/read`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-key": bridgeKey,
      },
      body: JSON.stringify({ query: "recent", scope_path: "2", match_count: 10 }),
      signal: AbortSignal.timeout(SOURCE_TIMEOUT),
    });

    if (!res.ok) throw new Error(`Bridge API returned ${res.status}`);

    const data = await res.json();
    const memories: any[] = data.memories ?? [];
    const ids = memories.map((m: any) => m.id);

    const prevIds = new Set(snapshot?.forest_branch_ids ?? []);
    const newIds = ids.filter((id) => !prevIds.has(id));
    const changed = newIds.length > 0;

    return {
      delta: {
        source: "forest",
        changed,
        summary: changed
          ? `${newIds.length} new Forest branch${newIds.length > 1 ? "es" : ""}`
          : "No new Forest branches",
        count: newIds.length,
      },
      snapshotUpdate: { forest_branch_ids: ids.slice(0, 20) },
    };
  } catch (err) {
    return {
      delta: {
        source: "forest",
        changed: false,
        summary: "Check failed",
        count: 0,
        error: (err as Error).message,
      },
      snapshotUpdate: {},
    };
  }
}
