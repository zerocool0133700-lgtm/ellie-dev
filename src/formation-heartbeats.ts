/**
 * Formation Heartbeat Scheduler — ELLIE-723
 *
 * Allows formations to run on a cron schedule without manual invocation.
 * Integrates with atomic checkout (ELLIE-721) to prevent overlapping runs.
 *
 * Database functions module — uses postgres.js via ellie-forest.
 */

import { sql } from "../../ellie-forest/src/index";
import {
  parseCron,
  nextCronRun,
  type FormationHeartbeat,
  type HeartbeatRun,
  type HeartbeatRunStatus,
  type UpsertHeartbeatInput,
  type SchedulerTickResult,
} from "./types/formation-heartbeats";

// ── CRUD ────────────────────────────────────────────────────

/**
 * Create or update a heartbeat schedule.
 * Computes next_run_at from the cron expression.
 */
export async function upsertHeartbeat(
  input: UpsertHeartbeatInput,
): Promise<FormationHeartbeat> {
  const cron = parseCron(input.schedule);
  const nextRun = nextCronRun(cron, new Date());

  const [hb] = await sql<FormationHeartbeat[]>`
    INSERT INTO formation_heartbeats (
      formation_slug, schedule, facilitator_agent_id, enabled,
      run_context, next_run_at
    )
    VALUES (
      ${input.formation_slug},
      ${input.schedule},
      ${input.facilitator_agent_id}::uuid,
      ${input.enabled ?? true},
      ${sql.json(input.run_context ?? {})},
      ${nextRun ? nextRun.toISOString() : null}::timestamptz
    )
    ON CONFLICT (formation_slug) DO UPDATE SET
      schedule = ${input.schedule},
      facilitator_agent_id = ${input.facilitator_agent_id}::uuid,
      enabled = ${input.enabled ?? true},
      run_context = ${sql.json(input.run_context ?? {})},
      next_run_at = ${nextRun ? nextRun.toISOString() : null}::timestamptz,
      updated_at = NOW()
    RETURNING *
  `;

  return hb;
}

/**
 * Get a heartbeat by formation slug.
 */
export async function getHeartbeat(slug: string): Promise<FormationHeartbeat | null> {
  const [hb] = await sql<FormationHeartbeat[]>`
    SELECT * FROM formation_heartbeats WHERE formation_slug = ${slug}
  `;
  return hb ?? null;
}

/**
 * List all heartbeats, optionally filtering by enabled status.
 */
export async function listHeartbeats(
  opts: { enabledOnly?: boolean } = {},
): Promise<FormationHeartbeat[]> {
  if (opts.enabledOnly) {
    return sql<FormationHeartbeat[]>`
      SELECT * FROM formation_heartbeats
      WHERE enabled = true
      ORDER BY next_run_at ASC NULLS LAST
    `;
  }
  return sql<FormationHeartbeat[]>`
    SELECT * FROM formation_heartbeats
    ORDER BY formation_slug ASC
  `;
}

/**
 * Enable or disable a heartbeat.
 */
export async function setHeartbeatEnabled(
  slug: string,
  enabled: boolean,
): Promise<FormationHeartbeat | null> {
  const [hb] = await sql<FormationHeartbeat[]>`
    UPDATE formation_heartbeats
    SET enabled = ${enabled}, updated_at = NOW()
    WHERE formation_slug = ${slug}
    RETURNING *
  `;
  return hb ?? null;
}

/**
 * Delete a heartbeat schedule.
 */
export async function deleteHeartbeat(slug: string): Promise<boolean> {
  const rows = await sql`
    DELETE FROM formation_heartbeats
    WHERE formation_slug = ${slug}
    RETURNING formation_slug
  `;
  return rows.length > 0;
}

// ── Scheduler Tick ──────────────────────────────────────────

/**
 * Evaluate all enabled heartbeats and return which ones are due.
 * Does NOT trigger them — that's the caller's responsibility
 * (so the caller can integrate with atomic checkout).
 *
 * A heartbeat is due when: enabled=true AND next_run_at <= now.
 */
export async function getDueHeartbeats(
  now?: Date,
): Promise<FormationHeartbeat[]> {
  const asOf = now ?? new Date();

  return sql<FormationHeartbeat[]>`
    SELECT * FROM formation_heartbeats
    WHERE enabled = true
      AND next_run_at IS NOT NULL
      AND next_run_at <= ${asOf.toISOString()}::timestamptz
    ORDER BY next_run_at ASC
  `;
}

/**
 * Run a single scheduler tick: find due heartbeats, mark them as running,
 * and advance next_run_at. Returns a tick result describing what happened.
 *
 * The `triggerFn` callback is called for each due heartbeat. It should
 * create a formation session (using atomic checkout) and return the
 * session ID on success, or null if checkout failed (overlapping run).
 */
export async function schedulerTick(
  triggerFn: (hb: FormationHeartbeat) => Promise<string | null>,
  now?: Date,
): Promise<SchedulerTickResult> {
  const asOf = now ?? new Date();
  const due = await getDueHeartbeats(asOf);

  const result: SchedulerTickResult = {
    evaluated: due.length,
    triggered: [],
    skipped: [],
  };

  for (const hb of due) {
    // Record the run start
    const [run] = await sql<HeartbeatRun[]>`
      INSERT INTO heartbeat_runs (formation_slug, status, started_at)
      VALUES (${hb.formation_slug}, 'started', ${asOf.toISOString()}::timestamptz)
      RETURNING *
    `;

    let sessionId: string | null = null;
    try {
      sessionId = await triggerFn(hb);
    } catch (err) {
      // Trigger failed — log as failed run
      const errorMsg = err instanceof Error ? err.message : String(err);
      await completeRun(run.id, "failed", null, errorMsg);
      result.skipped.push({ slug: hb.formation_slug, reason: `trigger error: ${errorMsg}` });
      // Still advance next_run_at to avoid retry loops
      await advanceNextRun(hb.formation_slug, hb.schedule, asOf);
      continue;
    }

    if (sessionId === null) {
      // Checkout failed — overlapping run, log as skipped
      await completeRun(run.id, "skipped", null, null, "overlapping run (checkout failed)");
      result.skipped.push({ slug: hb.formation_slug, reason: "overlapping run" });
      // Don't advance next_run_at — retry next tick
      continue;
    }

    // Success — update the run record and advance schedule
    await completeRun(run.id, "completed", sessionId);
    await advanceNextRun(hb.formation_slug, hb.schedule, asOf);
    result.triggered.push(hb.formation_slug);
  }

  return result;
}

// ── Run Completion ──────────────────────────────────────────

/**
 * Complete a heartbeat run with final status.
 */
async function completeRun(
  runId: string,
  status: HeartbeatRunStatus,
  sessionId: string | null,
  error?: string | null,
  skipReason?: string | null,
): Promise<void> {
  await sql`
    UPDATE heartbeat_runs
    SET
      status = ${status},
      completed_at = NOW(),
      duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at))::int * 1000,
      formation_session_id = ${sessionId ?? null}::uuid,
      error = ${error ?? null},
      skip_reason = ${skipReason ?? null}
    WHERE id = ${runId}::uuid
  `;
}

/**
 * Advance a heartbeat's next_run_at and update last_run_at.
 */
async function advanceNextRun(
  slug: string,
  schedule: string,
  lastRun: Date,
): Promise<void> {
  const cron = parseCron(schedule);
  const nextRun = nextCronRun(cron, lastRun);

  await sql`
    UPDATE formation_heartbeats
    SET
      last_run_at = ${lastRun.toISOString()}::timestamptz,
      next_run_at = ${nextRun ? nextRun.toISOString() : null}::timestamptz,
      updated_at = NOW()
    WHERE formation_slug = ${slug}
  `;
}

// ── Audit Trail Queries ─────────────────────────────────────

/**
 * Get recent heartbeat runs for a formation.
 */
export async function getHeartbeatRuns(
  slug: string,
  limit: number = 20,
): Promise<HeartbeatRun[]> {
  return sql<HeartbeatRun[]>`
    SELECT * FROM heartbeat_runs
    WHERE formation_slug = ${slug}
    ORDER BY started_at DESC
    LIMIT ${limit}
  `;
}

/**
 * Get the last run for a formation.
 */
export async function getLastRun(slug: string): Promise<HeartbeatRun | null> {
  const [run] = await sql<HeartbeatRun[]>`
    SELECT * FROM heartbeat_runs
    WHERE formation_slug = ${slug}
    ORDER BY started_at DESC
    LIMIT 1
  `;
  return run ?? null;
}

/**
 * Get runs by status across all formations.
 */
export async function getRunsByStatus(
  status: HeartbeatRunStatus,
  limit: number = 50,
): Promise<HeartbeatRun[]> {
  return sql<HeartbeatRun[]>`
    SELECT * FROM heartbeat_runs
    WHERE status = ${status}
    ORDER BY started_at DESC
    LIMIT ${limit}
  `;
}
