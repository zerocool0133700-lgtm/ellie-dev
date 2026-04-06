// src/prompt-layers/awareness.ts
/**
 * Layer 2: Awareness builder with mode filtering.
 * Fetches structured state data and renders to natural language based on conversation mode.
 */

import type {
  Awareness,
  LayeredMode,
} from "./types";
import { MODE_AWARENESS_FILTERS } from "../context-mode";

// ── Build ────────────────────────────────────────────────────

/**
 * Fetches data from multiple sources in parallel and returns a structured Awareness object.
 * Data fetchers are stubs for now — integration with real pipeline happens in Task 7.
 */
export async function buildAwareness(_supabase: any): Promise<Awareness> {
  // Fetch all sections in parallel (stubs return empty/minimal data)
  const [work, conversations, system, calendar, heartbeat] = await Promise.all([
    fetchWork(_supabase),
    fetchConversations(_supabase),
    fetchSystem(_supabase),
    fetchCalendar(_supabase),
    fetchHeartbeat(_supabase),
  ]);

  return { work, conversations, system, calendar, heartbeat };
}

async function fetchWork(_supabase: any): Promise<Awareness["work"]> {
  return {
    active_items: [],
    recent_sessions: [],
    blocked_items: [],
  };
}

async function fetchConversations(_supabase: any): Promise<Awareness["conversations"]> {
  return {
    last_conversation: null,
    open_threads: [],
  };
}

async function fetchSystem(_supabase: any): Promise<Awareness["system"]> {
  return {
    incidents: [],
    agent_status: [],
    creatures: [],
  };
}

async function fetchCalendar(_supabase: any): Promise<Awareness["calendar"]> {
  return {
    next_event: null,
    today_count: 0,
  };
}

async function fetchHeartbeat(_supabase: any): Promise<Awareness["heartbeat"]> {
  return {
    overdue_items: [],
    stale_threads: [],
    signals: [],
  };
}

// ── Filter & Render ──────────────────────────────────────────

/**
 * Takes the full Awareness object and a mode, applies the mode's filter,
 * and renders only the matching sections to natural language.
 */
export function filterAwarenessByMode(awareness: Awareness, mode: LayeredMode): string {
  const filter = MODE_AWARENESS_FILTERS[mode];
  const lines: string[] = ["## AWARENESS"];

  // Work section
  if (filter.work !== "none") {
    const workLines = renderWork(awareness, filter.work);
    lines.push(...workLines);
  }

  // Conversations section
  if (filter.conversations !== "none") {
    const convLines = renderConversations(awareness, filter.conversations);
    lines.push(...convLines);
  }

  // System section
  if (filter.system !== "none") {
    const sysLines = renderSystem(awareness, filter.system);
    lines.push(...sysLines);
  }

  // Calendar section
  if (filter.calendar !== "none") {
    const calLines = renderCalendar(awareness, filter.calendar);
    lines.push(...calLines);
  }

  // Heartbeat section
  if (filter.heartbeat !== "none") {
    const hbLines = renderHeartbeat(awareness, filter.heartbeat);
    lines.push(...hbLines);
  }

  // If only the header line, nothing to report
  if (lines.length === 1) {
    lines.push("No notable activity.");
  }

  return lines.join("\n");
}

// ── Section Renderers ────────────────────────────────────────

function renderWork(
  awareness: Awareness,
  level: "full" | "overdue_blocked"
): string[] {
  const lines: string[] = [];

  if (level === "full") {
    const { active_items, blocked_items } = awareness.work;
    if (active_items.length > 0) {
      const list = active_items.map((i) => `${i.id} (${i.title})`).join(", ");
      lines.push(`Active work: ${list}.`);
    }
    if (blocked_items.length > 0) {
      const list = blocked_items.map((i) => `${i.id} (${i.title})`).join(", ");
      lines.push(`Blocked: ${list}.`);
    }
  } else if (level === "overdue_blocked") {
    const { blocked_items } = awareness.work;
    const overdue = awareness.heartbeat.overdue_items;
    if (overdue.length > 0) {
      const list = overdue.map((i) => `${i.id} (${i.title})`).join(", ");
      lines.push(`Overdue work: ${list}.`);
    }
    if (blocked_items.length > 0) {
      const list = blocked_items.map((i) => `${i.id} (${i.title})`).join(", ");
      lines.push(`Blocked: ${list}.`);
    }
  }

  return lines;
}

function renderConversations(
  awareness: Awareness,
  level: "full" | "last_only" | "open_threads" | "stale_threads"
): string[] {
  const lines: string[] = [];
  const { last_conversation, open_threads } = awareness.conversations;

  if (level === "last_only" || level === "full") {
    if (last_conversation) {
      lines.push(
        `Last conversation: ${last_conversation.topic} (with ${last_conversation.agent}).`
      );
    }
  }

  if (level === "open_threads" || level === "full") {
    if (open_threads.length > 0) {
      const list = open_threads.map((t) => `${t.topic} (${t.agent})`).join(", ");
      lines.push(`Open threads: ${list}.`);
    }
  }

  if (level === "stale_threads") {
    const stale = awareness.heartbeat.stale_threads;
    if (stale.length > 0) {
      const list = stale.map((t) => `${t.topic} (${t.agent})`).join(", ");
      lines.push(`Stale threads: ${list}.`);
    }
  }

  return lines;
}

function renderSystem(
  awareness: Awareness,
  level: "full" | "incidents_only" | "agent_status"
): string[] {
  const lines: string[] = [];
  const { incidents, agent_status } = awareness.system;

  if (level === "incidents_only" || level === "full") {
    if (incidents.length > 0) {
      const list = incidents.map((i) => `${i.title} [${i.severity}]`).join(", ");
      lines.push(`Incidents: ${list}.`);
    }
  }

  if (level === "agent_status" || level === "full") {
    if (agent_status.length > 0) {
      const list = agent_status
        .map((a) => (a.current_task ? `${a.name} (${a.current_task})` : `${a.name} (${a.status})`))
        .join(", ");
      lines.push(`Agents: ${list}.`);
    }
  }

  return lines;
}

function renderCalendar(
  awareness: Awareness,
  level: "full" | "next_only" | "count_only"
): string[] {
  const lines: string[] = [];
  const { next_event, today_count } = awareness.calendar;

  if (level === "next_only" || level === "full") {
    if (next_event) {
      lines.push(`Next event: ${next_event.title} at ${next_event.start}.`);
    }
  }

  if (level === "count_only" || level === "full") {
    if (today_count > 0) {
      lines.push(`${today_count} event${today_count === 1 ? "" : "s"} today.`);
    }
  }

  return lines;
}

function renderHeartbeat(
  awareness: Awareness,
  level: "full" | "overdue"
): string[] {
  const lines: string[] = [];
  const { overdue_items, signals } = awareness.heartbeat;

  if (level === "overdue" || level === "full") {
    if (overdue_items.length > 0) {
      const list = overdue_items.map((i) => `${i.id} (${i.title})`).join(", ");
      lines.push(`Overdue: ${list}.`);
    }
  }

  if (level === "full") {
    for (const signal of signals) {
      lines.push(`[${signal.priority}] ${signal.summary}`);
    }
  }

  return lines;
}

// ── Convenience Wrapper ──────────────────────────────────────

/**
 * Convenience wrapper: builds awareness then filters and renders it for the given mode.
 */
export async function renderAwareness(supabase: any, mode: LayeredMode): Promise<string> {
  const awareness = await buildAwareness(supabase);
  return filterAwarenessByMode(awareness, mode);
}
