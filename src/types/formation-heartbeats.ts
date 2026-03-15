/**
 * Formation Heartbeat Scheduler Types — ELLIE-723
 *
 * Types for cron-based formation scheduling, audit trail,
 * and a lightweight cron expression parser.
 *
 * Pure module — types, parsing, and helpers only, no side effects.
 */

// ── Database Types ──────────────────────────────────────────

/** A scheduled formation heartbeat (maps to formation_heartbeats table). */
export interface FormationHeartbeat {
  formation_slug: string;
  created_at: Date;
  updated_at: Date;
  schedule: string;
  facilitator_agent_id: string;
  last_run_at: Date | null;
  next_run_at: Date | null;
  enabled: boolean;
  run_context: Record<string, unknown>;
}

/** A heartbeat run audit record (maps to heartbeat_runs table). */
export interface HeartbeatRun {
  id: string;
  created_at: Date;
  formation_slug: string;
  status: HeartbeatRunStatus;
  started_at: Date;
  completed_at: Date | null;
  duration_ms: number | null;
  formation_session_id: string | null;
  skip_reason: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
}

export type HeartbeatRunStatus = "started" | "completed" | "failed" | "skipped";

/** Valid heartbeat run statuses. */
export const VALID_HEARTBEAT_RUN_STATUSES = [
  "started",
  "completed",
  "failed",
  "skipped",
] as const;

// ── Input Types ─────────────────────────────────────────────

/** Input for creating/updating a heartbeat schedule. */
export interface UpsertHeartbeatInput {
  formation_slug: string;
  schedule: string;
  facilitator_agent_id: string;
  enabled?: boolean;
  run_context?: Record<string, unknown>;
}

/** Result of a scheduler tick — which formations were triggered. */
export interface SchedulerTickResult {
  evaluated: number;
  triggered: string[];
  skipped: { slug: string; reason: string }[];
}

// ── Cron Expression Parser ──────────────────────────────────

/**
 * Parsed 5-field cron expression.
 * Fields: minute, hour, day-of-month, month, day-of-week.
 * Each field is an array of valid integer values.
 */
export interface ParsedCron {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

/** Field ranges for validation. */
const CRON_RANGES: [number, number][] = [
  [0, 59],  // minute
  [0, 23],  // hour
  [1, 31],  // day of month
  [1, 12],  // month
  [0, 6],   // day of week (0=Sun)
];

/**
 * Parse a 5-field cron expression into numeric arrays.
 * Supports: wildcards, numbers, ranges, steps, and comma-separated lists.
 * Throws on invalid expressions.
 */
export function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
  }

  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parts.map((part, i) =>
    parseCronField(part, CRON_RANGES[i][0], CRON_RANGES[i][1]),
  );

  return { minutes, hours, daysOfMonth, months, daysOfWeek };
}

/**
 * Parse a single cron field into an array of valid values.
 */
export function parseCronField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    const rangePart = stepMatch ? stepMatch[1] : part;

    let rangeMin: number;
    let rangeMax: number;

    if (rangePart === "*") {
      rangeMin = min;
      rangeMax = max;
    } else if (rangePart.includes("-")) {
      const [lo, hi] = rangePart.split("-").map(Number);
      if (isNaN(lo) || isNaN(hi) || lo < min || hi > max || lo > hi) {
        throw new Error(`Invalid cron range: ${rangePart} (valid: ${min}-${max})`);
      }
      rangeMin = lo;
      rangeMax = hi;
    } else {
      const n = parseInt(rangePart, 10);
      if (isNaN(n) || n < min || n > max) {
        throw new Error(`Invalid cron value: ${rangePart} (valid: ${min}-${max})`);
      }
      rangeMin = n;
      rangeMax = n;
    }

    if (step < 1) {
      throw new Error(`Invalid cron step: ${step}`);
    }

    for (let v = rangeMin; v <= rangeMax; v += step) {
      values.add(v);
    }
  }

  return Array.from(values).sort((a, b) => a - b);
}

/**
 * Compute the next run time after `after` for a parsed cron expression.
 * Searches forward up to 366 days before giving up.
 *
 * Returns null if no match is found (should not happen for valid crons).
 */
export function nextCronRun(cron: ParsedCron, after: Date): Date | null {
  // Start from the next full minute after `after` (all UTC)
  const d = new Date(after);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);

  const maxIterations = 366 * 24 * 60; // 1 year of minutes
  for (let i = 0; i < maxIterations; i++) {
    const month = d.getUTCMonth() + 1; // 1-indexed
    const dayOfMonth = d.getUTCDate();
    const dayOfWeek = d.getUTCDay(); // 0=Sun
    const hour = d.getUTCHours();
    const minute = d.getUTCMinutes();

    if (
      cron.months.includes(month) &&
      cron.daysOfMonth.includes(dayOfMonth) &&
      cron.daysOfWeek.includes(dayOfWeek) &&
      cron.hours.includes(hour) &&
      cron.minutes.includes(minute)
    ) {
      return new Date(d);
    }

    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }

  return null;
}

/**
 * Check if a given time matches a cron expression.
 */
export function cronMatches(cron: ParsedCron, time: Date): boolean {
  return (
    cron.minutes.includes(time.getUTCMinutes()) &&
    cron.hours.includes(time.getUTCHours()) &&
    cron.daysOfMonth.includes(time.getUTCDate()) &&
    cron.months.includes(time.getUTCMonth() + 1) &&
    cron.daysOfWeek.includes(time.getUTCDay())
  );
}
