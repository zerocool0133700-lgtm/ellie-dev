/**
 * Workflow Checkpoint API — ELLIE-834
 *
 * Manages durable workflow state in Forest. Agents create checkpoints
 * at each step; crashes trigger recovery from the last checkpoint.
 */

export type CheckpointStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export interface WorkflowInstance {
  id: string;
  definition_id: string | null;
  work_item_id: string | null;
  status: CheckpointStatus;
  current_step: number;
  context: Record<string, unknown>;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
  created_by: string | null;
}

export interface WorkflowCheckpoint {
  id: string;
  workflow_id: string;
  step: number;
  agent: string;
  task_id: string | null;
  status: CheckpointStatus;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
}

export interface CreateInstanceOpts {
  definition_id?: string;
  work_item_id?: string;
  context?: Record<string, unknown>;
  created_by?: string;
}

export interface CreateCheckpointOpts {
  workflow_id: string;
  step: number;
  agent: string;
  task_id?: string;
  input?: Record<string, unknown>;
}

export interface UpdateCheckpointOpts {
  status: CheckpointStatus;
  output?: Record<string, unknown>;
  error_message?: string;
}

// ── Instance operations ──────────────────────────────────────────

export async function createInstance(sql: any, opts: CreateInstanceOpts): Promise<WorkflowInstance> {
  const [row] = await sql`
    INSERT INTO workflow_instances (definition_id, work_item_id, context, created_by, status)
    VALUES (${opts.definition_id ?? null}, ${opts.work_item_id ?? null},
            ${JSON.stringify(opts.context ?? {})}, ${opts.created_by ?? null}, 'pending')
    RETURNING *
  `;
  return row;
}

export async function getInstance(sql: any, id: string): Promise<WorkflowInstance | null> {
  const [row] = await sql`SELECT * FROM workflow_instances WHERE id = ${id}`;
  return row ?? null;
}

export async function updateInstanceStatus(
  sql: any, id: string, status: CheckpointStatus, step?: number, error?: string,
): Promise<void> {
  await sql`
    UPDATE workflow_instances SET
      status = ${status},
      current_step = COALESCE(${step ?? null}, current_step),
      completed_at = ${status === "completed" || status === "failed" ? sql`NOW()` : null},
      error_message = ${error ?? null}
    WHERE id = ${id}
  `;
}

export async function getInstancesByWorkItem(sql: any, workItemId: string): Promise<WorkflowInstance[]> {
  return sql`SELECT * FROM workflow_instances WHERE work_item_id = ${workItemId} ORDER BY started_at DESC`;
}

// ── Checkpoint operations ────────────────────────────────────────

export async function createCheckpoint(sql: any, opts: CreateCheckpointOpts): Promise<WorkflowCheckpoint> {
  const [row] = await sql`
    INSERT INTO workflow_checkpoints (workflow_id, step, agent, task_id, input, status, started_at)
    VALUES (${opts.workflow_id}, ${opts.step}, ${opts.agent}, ${opts.task_id ?? null},
            ${opts.input ? JSON.stringify(opts.input) : null}, 'in_progress', NOW())
    ON CONFLICT (workflow_id, step) DO UPDATE SET
      agent = EXCLUDED.agent,
      task_id = EXCLUDED.task_id,
      input = EXCLUDED.input,
      status = 'in_progress',
      started_at = NOW(),
      completed_at = NULL,
      error_message = NULL
    RETURNING *
  `;
  return row;
}

export async function updateCheckpoint(
  sql: any, workflowId: string, step: number, opts: UpdateCheckpointOpts,
): Promise<WorkflowCheckpoint | null> {
  const [row] = await sql`
    UPDATE workflow_checkpoints SET
      status = ${opts.status},
      output = ${opts.output ? JSON.stringify(opts.output) : sql`output`},
      completed_at = ${opts.status === "completed" || opts.status === "failed" ? sql`NOW()` : null},
      error_message = ${opts.error_message ?? null}
    WHERE workflow_id = ${workflowId} AND step = ${step}
    RETURNING *
  `;
  return row ?? null;
}

export async function getCheckpoints(sql: any, workflowId: string): Promise<WorkflowCheckpoint[]> {
  return sql`SELECT * FROM workflow_checkpoints WHERE workflow_id = ${workflowId} ORDER BY step`;
}

export async function getActiveCheckpointsForAgent(sql: any, agent: string): Promise<WorkflowCheckpoint[]> {
  return sql`
    SELECT c.* FROM workflow_checkpoints c
    JOIN workflow_instances w ON w.id = c.workflow_id
    WHERE c.agent = ${agent} AND c.status IN ('pending', 'in_progress')
    AND w.status IN ('pending', 'in_progress')
    ORDER BY c.started_at
  `;
}

export async function getLastCompletedStep(sql: any, workflowId: string): Promise<number> {
  const [row] = await sql`
    SELECT MAX(step) as last_step FROM workflow_checkpoints
    WHERE workflow_id = ${workflowId} AND status = 'completed'
  `;
  return row?.last_step ?? -1;
}
