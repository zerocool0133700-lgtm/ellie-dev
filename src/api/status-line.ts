/**
 * Status Line API — ELLIE-1025
 * Compact endpoint for dashboard status bar consumption.
 */

import { log } from "../logger.ts";
import { getChannelHealth } from "../channel-health.ts";

const logger = log.child("api:status-line");

export interface StatusLinePayload {
  creature: {
    active: number;
    pending: number;
    failed: number;
    lastDispatchAt: string | null;
  };
  ticket: {
    activeWorkItemId: string | null;
    title: string | null;
    agentName: string | null;
    sessionStartedAt: string | null;
  };
  forestHealth: {
    status: "ok" | "degraded" | "down" | "unknown";
    latencyMs: number | null;
    treeCount: number;
    recentEventCount: number;
  };
  system: {
    relayStatus: string;
    uptimeSeconds: number;
  };
  timestamp: string;
}

/** Pure data assembly — testable without HTTP */
export async function getStatusLine(deps: {
  forestSql: any;
  supabase: any;
}): Promise<StatusLinePayload> {
  const { forestSql, supabase } = deps;

  // Parallel queries for speed
  const [creatureStates, lastDispatch, activeSession, forestHealth, treeCount, recentEvents] = await Promise.allSettled([
    // Creature state counts
    forestSql`SELECT state, count(*)::int as count FROM creatures GROUP BY state`.catch(() => []),
    // Last dispatch timestamp
    forestSql`SELECT dispatched_at FROM creatures WHERE dispatched_at IS NOT NULL ORDER BY dispatched_at DESC LIMIT 1`.catch(() => []),
    // Active work session
    supabase.from("work_sessions").select("work_item_id, title, agent, created_at").eq("state", "active").order("created_at", { ascending: false }).limit(1).single().then((r: any) => r.data).catch(() => null),
    // Forest health via channel health
    Promise.resolve(getChannelHealth()).catch(() => null),
    // Tree count
    forestSql`SELECT count(*)::int as count FROM trees WHERE state = 'growing'`.catch(() => [{ count: 0 }]),
    // Recent forest events
    forestSql`SELECT count(*)::int as count FROM forest_events WHERE created_at > now() - interval '1 hour'`.catch(() => [{ count: 0 }]),
  ]);

  // Parse creature states
  const states = creatureStates.status === "fulfilled" ? creatureStates.value : [];
  const stateMap: Record<string, number> = {};
  for (const row of states) stateMap[row.state] = row.count;

  // Parse last dispatch
  const lastDispatchAt = lastDispatch.status === "fulfilled" && lastDispatch.value.length > 0
    ? lastDispatch.value[0].dispatched_at?.toISOString() || null
    : null;

  // Parse active session
  const session = activeSession.status === "fulfilled" ? activeSession.value : null;

  // Parse forest health
  const health = forestHealth.status === "fulfilled" ? forestHealth.value : null;
  const forestStatus = health?.forest?.status || "unknown";
  const forestLatency = health?.forest?.latencyMs || null;

  // Parse counts
  const trees = treeCount.status === "fulfilled" ? (treeCount.value[0]?.count || 0) : 0;
  const events = recentEvents.status === "fulfilled" ? (recentEvents.value[0]?.count || 0) : 0;

  return {
    creature: {
      active: stateMap["dispatched"] || stateMap["active"] || 0,
      pending: stateMap["idle"] || stateMap["pending"] || 0,
      failed: stateMap["failed"] || stateMap["error"] || 0,
      lastDispatchAt,
    },
    ticket: {
      activeWorkItemId: session?.work_item_id || null,
      title: session?.title || null,
      agentName: session?.agent || null,
      sessionStartedAt: session?.created_at || null,
    },
    forestHealth: {
      status: forestStatus,
      latencyMs: forestLatency,
      treeCount: trees,
      recentEventCount: events,
    },
    system: {
      relayStatus: "ok",
      uptimeSeconds: Math.floor(process.uptime()),
    },
    timestamp: new Date().toISOString(),
  };
}
