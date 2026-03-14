/**
 * ELLIE-715: Agent Progress Checkpoint Types
 *
 * Defines the data model for time-based progress checkpoints.
 * Checkpoints fire at configurable intervals (default 25/50/75% of estimated duration)
 * and capture a snapshot of what's done, what's next, and any blockers.
 *
 * Storage: checkpoint reports are stored as work_session_updates rows
 * with update_type = 'checkpoint' and the CheckpointReport in the details JSONB field.
 */

/** Configuration for time-based progress checkpoints. */
export interface CheckpointConfig {
  /** Whether checkpoints are enabled. Default: true. Set false for exploratory tasks. */
  enabled: boolean;
  /** Percentage intervals to fire checkpoints at. Default: [25, 50, 75]. */
  intervals: number[];
}

/** Report generated at each checkpoint, stored in work_session_updates.details. */
export interface CheckpointReport {
  /** Checkpoint percentage (e.g. 25, 50, 75). */
  percent: number;
  /** Minutes elapsed since session start. */
  elapsed_minutes: number;
  /** Estimated total minutes for the task. */
  estimated_total_minutes: number;
  /** What's been accomplished so far (from working memory task_stack / conversation_thread). */
  done: string;
  /** What's planned next. */
  next: string;
  /** Any blockers or issues. Empty string if none. */
  blockers: string;
  /** Agent turn count at checkpoint time (from working memory turn_number). */
  turn_count?: number;
}

/**
 * Timer state for an active checkpoint schedule.
 * Managed by the relay — one per active work session with checkpoints enabled.
 */
export interface CheckpointTimerState {
  /** Work session ID (references work_sessions.session_id). */
  session_id: string;
  /** Plane ticket ID (e.g. ELLIE-715). */
  work_item_id: string;
  /** Agent name running the session. */
  agent: string;
  /** Session start timestamp. */
  started_at: Date;
  /** Estimated duration in minutes. */
  estimated_duration_minutes: number;
  /** Intervals that have already fired (e.g. [25] after 25% checkpoint). */
  fired: number[];
  /** Intervals still pending (e.g. [50, 75] after 25% fires). */
  remaining: number[];
  /** Node.js timer IDs for cancellation on session end. */
  timer_ids: ReturnType<typeof setTimeout>[];
}

/** Default checkpoint config applied when none is specified. */
export const DEFAULT_CHECKPOINT_CONFIG: CheckpointConfig = {
  enabled: true,
  intervals: [25, 50, 75],
};

/** Default estimated duration when no estimate is provided (minutes). */
export const DEFAULT_ESTIMATED_DURATION_MINUTES = 60;
