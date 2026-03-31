/**
 * Heartbeat source adapter — calendar (ELLIE-1164)
 *
 * Detects upcoming calendar events starting in the next 30 minutes.
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

    const now = new Date().toISOString();
    const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT);

    let events: any[] = [];
    try {
      const { data, error } = await supabase
        .from("calendar_intel")
        .select("id, title, start_time")
        .gte("start_time", now)
        .lte("start_time", soon)
        .order("start_time");

      if (error) throw error;
      events = data ?? [];
    } finally {
      clearTimeout(timer);
    }

    const eventIds = events.map((e: any) => e.id);
    const prevIds = new Set(snapshot?.calendar_event_ids ?? []);
    const newEvents = events.filter((e: any) => !prevIds.has(e.id));
    const changed = newEvents.length > 0;

    return {
      delta: {
        source: "calendar",
        changed,
        summary: changed
          ? `${newEvents.length} upcoming event${newEvents.length > 1 ? "s" : ""}: ${newEvents.map((e: any) => e.title).join(", ")}`
          : events.length > 0
            ? `${events.length} event${events.length > 1 ? "s" : ""} soon`
            : "No upcoming events",
        count: newEvents.length,
        details: newEvents,
      },
      snapshotUpdate: { calendar_event_ids: eventIds },
    };
  } catch (err) {
    return {
      delta: {
        source: "calendar",
        changed: false,
        summary: "Check failed",
        count: 0,
        error: (err as Error).message,
      },
      snapshotUpdate: {},
    };
  }
}
