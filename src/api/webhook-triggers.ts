/**
 * Webhook Triggers REST API — ELLIE-977
 *
 * Management routes: /api/webhooks (CRUD, toggle, regenerate token, invocations)
 * Trigger route: /api/webhooks/trigger/:token (public, no auth needed — token IS the auth)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createWebhook,
  getWebhook,
  listWebhooks,
  updateWebhook,
  deleteWebhook,
  setWebhookEnabled,
  regenerateToken,
  getInvocations,
  invokeWebhook,
  validateWebhookInput,
  type CreateWebhookInput,
  type UpdateWebhookInput,
} from "../webhook-triggers.ts";
import { log } from "../logger.ts";

const logger = log.child("api:webhooks");

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

/**
 * Handle /api/webhooks routes.
 * Returns true if the route was handled.
 */
export async function handleWebhookRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? "GET";

  // ── Public trigger endpoint (no auth) ──────────────────────
  // POST /api/webhooks/trigger/:token
  const triggerMatch = pathname.match(/^\/api\/webhooks\/trigger\/([a-f0-9]{48})$/);
  if (triggerMatch && method === "POST") {
    const token = triggerMatch[1];
    const payload = await readBody(req);
    const sourceIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      || req.socket?.remoteAddress
      || null;
    const result = await invokeWebhook(token, payload, sourceIp);
    json(res, result.ok ? 200 : result.status === "rejected" ? 429 : 500, result);
    return true;
  }

  // ── Management endpoints (require auth — handled by parent router) ──

  // GET /api/webhooks — list all
  if (pathname === "/api/webhooks" && method === "GET") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const enabledOnly = url.searchParams.get("enabled") === "true";
    const webhooks = await listWebhooks({ enabledOnly: enabledOnly || undefined });
    json(res, 200, { webhooks });
    return true;
  }

  // POST /api/webhooks — create
  if (pathname === "/api/webhooks" && method === "POST") {
    const body = await readBody(req) as CreateWebhookInput;
    const error = validateWebhookInput(body);
    if (error) {
      json(res, 400, { error });
      return true;
    }
    const webhook = await createWebhook(body);
    logger.info(`Created webhook: ${webhook.name} (${webhook.action_type})`);
    json(res, 201, { webhook });
    return true;
  }

  // Routes with webhook ID: /api/webhooks/:id
  const idMatch = pathname.match(/^\/api\/webhooks\/([0-9a-f-]{36})$/);
  if (idMatch) {
    const id = idMatch[1];

    if (method === "GET") {
      const webhook = await getWebhook(id);
      if (!webhook) { json(res, 404, { error: "webhook not found" }); return true; }
      json(res, 200, { webhook });
      return true;
    }

    if (method === "PATCH") {
      const body = await readBody(req) as UpdateWebhookInput;
      const webhook = await updateWebhook(id, body);
      if (!webhook) { json(res, 404, { error: "webhook not found" }); return true; }
      json(res, 200, { webhook });
      return true;
    }

    if (method === "DELETE") {
      const deleted = await deleteWebhook(id);
      if (!deleted) { json(res, 404, { error: "webhook not found" }); return true; }
      json(res, 200, { ok: true });
      return true;
    }

    return false;
  }

  // POST /api/webhooks/:id/toggle
  const toggleMatch = pathname.match(/^\/api\/webhooks\/([0-9a-f-]{36})\/toggle$/);
  if (toggleMatch && method === "POST") {
    const body = await readBody(req) as { enabled: boolean };
    const webhook = await setWebhookEnabled(toggleMatch[1], !!body.enabled);
    if (!webhook) { json(res, 404, { error: "webhook not found" }); return true; }
    json(res, 200, { webhook });
    return true;
  }

  // POST /api/webhooks/:id/regenerate-token
  const regenMatch = pathname.match(/^\/api\/webhooks\/([0-9a-f-]{36})\/regenerate-token$/);
  if (regenMatch && method === "POST") {
    const webhook = await regenerateToken(regenMatch[1]);
    if (!webhook) { json(res, 404, { error: "webhook not found" }); return true; }
    json(res, 200, { webhook });
    return true;
  }

  // GET /api/webhooks/:id/invocations
  const invMatch = pathname.match(/^\/api\/webhooks\/([0-9a-f-]{36})\/invocations$/);
  if (invMatch && method === "GET") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
    const invocations = await getInvocations(invMatch[1], Math.min(limit, 100));
    json(res, 200, { invocations });
    return true;
  }

  return false;
}
