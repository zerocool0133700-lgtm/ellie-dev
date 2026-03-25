/**
 * Webhook Triggers — ELLIE-977
 *
 * Inbound webhook system for triggering actions via HTTP POST.
 * Each webhook gets a unique token used for authentication in the URL path.
 *
 * POST /api/webhooks/trigger/:token
 *   - Validates token, checks enabled + cooldown
 *   - Merges caller payload with webhook config
 *   - Executes action (formation, dispatch, http, reminder)
 *   - Logs invocation with status + duration
 */

import { log } from "./logger.ts";
import { validateConfig, type TaskType } from "./scheduled-tasks.ts";

const logger = log.child("webhook-triggers");

// ── Types ────────────────────────────────────────────────────

export interface WebhookTrigger {
  id: string;
  created_at: Date;
  updated_at: Date;
  name: string;
  description: string;
  token: string;
  action_type: TaskType;
  config: Record<string, unknown>;
  enabled: boolean;
  cooldown_seconds: number;
  last_triggered_at: Date | null;
  trigger_count: number;
  created_by: string | null;
}

export interface WebhookInvocation {
  id: string;
  created_at: Date;
  webhook_id: string;
  status: "started" | "completed" | "failed" | "rejected";
  started_at: Date;
  completed_at: Date | null;
  duration_ms: number | null;
  error: string | null;
  source_ip: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface CreateWebhookInput {
  name: string;
  description?: string;
  action_type: TaskType;
  config: Record<string, unknown>;
  enabled?: boolean;
  cooldown_seconds?: number;
  created_by?: string;
}

export interface UpdateWebhookInput {
  name?: string;
  description?: string;
  action_type?: TaskType;
  config?: Record<string, unknown>;
  enabled?: boolean;
  cooldown_seconds?: number;
}

export interface InvokeResult {
  ok: boolean;
  invocation_id: string;
  status: "completed" | "failed" | "rejected";
  error?: string;
  result?: Record<string, unknown>;
}

// ── Token Generation ─────────────────────────────────────────

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Validation ───────────────────────────────────────────────

export function validateWebhookInput(input: CreateWebhookInput): string | null {
  if (!input.name?.trim()) return "name is required";
  const validTypes: TaskType[] = ["formation", "dispatch", "http", "reminder"];
  if (!validTypes.includes(input.action_type)) return `invalid action_type: ${input.action_type}`;
  return validateConfig(input.action_type, input.config);
}

// ── Database ─────────────────────────────────────────────────

let _sql: any = null;

async function getSql() {
  if (_sql) return _sql;
  const { sql } = await import("../../ellie-forest/src/index");
  _sql = sql;
  return sql;
}

export async function createWebhook(input: CreateWebhookInput): Promise<WebhookTrigger> {
  const sql = await getSql();
  const token = generateToken();

  const [wh] = await sql<WebhookTrigger[]>`
    INSERT INTO webhook_triggers (
      name, description, token, action_type, config, enabled,
      cooldown_seconds, created_by
    )
    VALUES (
      ${input.name},
      ${input.description ?? ""},
      ${token},
      ${input.action_type},
      ${sql.json(input.config)},
      ${input.enabled ?? true},
      ${input.cooldown_seconds ?? 0},
      ${input.created_by ?? null}
    )
    RETURNING *
  `;
  return wh;
}

export async function getWebhook(id: string): Promise<WebhookTrigger | null> {
  const sql = await getSql();
  const [wh] = await sql<WebhookTrigger[]>`
    SELECT * FROM webhook_triggers WHERE id = ${id}::uuid
  `;
  return wh ?? null;
}

export async function getWebhookByToken(token: string): Promise<WebhookTrigger | null> {
  const sql = await getSql();
  const [wh] = await sql<WebhookTrigger[]>`
    SELECT * FROM webhook_triggers WHERE token = ${token}
  `;
  return wh ?? null;
}

export async function listWebhooks(opts: { enabledOnly?: boolean } = {}): Promise<WebhookTrigger[]> {
  const sql = await getSql();
  if (opts.enabledOnly) {
    return sql<WebhookTrigger[]>`
      SELECT * FROM webhook_triggers WHERE enabled = true ORDER BY name ASC
    `;
  }
  return sql<WebhookTrigger[]>`
    SELECT * FROM webhook_triggers ORDER BY name ASC
  `;
}

export async function updateWebhook(id: string, input: UpdateWebhookInput): Promise<WebhookTrigger | null> {
  const sql = await getSql();
  const existing = await getWebhook(id);
  if (!existing) return null;

  const [wh] = await sql<WebhookTrigger[]>`
    UPDATE webhook_triggers SET
      name = ${input.name ?? existing.name},
      description = ${input.description ?? existing.description},
      action_type = ${input.action_type ?? existing.action_type},
      config = ${sql.json(input.config ?? existing.config)},
      enabled = ${input.enabled ?? existing.enabled},
      cooldown_seconds = ${input.cooldown_seconds ?? existing.cooldown_seconds},
      updated_at = NOW()
    WHERE id = ${id}::uuid
    RETURNING *
  `;
  return wh ?? null;
}

export async function deleteWebhook(id: string): Promise<boolean> {
  const sql = await getSql();
  const rows = await sql`
    DELETE FROM webhook_triggers WHERE id = ${id}::uuid RETURNING id
  `;
  return rows.length > 0;
}

export async function setWebhookEnabled(id: string, enabled: boolean): Promise<WebhookTrigger | null> {
  const sql = await getSql();
  const [wh] = await sql<WebhookTrigger[]>`
    UPDATE webhook_triggers SET enabled = ${enabled}, updated_at = NOW()
    WHERE id = ${id}::uuid
    RETURNING *
  `;
  return wh ?? null;
}

export async function regenerateToken(id: string): Promise<WebhookTrigger | null> {
  const sql = await getSql();
  const newToken = generateToken();
  const [wh] = await sql<WebhookTrigger[]>`
    UPDATE webhook_triggers SET token = ${newToken}, updated_at = NOW()
    WHERE id = ${id}::uuid
    RETURNING *
  `;
  return wh ?? null;
}

// ── Invocation Log ───────────────────────────────────────────

export async function getInvocations(webhookId: string, limit = 20): Promise<WebhookInvocation[]> {
  const sql = await getSql();
  return sql<WebhookInvocation[]>`
    SELECT * FROM webhook_invocations
    WHERE webhook_id = ${webhookId}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

async function recordInvocationStart(
  webhookId: string,
  sourceIp: string | null,
  payload: Record<string, unknown>,
): Promise<string> {
  const sql = await getSql();
  const [inv] = await sql<{ id: string }[]>`
    INSERT INTO webhook_invocations (webhook_id, status, source_ip, payload)
    VALUES (${webhookId}::uuid, 'started', ${sourceIp}, ${sql.json(payload)})
    RETURNING id
  `;
  return inv.id;
}

async function completeInvocation(
  invId: string,
  status: "completed" | "failed" | "rejected",
  error?: string | null,
  result?: Record<string, unknown>,
): Promise<void> {
  const sql = await getSql();
  await sql`
    UPDATE webhook_invocations SET
      status = ${status},
      completed_at = NOW(),
      duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at))::int * 1000,
      error = ${error ?? null},
      result = ${sql.json(result ?? {})}
    WHERE id = ${invId}::uuid
  `;
}

async function updateTriggerStats(webhookId: string): Promise<void> {
  const sql = await getSql();
  await sql`
    UPDATE webhook_triggers SET
      last_triggered_at = NOW(),
      trigger_count = trigger_count + 1,
      updated_at = NOW()
    WHERE id = ${webhookId}::uuid
  `;
}

// ── Invoke ───────────────────────────────────────────────────

/**
 * Invoke a webhook by token. Validates, checks cooldown, executes action.
 * Called from the HTTP route handler.
 */
export async function invokeWebhook(
  token: string,
  payload: Record<string, unknown>,
  sourceIp: string | null,
): Promise<InvokeResult> {
  const webhook = await getWebhookByToken(token);

  if (!webhook) {
    return { ok: false, invocation_id: "", status: "rejected", error: "webhook not found" };
  }

  if (!webhook.enabled) {
    return { ok: false, invocation_id: "", status: "rejected", error: "webhook is disabled" };
  }

  // Cooldown check
  if (webhook.cooldown_seconds > 0 && webhook.last_triggered_at) {
    const elapsed = (Date.now() - new Date(webhook.last_triggered_at).getTime()) / 1000;
    if (elapsed < webhook.cooldown_seconds) {
      const invId = await recordInvocationStart(webhook.id, sourceIp, payload);
      await completeInvocation(invId, "rejected", `cooldown: ${Math.ceil(webhook.cooldown_seconds - elapsed)}s remaining`);
      return { ok: false, invocation_id: invId, status: "rejected", error: `cooldown: ${Math.ceil(webhook.cooldown_seconds - elapsed)}s remaining` };
    }
  }

  const invId = await recordInvocationStart(webhook.id, sourceIp, payload);

  try {
    // Merge webhook config with caller payload (payload overrides)
    const mergedConfig = { ...webhook.config, ...payload };

    // Build a pseudo-ScheduledTask to reuse executors
    const pseudoTask = {
      id: webhook.id,
      created_at: webhook.created_at,
      updated_at: webhook.updated_at,
      name: webhook.name,
      description: webhook.description,
      task_type: webhook.action_type,
      schedule: "",
      timezone: "America/Chicago",
      enabled: true,
      config: mergedConfig,
      last_run_at: null,
      next_run_at: null,
      last_status: null,
      last_error: null,
      consecutive_failures: 0,
      created_by: webhook.created_by,
    };

    const { getDefaultExecutors } = await import("./scheduled-tasks.ts");
    const executors = getDefaultExecutors();
    const executor = executors[webhook.action_type];

    if (!executor) {
      throw new Error(`no executor for action type: ${webhook.action_type}`);
    }

    const result = await executor(pseudoTask as any);
    await completeInvocation(invId, "completed", null, result);
    await updateTriggerStats(webhook.id);

    logger.info(`Webhook triggered: ${webhook.name}`, { action: webhook.action_type });
    return { ok: true, invocation_id: invId, status: "completed", result };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await completeInvocation(invId, "failed", errorMsg);
    await updateTriggerStats(webhook.id);
    logger.error(`Webhook failed: ${webhook.name}`, { error: errorMsg });
    return { ok: false, invocation_id: invId, status: "failed", error: errorMsg };
  }
}

// ── Test Utilities ───────────────────────────────────────────

export function _setSqlForTesting(sql: any): void {
  _sql = sql;
}

export { generateToken as _generateTokenForTesting };
