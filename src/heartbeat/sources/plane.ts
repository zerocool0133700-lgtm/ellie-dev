/**
 * Heartbeat source adapter — plane (ELLIE-1164)
 *
 * Checks Plane for recently updated tickets.
 */

import type { SourceDelta, HeartbeatSnapshot } from "../types.ts";

const SOURCE_TIMEOUT = 5000;

export async function check(snapshot: HeartbeatSnapshot | null): Promise<{
  delta: SourceDelta;
  snapshotUpdate: Partial<HeartbeatSnapshot>;
}> {
  try {
    const apiKey = process.env.PLANE_API_KEY;
    if (!apiKey) throw new Error("PLANE_API_KEY not set");

    const projectId = "7194ace4-b80e-4c83-8042-c925598accf2";

    const res = await fetch(
      `http://localhost:8082/api/v1/workspaces/evelife/projects/${projectId}/issues/?order_by=-updated_at&per_page=5`,
      {
        headers: { "x-api-key": apiKey },
        signal: AbortSignal.timeout(SOURCE_TIMEOUT),
      },
    );

    if (!res.ok) throw new Error(`Plane API returned ${res.status}`);

    const data = await res.json();
    const latest = data.results?.[0];
    const latestUpdated: string = latest?.updated_at || "";

    const prevUpdated = snapshot?.plane_last_updated_at ?? "";
    const changed = latestUpdated !== "" && latestUpdated !== prevUpdated;

    return {
      delta: {
        source: "plane",
        changed,
        summary: changed
          ? `Ticket updated: ${latest?.sequence_id ?? latest?.id ?? "unknown"}`
          : "No ticket changes",
        count: changed ? 1 : 0,
        details: changed ? { id: latest?.id, sequence_id: latest?.sequence_id, updated_at: latestUpdated } : undefined,
      },
      snapshotUpdate: { plane_last_updated_at: latestUpdated },
    };
  } catch (err) {
    return {
      delta: {
        source: "plane",
        changed: false,
        summary: "Check failed",
        count: 0,
        error: (err as Error).message,
      },
      snapshotUpdate: {},
    };
  }
}
