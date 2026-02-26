/**
 * Microsoft Outlook Email Module
 *
 * Handles OAuth2 authentication and email operations via Microsoft Graph API.
 * Supports both Outlook.com and Hotmail accounts (same Microsoft identity).
 *
 * Set MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, and MICROSOFT_REFRESH_TOKEN
 * in .env. Run `bun scripts/oauth-microsoft.ts` to get the refresh token.
 */

import { log } from "./logger.ts";

const logger = log.child("outlook");

// ============================================================
// TYPES
// ============================================================

export interface OutlookMessage {
  id: string;
  subject: string;
  from: { emailAddress: { name: string; address: string } };
  toRecipients: Array<{ emailAddress: { name: string; address: string } }>;
  receivedDateTime: string;
  bodyPreview: string;
  body?: { contentType: string; content: string };
  isRead: boolean;
  hasAttachments: boolean;
  conversationId: string;
  webLink: string;
}

export interface OutlookSendPayload {
  subject: string;
  body: string;
  to: string[];
  cc?: string[];
}

// ============================================================
// AUTH — OAuth 2.0 via Microsoft identity platform
// ============================================================

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

// Read env lazily so tests can set process.env before calling functions
function env(key: string): string { return process.env[key] || ""; }

// "consumers" tenant for personal Microsoft accounts (Outlook.com/Hotmail)
const TOKEN_ENDPOINT = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";

export function isOutlookConfigured(): boolean {
  return !!(env("MICROSOFT_CLIENT_ID") && env("MICROSOFT_CLIENT_SECRET") && env("MICROSOFT_REFRESH_TOKEN"));
}

export function getOutlookEmail(): string {
  return env("MICROSOFT_USER_EMAIL");
}

/** Reset token cache — exported for tests only. */
export function _resetTokenCache(): void {
  cachedToken = null;
}

export async function initOutlook(): Promise<boolean> {
  if (!isOutlookConfigured()) {
    console.log("[outlook] Not configured — Microsoft Outlook disabled");
    return false;
  }

  const token = await getAccessToken();
  if (token) {
    console.log(`[outlook] Initialized (account: ${getOutlookEmail() || "unknown"})`);
    return true;
  }
  logger.error("Token refresh failed at init");
  return false;
}

async function getAccessToken(): Promise<string | null> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.accessToken;
  }

  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env("MICROSOFT_CLIENT_ID"),
        client_secret: env("MICROSOFT_CLIENT_SECRET"),
        refresh_token: env("MICROSOFT_REFRESH_TOKEN"),
        grant_type: "refresh_token",
        scope: "Mail.Read Mail.Send Mail.ReadWrite offline_access User.Read",
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error("Token refresh failed", { status: res.status, body: body.substring(0, 300) });
      return null;
    }

    const data = await res.json();
    cachedToken = {
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    };
    return cachedToken.accessToken;
  } catch (err) {
    logger.error("Token refresh error", err);
    return null;
  }
}

// ============================================================
// GRAPH API HELPERS
// ============================================================

const GRAPH_BASE = "https://graph.microsoft.com/v1.0/me";

async function graphFetch(path: string, options?: RequestInit): Promise<any> {
  const token = await getAccessToken();
  if (!token) throw new Error("Outlook not authenticated");

  const res = await fetch(`${GRAPH_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph API error (${res.status}): ${body.substring(0, 500)}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

// ============================================================
// EMAIL OPERATIONS
// ============================================================

/** List unread messages in inbox. */
export async function listUnread(limit: number = 10): Promise<OutlookMessage[]> {
  const params = new URLSearchParams({
    $filter: "isRead eq false",
    $top: String(limit),
    $orderby: "receivedDateTime desc",
    $select: "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments,conversationId,webLink",
  });
  const data = await graphFetch(`/mailFolders/inbox/messages?${params}`);
  return data?.value || [];
}

/** Get unread count for inbox. */
export async function getUnreadCount(): Promise<number> {
  const data = await graphFetch("/mailFolders/inbox?$select=unreadItemCount");
  return data?.unreadItemCount || 0;
}

/** Search messages using Microsoft Graph $search. */
export async function searchMessages(query: string, limit: number = 10): Promise<OutlookMessage[]> {
  const params = new URLSearchParams({
    $search: `"${query}"`,
    $top: String(limit),
    $select: "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments,conversationId,webLink",
  });
  const data = await graphFetch(`/messages?${params}`);
  return data?.value || [];
}

/** Get full message content by ID. */
export async function getMessage(messageId: string): Promise<OutlookMessage> {
  return graphFetch(`/messages/${encodeURIComponent(messageId)}`);
}

/** Send a new email. */
export async function sendEmail(payload: OutlookSendPayload): Promise<void> {
  const message: Record<string, any> = {
    subject: payload.subject,
    body: { contentType: "Text", content: payload.body },
    toRecipients: payload.to.map((addr) => ({
      emailAddress: { address: addr },
    })),
  };
  if (payload.cc?.length) {
    message.ccRecipients = payload.cc.map((addr) => ({
      emailAddress: { address: addr },
    }));
  }
  await graphFetch("/sendMail", {
    method: "POST",
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
  console.log(`[outlook] Email sent: "${payload.subject}" to ${payload.to.join(", ")}`);
}

/** Reply to an existing message. */
export async function replyToMessage(messageId: string, comment: string): Promise<void> {
  await graphFetch(`/messages/${encodeURIComponent(messageId)}/reply`, {
    method: "POST",
    body: JSON.stringify({ comment }),
  });
  console.log(`[outlook] Reply sent to message ${messageId.substring(0, 20)}...`);
}

/** Mark a message as read. */
export async function markAsRead(messageId: string): Promise<void> {
  await graphFetch(`/messages/${encodeURIComponent(messageId)}`, {
    method: "PATCH",
    body: JSON.stringify({ isRead: true }),
  });
}
