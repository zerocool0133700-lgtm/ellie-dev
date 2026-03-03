/**
 * Jobs Ledger — ELLIE-438/439
 *
 * Persistent job tracking: creation, progress, completion, metrics.
 * Extends the orchestration system with step-level detail, cost accounting,
 * and sub-job hierarchy (pipeline / fan-out / critic-loop).
 */

import { log } from "./logger.ts";
import postgres from "postgres";

const logger = log.child("jobs-ledger");

let _db: ReturnType<typeof postgres> | null = null;
function db() {
  if (!_db) {
    _db = postgres({ host: "/var/run/postgresql", database: "ellie-forest", username: "ellie" });
  }
  return _db;
}

// ── Types ──────────────────────────────────────────────────────────────────

export type JobType = "dispatch" | "pipeline" | "fan-out" | "critic-loop";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Job {
  job_id: string;
  type: JobType;
  status: JobStatus;
  source: string | null;
  parent_job_id: string | null;
  work_item_id: string | null;
  agent_type: string | null;
  model: string | null;
  prompt_summary: string | null;
  tools_enabled: string[] | null;
  input_data: Record<string, unknown>;
  result: Record<string, unknown>;
  completed_steps: number;
  current_step: string | null;
  last_heartbeat: string | null;
  total_duration_ms: number | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: string;
  retry_count: number;
  error_count: number;
  run_id: string | null;
  tree_id: string | null;
  creature_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobEvent {
  event_id: string;
  job_id: string;
  event: string;
  step_name: string | null;
  details: Record<string, unknown>;
  duration_ms: number | null;
  created_at: string;
}

export interface CreateJobOpts {
  type?: JobType;
  source?: string;
  parent_job_id?: string;
  work_item_id?: string;
  agent_type?: string;
  model?: string;
  prompt_summary?: string;
  tools_enabled?: string[];
  input_data?: Record<string, unknown>;
  run_id?: string;
  tree_id?: string;
  creature_id?: string;
}

export interface UpdateJobOpts {
  status?: JobStatus;
  current_step?: string | null;
  completed_steps?: number;
  last_heartbeat?: Date;
  total_duration_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  retry_count?: number;
  error_count?: number;
  result?: Record<string, unknown>;
  model?: string;
  tree_id?: string;
  creature_id?: string;
}

export interface JobFilters {
  status?: JobStatus;
  type?: JobType;
  agent_type?: string;
  parent_job_id?: string | null;
  work_item_id?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export interface JobMetrics {
  total: number;
  completed: number;
  failed: number;
  running: number;
  success_rate: number;
  avg_duration_ms: number | null;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: string;
  by_agent: Array<{ agent_type: string; count: number; success_rate: number; avg_duration_ms: number | null }>;
  by_type: Array<{ type: string; count: number }>;
}

// ── Core Operations ────────────────────────────────────────────────────────

export async function createJob(opts: CreateJobOpts): Promise<string> {
  try {
    const [row] = await db()`
      INSERT INTO jobs (
        type, source, parent_job_id, work_item_id, agent_type, model,
        prompt_summary, tools_enabled, input_data, run_id, tree_id, creature_id,
        status, last_heartbeat
      ) VALUES (
        ${opts.type ?? "dispatch"}, ${opts.source ?? null}, ${opts.parent_job_id ?? null},
        ${opts.work_item_id ?? null}, ${opts.agent_type ?? null}, ${opts.model ?? null},
        ${opts.prompt_summary ?? null}, ${opts.tools_enabled ?? null},
        ${JSON.stringify(opts.input_data ?? {})}, ${opts.run_id ?? null},
        ${opts.tree_id ?? null}, ${opts.creature_id ?? null},
        'queued', now()
      )
      RETURNING job_id
    `;
    await appendJobEvent(row.job_id, "created", { source: opts.source, agent_type: opts.agent_type });
    return row.job_id;
  } catch (err: unknown) {
    logger.error("createJob failed", err);
    throw err;
  }
}

export async function updateJob(jobId: string, update: UpdateJobOpts): Promise<void> {
  try {
    // Build a plain object of only the fields that were provided.
    // postgres.js db(obj) generates a safe parameterised SET clause — no unsafe().
    const fields: Record<string, unknown> = {};
    if (update.current_step    !== undefined) fields.current_step    = update.current_step;
    if (update.completed_steps !== undefined) fields.completed_steps = update.completed_steps;
    if (update.last_heartbeat  !== undefined) fields.last_heartbeat  = update.last_heartbeat;
    if (update.total_duration_ms !== undefined) fields.total_duration_ms = update.total_duration_ms;
    if (update.tokens_in       !== undefined) fields.tokens_in       = update.tokens_in;
    if (update.tokens_out      !== undefined) fields.tokens_out      = update.tokens_out;
    if (update.cost_usd        !== undefined) fields.cost_usd        = update.cost_usd;
    if (update.retry_count     !== undefined) fields.retry_count     = update.retry_count;
    if (update.error_count     !== undefined) fields.error_count     = update.error_count;
    if (update.result          !== undefined) fields.result          = JSON.stringify(update.result);
    if (update.model           !== undefined) fields.model           = update.model;
    if (update.tree_id         !== undefined) fields.tree_id         = update.tree_id;
    if (update.creature_id     !== undefined) fields.creature_id     = update.creature_id;

    // status requires an explicit cast — handle separately so the SET clause
    // still uses parameterised values throughout.
    if (!Object.keys(fields).length && update.status === undefined) return;

    if (update.status !== undefined) {
      await db()`
        UPDATE jobs
        SET ${db(fields).length ? db()`${db(fields)},` : db()``}
            status = ${update.status}::job_status
        WHERE job_id = ${jobId}
      `;
    } else {
      await db()`UPDATE jobs SET ${db(fields)} WHERE job_id = ${jobId}`;
    }
  } catch (err: unknown) {
    logger.error("updateJob failed", { jobId, err });
  }
}

export async function appendJobEvent(
  jobId: string,
  event: string,
  details?: Record<string, unknown>,
  opts?: { step_name?: string; duration_ms?: number },
): Promise<void> {
  try {
    await db()`
      INSERT INTO job_events (job_id, event, step_name, details, duration_ms)
      VALUES (${jobId}, ${event}, ${opts?.step_name ?? null},
              ${JSON.stringify(details ?? {})}, ${opts?.duration_ms ?? null})
    `;
  } catch (err: unknown) {
    logger.error("appendJobEvent failed", { jobId, event, err });
  }
}

// ── Queries ────────────────────────────────────────────────────────────────

export async function findJobByRunId(runId: string): Promise<Job | null> {
  try {
    const [job] = await db()`SELECT * FROM jobs WHERE run_id = ${runId} LIMIT 1`;
    return (job as Job) ?? null;
  } catch {
    return null;
  }
}

export async function getJob(jobId: string): Promise<{
  job: Job;
  events: JobEvent[];
  sub_jobs: Job[];
} | null> {
  try {
    const [job] = await db()`SELECT * FROM jobs WHERE job_id = ${jobId}`;
    if (!job) return null;
    const events = await db()`SELECT * FROM job_events WHERE job_id = ${jobId} ORDER BY created_at`;
    const sub_jobs = await db()`SELECT * FROM jobs WHERE parent_job_id = ${jobId} ORDER BY created_at`;
    return { job: job as Job, events: events as JobEvent[], sub_jobs: sub_jobs as Job[] };
  } catch (err: unknown) {
    logger.error("getJob failed", { jobId, err });
    return null;
  }
}

export async function listJobs(filters: JobFilters = {}): Promise<Job[]> {
  try {
    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = filters.offset ?? 0;

    const rows = await db()`
      SELECT * FROM jobs
      WHERE 1=1
        ${filters.status ? db()`AND status = ${filters.status}::job_status` : db()``}
        ${filters.type ? db()`AND type = ${filters.type}::job_type` : db()``}
        ${filters.agent_type ? db()`AND agent_type = ${filters.agent_type}` : db()``}
        ${filters.work_item_id ? db()`AND work_item_id = ${filters.work_item_id}` : db()``}
        ${filters.parent_job_id !== undefined
          ? filters.parent_job_id === null
            ? db()`AND parent_job_id IS NULL`
            : db()`AND parent_job_id = ${filters.parent_job_id}`
          : db()``}
        ${filters.since ? db()`AND created_at >= ${filters.since}` : db()``}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows as Job[];
  } catch (err: unknown) {
    logger.error("listJobs failed", err);
    return [];
  }
}

export async function getJobMetrics(since?: string): Promise<JobMetrics> {
  try {
    const sinceClause = since
      ? db()`AND created_at >= ${since}`
      : db()``;

    const [totals] = await db()`
      SELECT
        COUNT(*)::int                                                  AS total,
        COUNT(*) FILTER (WHERE status = 'completed')::int             AS completed,
        COUNT(*) FILTER (WHERE status = 'failed')::int                AS failed,
        COUNT(*) FILTER (WHERE status = 'running')::int               AS running,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE status = 'completed') /
          NULLIF(COUNT(*) FILTER (WHERE status IN ('completed','failed')), 0),
          1
        )                                                              AS success_rate,
        ROUND(AVG(total_duration_ms) FILTER (WHERE status = 'completed'))::bigint
                                                                       AS avg_duration_ms,
        COALESCE(SUM(tokens_in),   0)::int                            AS total_tokens_in,
        COALESCE(SUM(tokens_out),  0)::int                            AS total_tokens_out,
        COALESCE(SUM(cost_usd), 0)::numeric(10,4)                     AS total_cost_usd
      FROM jobs WHERE 1=1 ${sinceClause}
    `;

    const by_agent = await db()`
      SELECT
        agent_type,
        COUNT(*)::int AS count,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE status = 'completed') /
          NULLIF(COUNT(*) FILTER (WHERE status IN ('completed','failed')), 0),
          1
        ) AS success_rate,
        ROUND(AVG(total_duration_ms) FILTER (WHERE status = 'completed'))::bigint AS avg_duration_ms
      FROM jobs
      WHERE agent_type IS NOT NULL ${sinceClause}
      GROUP BY agent_type
      ORDER BY count DESC
    `;

    const by_type = await db()`
      SELECT type, COUNT(*)::int AS count
      FROM jobs WHERE 1=1 ${sinceClause}
      GROUP BY type ORDER BY count DESC
    `;

    return {
      total: totals.total ?? 0,
      completed: totals.completed ?? 0,
      failed: totals.failed ?? 0,
      running: totals.running ?? 0,
      success_rate: Number(totals.success_rate ?? 0),
      avg_duration_ms: totals.avg_duration_ms ? Number(totals.avg_duration_ms) : null,
      total_tokens_in: totals.total_tokens_in ?? 0,
      total_tokens_out: totals.total_tokens_out ?? 0,
      total_cost_usd: String(totals.total_cost_usd ?? "0"),
      by_agent: by_agent as JobMetrics["by_agent"],
      by_type: by_type as JobMetrics["by_type"],
    };
  } catch (err: unknown) {
    logger.error("getJobMetrics failed", err);
    return {
      total: 0, completed: 0, failed: 0, running: 0,
      success_rate: 0, avg_duration_ms: null,
      total_tokens_in: 0, total_tokens_out: 0, total_cost_usd: "0",
      by_agent: [], by_type: [],
    };
  }
}
