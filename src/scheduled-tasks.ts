/**
 * Scheduled Tasks — ELLIE-975/976
 *
 * General-purpose user-configurable cron scheduler.
 * Stores schedules in Forest DB, evaluates them on a periodic tick,
 * and dispatches work based on task_type + config.
 *
 * Task types:
 *   formation  — invoke a formation by slug
 *   dispatch   — dispatch to an agent via orchestration-dispatch
 *   http       — POST to an internal relay endpoint
 *   reminder   — send a notification to Dave
 */

import { log } from "./logger.ts";
import {
  parseCron,
  nextCronRun,
  type ParsedCron,
} from "./types/formation-heartbeats";

const logger = log.child("scheduled-tasks");

// ── Types ────────────────────────────────────────────────────

export type TaskType = "formation" | "dispatch" | "http" | "reminder";
export type RunStatus = "started" | "completed" | "failed" | "skipped";

export interface ScheduledTask {
  id: string;
  created_at: Date;
  updated_at: Date;
  name: string;
  description: string;
  task_type: TaskType;
  schedule: string;
  timezone: string;
  enabled: boolean;
  config: Record<string, unknown>;
  last_run_at: Date | null;
  next_run_at: Date | null;
  last_status: RunStatus | null;
  last_error: string | null;
  consecutive_failures: number;
  created_by: string | null;
}

export interface ScheduledTaskRun {
  id: string;
  created_at: Date;
  task_id: string;
  status: RunStatus;
  started_at: Date;
  completed_at: Date | null;
  duration_ms: number | null;
  error: string | null;
  result: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface CreateTaskInput {
  name: string;
  description?: string;
  task_type: TaskType;
  schedule: string;
  timezone?: string;
  enabled?: boolean;
  config: Record<string, unknown>;
  created_by?: string;
}

export interface UpdateTaskInput {
  name?: string;
  description?: string;
  schedule?: string;
  timezone?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface TickResult {
  evaluated: number;
  triggered: string[];
  skipped: { id: string; name: string; reason: string }[];
  failed: { id: string; name: string; error: string }[];
}

// ── Validation ───────────────────────────────────────────────

const VALID_TASK_TYPES: TaskType[] = ["formation", "dispatch", "http", "reminder"];
const MAX_CONSECUTIVE_FAILURES = 5;

export function validateTaskInput(input: CreateTaskInput): string | null {
  if (!input.name?.trim()) return "name is required";
  if (!VALID_TASK_TYPES.includes(input.task_type)) return `invalid task_type: ${input.task_type}`;
  try {
    parseCron(input.schedule);
  } catch (err) {
    return `invalid schedule: ${err instanceof Error ? err.message : String(err)}`;
  }
  return validateConfig(input.task_type, input.config);
}

export function validateConfig(taskType: TaskType, config: Record<string, unknown>): string | null {
  switch (taskType) {
    case "formation":
      if (!config.formation_slug || typeof config.formation_slug !== "string")
        return "formation tasks require config.formation_slug";
      break;
    case "dispatch":
      if (!config.agent || typeof config.agent !== "string")
        return "dispatch tasks require config.agent";
      if (!config.prompt || typeof config.prompt !== "string")
        return "dispatch tasks require config.prompt";
      break;
    case "http":
      if (!config.endpoint || typeof config.endpoint !== "string")
        return "http tasks require config.endpoint";
      break;
    case "reminder":
      if (!config.message || typeof config.message !== "string")
        return "reminder tasks require config.message";
      break;
  }
  return null;
}

// ── Database Operations ──────────────────────────────────────

let _sql: ReturnType<typeof import("postgres").default> | null = null;

async function getSql() {
  if (_sql) return _sql;
  const { sql } = await import("../../ellie-forest/src/index");
  _sql = sql;
  return sql;
}

export async function createTask(input: CreateTaskInput): Promise<ScheduledTask> {
  const sql = await getSql();
  const cron = parseCron(input.schedule);
  const nextRun = nextCronRun(cron, new Date());

  const [task] = await sql<ScheduledTask[]>`
    INSERT INTO scheduled_tasks (
      name, description, task_type, schedule, timezone, enabled,
      config, next_run_at, created_by
    )
    VALUES (
      ${input.name},
      ${input.description ?? ""},
      ${input.task_type},
      ${input.schedule},
      ${input.timezone ?? "America/Chicago"},
      ${input.enabled ?? true},
      ${sql.json(input.config)},
      ${nextRun ? nextRun.toISOString() : null}::timestamptz,
      ${input.created_by ?? null}
    )
    RETURNING *
  `;
  return task;
}

export async function getTask(id: string): Promise<ScheduledTask | null> {
  const sql = await getSql();
  const [task] = await sql<ScheduledTask[]>`
    SELECT * FROM scheduled_tasks WHERE id = ${id}::uuid
  `;
  return task ?? null;
}

export async function listTasks(opts: { enabledOnly?: boolean; taskType?: TaskType } = {}): Promise<ScheduledTask[]> {
  const sql = await getSql();
  if (opts.enabledOnly && opts.taskType) {
    return sql<ScheduledTask[]>`
      SELECT * FROM scheduled_tasks
      WHERE enabled = true AND task_type = ${opts.taskType}
      ORDER BY next_run_at ASC NULLS LAST
    `;
  }
  if (opts.enabledOnly) {
    return sql<ScheduledTask[]>`
      SELECT * FROM scheduled_tasks
      WHERE enabled = true
      ORDER BY next_run_at ASC NULLS LAST
    `;
  }
  if (opts.taskType) {
    return sql<ScheduledTask[]>`
      SELECT * FROM scheduled_tasks
      WHERE task_type = ${opts.taskType}
      ORDER BY name ASC
    `;
  }
  return sql<ScheduledTask[]>`
    SELECT * FROM scheduled_tasks ORDER BY name ASC
  `;
}

export async function updateTask(id: string, input: UpdateTaskInput): Promise<ScheduledTask | null> {
  const sql = await getSql();
  const existing = await getTask(id);
  if (!existing) return null;

  const newSchedule = input.schedule ?? existing.schedule;
  let nextRun = existing.next_run_at;
  if (input.schedule) {
    const cron = parseCron(input.schedule);
    nextRun = nextCronRun(cron, new Date());
  }

  const [task] = await sql<ScheduledTask[]>`
    UPDATE scheduled_tasks SET
      name = ${input.name ?? existing.name},
      description = ${input.description ?? existing.description},
      schedule = ${newSchedule},
      timezone = ${input.timezone ?? existing.timezone},
      enabled = ${input.enabled ?? existing.enabled},
      config = ${sql.json(input.config ?? existing.config)},
      next_run_at = ${nextRun ? (nextRun instanceof Date ? nextRun.toISOString() : nextRun) : null}::timestamptz,
      updated_at = NOW()
    WHERE id = ${id}::uuid
    RETURNING *
  `;
  return task ?? null;
}

export async function deleteTask(id: string): Promise<boolean> {
  const sql = await getSql();
  const rows = await sql`
    DELETE FROM scheduled_tasks WHERE id = ${id}::uuid RETURNING id
  `;
  return rows.length > 0;
}

export async function setTaskEnabled(id: string, enabled: boolean): Promise<ScheduledTask | null> {
  const sql = await getSql();
  const [task] = await sql<ScheduledTask[]>`
    UPDATE scheduled_tasks
    SET enabled = ${enabled}, updated_at = NOW()
    WHERE id = ${id}::uuid
    RETURNING *
  `;
  return task ?? null;
}

// ── Run History ──────────────────────────────────────────────

export async function getTaskRuns(taskId: string, limit = 20): Promise<ScheduledTaskRun[]> {
  const sql = await getSql();
  return sql<ScheduledTaskRun[]>`
    SELECT * FROM scheduled_task_runs
    WHERE task_id = ${taskId}::uuid
    ORDER BY started_at DESC
    LIMIT ${limit}
  `;
}

async function recordRunStart(taskId: string): Promise<string> {
  const sql = await getSql();
  const [run] = await sql<{ id: string }[]>`
    INSERT INTO scheduled_task_runs (task_id, status, started_at)
    VALUES (${taskId}::uuid, 'started', NOW())
    RETURNING id
  `;
  return run.id;
}

async function completeRun(
  runId: string,
  status: RunStatus,
  error?: string | null,
  result?: Record<string, unknown>,
): Promise<void> {
  const sql = await getSql();
  await sql`
    UPDATE scheduled_task_runs SET
      status = ${status},
      completed_at = NOW(),
      duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at))::int * 1000,
      error = ${error ?? null},
      result = ${sql.json(result ?? {})}
    WHERE id = ${runId}::uuid
  `;
}

async function advanceNextRun(task: ScheduledTask): Promise<void> {
  const sql = await getSql();
  const cron = parseCron(task.schedule);
  const nextRun = nextCronRun(cron, new Date());

  await sql`
    UPDATE scheduled_tasks SET
      last_run_at = NOW(),
      next_run_at = ${nextRun ? nextRun.toISOString() : null}::timestamptz,
      updated_at = NOW()
    WHERE id = ${task.id}::uuid
  `;
}

async function markTaskStatus(
  taskId: string,
  status: RunStatus,
  error?: string | null,
): Promise<void> {
  const sql = await getSql();
  if (status === "completed") {
    await sql`
      UPDATE scheduled_tasks SET
        last_status = 'completed', last_error = NULL,
        consecutive_failures = 0, updated_at = NOW()
      WHERE id = ${taskId}::uuid
    `;
  } else if (status === "failed") {
    await sql`
      UPDATE scheduled_tasks SET
        last_status = 'failed', last_error = ${error ?? null},
        consecutive_failures = consecutive_failures + 1, updated_at = NOW()
      WHERE id = ${taskId}::uuid
    `;
  }
}

// ── Scheduler Tick ───────────────────────────────────────────

/**
 * Get tasks that are due for execution.
 */
export async function getDueTasks(now?: Date): Promise<ScheduledTask[]> {
  const sql = await getSql();
  const asOf = now ?? new Date();
  return sql<ScheduledTask[]>`
    SELECT * FROM scheduled_tasks
    WHERE enabled = true
      AND next_run_at IS NOT NULL
      AND next_run_at <= ${asOf.toISOString()}::timestamptz
      AND consecutive_failures < ${MAX_CONSECUTIVE_FAILURES}
    ORDER BY next_run_at ASC
  `;
}

/**
 * Execute a single scheduler tick. Finds due tasks, runs each, records results.
 * The executors map provides the actual execution logic per task type.
 */
export async function schedulerTick(
  executors: Partial<Record<TaskType, (task: ScheduledTask) => Promise<Record<string, unknown>>>>,
  now?: Date,
): Promise<TickResult> {
  const due = await getDueTasks(now);
  const result: TickResult = {
    evaluated: due.length,
    triggered: [],
    skipped: [],
    failed: [],
  };

  for (const task of due) {
    const executor = executors[task.task_type];
    if (!executor) {
      result.skipped.push({ id: task.id, name: task.name, reason: `no executor for type: ${task.task_type}` });
      await advanceNextRun(task);
      continue;
    }

    const runId = await recordRunStart(task.id);

    try {
      const execResult = await executor(task);
      await completeRun(runId, "completed", null, execResult);
      await markTaskStatus(task.id, "completed");
      await advanceNextRun(task);
      result.triggered.push(task.name);
      logger.info(`Executed: ${task.name}`, { taskType: task.task_type });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await completeRun(runId, "failed", errorMsg);
      await markTaskStatus(task.id, "failed", errorMsg);
      await advanceNextRun(task);
      result.failed.push({ id: task.id, name: task.name, error: errorMsg });
      logger.error(`Failed: ${task.name}`, { error: errorMsg });
    }
  }

  return result;
}

// ── Built-in Executors ───────────────────────────────────────

export async function executeFormation(task: ScheduledTask): Promise<Record<string, unknown>> {
  const slug = task.config.formation_slug as string;
  const { invokeFormation } = await import("./formations/orchestrator.ts");
  const { getRelayDeps } = await import("./relay-state.ts");
  const deps = getRelayDeps();
  const result = await invokeFormation(deps, slug, task.config.prompt as string || `Scheduled run of ${slug}`, {
    timeout: (task.config.timeout as number) || 30_000,
  });
  return { formation_slug: slug, status: result.status };
}

export async function executeDispatch(task: ScheduledTask): Promise<Record<string, unknown>> {
  const agent = task.config.agent as string;
  const prompt = task.config.prompt as string;
  const { executeTrackedDispatch } = await import("./orchestration-dispatch.ts");
  const { getRelayDeps } = await import("./relay-state.ts");
  const deps = getRelayDeps();
  const result = await executeTrackedDispatch(deps, {
    agentName: agent,
    userMessage: prompt,
    workItemId: task.config.work_item_id as string || undefined,
  });
  return { agent, run_id: result.runId };
}

export async function executeHttp(task: ScheduledTask): Promise<Record<string, unknown>> {
  const endpoint = task.config.endpoint as string;
  const body = task.config.body ?? {};
  const method = (task.config.method as string) || "POST";

  // Only allow internal relay endpoints
  const url = endpoint.startsWith("/")
    ? `http://localhost:3001${endpoint}`
    : endpoint;

  if (!url.startsWith("http://localhost:")) {
    throw new Error("HTTP tasks can only call localhost endpoints");
  }

  const resp = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method !== "GET" ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }

  return { status: resp.status, url };
}

export async function executeReminder(task: ScheduledTask): Promise<Record<string, unknown>> {
  const message = task.config.message as string;
  const channel = (task.config.channel as string) || "telegram";

  const { notify } = await import("./notification-policy.ts");
  const { getNotifyCtx } = await import("./relay-state.ts");

  await notify(getNotifyCtx(), {
    event: "scheduled_reminder" as any,
    telegramMessage: message,
    gchatMessage: channel === "all" ? message : undefined,
  });

  return { message: message.substring(0, 100), channel };
}

/** Default executor map. */
export function getDefaultExecutors(): Record<TaskType, (task: ScheduledTask) => Promise<Record<string, unknown>>> {
  return {
    formation: executeFormation,
    dispatch: executeDispatch,
    http: executeHttp,
    reminder: executeReminder,
  };
}

// ── Test Utilities ───────────────────────────────────────────

export function _setSqlForTesting(sql: any): void {
  _sql = sql;
}
