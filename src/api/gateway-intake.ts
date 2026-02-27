/**
 * Gateway intake endpoints — receives forwarded events from ellie-gateway.
 *
 * POST /api/gateway/event  — normalized events (GitHub, etc.) → Bridge awareness
 * POST /api/gateway/alert  — urgent events → agent queue + notification
 * POST /api/gateway/email  — email change notification → fetch + process
 * POST /api/gateway/calendar-sync — calendar change → trigger sync
 *
 * ELLIE-151, ELLIE-236 (HMAC auth + schema validation + sanitization)
 */

import type { IncomingMessage, ServerResponse } from "http";
import { createHmac, timingSafeEqual } from "crypto";
import { log } from "../logger.ts";

const logger = log.child("gateway-intake");
import { notify } from "../notification-policy.ts";
import { getNotifyCtx, getRelayDeps } from "../relay-state.ts";
import { syncAllCalendars } from "../calendar-sync.ts";
import { getMessage as outlookGetMessage } from "../outlook.ts";
import { retrieveSecret } from "../../../ellie-forest/src/hollow.ts";

const KEYCHAIN_ID = "568c0a6a-0c98-4784-87f3-d909139d8c35";
const MAX_TIMESTAMP_DRIFT_MS = 5 * 60_000; // 5 minutes — reject replayed requests

// Cached HMAC secret — loaded from Hollow on first use
let _hmacSecret: string | null = null;
async function getHmacSecret(): Promise<string> {
  if (_hmacSecret !== null) return _hmacSecret;
  _hmacSecret = (await retrieveSecret(KEYCHAIN_ID, "gateway_hmac_secret")) || "";
  if (_hmacSecret) logger.info("HMAC secret loaded from Hollow");
  return _hmacSecret;
}

// ── HMAC verification ──────────────────────────────────────

/**
 * Verify the request came from our gateway using HMAC-SHA256.
 * Checks: X-Gateway-Source header, timestamp drift, signature.
 * Backwards-compatible: if HMAC secret not configured, falls back to header-only check.
 */
async function isGatewayRequest(req: IncomingMessage, rawBody: string): Promise<boolean> {
  if (req.headers["x-gateway-source"] !== "ellie-gateway") return false;

  const secret = await getHmacSecret();
  if (!secret) return true; // no secret configured — header-only (dev mode)

  const timestamp = req.headers["x-gateway-timestamp"] as string | undefined;
  const signature = req.headers["x-gateway-signature"] as string | undefined;

  if (!timestamp || !signature) {
    logger.warn("Missing HMAC headers");
    return false;
  }

  // Reject if timestamp too old or in the future (replay protection)
  const drift = Math.abs(Date.now() - parseInt(timestamp, 10));
  if (isNaN(drift) || drift > MAX_TIMESTAMP_DRIFT_MS) {
    logger.warn("Timestamp drift too large", { drift });
    return false;
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  // Constant-time comparison to prevent timing attacks
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false; // length mismatch
  }
}

// ── Schema validation ──────────────────────────────────────

function validateEventPayload(data: any): string | null {
  if (!data || typeof data !== "object") return "Body must be an object";
  if (typeof data.source !== "string" || data.source.length === 0) return "Missing source";
  if (typeof data.category !== "string" || data.category.length === 0) return "Missing category";
  if (typeof data.summary !== "string" || data.summary.length === 0) return "Missing summary";
  if (data.summary.length > 500) return "summary too long (max 500)";
  if (data.envelope_id && typeof data.envelope_id !== "string") return "envelope_id must be a string";
  return null;
}

function validateAlertPayload(data: any): string | null {
  if (!data || typeof data !== "object") return "Body must be an object";
  if (typeof data.source !== "string" || data.source.length === 0) return "Missing source";
  if (typeof data.summary !== "string" || data.summary.length === 0) return "Missing summary";
  if (data.summary.length > 500) return "summary too long (max 500)";
  return null;
}

function validateEmailPayload(data: any): string | null {
  if (!data || typeof data !== "object") return "Body must be an object";
  if (typeof data.message_id !== "string" || data.message_id.length === 0) return "Missing message_id";
  if (data.message_id.length > 500) return "message_id too long (max 500)";
  if (data.change_type && typeof data.change_type !== "string") return "change_type must be a string";
  return null;
}

// ── Input sanitization ─────────────────────────────────────

/** Strip HTML tags and control characters from a string. */
function sanitize(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
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

  const endpoint = pathname.replace("/api/gateway/", "");

  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString();
  });
  req.on("end", async () => {
    // ELLIE-236: HMAC verification (needs raw body for signature check)
    if (!(await isGatewayRequest(req, body))) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    try {
      const data = JSON.parse(body);

      switch (endpoint) {
        case "event": {
          const err = validateEventPayload(data);
          if (err) { res.writeHead(400); res.end(JSON.stringify({ error: err })); return; }
          data.summary = sanitize(data.summary);
          await handleGatewayEvent(data, res);
          break;
        }
        case "alert": {
          const err = validateAlertPayload(data);
          if (err) { res.writeHead(400); res.end(JSON.stringify({ error: err })); return; }
          data.summary = sanitize(data.summary);
          await handleGatewayAlert(data, res);
          break;
        }
        case "email": {
          const err = validateEmailPayload(data);
          if (err) { res.writeHead(400); res.end(JSON.stringify({ error: err })); return; }
          await handleGatewayEmail(data, res);
          break;
        }
        case "calendar-sync":
          await handleGatewayCalendarSync(data, res);
          break;
        default:
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown gateway endpoint" }));
      }
    } catch (err: any) {
      logger.error("Error on endpoint", { endpoint, message: err?.message });
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
    logger.error("Bridge write error", { message: err?.message });
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
    logger.error("Notification error", { message: err?.message });
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
    logger.error("Queue item creation error", { message: err?.message });
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
    logger.error("Email fetch error", { message: err?.message });
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
    logger.error("Calendar sync error", { message: err?.message });
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}
