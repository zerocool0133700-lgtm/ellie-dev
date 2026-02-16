/**
 * Google Chat Module
 *
 * Handles authentication, message sending, and webhook parsing
 * for Google Chat integration. Uses a service account for auth
 * (JWT signed with Node.js crypto — no extra dependencies).
 */

import { readFile } from "fs/promises";
import { createSign } from "crypto";

// ============================================================
// TYPES
// ============================================================

export interface GoogleChatEvent {
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

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

// ============================================================
// AUTH — Service Account JWT → Access Token
// ============================================================

let serviceAccount: ServiceAccountKey | null = null;
let cachedToken: CachedToken | null = null;

/**
 * Load and cache the service account key from disk.
 * Call at startup — returns false if not configured (graceful skip).
 */
export async function initGoogleChat(): Promise<boolean> {
  const keyPath = process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_KEY_PATH;
  if (!keyPath) {
    console.log("[gchat] No GOOGLE_CHAT_SERVICE_ACCOUNT_KEY_PATH — Google Chat disabled");
    return false;
  }

  try {
    const raw = await readFile(keyPath, "utf-8");
    serviceAccount = JSON.parse(raw);
    console.log("[gchat] Service account loaded:", serviceAccount!.client_email);
    return true;
  } catch (err) {
    console.error("[gchat] Failed to load service account key:", err);
    return false;
  }
}

/**
 * Get a valid access token, refreshing if expired.
 * Signs a JWT with the service account private key and exchanges it
 * at Google's token endpoint. Caches for ~55 minutes.
 */
async function getAccessToken(): Promise<string> {
  if (!serviceAccount) throw new Error("Google Chat not initialized");

  // Return cached token if still valid (with 5-min buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60_000) {
    return cachedToken.accessToken;
  }

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

  console.log("[gchat] Access token refreshed");
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
 * Returns null if the event isn't a user message (e.g., bot added to space).
 */
export function parseGoogleChatEvent(event: GoogleChatEvent): ParsedGoogleChatMessage | null {
  // Only process MESSAGE events with actual text
  if (event.type !== "MESSAGE" || !event.message?.text) {
    console.log(`[gchat] Ignoring event type: ${event.type}`);
    return null;
  }

  // Strip the bot @mention if present (Chat prepends it in spaces)
  const text = event.message.text.replace(/^@\S+\s*/, "").trim();
  if (!text) return null;

  return {
    text,
    spaceName: event.space.name,
    threadName: event.message.thread?.name || null,
    senderEmail: event.message.sender.email,
    senderName: event.message.sender.displayName,
    messageName: event.message.name,
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
  return serviceAccount !== null;
}
