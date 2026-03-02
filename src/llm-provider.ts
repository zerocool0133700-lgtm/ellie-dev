/**
 * LLM Provider Fallback — ELLIE-408
 *
 * Tracks Anthropic availability and provides OpenAI (GPT-4o) fallback
 * for basic conversation when Claude is unreachable.
 *
 * Flow:
 *   - callClaude() succeeds → recordAnthropicSuccess() resets failure counter
 *   - callClaude() fails with outage error → recordAnthropicFailure() bumps counter
 *   - After FAILURE_THRESHOLD consecutive failures → fallback activates
 *   - Recovery probe runs every 2 min via relay housekeeping interval
 *   - On successful probe → recordAnthropicSuccess() deactivates fallback
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { log } from "./logger.ts";

const logger = log.child("llm-provider");

const FAILURE_THRESHOLD = 2;
const RECOVERY_PROBE_MS = 120_000; // 2 minutes

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const PROJECT_ROOT = dirname(dirname(import.meta.path));
const SOUL_PATH = join(PROJECT_ROOT, "config", "soul.md");

// ── State ────────────────────────────────────────────────────

let consecutiveFailures = 0;
let fallbackActive = false;
let fallbackJustActivated = false;
let lastRecoveryProbeAt = 0;
let soulPromptCache: string | null = null;

// ── Outage detection ─────────────────────────────────────────

export function isOutageError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("529") ||
    msg.includes("overload") ||
    msg.includes("service unavail") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("api error") ||
    msg.includes("connection refused") ||
    // Claude CLI outputs this when it can't reach Anthropic
    msg.includes("anthropic") && (msg.includes("error") || msg.includes("fail"))
  );
}

// ── Failure tracking ─────────────────────────────────────────

export function recordAnthropicSuccess(): void {
  if (consecutiveFailures > 0 || fallbackActive) {
    logger.info(`Anthropic back online after ${consecutiveFailures} failures`);
  }
  consecutiveFailures = 0;
  fallbackActive = false;
  fallbackJustActivated = false;
}

export function recordAnthropicFailure(err: unknown): void {
  if (!isOutageError(err)) return; // ignore non-outage errors (user input errors, etc.)
  consecutiveFailures++;
  logger.warn(`Anthropic failure #${consecutiveFailures}: ${err instanceof Error ? err.message.substring(0, 100) : String(err).substring(0, 100)}`);
  if (!fallbackActive && consecutiveFailures >= FAILURE_THRESHOLD) {
    fallbackActive = true;
    fallbackJustActivated = true;
    logger.warn("Anthropic outage threshold reached — activating OpenAI fallback");
  }
}

export function isFallbackActive(): boolean {
  return fallbackActive;
}

/**
 * Returns true exactly once when fallback first activates.
 * Used to send the one-time user notification.
 */
export function consumeFallbackJustActivated(): boolean {
  if (fallbackJustActivated) {
    fallbackJustActivated = false;
    return true;
  }
  return false;
}

export function shouldProbeRecovery(): boolean {
  if (!fallbackActive) return false;
  return Date.now() - lastRecoveryProbeAt >= RECOVERY_PROBE_MS;
}

export function markRecoveryProbeAttempted(): void {
  lastRecoveryProbeAt = Date.now();
}

// ── Soul prompt loading ───────────────────────────────────────

async function loadSoulPrompt(): Promise<string> {
  if (soulPromptCache) return soulPromptCache;
  try {
    const raw = await readFile(SOUL_PATH, "utf-8");
    // Trim to first 2000 chars to stay within OpenAI system prompt limits
    soulPromptCache = raw.substring(0, 2000);
    return soulPromptCache;
  } catch {
    return "You are Ellie, a personal AI assistant. Be helpful, warm, and concise.";
  }
}

// ── OpenAI fallback ───────────────────────────────────────────

/**
 * Call OpenAI GPT-4o for fallback conversation.
 * Uses fetch directly — no SDK required.
 */
export async function callOpenAiFallback(userText: string): Promise<string> {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not configured — cannot use fallback");
  }

  const systemPrompt = await loadSoulPrompt();

  const body = JSON.stringify({
    model: "gpt-4o",
    max_tokens: 2048,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
  });

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`OpenAI fallback error ${resp.status}: ${errText.substring(0, 200)}`);
  }

  const data = await resp.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  return data.choices?.[0]?.message?.content?.trim() ?? "";
}
