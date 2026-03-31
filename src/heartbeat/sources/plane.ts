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
    const results: any[] = data.results ?? [];

    // Only consider tickets with meaningful state fields — filter out noise from
    // timestamp-only bumps (e.g. views, reorders) by hashing status + priority.
    const meaningful = results.filter((t: any) => t.state_detail?.name || t.priority);
    const stateHash = meaningful
      .map((t: any) => `${t.sequence_id}:${t.state_detail?.name}:${t.priority}`)
      .join(",");

    const prevHash = snapshot?.plane_last_updated_at ?? "";
    const changed = stateHash !== "" && stateHash !== prevHash;

    const changedTickets = changed
      ? meaningful.map((t: any) => t.sequence_id ?? t.id ?? "unknown")
      : [];

    return {
      delta: {
        source: "plane",
        changed,
        summary: changed
          ? `Ticket state changed: ${changedTickets.join(", ")}`
          : "No meaningful ticket changes",
        count: changedTickets.length,
        details: changed ? { tickets: meaningful.map((t: any) => ({ id: t.id, sequence_id: t.sequence_id, state: t.state_detail?.name, priority: t.priority })) } : undefined,
      },
      snapshotUpdate: { plane_last_updated_at: stateHash },
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
