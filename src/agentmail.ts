/**
 * AgentMail Email Channel Client — ELLIE-785
 *
 * Handles inbound webhooks and outbound email via the AgentMail API.
 * Endpoint: https://api.agentmail.to/v0
 *
 * Inbound: POST /api/agentmail/webhooks (webhook from AgentMail)
 * Outbound: POST /v0/inboxes/{inbox}/messages/send (new email)
 *           POST /v0/inboxes/{inbox}/messages/{id}/reply (threaded reply)
 */

import { createHmac } from "crypto";

// ── Types ────────────────────────────────────────────────────

export interface AgentMailMessage {
  message_id: string;
  thread_id: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  extracted_text?: string;
  created_at?: string;
  headers?: Record<string, string>;
}

export interface AgentEmailHeaders {
  "X-Sent-By-Agent"?: string;
  "X-Agent-Type"?: string;
  "X-Message-Type"?: "inter-agent" | "external" | "notification";
  "X-Thread-Context"?: string;
}

export interface AgentMailWebhookPayload {
  event_type: string;
  data: {
    inbox_id: string;
    message_id: string;
    thread_id: string;
    from: string;
    to: string[];
    subject: string;
    text?: string;
    html?: string;
    extracted_text?: string;
    headers?: Record<string, string>;
  };
  timestamp: string;
}

export interface AgentMailSendResult {
  message_id: string;
  thread_id: string;
}

export interface AgentMailConfig {
  apiKey: string;
  inboxEmail: string;
  webhookSecret: string;
}

// ── Config ───────────────────────────────────────────────────

const API_BASE = "https://api.agentmail.to/v0";

export function getAgentMailConfig(): AgentMailConfig | null {
  const apiKey = process.env.AGENTMAIL_API_KEY;
  const inboxEmail = process.env.AGENTMAIL_INBOX_EMAIL;
  const webhookSecret = process.env.AGENTMAIL_WEBHOOK_SECRET;

  if (!apiKey || !inboxEmail || !webhookSecret) return null;

  return { apiKey, inboxEmail, webhookSecret };
}

export function isAgentMailEnabled(): boolean {
  return getAgentMailConfig() !== null;
}

// ── Webhook Verification ────────────────────────────────────

/**
 * Verify an incoming webhook signature from AgentMail.
 * AgentMail signs webhooks with HMAC-SHA256 using the webhook secret.
 */
export function verifyWebhookSignature(
  body: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;

  const expected = createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  // Compare with timing-safe check
  if (signature.length !== expected.length) return false;

  let mismatch = 0;
  for (let i = 0; i < signature.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

// ── Parse Webhook ───────────────────────────────────────────

export interface ParsedEmailMessage {
  messageId: string;
  threadId: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  inboxId: string;
  headers?: Record<string, string>;
}

/**
 * Parse an AgentMail webhook payload into a normalized message.
 * Returns null if the payload is not a message.received event or is invalid.
 */
export function parseWebhookPayload(
  payload: AgentMailWebhookPayload,
): ParsedEmailMessage | null {
  if (payload.event_type !== "message.received") return null;

  const d = payload.data;
  if (!d?.message_id || !d?.from) return null;

  // Extract text content — prefer extracted_text > text > stripped html
  const text = d.extracted_text || d.text || "";
  if (!text.trim()) return null;

  return {
    messageId: d.message_id,
    threadId: d.thread_id,
    from: d.from,
    to: d.to || [],
    subject: d.subject || "(no subject)",
    text: text.trim(),
    inboxId: d.inbox_id,
    headers: d.headers,
  };
}

// ── Outbound API ────────────────────────────────────────────

/**
 * Send a new email (not a reply).
 */
export async function sendEmail(
  to: string[],
  subject: string,
  text: string,
  config?: AgentMailConfig,
  headers?: Record<string, string>,
): Promise<AgentMailSendResult> {
  const cfg = config ?? getAgentMailConfig();
  if (!cfg) throw new Error("AgentMail not configured");

  const body: { to: string[]; subject: string; text: string; headers?: Record<string, string> } = {
    to,
    subject,
    text,
  };

  if (headers) {
    body.headers = headers;
  }

  const res = await fetch(`${API_BASE}/inboxes/${encodeURIComponent(cfg.inboxEmail)}/messages/send`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`AgentMail send failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<AgentMailSendResult>;
}

/**
 * Reply to an existing message (maintains threading).
 */
export async function replyToEmail(
  messageId: string,
  text: string,
  config?: AgentMailConfig,
  headers?: Record<string, string>,
): Promise<AgentMailSendResult> {
  const cfg = config ?? getAgentMailConfig();
  if (!cfg) throw new Error("AgentMail not configured");

  const body: { text: string; headers?: Record<string, string> } = { text };

  if (headers) {
    body.headers = headers;
  }

  const res = await fetch(
    `${API_BASE}/inboxes/${encodeURIComponent(cfg.inboxEmail)}/messages/${encodeURIComponent(messageId)}/reply`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`AgentMail reply failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<AgentMailSendResult>;
}

/**
 * List threads for the inbox (for testing/debugging).
 */
export async function listThreads(
  config?: AgentMailConfig,
): Promise<{ threads: Array<{ thread_id: string; subject: string; updated_at: string }> }> {
  const cfg = config ?? getAgentMailConfig();
  if (!cfg) throw new Error("AgentMail not configured");

  const res = await fetch(`${API_BASE}/inboxes/${encodeURIComponent(cfg.inboxEmail)}/threads`, {
    headers: { "Authorization": `Bearer ${cfg.apiKey}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`AgentMail list threads failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<{ threads: Array<{ thread_id: string; subject: string; updated_at: string }> }>;
}

// ── Helper Functions ─────────────────────────────────────────

/**
 * Check if a message is from an agent based on custom headers.
 */
export function isInterAgentMessage(headers?: Record<string, string>): boolean {
  return !!headers?.["X-Sent-By-Agent"];
}

/**
 * Build agent email headers for outbound messages.
 */
export function buildAgentHeaders(
  agentName: string,
  agentType: string,
  messageType: "inter-agent" | "external" | "notification" = "inter-agent",
  threadContext?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Sent-By-Agent": agentName,
    "X-Agent-Type": agentType,
    "X-Message-Type": messageType,
  };

  if (threadContext) {
    headers["X-Thread-Context"] = threadContext;
  }

  return headers;
}
