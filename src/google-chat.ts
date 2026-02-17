/**
 * Google Chat Module
 *
 * Handles authentication, message sending, and webhook parsing
 * for Google Chat integration. Supports two auth methods:
 *
 * 1. OAuth 2.0 (preferred) — uses client credentials + refresh token
 * 2. Service Account JWT — signs JWTs with a private key file
 *
 * Set GOOGLE_CHAT_OAUTH_CLIENT_ID / SECRET / REFRESH_TOKEN for OAuth,
 * or GOOGLE_CHAT_SERVICE_ACCOUNT_KEY_PATH for service account.
 */

import { readFile } from "fs/promises";
import { createSign } from "crypto";

// ============================================================
// TYPES
// ============================================================

/** Legacy webhook format (type/message/space at top level) */
export interface GoogleChatEventLegacy {
  type: string;
  eventTime: string;
  space: { name: string; type: string; displayName?: string };
  message?: {
    name: string;
    text: string;
    thread?: { name: string };
    sender: { name: string; displayName: string; email: string; type: string };
    createTime: string;
  };
  user?: { name: string; displayName: string; email: string; type: string };
}

/** New Workspace Add-on webhook format (data nested under chat.messagePayload) */
export interface GoogleChatEventNew {
  commonEventObject?: { hostApp: string; platform: string };
  chat: {
    user?: { name: string; displayName: string; email: string; type: string };
    eventTime: string;
    messagePayload?: {
      space: { name: string; type: string; displayName?: string };
      message: {
        name: string;
        text: string;
        argumentText?: string;
        thread?: { name: string };
        sender: { name: string; displayName: string; email: string; type: string };
        createTime: string;
        space?: { name: string };
      };
    };
    addedToSpacePayload?: {
      space: { name: string; type: string };
    };
  };
}

/** Union of both webhook formats */
export type GoogleChatEvent = GoogleChatEventLegacy | GoogleChatEventNew;

export interface ParsedGoogleChatMessage {
  text: string;
  spaceName: string;
  threadName: string | null;
  senderEmail: string;
  senderName: string;
  messageName: string;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

type AuthMethod = "oauth" | "service_account";

// ============================================================
// AUTH — OAuth 2.0 or Service Account JWT → Access Token
// ============================================================

let authMethod: AuthMethod | null = null;
let serviceAccount: ServiceAccountKey | null = null;
let oauthCreds: OAuthCredentials | null = null;
let cachedToken: CachedToken | null = null;

/**
 * Initialize Google Chat auth. Tries OAuth first, then service account.
 * Call at startup — returns false if not configured (graceful skip).
 */
export async function initGoogleChat(): Promise<boolean> {
  // Try OAuth 2.0 first
  const clientId = process.env.GOOGLE_CHAT_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CHAT_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_CHAT_OAUTH_REFRESH_TOKEN;

  if (clientId && clientSecret && refreshToken) {
    oauthCreds = { clientId, clientSecret, refreshToken };
    authMethod = "oauth";
    console.log("[gchat] OAuth 2.0 credentials loaded (client:", clientId.substring(0, 20) + "...)");
    return true;
  }

  // Fall back to service account
  const keyPath = process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_KEY_PATH;
  if (!keyPath) {
    console.log("[gchat] No OAuth or service account configured — Google Chat disabled");
    return false;
  }

  try {
    const raw = await readFile(keyPath, "utf-8");
    serviceAccount = JSON.parse(raw);
    authMethod = "service_account";
    console.log("[gchat] Service account loaded:", serviceAccount!.client_email);
    return true;
  } catch (err) {
    console.error("[gchat] Failed to load service account key:", err);
    return false;
  }
}

/**
 * Get a valid access token using the configured auth method.
 * Caches tokens and refreshes when expired (with 5-min buffer).
 */
async function getAccessToken(): Promise<string> {
  if (!authMethod) throw new Error("Google Chat not initialized");

  // Return cached token if still valid (with 5-min buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60_000) {
    return cachedToken.accessToken;
  }

  if (authMethod === "oauth") {
    return refreshOAuthToken();
  } else {
    return refreshServiceAccountToken();
  }
}

/** Refresh using OAuth 2.0 client credentials + refresh token. */
async function refreshOAuthToken(): Promise<string> {
  if (!oauthCreds) throw new Error("OAuth credentials not loaded");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: oauthCreds.clientId,
      client_secret: oauthCreds.clientSecret,
      refresh_token: oauthCreds.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OAuth token refresh failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };

  console.log("[gchat] OAuth access token refreshed");
  return cachedToken.accessToken;
}

/** Refresh using service account JWT assertion. */
async function refreshServiceAccountToken(): Promise<string> {
  if (!serviceAccount) throw new Error("Service account not loaded");

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/chat.bot",
    aud: serviceAccount.token_uri,
    iat: now,
    exp: now + 3600,
  })).toString("base64url");

  const signInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signInput);
  const signature = signer.sign(serviceAccount.private_key, "base64url");

  const jwt = `${signInput}.${signature}`;

  const res = await fetch(serviceAccount.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  console.log("[gchat] Service account access token refreshed");
  return cachedToken.accessToken;
}

// ============================================================
// SEND MESSAGES
// ============================================================

const GCHAT_MAX_LENGTH = 4000; // Google Chat limit is 4096, leave margin

/**
 * Split a long message at paragraph boundaries.
 */
function splitMessage(text: string): string[] {
  if (text.length <= GCHAT_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= GCHAT_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try paragraph break, then line break, then space
    let splitIndex = remaining.lastIndexOf("\n\n", GCHAT_MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", GCHAT_MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", GCHAT_MAX_LENGTH);
    if (splitIndex === -1) splitIndex = GCHAT_MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}

/**
 * Send a message to a Google Chat space, optionally in a thread.
 * Automatically splits long messages.
 */
export async function sendGoogleChatMessage(
  spaceName: string,
  text: string,
  threadName?: string | null,
): Promise<void> {
  const token = await getAccessToken();
  const chunks = splitMessage(text);

  for (const chunk of chunks) {
    const body: Record<string, unknown> = { text: chunk };
    if (threadName) {
      body.thread = { name: threadName };
    }

    // messageReplyOption ensures replies stay in-thread
    let url = `https://chat.googleapis.com/v1/${spaceName}/messages`;
    if (threadName) {
      url += "?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD";
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[gchat] Send failed (${res.status}):`, errBody);
      throw new Error(`Google Chat send failed: ${res.status}`);
    }
  }
}

// ============================================================
// PARSE WEBHOOK EVENTS
// ============================================================

/**
 * Parse an incoming Google Chat webhook event into a simple message structure.
 * Supports both the legacy format (type/message at top level) and the new
 * Workspace Add-on format (data nested under chat.messagePayload).
 * Returns null if the event isn't a user message (e.g., bot added to space).
 */
export function parseGoogleChatEvent(event: GoogleChatEvent): ParsedGoogleChatMessage | null {
  // Detect new Workspace Add-on format (has chat.messagePayload)
  if ("chat" in event && (event as GoogleChatEventNew).chat?.messagePayload) {
    const newEvent = event as GoogleChatEventNew;
    const payload = newEvent.chat.messagePayload!;
    const msg = payload.message;

    if (!msg?.text) {
      console.log("[gchat] New format event has no message text — ignoring");
      return null;
    }

    const text = msg.text.replace(/^@\S+\s*/, "").trim();
    if (!text) return null;

    return {
      text,
      spaceName: payload.space.name,
      threadName: msg.thread?.name || null,
      senderEmail: msg.sender.email,
      senderName: msg.sender.displayName,
      messageName: msg.name,
    };
  }

  // Legacy format: type/message/space at top level
  const legacy = event as GoogleChatEventLegacy;
  if (legacy.type !== "MESSAGE" || !legacy.message?.text) {
    console.log(`[gchat] Ignoring event type: ${legacy.type}`);
    return null;
  }

  const text = legacy.message.text.replace(/^@\S+\s*/, "").trim();
  if (!text) return null;

  return {
    text,
    spaceName: legacy.space.name,
    threadName: legacy.message.thread?.name || null,
    senderEmail: legacy.message.sender.email,
    senderName: legacy.message.sender.displayName,
    messageName: legacy.message.name,
  };
}

// ============================================================
// SENDER VALIDATION
// ============================================================

/**
 * Check if the sender is the allowed user.
 */
export function isAllowedSender(email: string): boolean {
  const allowed = process.env.GOOGLE_CHAT_ALLOWED_EMAIL;
  if (!allowed) {
    console.warn("[gchat] GOOGLE_CHAT_ALLOWED_EMAIL not set — rejecting all messages");
    return false;
  }
  return email.toLowerCase() === allowed.toLowerCase();
}

/**
 * Check if Google Chat is configured and ready.
 */
export function isGoogleChatEnabled(): boolean {
  return authMethod !== null;
}
