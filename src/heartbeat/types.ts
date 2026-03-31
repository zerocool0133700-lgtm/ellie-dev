/**
 * Coordinator Heartbeat — Shared Types (ELLIE-1164)
 */

export type HeartbeatSource = "email" | "ci" | "plane" | "calendar" | "forest" | "gtd";

export interface SourceDelta {
  source: HeartbeatSource;
  changed: boolean;
  summary: string;
  count: number;
  details?: unknown;
  error?: string;
}

export interface HeartbeatSnapshot {
  email_unread_count: number;
  ci_run_ids: string[];
  plane_last_updated_at: string;
  calendar_event_ids: string[];
  forest_branch_ids: string[];
  gtd_open_count: number;
  gtd_overdue_ids: string[];
  gtd_completed_ids: string[];
  captured_at: string;
}

export interface HeartbeatConfig {
  enabled: boolean;
  interval_ms: number;
  active_start: string;
  active_end: string;
  sources: HeartbeatSource[];
  startup_grace_ms: number;
  min_phase2_interval_ms: number;
}

export interface HeartbeatState extends HeartbeatConfig {
  last_tick_at: string | null;
  last_phase2_at: string | null;
  last_snapshot: HeartbeatSnapshot | null;
  source_cooldowns: Record<string, string>;
  consecutive_skips: number;
}

export interface TickRecord {
  phase_reached: 1 | 2;
  deltas: SourceDelta[];
  actions_taken?: unknown;
  cost_usd: number;
  duration_ms: number;
  foundation: string;
  skipped_reason?: string;
}
