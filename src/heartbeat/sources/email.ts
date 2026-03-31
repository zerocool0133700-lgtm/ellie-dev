/**
 * Heartbeat source adapter — email (ELLIE-1164)
 *
 * Counts new Gmail messages since the last snapshot tick.
 */

import { getRelayDeps } from "../../relay-state.ts";
import type { SourceDelta, HeartbeatSnapshot } from "../types.ts";

const SOURCE_TIMEOUT = 5000;

export async function check(snapshot: HeartbeatSnapshot | null): Promise<{
  delta: SourceDelta;
  snapshotUpdate: Partial<HeartbeatSnapshot>;
}> {
  try {
    const { supabase } = getRelayDeps();
    if (!supabase) throw new Error("Supabase not initialized");

    const since = snapshot?.captured_at || new Date(Date.now() - 15 * 60 * 1000).toISOString();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT);

    let count = 0;
    try {
      const { count: rowCount, error } = await supabase
        .from("messages")
        .select("*", { count: "exact", head: true })
        .eq("channel", "gmail")
        .eq("role", "user")
        .gte("created_at", since);

      if (error) throw error;
      count = rowCount ?? 0;
    } finally {
      clearTimeout(timer);
    }

    const prevCount = snapshot?.email_unread_count ?? 0;
    const changed = count > prevCount;

    return {
      delta: {
        source: "email",
        changed,
        summary: count > 0 ? `${count} new emails` : "No new emails",
        count,
      },
      snapshotUpdate: { email_unread_count: count },
    };
  } catch (err) {
    return {
      delta: {
        source: "email",
        changed: false,
        summary: "Check failed",
        count: 0,
        error: (err as Error).message,
      },
      snapshotUpdate: {},
    };
  }
}
