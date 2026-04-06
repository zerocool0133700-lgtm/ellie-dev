// src/prompt-layers/types.ts
/**
 * Shared types for the layered prompt architecture.
 * See spec: docs/superpowers/specs/2026-04-06-layered-prompt-architecture-design.md
 */

// ── Conversation Modes ──────────────────────────────────────

/** Extended mode set — adds voice-casual, personal, heartbeat to existing context-mode.ts modes */
export type LayeredMode = "voice-casual" | "dev-session" | "planning" | "personal" | "heartbeat";

// ── Layer 1: Identity ───────────────────────────────────────

export interface IdentityBlock {
  soul: string;
  identity: string;
  user: string;
  relationship: string;
  skillSummary: string;
}

export interface SkillRegistryEntry {
  name: string;
  triggers: string[];
  file: string;
  description: string;
}

// ── Layer 2: Awareness ──────────────────────────────────────

export interface WorkItemSummary {
  id: string;
  title: string;
  priority: string;
  state: string;
}

export interface SessionSummary {
  work_item_id: string;
  title: string;
  completed_at: string;
  summary: string;
}

export interface ConversationSummary {
  id: string;
  topic: string;
  agent: string;
  last_message_at: string;
}

export interface ThreadSummary {
  id: string;
  agent: string;
  topic: string;
  last_message_at: string;
  stale: boolean;
}

export interface IncidentSummary {
  id: string;
  severity: string;
  title: string;
}

export interface AgentStatusEntry {
  name: string;
  status: "active" | "idle";
  current_task?: string;
}

export interface CreatureStatusEntry {
  id: string;
  species: string;
  state: string;
  agent: string;
}

export interface CalendarEventSummary {
  title: string;
  start: string;
  end: string;
}

export interface HeartbeatSignal {
  type: "overdue" | "stale_thread" | "incident" | "custom";
  summary: string;
  priority: "high" | "medium" | "low";
}

export interface Awareness {
  work: {
    active_items: WorkItemSummary[];
    recent_sessions: SessionSummary[];
    blocked_items: WorkItemSummary[];
  };
  conversations: {
    last_conversation: ConversationSummary | null;
    open_threads: ThreadSummary[];
  };
  system: {
    incidents: IncidentSummary[];
    agent_status: AgentStatusEntry[];
    creatures: CreatureStatusEntry[];
  };
  calendar: {
    next_event: CalendarEventSummary | null;
    today_count: number;
  };
  heartbeat: {
    overdue_items: WorkItemSummary[];
    stale_threads: ThreadSummary[];
    signals: HeartbeatSignal[];
  };
}

/** Declares which awareness sections each mode receives */
export interface ModeAwarenessFilter {
  work: "full" | "overdue_blocked" | "none";
  conversations: "full" | "last_only" | "open_threads" | "stale_threads" | "none";
  system: "full" | "incidents_only" | "agent_status" | "none";
  calendar: "full" | "next_only" | "count_only" | "none";
  heartbeat: "full" | "overdue" | "none";
}

// ── Layer 3: Knowledge ──────────────────────────────────────

export interface KnowledgeResult {
  skillDocs: string;       // loaded SKILL.md content (Channel A)
  forestKnowledge: string; // retrieved memories (Channel B)
  expansion: string;       // contextual expansion (Channel C)
}

// ── Orchestration ───────────────────────────────────────────

export interface LayeredPromptResult {
  identity: string;        // rendered Layer 1
  awareness: string;       // rendered Layer 2
  knowledge: string;       // rendered Layer 3
  mode: LayeredMode;
  totalBytes: number;
}
