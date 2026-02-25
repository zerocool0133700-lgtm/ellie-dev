/**
 * Gateway intake endpoints — receives forwarded events from ellie-gateway.
 *
 * POST /api/gateway/event  — normalized events (GitHub, etc.) → Bridge awareness
 * POST /api/gateway/alert  — urgent events → agent queue + notification
 * POST /api/gateway/email  — email change notification → fetch + process
 * POST /api/gateway/calendar-sync — calendar change → trigger sync
 *
 * ELLIE-151
 */

import type { IncomingMessage, ServerResponse } from "http";
import { notify } from "../notification-policy.ts";
import { getNotifyCtx, getRelayDeps } from "../relay-state.ts";
import { syncAllCalendars } from "../calendar-sync.ts";
import { getMessage as outlookGetMessage } from "../outlook.ts";

/** Verify the request came from our gateway (localhost). */
function isGatewayRequest(req: IncomingMessage): boolean {
  return req.headers["x-gateway-source"] === "ellie-gateway";
}

/**
 * Handle all /api/gateway/* routes.
 * Returns true if the route was handled, false if not a gateway route.
 */
export function handleGatewayRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): boolean {
  if (!pathname.startsWith("/api/gateway/")) return false;

  if (!isGatewayRequest(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden" }));
    return true;
  }

  const endpoint = pathname.replace("/api/gateway/", "");

  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString();
  });
  req.on("end", async () => {
    try {
      const data = JSON.parse(body);

      switch (endpoint) {
        case "event":
          await handleGatewayEvent(data, res);
          break;
        case "alert":
          await handleGatewayAlert(data, res);
          break;
        case "email":
          await handleGatewayEmail(data, res);
          break;
        case "calendar-sync":
          await handleGatewayCalendarSync(data, res);
          break;
        default:
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown gateway endpoint" }));
      }
    } catch (err: any) {
      console.error(`[gateway-intake] Error on ${endpoint}:`, err?.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message || "Internal error" }));
    }
  });

  return true;
}

/**
 * Normal events — write to Bridge as awareness findings.
 * No AI interruption, just knowledge graph updates.
 */
async function handleGatewayEvent(
  data: any,
  res: ServerResponse,
): Promise<void> {
  const { source, category, summary, actor, payload, envelope_id } = data;

  console.log(`[gateway-intake] Event: ${source}/${category} — ${summary}`);

  // Write to Forest Bridge as a finding
  try {
    const { writeMemory } = await import("../../../ellie-forest/src/index");
    await writeMemory({
      content: `[${source}] ${summary}${payload?.url ? ` — ${payload.url}` : ""}`,
      type: "finding",
      scope_path: "2/1", // ellie-dev scope
      confidence: 0.7,
      metadata: {
        source: `gateway:${source}`,
        category,
        actor,
        envelope_id,
        ...(payload?.repo && { repo: payload.repo }),
        ...(payload?.number && { number: payload.number }),
      },
    });
  } catch (err: any) {
    console.error("[gateway-intake] Bridge write error:", err?.message);
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

/**
 * Urgent events — create agent queue item + send notification.
 * Used for CI failures, critical alerts, etc.
 */
async function handleGatewayAlert(
  data: any,
  res: ServerResponse,
): Promise<void> {
  const { source, summary, payload, envelope_id } = data;

  console.log(`[gateway-intake] ALERT: ${source} — ${summary}`);

  // Send notification to Telegram/Google Chat
  try {
    await notify(getNotifyCtx(), {
      event: "dispatch_confirm",
      workItemId: envelope_id,
      telegramMessage: `🚨 *Gateway Alert* (${source}): ${summary}`,
      gchatMessage: `Gateway Alert (${source}): ${summary}`,
    });
  } catch (err: any) {
    console.error("[gateway-intake] Notification error:", err?.message);
  }

  // Create agent queue item for the dev agent to review
  try {
    const { createQueueItemDirect } = await import("./agent-queue.ts");
    await createQueueItemDirect({
      source: `gateway:${source}`,
      target: "dev",
      priority: "high",
      category: "alert",
      title: summary,
      content: JSON.stringify(payload, null, 2),
      work_item_id: null,
      metadata: { envelope_id, gateway_source: source },
    });
  } catch (err: any) {
    console.error("[gateway-intake] Queue item creation error:", err?.message);
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

/**
 * Email change notification — fetch full message via Graph API.
 * Uses the relay's existing outlook.ts module.
 */
async function handleGatewayEmail(
  data: any,
  res: ServerResponse,
): Promise<void> {
  const { message_id, change_type, envelope_id } = data;

  console.log(`[gateway-intake] Email ${change_type}: ${message_id.substring(0, 20)}...`);

  try {
    const message = await outlookGetMessage(message_id);
    if (message) {
      console.log(
        `[gateway-intake] Fetched email: "${message.subject}" from ${message.from?.emailAddress?.name || "unknown"}`,
      );

      // Write to Bridge as awareness
      const { writeMemory } = await import("../../../ellie-forest/src/index");
      await writeMemory({
        content: `[email] ${change_type}: "${message.subject}" from ${message.from?.emailAddress?.name || message.from?.emailAddress?.address || "unknown"}`,
        type: "finding",
        scope_path: "2",
        confidence: 0.6,
        metadata: {
          source: "gateway:outlook",
          message_id,
          envelope_id,
          subject: message.subject,
          from: message.from?.emailAddress?.address,
        },
      });
    }
  } catch (err: any) {
    console.error("[gateway-intake] Email fetch error:", err?.message);
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

/**
 * Calendar change notification — trigger the relay's existing calendar sync.
 */
async function handleGatewayCalendarSync(
  data: any,
  res: ServerResponse,
): Promise<void> {
  console.log(`[gateway-intake] Calendar sync triggered by gateway`);

  try {
    await syncAllCalendars();
    console.log("[gateway-intake] Calendar sync complete");
  } catch (err: any) {
    console.error("[gateway-intake] Calendar sync error:", err?.message);
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}
