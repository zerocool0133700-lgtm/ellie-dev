/**
 * Session Spawn Types — ELLIE-942
 *
 * Types for sub-agent session spawning with thread binding,
 * memory arc assignment, and cost rollup.
 */

// ── Spawn Options ───────────────────────────────────────────

/** How the child session inherits or forks the parent's memory arc. */
export type ArcMode = "inherit" | "fork";

/** Delivery context captured at spawn time for result announcement. */
export interface DeliveryContext {
  channel: string;
  chatId?: number | string;
  threadId?: string;
  webhookId?: string;
  webhookToken?: string;
  guildId?: string;
}

/** Options for spawning a sub-agent session. */
export interface SpawnOpts {
  /** Parent session ID — the session requesting the spawn. */
  parentSessionId: string;
  /** Parent agent name — used for cost attribution. */
  parentAgentName: string;
  /** Target agent name to spawn. */
  targetAgentName: string;
  /** Task instruction for the child. */
  task: string;
  /** Channel the parent is operating in. */
  channel: string;
  /** User ID that owns both sessions. */
  userId: string;
  /** Work item ID (ticket) — shared between parent and child. */
  workItemId?: string;
  /** Memory arc mode: "inherit" joins parent arc, "fork" creates a child arc. */
  arcMode?: ArcMode;
  /** Parent's memory arc ID (if arc mode is relevant). */
  parentArcId?: string;
  /** Delivery context for result announcement. */
  deliveryContext?: DeliveryContext;
  /** Whether the child should bind to the parent's thread. */
  threadBind?: boolean;
  /** Optional timeout in seconds for the child session. */
  timeoutSeconds?: number;
}

// ── Spawn Records ───────────────────────────────────────────

/** State of a spawned sub-agent session. */
export type SpawnState = "pending" | "running" | "completed" | "failed" | "timed_out";

/** Registry record for a spawned sub-agent session. */
export interface SpawnRecord {
  /** Unique ID for this spawn. */
  id: string;
  /** Parent session ID. */
  parentSessionId: string;
  /** Parent agent name. */
  parentAgentName: string;
  /** Child session ID (set once dispatched). */
  childSessionId: string;
  /** Child session key (composite: agent:targetAgent:subagent:uuid). */
  childSessionKey: string;
  /** Target agent that was spawned. */
  targetAgentName: string;
  /** Task assigned to the child. */
  task: string;
  /** Current state of the spawn. */
  state: SpawnState;
  /** Arc mode chosen at spawn time. */
  arcMode: ArcMode;
  /** Memory arc ID the child is writing to. */
  arcId: string | null;
  /** Delivery context captured from parent. */
  deliveryContext: DeliveryContext | null;
  /** Whether thread binding is active. */
  threadBound: boolean;
  /** Work item context. */
  workItemId: string | null;
  /** When the spawn was created. */
  createdAt: number;
  /** When the child completed (if done). */
  endedAt: number | null;
  /** Completion result text from child (if any). */
  resultText: string | null;
  /** Error message (if failed). */
  error: string | null;
  /** Timeout threshold. */
  timeoutSeconds: number;
}

// ── Spawn Result ────────────────────────────────────────────

/** Result returned to the parent after spawning. */
export interface SpawnResult {
  /** Whether the spawn was accepted. */
  success: boolean;
  /** The spawn record ID. */
  spawnId: string;
  /** The child session key. */
  childSessionKey: string;
  /** Error message if spawn failed. */
  error?: string;
}

// ── Announcement ────────────────────────────────────────────

/** Payload sent back to the parent when a child completes. */
export interface SpawnAnnouncement {
  spawnId: string;
  childSessionKey: string;
  targetAgentName: string;
  state: SpawnState;
  resultText: string | null;
  error: string | null;
  costCents: number;
  durationMs: number;
}

// ── Cost Rollup ─────────────────────────────────────────────

/** Aggregated cost for all children of a parent session. */
export interface SpawnCostRollup {
  parentSessionId: string;
  totalCostCents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  childCount: number;
  children: Array<{
    spawnId: string;
    targetAgentName: string;
    costCents: number;
    inputTokens: number;
    outputTokens: number;
  }>;
}
