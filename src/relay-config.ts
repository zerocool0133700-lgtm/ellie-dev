/**
 * Relay configuration — constants, env vars, and context docket.
 *
 * Extracted from relay.ts — ELLIE-184 Phase 0.
 */

import { createHmac } from "crypto";
import { join, dirname } from "path";
import type { IncomingMessage } from "http";
import { log } from "./logger.ts";

const logger = log.child("relay-config");

export const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
export const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
export const PROJECT_DIR = process.env.PROJECT_DIR || "";
export const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");

// Agent mode: gives Claude access to tools (Read, Write, Bash, etc.)
export const AGENT_MODE = process.env.AGENT_MODE !== "false"; // on by default
export const DEFAULT_TOOLS = "Read,Edit,Write,Bash,Glob,Grep,WebSearch,WebFetch";
export const MCP_TOOLS = "mcp__google-workspace__*,mcp__github__*,mcp__memory__*,mcp__sequential-thinking__*,mcp__plane__*,mcp__claude_ai_Miro__*,mcp__brave-search__*,mcp__excalidraw__*,mcp__forest-bridge__*";
export const ALLOWED_TOOLS = (process.env.ALLOWED_TOOLS || `${DEFAULT_TOOLS},${MCP_TOOLS}`).split(",").map(t => t.trim());

// Voice call config
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
export const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
export const HTTP_PORT = parseInt(process.env.HTTP_PORT || "3000");
export const PUBLIC_URL = process.env.PUBLIC_URL || "";
export const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
export const EXTENSION_API_KEY = process.env.EXTENSION_API_KEY || "";
export const ALLOWED_CALLERS: Set<string> = new Set(
  [process.env.DAVE_PHONE_NUMBER, ...(process.env.ALLOWED_CALLERS || "").split(",")]
    .map(n => n?.trim().replace(/\D/g, ""))
    .filter(Boolean)
);

/**
 * Validate Twilio webhook signature (X-Twilio-Signature).
 * Uses HMAC-SHA1 with the auth token over the full URL + sorted POST params.
 */
export function validateTwilioSignature(
  req: IncomingMessage,
  body: string,
): boolean {
  if (!TWILIO_AUTH_TOKEN) return true; // Skip validation if not configured
  const signature = req.headers["x-twilio-signature"] as string;
  if (!signature) return false;

  const protocol = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  const url = `${protocol}://${host}${req.url}`;

  // Parse form-encoded body and sort params alphabetically
  const params = new URLSearchParams(body);
  const sortedKeys = [...params.keys()].sort();
  let dataString = url;
  for (const key of sortedKeys) {
    dataString += key + params.get(key);
  }

  const expected = createHmac("sha1", TWILIO_AUTH_TOKEN)
    .update(dataString)
    .digest("base64");

  return signature === expected;
}

// Google Chat space for notifications
export const GCHAT_SPACE_NOTIFY = process.env.GOOGLE_CHAT_SPACE_NAME || "";

// Directories
export const TEMP_DIR = join(RELAY_DIR, "temp");
export const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// ============================================================
// CONTEXT DOCKET
// ============================================================

const CONTEXT_ENDPOINT = "http://localhost:3000/api/context";
let cachedContext: { document: string; fetchedAt: number } | null = null;
const CONTEXT_CACHE_MS = 5 * 60_000; // cache for 5 minutes

export async function getContextDocket(): Promise<string> {
  const now = Date.now();
  if (cachedContext && now - cachedContext.fetchedAt < CONTEXT_CACHE_MS) {
    return cachedContext.document;
  }
  try {
    const res = await fetch(CONTEXT_ENDPOINT);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cachedContext = { document: data.document, fetchedAt: now };
    console.log("[context] Loaded context docket");
    return data.document;
  } catch (err) {
    logger.error("Failed to fetch context docket", err);
    return cachedContext?.document || "";
  }
}

/** Invalidate the cached context so the next call fetches fresh data. */
export function clearContextCache(): void {
  cachedContext = null;
}
