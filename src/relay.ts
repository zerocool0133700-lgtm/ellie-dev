/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context, InputFile, InlineKeyboard } from "grammy";
import { spawn } from "bun";
import { createHmac } from "crypto";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { WebSocketServer, WebSocket } from "ws";
import Anthropic from "@anthropic-ai/sdk";
import { transcribe } from "./transcribe.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
  getRecentMessages,
} from "./memory.ts";
import { consolidateNow } from "./consolidate-inline.ts";
import { indexMessage, searchElastic } from "./elasticsearch.ts";
import { getForestContext, initForestSync } from "./elasticsearch/context.ts";
import {
  initGoogleChat,
  parseGoogleChatEvent,
  sendGoogleChatMessage,
  isAllowedSender,
  isGoogleChatEnabled,
  type GoogleChatEvent,
} from "./google-chat.ts";
import {
  deliverMessage,
  acknowledgeChannel,
  startNudgeChecker,
  type DeliveryResult,
} from "./delivery.ts";
import {
  routeAndDispatch,
  syncResponse,
  dispatchAgent,
  type DispatchResult,
} from "./agent-router.ts";
import { initClassifier } from "./intent-classifier.ts";
import { initEntailmentClassifier } from "./entailment-classifier.ts";
import { getStructuredContext, getAgentStructuredContext } from "./context-sources.ts";
import {
  initOutlook,
  isOutlookConfigured,
  getOutlookEmail,
  listUnread as outlookListUnread,
  searchMessages as outlookSearchMessages,
  getMessage as outlookGetMessage,
  sendEmail as outlookSendEmail,
  replyToMessage as outlookReplyToMessage,
  markAsRead as outlookMarkAsRead,
} from "./outlook.ts";
import {
  executeOrchestrated,
  PipelineStepError,
  type PipelineStep,
  type ExecutionResult,
} from "./orchestrator.ts";
import type { ExecutionMode } from "./intent-classifier.ts";
import {
  extractApprovalTags,
  storePendingAction,
  getPendingAction,
  removePendingAction,
  startExpiryCleanup,
} from "./approval.ts";
import {
  isPlaneConfigured,
  fetchWorkItemDetails,
  listOpenIssues,
  setTimeoutRecoveryLock,
} from "./plane.ts";
import { notify, type NotifyContext } from "./notification-policy.ts";
import {
  getOrCreateConversation,
  attachMessage,
  maybeGenerateSummary,
  closeActiveConversation,
  closeConversation,
  expireIdleConversations,
  getConversationContext,
} from "./conversations.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");

// Agent mode: gives Claude access to tools (Read, Write, Bash, etc.)
const AGENT_MODE = process.env.AGENT_MODE !== "false"; // on by default
// Agent model override: when true, per-agent model settings are passed to CLI (uses API credits instead of Max subscription)
const AGENT_MODEL_OVERRIDE = process.env.AGENT_MODEL_OVERRIDE === "true"; // off by default
const DEFAULT_TOOLS = "Read,Edit,Write,Bash,Glob,Grep,WebSearch,WebFetch";
const MCP_TOOLS = "mcp__google-workspace__*,mcp__github__*,mcp__memory__*,mcp__sequential-thinking__*,mcp__plane__*,mcp__claude_ai_Miro__*,mcp__brave-search__*,mcp__excalidraw__*";
const ALLOWED_TOOLS = (process.env.ALLOWED_TOOLS || `${DEFAULT_TOOLS},${MCP_TOOLS}`).split(",").map(t => t.trim());

// Voice call config
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
const HTTP_PORT = parseInt(process.env.HTTP_PORT || "3000");
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const EXTENSION_API_KEY = process.env.EXTENSION_API_KEY || "";
const SILENCE_THRESHOLD_MS = 800; // ms of silence after speech to trigger processing
const MIN_AUDIO_MS = 400;
const TMP_DIR = process.env.TMPDIR || "/tmp";

/**
 * Validate Twilio webhook signature (X-Twilio-Signature).
 * Uses HMAC-SHA1 with the auth token over the full URL + sorted POST params.
 */
function validateTwilioSignature(
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

// Mulaw energy threshold — Twilio sends continuous packets even during silence.
// Mulaw silence center is 0xFF (positive) / 0x7F (negative). Values near these are quiet.
// We measure "energy" as deviation from the silence point.
const MULAW_ENERGY_THRESHOLD = 10; // average energy per sample to count as speech

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Session tracking for conversation continuity
const SESSION_FILE = join(RELAY_DIR, "session.json");

interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

// Track active agent per channel (Telegram, GChat, etc.)
const activeAgentByChannel = new Map<string, string>();
function getActiveAgent(channel = "telegram"): string {
  return activeAgentByChannel.get(channel) ?? "general";
}
function setActiveAgent(channel: string, agentName: string): void {
  activeAgentByChannel.set(channel, agentName);
}

// ============================================================
// CONTEXT DOCKET
// ============================================================

const CONTEXT_ENDPOINT = "http://localhost:3000/api/context";
let cachedContext: { document: string; fetchedAt: number } | null = null;
const CONTEXT_CACHE_MS = 5 * 60_000; // cache for 5 minutes

async function getContextDocket(): Promise<string> {
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
    console.error("[context] Failed to fetch context docket:", err);
    return cachedContext?.document || "";
  }
}

// ============================================================
// CONVERSATION END DETECTION
// ============================================================

const TELEGRAM_IDLE_MS = 10 * 60_000; // 10 minutes of silence = conversation over
let telegramIdleTimer: ReturnType<typeof setTimeout> | null = null;
let gchatIdleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Close the active conversation for a channel, extract memories,
 * then invalidate the context cache so the next interaction gets fresh data.
 * Falls back to legacy consolidation if conversation tracking isn't active.
 */
async function triggerConsolidation(channel?: string): Promise<void> {
  if (!supabase) return;
  try {
    if (channel) {
      // Try new conversation-based close first
      const closed = await closeActiveConversation(supabase, channel);
      if (closed) {
        cachedContext = null;
        console.log(`[conversation] Conversation closed (${channel}) — context cache cleared`);
        return;
      }
    }

    // Fallback to legacy consolidation for untracked messages
    const created = await consolidateNow(supabase, {
      channel,
      onComplete: () => {
        cachedContext = null;
      },
    });
    if (created) {
      console.log(`[consolidate] Conversation ended (${channel || "all"}) — context cache cleared`);
    }
  } catch (err) {
    console.error("[consolidate] Consolidation error:", err);
  }
}

/**
 * Reset the Telegram idle timer. Called after every Telegram message.
 * When the timer fires, it means no messages for 10 minutes = conversation over.
 */
function resetTelegramIdleTimer(): void {
  if (telegramIdleTimer) clearTimeout(telegramIdleTimer);
  telegramIdleTimer = setTimeout(() => {
    console.log("[consolidate] Telegram idle for 10 minutes — consolidating...");
    triggerConsolidation("telegram");
  }, TELEGRAM_IDLE_MS);
}

function resetGchatIdleTimer(): void {
  if (gchatIdleTimer) clearTimeout(gchatIdleTimer);
  gchatIdleTimer = setTimeout(() => {
    console.log("[consolidate] Google Chat idle for 10 minutes — consolidating...");
    triggerConsolidation("google-chat");
  }, TELEGRAM_IDLE_MS);
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

async function saveSession(state: SessionState): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

let session = await loadSession();

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0); // Check if process exists
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
      }
    }

    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

// Cleanup on exit
process.on("exit", () => {
  try {
    require("fs").unlinkSync(LOCK_FILE);
  } catch {}
});
process.on("SIGINT", async () => {
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await releaseLock();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. Create a new bot with /newbot");
  console.log("3. Copy the token to .env");
  process.exit(1);
}

// Create directories
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// ============================================================
// SUPABASE (optional — only if configured)
// ============================================================

const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

async function saveMessage(
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
  channel: string = "telegram"
): Promise<string | null> {
  if (!supabase) return null;
  try {
    // Get or create active conversation for this channel
    const conversationId = await getOrCreateConversation(supabase, channel);

    const { data } = await supabase.from("messages").insert({
      role,
      content,
      channel,
      metadata: metadata || {},
      conversation_id: conversationId,
    }).select("id").single();

    // Index to ES (fire-and-forget)
    if (data?.id) {
      indexMessage({
        id: data.id,
        content, role, channel,
        created_at: new Date().toISOString(),
      }).catch(() => {});

      // Update conversation stats + maybe generate rolling summary (fire-and-forget)
      if (conversationId) {
        attachMessage(supabase, data.id, conversationId).catch(() => {});
        maybeGenerateSummary(supabase, conversationId).catch(() => {});
      }
    }

    return data?.id || null;
  } catch (error) {
    console.error("Supabase save error:", error);
    return null;
  }
}

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

export const bot = new Bot(BOT_TOKEN);

// Start approval expiry cleanup
startExpiryCleanup();

// Periodic idle conversation expiry (every 5 minutes)
setInterval(() => {
  if (supabase) {
    expireIdleConversations(supabase).catch(() => {});
    expireStaleAgentSessions(supabase).catch(() => {});
  }
}, 5 * 60_000);

// Note: expireStaleWorkSessions (old Supabase work_sessions table) removed in ELLIE-88.
// Forest is now the source of truth for work sessions. See ellie-forest/src/work-sessions.ts.

/** Expire agent sessions that have been active for > 2 hours without activity */
async function expireStaleAgentSessions(sb: SupabaseClient): Promise<void> {
  const cutoff = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const { data, error } = await sb
    .from("agent_sessions")
    .update({ state: "completed", completed_at: new Date().toISOString() })
    .eq("state", "active")
    .lt("last_activity", cutoff)
    .select("id");

  if (error) {
    console.error("[session-cleanup] agent_sessions expire error:", error);
    return;
  }
  if (data && data.length > 0) {
    console.log(`[session-cleanup] Expired ${data.length} stale agent session(s)`);
  }
}

// ============================================================
// SECURITY: Only respond to authorized user
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();

  // If ALLOWED_USER_ID is set, enforce it
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${userId}`);
    await ctx.reply("This bot is private.");
    return;
  }

  await next();
});

// ============================================================
// CORE: Call Claude CLI
// ============================================================

async function callClaude(
  prompt: string,
  options?: { resume?: boolean; imagePath?: string; allowedTools?: string[]; model?: string; sessionId?: string }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  // Resume previous session if available and requested
  // Explicit sessionId override takes priority (used by approval handlers)
  const resumeSessionId = options?.sessionId || session.sessionId;
  if (options?.resume && resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  args.push("--output-format", "text");

  // Per-agent model override — opt-in via AGENT_MODEL_OVERRIDE=true env var
  // (specifying a model ID routes to API credits instead of the Max subscription default)
  if (AGENT_MODEL_OVERRIDE && options?.model) { args.push("--model", options.model); }

  // Agent mode: allow tools without interactive prompts
  if (AGENT_MODE) {
    const tools = options?.allowedTools?.length ? options.allowedTools : ALLOWED_TOOLS;
    args.push("--allowedTools", ...tools);
  }

  // Log CLI invocation details (redact prompt, show flags)
  const flagArgs = args.slice(1).filter(a => a.startsWith("--"));
  const resumeId = options?.resume && resumeSessionId ? resumeSessionId.slice(0, 8) : null;
  const toolCount = options?.allowedTools?.length || ALLOWED_TOOLS.length;
  console.log(
    `[claude] Invoking: prompt=${prompt.length} chars` +
    `${resumeId ? `, resume=${resumeId}` : ""}` +
    `, tools=${toolCount}` +
    `, flags=[${flagArgs.join(", ")}]`
  );

  try {
    const proc = spawn(args, {
      stdin: "ignore",   // Close stdin — prevents blocking on permission prompts
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || undefined,
      env: {
        ...process.env,
        CLAUDECODE: "",             // Prevent nested session detection
        ANTHROPIC_API_KEY: "",      // Don't override Max subscription with API key
      },
    });

    // Agentic tasks can take several minutes (tool use, multi-step reasoning)
    const TIMEOUT_MS = AGENT_MODE ? 420_000 : 60_000;
    let timedOut = false;
    let forceKilled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const timeout = setTimeout(() => {
      timedOut = true;
      const timeoutSec = TIMEOUT_MS / 1000;
      console.error(`[claude] Timeout after ${timeoutSec}s — sending SIGTERM (pid ${proc.pid})`);
      proc.kill(); // SIGTERM

      // Escalate to SIGKILL if process doesn't exit within 5s
      killTimer = setTimeout(() => {
        try {
          process.kill(proc.pid, 0); // Throws if process is dead
          console.error(`[claude] Process ${proc.pid} survived SIGTERM — sending SIGKILL`);
          proc.kill(9); // SIGKILL
          forceKilled = true;
        } catch {
          // Process already exited from SIGTERM — no action needed
        }
      }, 5_000);
    }, TIMEOUT_MS);

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error(
        `[claude] Exit code ${exitCode}` +
        `${timedOut ? " (timed out)" : ""}` +
        `${forceKilled ? " (force-killed)" : ""}` +
        `${stderr ? ` — stderr: ${stderr.substring(0, 500)}` : " — no stderr"}` +
        `${output ? ` — stdout preview: ${output.substring(0, 200)}` : ""}`
      );

      // Retry without --resume if the session history is corrupted
      // (e.g., tool_use.name exceeding API limits from a previous turn)
      const combined = (stderr + output).toLowerCase();
      if (options?.resume && resumeSessionId && combined.includes("tool_use.name")) {
        console.warn("[claude] Corrupted session history — retrying without --resume");
        return callClaude(prompt, { ...options, resume: false, sessionId: undefined });
      }

      // Timeout: return actionable message instead of generic error
      if (timedOut) {
        broadcastExtension({ type: "error", source: "callClaude", message: `Timeout after ${TIMEOUT_MS / 1000}s${forceKilled ? " (force-killed)" : ""}` });
        // Lock Plane state changes during recovery to prevent churn
        setTimeoutRecoveryLock(60_000);

        const timeoutSec = TIMEOUT_MS / 1000;
        const processStatus = forceKilled
          ? "The process did not respond to termination and was force-killed."
          : "The process was terminated.";

        const partialOutput = output?.trim();
        let message = `Task timed out after ${timeoutSec}s. ${processStatus}`;

        if (partialOutput) {
          const preview = partialOutput.length > 500
            ? partialOutput.substring(0, 500) + "..."
            : partialOutput;
          message += `\n\nPartial output before timeout:\n${preview}`;
        }

        message += `\n\nYou can retry the request, or ask "what did you get done?" to check if work was partially completed.`;

        return message;
      }

      // Exit 143 = SIGTERM (128+15) from external signal (e.g. service restart)
      if (exitCode === 143) {
        broadcastExtension({ type: "error", source: "callClaude", message: "SIGTERM (exit 143) — service restart or external kill" });
        const partialOutput = output?.trim();
        let message = "I got interrupted while working on this (the service was restarted or the process was terminated externally).";
        if (partialOutput) {
          const preview = partialOutput.length > 500
            ? partialOutput.substring(0, 500) + "..."
            : partialOutput;
          message += `\n\nHere's what I had so far:\n${preview}`;
        }
        message += "\n\nWant me to try again?";
        return message;
      }

      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
    }

    console.log(`[claude] Success: ${output.length} chars, exit ${exitCode}`);

    // Extract session ID from output if present (for --resume)
    const sessionMatch = output.match(/Session ID: ([a-f0-9-]+)/i);
    if (sessionMatch) {
      session.sessionId = sessionMatch[1];
      session.lastActivity = new Date().toISOString();
      await saveSession(session);
      console.log(`[claude] Session ID: ${session.sessionId.slice(0, 8)}`);
    }

    return output.trim();
  } catch (error) {
    console.error(`[claude] Spawn error:`, error);
    return `Error: Could not run Claude CLI`;
  }
}

// ============================================================
// TYPING HEARTBEAT + CONCURRENCY
// ============================================================

async function callClaudeWithTyping(
  ctx: Context,
  prompt: string,
  options?: { resume?: boolean; imagePath?: string; allowedTools?: string[]; model?: string }
): Promise<string> {
  // Send typing indicator every 4 seconds while Claude works
  const interval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4_000);

  try {
    return await callClaude(prompt, options);
  } finally {
    clearInterval(interval);
  }
}

// Concurrency guard: queue messages while Claude is working
interface QueueItem {
  task: () => Promise<void>;
  channel: string;
  preview: string;
  enqueuedAt: number;
}

let busy = false;
let currentItem: { channel: string; preview: string; startedAt: number } | null = null;
const messageQueue: QueueItem[] = [];

async function processQueue(): Promise<void> {
  while (messageQueue.length > 0) {
    const next = messageQueue.shift()!;
    currentItem = { channel: next.channel, preview: next.preview, startedAt: Date.now() };
    broadcastExtension({ type: "queue_status", busy: true, queueLength: messageQueue.length, current: currentItem });
    await next.task();
  }
  currentItem = null;
  busy = false;
  broadcastExtension({ type: "queue_status", busy: false, queueLength: 0, current: null });
}

/**
 * Enqueue a task for the shared Claude pipeline.
 * Used by non-Telegram channels (Google Chat) that don't have a grammY ctx.
 * Returns a promise that resolves when the task completes.
 */
function enqueue(
  task: () => Promise<void>,
  channel: string = "google-chat",
  preview: string = "(message)",
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const item: QueueItem = {
      task: async () => {
        try {
          await task();
          resolve();
        } catch (err) {
          reject(err);
        }
      },
      channel,
      preview,
      enqueuedAt: Date.now(),
    };

    if (busy) {
      messageQueue.push(item);
      return;
    }
    busy = true;
    currentItem = { channel: item.channel, preview: item.preview, startedAt: Date.now() };
    item.task().finally(() => processQueue());
  });
}

function withQueue(
  handler: (ctx: Context) => Promise<void>,
  previewExtractor?: (ctx: Context) => string,
) {
  return async (ctx: Context) => {
    const preview = previewExtractor
      ? previewExtractor(ctx)
      : (ctx.message?.text?.substring(0, 50) ?? "(no text)");

    if (busy) {
      const position = messageQueue.length + 1;
      await ctx.reply(`I'm working on something — I'll get to this next. (Queue position: ${position})`);
      messageQueue.push({
        task: () => handler(ctx),
        channel: "telegram",
        preview,
        enqueuedAt: Date.now(),
      });
      return;
    }
    busy = true;
    currentItem = { channel: "telegram", preview, startedAt: Date.now() };
    try {
      await handler(ctx);
    } finally {
      await processQueue();
    }
  };
}

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Text messages
bot.on("message:text", withQueue(async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from?.id.toString() || "";
  console.log(`Message: ${text.substring(0, 50)}...`);

  await ctx.replyWithChatAction("typing");
  acknowledgeChannel("telegram"); // User responded — clear pending responses

  await saveMessage("user", text);
  broadcastExtension({ type: "message_in", channel: "telegram", preview: text.substring(0, 200) });

  // Slash commands — direct responses, bypass Claude pipeline (ELLIE-113)
  if (text.startsWith("/search ")) {
    const query = text.slice(8).trim();
    if (!query) { await ctx.reply("Usage: /search <query>"); return; }
    try {
      const { searchForestSafe } = await import("./elasticsearch/search-forest.ts");
      const results = await searchForestSafe(query, { limit: 10 });
      await sendResponse(ctx, results || "No results found.");
    } catch (err) {
      console.error("[/search] Error:", err);
      await ctx.reply("Search failed — ES may be unavailable.");
    }
    return;
  }

  if (text === "/forest-metrics" || text.startsWith("/forest-metrics ")) {
    try {
      const { getForestMetricsSafe } = await import("./elasticsearch/search-forest.ts");
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const metrics = await getForestMetricsSafe({
        timeRange: { from: weekAgo.toISOString(), to: now.toISOString() },
      });
      await sendResponse(ctx, formatForestMetrics(metrics));
    } catch (err) {
      console.error("[/forest-metrics] Error:", err);
      await ctx.reply("Metrics failed — ES may be unavailable.");
    }
    return;
  }

  // Route message to appropriate agent via LLM classifier (falls back gracefully)
  const agentResult = await routeAndDispatch(supabase, text, "telegram", userId);
  const effectiveText = agentResult?.route.strippedMessage || text;
  if (agentResult) {
    setActiveAgent("telegram", agentResult.dispatch.agent.name);
    broadcastExtension({ type: "route", channel: "telegram", agent: agentResult.dispatch.agent.name, mode: agentResult.route.execution_mode, confidence: agentResult.route.confidence });

    // Dispatch confirmation — fire BEFORE Claude call (ELLIE-80)
    if (agentResult.dispatch.agent.name !== "general" && agentResult.dispatch.is_new) {
      await ctx.reply(`\u{1F916} ${agentResult.dispatch.agent.name} agent`);
    }
  }

  // Gather context: docket + semantic search + ES full-text search + structured sources + recent messages + forest
  const [contextDocket, relevantContext, elasticContext, structuredContext, recentMessages, forestContext] = await Promise.all([
    getContextDocket(),
    getRelevantContext(supabase, effectiveText),
    searchElastic(effectiveText, { limit: 5, recencyBoost: true }),
    getAgentStructuredContext(supabase, getActiveAgent("telegram")),
    getRecentMessages(supabase),
    getForestContext(effectiveText),
  ]);

  // Detect work item mentions (ELLIE-5, EVE-3, etc.)
  let workItemContext = "";
  const workItemMatch = effectiveText.match(/\b([A-Z]+-\d+)\b/);
  if (workItemMatch && isPlaneConfigured()) {
    const details = await fetchWorkItemDetails(workItemMatch[1]);
    if (details) {
      workItemContext = `\nACTIVE WORK ITEM: ${workItemMatch[1]}\n` +
        `Title: ${details.name}\n` +
        `Priority: ${details.priority}\n` +
        `Description: ${details.description}\n`;
    }
  }

  // ── Multi-step execution branch (ELLIE-58) ──
  if (agentResult?.route.execution_mode !== "single" && agentResult?.route.skills?.length) {
    const execMode = agentResult.route.execution_mode;
    const steps: PipelineStep[] = agentResult.route.skills.map((s) => ({
      agent_name: s.agent,
      skill_name: s.skill !== "none" ? s.skill : undefined,
      instruction: s.instruction,
    }));

    const modeLabels: Record<string, string> = { pipeline: "Pipeline", "fan-out": "Fan-out", "critic-loop": "Critic loop" };
    const agentNames = [...new Set(steps.map((s) => s.agent_name))].join(" \u2192 ");
    await ctx.reply(`\u{1F504} ${modeLabels[execMode] || execMode}: ${agentNames} (${steps.length} steps)`);

    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4_000);

    broadcastExtension({ type: "pipeline_start", channel: "telegram", mode: execMode, steps: steps.length });
    try {
      const result = await executeOrchestrated(execMode, steps, effectiveText, {
        supabase,
        channel: "telegram",
        userId,
        anthropicClient: anthropic,
        onHeartbeat: () => { ctx.replyWithChatAction("typing").catch(() => {}); },
        contextDocket, relevantContext, elasticContext,
        structuredContext, recentMessages, workItemContext, forestContext,
        buildPromptFn: buildPrompt,
        callClaudeFn: callClaude,
      });

      clearInterval(typingInterval);

      const agentName = result.finalDispatch?.agent?.name || agentResult?.dispatch.agent.name || "general";
      const pipelineResponse = await processMemoryIntents(supabase, result.finalResponse, agentName);
      const cleanedPipelineResponse = await sendWithApprovals(ctx, pipelineResponse, session.sessionId, agentName);
      await saveMessage("assistant", cleanedPipelineResponse);
      broadcastExtension({ type: "pipeline_complete", channel: "telegram", mode: execMode, steps: result.stepResults.length, duration_ms: result.artifacts.total_duration_ms, cost_usd: result.artifacts.total_cost_usd });

      if (result.finalDispatch) {
        await syncResponse(supabase, result.finalDispatch.session_id, cleanedPipelineResponse, {
          duration_ms: result.artifacts.total_duration_ms,
        });
      }

      console.log(
        `[orchestrator] ${execMode}: ${result.stepResults.length} steps in ${result.artifacts.total_duration_ms}ms, ` +
        `$${result.artifacts.total_cost_usd.toFixed(4)}`,
      );
    } catch (err) {
      clearInterval(typingInterval);
      if (err instanceof PipelineStepError && err.partialOutput) {
        console.error(`[orchestrator] Step ${err.stepIndex} failed (${err.errorType}), sending partial results`);
        const partialResponse = await processMemoryIntents(supabase, err.partialOutput, agentResult?.dispatch.agent.name || "general");
        await sendResponse(ctx, partialResponse + "\n\n(Execution incomplete \u2014 showing partial results.)");
        await saveMessage("assistant", partialResponse);
      } else {
        console.error("[orchestrator] Multi-step failed, falling back to single agent:", err);
        const fallbackPrompt = buildPrompt(
          effectiveText, contextDocket, relevantContext, elasticContext, "telegram",
          agentResult?.dispatch.agent ? { system_prompt: agentResult.dispatch.agent.system_prompt, name: agentResult.dispatch.agent.name, tools_enabled: agentResult.dispatch.agent.tools_enabled } : undefined,
          workItemContext, structuredContext, recentMessages,
          agentResult?.dispatch.skill_context,
          forestContext,
        );
        const fallbackRaw = await callClaudeWithTyping(ctx, fallbackPrompt, { resume: true });
        const fallbackAgentName = agentResult?.dispatch.agent.name || "general";
        const fallbackResponse = await processMemoryIntents(supabase, fallbackRaw, fallbackAgentName);
        const cleaned = await sendWithApprovals(ctx, fallbackResponse, session.sessionId, fallbackAgentName);
        await saveMessage("assistant", cleaned);
      }
    }

    resetTelegramIdleTimer();
    return;
  }

  // ── Single-agent path (default) ──
  const enrichedPrompt = buildPrompt(
    effectiveText, contextDocket, relevantContext, elasticContext, "telegram",
    agentResult?.dispatch.agent ? { system_prompt: agentResult.dispatch.agent.system_prompt, name: agentResult.dispatch.agent.name, tools_enabled: agentResult.dispatch.agent.tools_enabled } : undefined,
    workItemContext, structuredContext, recentMessages,
    agentResult?.dispatch.skill_context,
    forestContext,
  );

  const agentTools = agentResult?.dispatch.agent.tools_enabled;
  const agentModel = agentResult?.dispatch.agent.model;

  const startTime = Date.now();
  const rawResponse = await callClaudeWithTyping(ctx, enrichedPrompt, {
    resume: true,
    allowedTools: agentTools?.length ? agentTools : undefined,
    model: agentModel || undefined,
  });
  const durationMs = Date.now() - startTime;

  // Parse and save any memory intents, strip tags from response
  const response = await processMemoryIntents(supabase, rawResponse, agentResult?.dispatch.agent.name || "general");

  const cleanedResponse = await sendWithApprovals(ctx, response, session.sessionId, agentResult?.dispatch.agent.name);

  await saveMessage("assistant", cleanedResponse);
  broadcastExtension({ type: "message_out", channel: "telegram", agent: agentResult?.dispatch.agent.name || "general", preview: cleanedResponse.substring(0, 200) });

  // Sync response to agent session (fire-and-forget)
  if (agentResult) {
    const syncResult = await syncResponse(supabase, agentResult.dispatch.session_id, cleanedResponse, {
      duration_ms: durationMs,
    });
    if (syncResult?.new_session_id) {
      await ctx.reply("\u21AA\uFE0F Handing off to another agent...");
    }
  }

  resetTelegramIdleTimer();
}));

// Voice messages
bot.on("message:voice", withQueue(async (ctx) => {
  const voice = ctx.message.voice;
  console.log(`Voice message: ${voice.duration}s`);
  await ctx.replyWithChatAction("typing");

  if (!process.env.VOICE_PROVIDER) {
    await ctx.reply(
      "Voice transcription is not set up yet. " +
        "Run the setup again and choose a voice provider (Groq or local Whisper)."
    );
    return;
  }

  try {
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    const transcription = await transcribe(buffer);
    if (!transcription) {
      await ctx.reply("Could not transcribe voice message.");
      return;
    }

    await saveMessage("user", `[Voice ${voice.duration}s]: ${transcription}`);
    broadcastExtension({ type: "message_in", channel: "telegram", preview: `[Voice ${voice.duration}s]: ${transcription.substring(0, 150)}` });

    const voiceUserId = ctx.from?.id.toString() || "";
    const agentResult = await routeAndDispatch(supabase, transcription, "telegram", voiceUserId);
    const effectiveTranscription = agentResult?.route.strippedMessage || transcription;
    if (agentResult) {
      setActiveAgent("telegram", agentResult.dispatch.agent.name);
      broadcastExtension({ type: "route", channel: "telegram", agent: agentResult.dispatch.agent.name, mode: agentResult.route.execution_mode });
    }

    const [contextDocket, relevantContext, elasticContext, structuredContext, recentMessages, forestContext] = await Promise.all([
      getContextDocket(),
      getRelevantContext(supabase, effectiveTranscription),
      searchElastic(effectiveTranscription, { limit: 5, recencyBoost: true }),
      getAgentStructuredContext(supabase, getActiveAgent("telegram")),
      getRecentMessages(supabase),
      getForestContext(effectiveTranscription),
    ]);

    // ── Voice multi-step branch (ELLIE-58) ──
    if (agentResult?.route.execution_mode !== "single" && agentResult?.route.skills?.length) {
      const execMode = agentResult.route.execution_mode;
      const steps: PipelineStep[] = agentResult.route.skills.map((s) => ({
        agent_name: s.agent,
        skill_name: s.skill !== "none" ? s.skill : undefined,
        instruction: s.instruction,
      }));

      const modeLabels: Record<string, string> = { pipeline: "Pipeline", "fan-out": "Fan-out", "critic-loop": "Critic loop" };
      const agentNames = [...new Set(steps.map((s) => s.agent_name))].join(" \u2192 ");
      await ctx.reply(`\u{1F504} ${modeLabels[execMode] || execMode}: ${agentNames} (${steps.length} steps)`);

      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 4_000);

      try {
        const result = await executeOrchestrated(execMode, steps, effectiveTranscription, {
          supabase,
          channel: "telegram",
          userId: voiceUserId,
          anthropicClient: anthropic,
          onHeartbeat: () => { ctx.replyWithChatAction("typing").catch(() => {}); },
          contextDocket, relevantContext, elasticContext,
          structuredContext, recentMessages, forestContext,
          buildPromptFn: buildPrompt,
          callClaudeFn: callClaude,
        });

        clearInterval(typingInterval);
        const voiceAgentName = result.finalDispatch?.agent?.name || agentResult?.dispatch.agent.name || "general";
        const pipelineResponse = await processMemoryIntents(supabase, result.finalResponse, voiceAgentName);
        const cleaned = await sendWithApprovals(ctx, pipelineResponse, session.sessionId, voiceAgentName);
        await saveMessage("assistant", cleaned);

        if (result.finalDispatch) {
          await syncResponse(supabase, result.finalDispatch.session_id, cleaned, {
            duration_ms: result.artifacts.total_duration_ms,
          });
        }

        console.log(
          `[orchestrator] Voice ${execMode}: ${result.stepResults.length} steps in ${result.artifacts.total_duration_ms}ms, $${result.artifacts.total_cost_usd.toFixed(4)}`,
        );
      } catch (err) {
        clearInterval(typingInterval);
        if (err instanceof PipelineStepError && err.partialOutput) {
          const partialResponse = await processMemoryIntents(supabase, err.partialOutput, agentResult?.dispatch.agent.name || "general");
          await sendResponse(ctx, partialResponse + "\n\n(Execution incomplete \u2014 showing partial results.)");
          await saveMessage("assistant", partialResponse);
        } else {
          console.error("[orchestrator] Voice multi-step failed:", err);
          await ctx.reply("Multi-step execution failed \u2014 processing as single request.");
          const fallbackPrompt = buildPrompt(
            `[Voice message transcribed]: ${effectiveTranscription}`,
            contextDocket, relevantContext, elasticContext, "telegram",
            agentResult?.dispatch.agent ? { system_prompt: agentResult.dispatch.agent.system_prompt, name: agentResult.dispatch.agent.name, tools_enabled: agentResult.dispatch.agent.tools_enabled } : undefined,
            undefined, structuredContext, recentMessages,
            agentResult?.dispatch.skill_context,
            forestContext,
          );
          const fallbackRaw = await callClaudeWithTyping(ctx, fallbackPrompt, { resume: true });
          const voiceFallbackAgent = agentResult?.dispatch.agent.name || "general";
          const fallbackResponse = await processMemoryIntents(supabase, fallbackRaw, voiceFallbackAgent);
          const cleaned = await sendWithApprovals(ctx, fallbackResponse, session.sessionId, voiceFallbackAgent);
          await saveMessage("assistant", cleaned);
        }
      }

      resetTelegramIdleTimer();
      return;
    }

    // ── Voice single-agent path (default) ──
    const enrichedPrompt = buildPrompt(
      `[Voice message transcribed]: ${effectiveTranscription}`,
      contextDocket,
      relevantContext,
      elasticContext,
      "telegram",
      agentResult?.dispatch.agent ? { system_prompt: agentResult.dispatch.agent.system_prompt, name: agentResult.dispatch.agent.name, tools_enabled: agentResult.dispatch.agent.tools_enabled } : undefined,
      undefined, structuredContext, recentMessages,
      agentResult?.dispatch.skill_context,
      forestContext,
    );

    const agentTools = agentResult?.dispatch.agent.tools_enabled;
    const agentModel = agentResult?.dispatch.agent.model;

    const startTime = Date.now();
    const rawResponse = await callClaudeWithTyping(ctx, enrichedPrompt, {
      resume: true,
      allowedTools: agentTools?.length ? agentTools : undefined,
      model: agentModel || undefined,
    });
    const durationMs = Date.now() - startTime;
    const claudeResponse = await processMemoryIntents(supabase, rawResponse, agentResult?.dispatch.agent.name || "general");

    // Try voice response for short replies without approval buttons
    const TTS_MAX_CHARS = 1500;
    const { cleanedText, confirmations } = extractApprovalTags(claudeResponse);

    if (confirmations.length === 0 && cleanedText.length <= TTS_MAX_CHARS && ELEVENLABS_API_KEY) {
      const audioBuffer = await textToSpeechOgg(cleanedText);
      if (audioBuffer) {
        await ctx.replyWithVoice(new InputFile(audioBuffer, "response.ogg"));
        await sendResponse(ctx, cleanedText);
        await saveMessage("assistant", cleanedText);

        if (agentResult) {
          syncResponse(supabase, agentResult.dispatch.session_id, cleanedText, {
            duration_ms: durationMs,
          }).catch(() => {});
        }

        resetTelegramIdleTimer();
        return;
      }
    }

    // Fall back to text (long response, TTS failure, or approval buttons)
    const cleanedResponse = await sendWithApprovals(ctx, claudeResponse, session.sessionId, agentResult?.dispatch.agent.name);

    await saveMessage("assistant", cleanedResponse);

    if (agentResult) {
      syncResponse(supabase, agentResult.dispatch.session_id, cleanedResponse, {
        duration_ms: durationMs,
      }).catch(() => {});
    }

    resetTelegramIdleTimer();
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.reply("Could not process voice message. Check logs for details.");
  }
}, (ctx) => `[Voice ${ctx.message?.voice?.duration ?? 0}s]`));

// Photos/Images
bot.on("message:photo", withQueue(async (ctx) => {
  console.log("Image received");
  await ctx.replyWithChatAction("typing");

  try {
    // Get highest resolution photo
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    // Download the image
    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    // Claude Code can see images via file path
    const caption = ctx.message.caption || "Analyze this image.";
    const prompt = `[Image: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Image]: ${caption}`);

    const claudeResponse = await callClaudeWithTyping(ctx, prompt, { resume: true });

    // Cleanup after processing
    await unlink(filePath).catch(() => {});

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse, getActiveAgent("telegram"));
    const finalResponse = await sendWithApprovals(ctx, cleanResponse, session.sessionId, getActiveAgent("telegram"));
    await saveMessage("assistant", finalResponse);
    resetTelegramIdleTimer();
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  }
}, (ctx) => ctx.message?.caption?.substring(0, 50) ?? "[Photo]"));

// Documents
bot.on("message:document", withQueue(async (ctx) => {
  const doc = ctx.message.document;
  console.log(`Document: ${doc.file_name}`);
  await ctx.replyWithChatAction("typing");

  try {
    const file = await ctx.getFile();
    const timestamp = Date.now();
    const fileName = doc.file_name || `file_${timestamp}`;
    const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    const prompt = `[File: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Document: ${doc.file_name}]: ${caption}`);

    const claudeResponse = await callClaudeWithTyping(ctx, prompt, { resume: true });

    await unlink(filePath).catch(() => {});

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse, getActiveAgent("telegram"));
    const finalResponse = await sendWithApprovals(ctx, cleanResponse, session.sessionId, getActiveAgent("telegram"));
    await saveMessage("assistant", finalResponse);
    resetTelegramIdleTimer();
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  }
}, (ctx) => ctx.message?.document?.file_name ?? "[Document]"));

// ============================================================
// APPROVAL CALLBACKS
// ============================================================

bot.callbackQuery(/^approve:(.+)$/, withQueue(async (ctx) => {
  const actionId = ctx.match![1];
  const action = getPendingAction(actionId);

  if (!action) {
    await ctx.answerCallbackQuery({ text: "This action has expired." });
    return;
  }

  await ctx.editMessageText(`\u2705 Approved: ${action.description}`);
  await ctx.answerCallbackQuery({ text: "Approved" });
  removePendingAction(actionId);

  await saveMessage("user", `[Approved action: ${action.description}]`);

  const resumePrompt = `The user APPROVED the following action: "${action.description}". Proceed with executing it now.`;

  await ctx.replyWithChatAction("typing");
  const rawResponse = await callClaudeWithTyping(ctx, resumePrompt, { resume: true });
  const approveAgent = action.agentName || getActiveAgent("telegram");
  const response = await processMemoryIntents(supabase, rawResponse, approveAgent);
  const cleanedResponse = await sendWithApprovals(ctx, response, session.sessionId, approveAgent);
  await saveMessage("assistant", cleanedResponse);
  resetTelegramIdleTimer();
}, () => "[Approval]"));

bot.callbackQuery(/^deny:(.+)$/, withQueue(async (ctx) => {
  const actionId = ctx.match![1];
  const action = getPendingAction(actionId);

  if (!action) {
    await ctx.answerCallbackQuery({ text: "This action has expired." });
    return;
  }

  await ctx.editMessageText(`\u274c Denied: ${action.description}`);
  await ctx.answerCallbackQuery({ text: "Denied" });
  removePendingAction(actionId);

  await saveMessage("user", `[Denied action: ${action.description}]`);

  const resumePrompt = `The user DENIED the following action: "${action.description}". Do NOT proceed with this action. Acknowledge briefly.`;

  await ctx.replyWithChatAction("typing");
  const rawResponse = await callClaudeWithTyping(ctx, resumePrompt, { resume: true });
  const denyAgent = action.agentName || getActiveAgent("telegram");
  const response = await processMemoryIntents(supabase, rawResponse, denyAgent);
  const cleanedResponse = await sendWithApprovals(ctx, response, session.sessionId, denyAgent);
  await saveMessage("assistant", cleanedResponse);
  resetTelegramIdleTimer();
}, () => "[Denial]"));

// ============================================================
// HELPERS
// ============================================================

// Load profile once at startup
let profileContext = "";
try {
  profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
} catch {
  // No profile yet — that's fine
}

const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

export function buildPrompt(
  userMessage: string,
  contextDocket?: string,
  relevantContext?: string,
  elasticContext?: string,
  channel: string = "telegram",
  agentConfig?: { system_prompt?: string | null; name?: string; tools_enabled?: string[] },
  workItemContext?: string,
  structuredContext?: string,
  recentMessages?: string,
  skillContext?: { name: string; description: string },
  forestContext?: string,
): string {
  const channelLabel = channel === "google-chat" ? "Google Chat" : "Telegram";

  // Use agent-specific system prompt if available, otherwise default
  const basePrompt = agentConfig?.system_prompt
    ? `${agentConfig.system_prompt}\nYou are responding via ${channelLabel}. Keep responses concise and conversational.`
    : `You are a personal AI assistant responding via ${channelLabel}. Keep responses concise and conversational.`;

  const parts = [basePrompt];

  // Inject matched skill context (ELLIE-53)
  if (skillContext) {
    parts.push(
      `\nACTIVE SKILL: ${skillContext.name}` +
      `\nTask: ${skillContext.description}` +
      `\nFocus your response on this specific capability. Use the appropriate tools to fulfill this request.`
    );
  }

  if (AGENT_MODE) {
    if (agentConfig?.tools_enabled?.length) {
      parts.push(
        `You have access to these tools: ${agentConfig.tools_enabled.join(", ")}. ` +
        "Use them freely to answer questions. " +
        "IMPORTANT: NEVER run sudo commands, NEVER install packages (apt, npm -g, brew), NEVER run commands that require interactive input or confirmation. " +
        "If a task would require sudo or installing software, tell the user what to run instead. " +
        "The user is reading on a phone. After using tools, give a concise final answer (not the raw tool output). " +
        "If a task requires multiple steps, just do them — don't ask for permission."
      );
    } else {
      parts.push(
        "You have full tool access: Read, Edit, Write, Bash, Glob, Grep, WebSearch, WebFetch. " +
        "You also have MCP tools:\n" +
        "- Google Workspace (user_google_email: zerocool0133700@gmail.com):\n" +
        "  Gmail: search_gmail_messages, get_gmail_message_content, send_gmail_message (send requires [CONFIRM])\n" +
        "  Calendar: get_events, create_event (create/modify requires [CONFIRM])\n" +
        "  Tasks: list_tasks, create_task, update_task, get_task\n" +
        "  Also: Drive, Docs, Sheets, Forms, Contacts\n" +
        "  Your system context already includes an unread email signal and pending Google Tasks.\n" +
        "  Use Gmail MCP tools to read full email content, reply to threads, or draft messages.\n" +
        "- GitHub, Memory, Sequential Thinking\n" +
        "- Plane (project management — workspace: evelife at plane.ellie-labs.dev)\n" +
        "- Brave Search (mcp__brave-search__brave_web_search, mcp__brave-search__brave_local_search)\n" +
        "- Miro (diagrams, docs, tables), Excalidraw (drawings, diagrams)\n" +
        (isOutlookConfigured()
          ? "- Microsoft Outlook (" + getOutlookEmail() + "):\n" +
            "  Available via HTTP API (use curl from Bash):\n" +
            "  - GET http://localhost:3001/api/outlook/unread — list unread messages\n" +
            "  - GET http://localhost:3001/api/outlook/search?q=QUERY — search messages\n" +
            "  - GET http://localhost:3001/api/outlook/message/MESSAGE_ID — get full message\n" +
            "  - POST http://localhost:3001/api/outlook/send -d '{\"subject\":\"...\",\"body\":\"...\",\"to\":[\"...\"]}' (requires [CONFIRM])\n" +
            "  - POST http://localhost:3001/api/outlook/reply -d '{\"messageId\":\"...\",\"comment\":\"...\"}' (requires [CONFIRM])\n" +
            "  Your system context already includes an Outlook unread email signal.\n"
          : "") +
        "Use them freely to answer questions — read files, run commands, search code, browse the web, check email, manage calendar. " +
        "IMPORTANT: NEVER run sudo commands, NEVER install packages (apt, npm -g, brew), NEVER run commands that require interactive input or confirmation. " +
        "If a task would require sudo or installing software, tell the user what to run instead. " +
        "The user is reading on a phone. After using tools, give a concise final answer (not the raw tool output). " +
        "If a task requires multiple steps, just do them — don't ask for permission."
      );
    }
  }

  if (USER_NAME) parts.push(`You are speaking with ${USER_NAME}.`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (structuredContext) parts.push(`\n${structuredContext}`);
  if (contextDocket) parts.push(`\nCONTEXT:\n${contextDocket}`);
  if (recentMessages) parts.push(`\n${recentMessages}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);
  if (elasticContext) parts.push(`\n${elasticContext}`);
  if (forestContext) parts.push(`\n${forestContext}`);

  parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nYou MUST actively log memories during conversations. Include these tags in your response " +
      "(they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]" +
      "\nUse [REMEMBER:] for: preferences, decisions, project details, personal info, " +
      "technical choices, things the user researched or asked about, and any context that " +
      "would be useful in future conversations. When in doubt, remember it."
  );

  parts.push(
    "\nACTION CONFIRMATIONS:" +
      "\nUse [CONFIRM: description] for these actions INSTEAD of executing:" +
      "\n- Sending or replying to emails (send_gmail_message, /api/outlook/send, /api/outlook/reply)" +
      "\n- Creating or modifying calendar events (create_event, modify_event)" +
      "\n- Git push, posting to channels, modifying databases" +
      "\n- Any difficult-to-undo external action" +
      "\nDo NOT use [CONFIRM:] for:" +
      "\n- Read-only: searching email, reading messages, checking calendar, listing tasks" +
      "\n- Google Tasks management: creating/completing/updating tasks (low-stakes, easily reversible)" +
      "\n- Actions the user explicitly and directly asked you to do in simple terms" +
      "\nThe user will see Approve/Deny buttons. If approved, you will be resumed with instructions to proceed." +
      '\nExample: "I\'ll send the report now. [CONFIRM: Send weekly report email to alice@example.com]"' +
      "\nYou can include multiple [CONFIRM:] tags if multiple actions need approval."
  );

  // Work item context and dispatch protocol
  if (workItemContext) {
    parts.push(workItemContext);
    parts.push(
      "\nWORK SESSION DISPATCH PROTOCOL:" +
        "\nYou are working on the above work item. Follow these steps:" +
        "\n1. Use Plane MCP tools to update issue state (mcp__plane__update_issue)" +
        "\n2. POST progress updates to http://localhost:3001/api/work-session/* via curl" +
        "\n3. Commit with [IDENTIFIER] prefix (e.g., [ELLIE-5] Brief description)" +
        "\n4. When done, POST to /api/work-session/complete and update Plane to Done"
    );
  }

  if (isPlaneConfigured()) {
    parts.push(
      "\nWORK ITEM COMMANDS:" +
        "\nYou can manage Plane work items via MCP tools (workspace: evelife, project: ELLIE)." +
        "\n- List open issues: mcp__plane__list_states, then query issues" +
        "\n- Create new issues when asked" +
        "\n- Use [ELLIE-N] prefix in commit messages when working on a tracked item"
    );
  }

  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}

// Format forest metrics for chat display (ELLIE-113)
function formatForestMetrics(m: { creaturesByEntity: Record<string, number>; eventsByKind: Record<string, number>; treesByType: Record<string, number>; creaturesByState: Record<string, number>; failureRate: number; totalEvents: number; totalCreatures: number; totalTrees: number }): string {
  const lines = ["Forest Metrics (last 7 days)\n"];

  lines.push(`Events: ${m.totalEvents} | Creatures: ${m.totalCreatures} | Trees: ${m.totalTrees}`);
  lines.push(`Failure rate: ${(m.failureRate * 100).toFixed(1)}%`);

  if (Object.keys(m.creaturesByEntity).length) {
    lines.push("\nCreatures by entity:");
    for (const [entity, count] of Object.entries(m.creaturesByEntity).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${entity}: ${count}`);
    }
  }

  if (Object.keys(m.eventsByKind).length) {
    lines.push("\nEvents by kind:");
    for (const [kind, count] of Object.entries(m.eventsByKind).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      lines.push(`  ${kind}: ${count}`);
    }
  }

  if (Object.keys(m.creaturesByState).length) {
    lines.push("\nCreatures by state:");
    for (const [state, count] of Object.entries(m.creaturesByState).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${state}: ${count}`);
    }
  }

  return lines.join("\n");
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
  const MAX_LENGTH = 4000;
  const FILE_THRESHOLD = 8000;

  // Short response: send as-is
  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
    return;
  }

  // Very long response: truncate message + attach full output as file
  if (response.length > FILE_THRESHOLD) {
    const truncated = response.substring(0, MAX_LENGTH - 200);
    await ctx.reply(`${truncated}\n\n... (truncated — full output attached)`);

    const buffer = Buffer.from(response, "utf-8");
    await ctx.replyWithDocument(new InputFile(buffer, "output.txt"));
    return;
  }

  // Medium response: split into chunks
  const chunks = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

/**
 * Send response with approval button handling.
 * Extracts [CONFIRM: ...] tags, sends text first, then each confirmation
 * as a separate message with Approve/Deny inline keyboard buttons.
 */
async function sendWithApprovals(
  ctx: Context,
  response: string,
  currentSessionId: string | null,
  agentName?: string,
): Promise<string> {
  const { cleanedText, confirmations } = extractApprovalTags(response);

  if (confirmations.length > 0) {
    if (cleanedText) {
      await sendResponse(ctx, cleanedText);
    }
    for (const description of confirmations) {
      const actionId = crypto.randomUUID();
      const keyboard = new InlineKeyboard()
        .text("\u2705 Approve", `approve:${actionId}`)
        .text("\u274c Deny", `deny:${actionId}`);

      const sent = await ctx.reply(
        `\u26a0\ufe0f Confirm action:\n${description}`,
        { reply_markup: keyboard },
      );

      storePendingAction(
        actionId,
        description,
        currentSessionId,
        sent.chat.id,
        sent.message_id,
        { agentName: agentName || getActiveAgent("telegram") },
      );
      console.log(`[approval] Pending: ${description.substring(0, 60)}`);
    }
  } else {
    await sendResponse(ctx, cleanedText);
  }

  return cleanedText;
}

// ============================================================
// VOICE: Whisper transcription (mulaw buffer → text)
// ============================================================

async function transcribeMulaw(mulawChunks: Buffer[]): Promise<string> {
  const combined = Buffer.concat(mulawChunks);
  if (combined.length < 400) return "";

  const timestamp = Date.now();
  const mulawPath = join(TMP_DIR, `call_${timestamp}.raw`);
  const wavPath = join(TMP_DIR, `call_${timestamp}.wav`);

  try {
    await writeFile(mulawPath, combined);

    const ffmpeg = spawn([
      "ffmpeg", "-f", "mulaw", "-ar", "8000", "-ac", "1",
      "-i", mulawPath,
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      wavPath, "-y"
    ], { stdout: "pipe", stderr: "pipe" });

    if (await ffmpeg.exited !== 0) {
      console.error("[voice] ffmpeg error:", await new Response(ffmpeg.stderr).text());
      return "";
    }

    const provider = process.env.VOICE_PROVIDER || "local";

    if (provider === "groq") {
      const wavBuffer = await readFile(wavPath);
      const Groq = (await import("groq-sdk")).default;
      const groq = new Groq();
      const file = new File([wavBuffer], "call.wav", { type: "audio/wav" });
      const result = await groq.audio.transcriptions.create({ file, model: "whisper-large-v3-turbo" });
      return result.text.trim();
    }

    const whisperBinary = process.env.WHISPER_BINARY || "whisper-cpp";
    const modelPath = process.env.WHISPER_MODEL_PATH || "";
    if (!modelPath) { console.error("[voice] WHISPER_MODEL_PATH not set"); return ""; }

    const txtPath = join(TMP_DIR, `call_${timestamp}.txt`);
    const whisper = spawn([
      whisperBinary, "--model", modelPath,
      "--file", wavPath,
      "--output-txt", "--output-file", join(TMP_DIR, `call_${timestamp}`),
      "--no-prints"
    ], { stdout: "pipe", stderr: "pipe" });

    if (await whisper.exited !== 0) {
      console.error("[voice] whisper error:", await new Response(whisper.stderr).text());
      return "";
    }

    const text = await readFile(txtPath, "utf-8");
    await unlink(txtPath).catch(() => {});
    return text.trim();
  } finally {
    await unlink(mulawPath).catch(() => {});
    await unlink(wavPath).catch(() => {});
  }
}

// ============================================================
// VOICE: ElevenLabs TTS (text → mulaw base64 for Twilio)
// ============================================================

/**
 * Stream TTS audio directly to Twilio WebSocket as chunks arrive from ElevenLabs.
 * Returns true on success, false on failure.
 * This avoids buffering the entire audio before playback — first audio plays
 * while the rest is still being generated.
 */
async function streamTTSToTwilio(
  text: string,
  ws: WebSocket,
  streamSid: string,
): Promise<boolean> {
  if (!ELEVENLABS_API_KEY) { console.error("[voice] No ElevenLabs API key"); return false; }

  const start = Date.now();

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?output_format=ulaw_8000`,
    {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );

  if (!response.ok || !response.body) {
    console.error("[voice] ElevenLabs stream error:", response.status, await response.text());
    return false;
  }

  // Stream chunks to Twilio as they arrive from ElevenLabs
  const CHUNK_SIZE = 160 * 20; // ~400ms of mulaw audio per Twilio chunk
  let buffer = Buffer.alloc(0);
  let firstChunkSent = false;

  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer = Buffer.concat([buffer, Buffer.from(value)]);

    // Send complete chunks as they accumulate
    while (buffer.length >= CHUNK_SIZE) {
      const chunk = buffer.subarray(0, CHUNK_SIZE);
      buffer = buffer.subarray(CHUNK_SIZE);

      ws.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: chunk.toString("base64") },
      }));

      if (!firstChunkSent) {
        console.log(`[voice] First TTS chunk sent in ${Date.now() - start}ms`);
        firstChunkSent = true;
      }
    }
  }

  // Send remaining audio
  if (buffer.length > 0) {
    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: buffer.toString("base64") },
    }));
  }

  console.log(`[voice] TTS stream complete in ${Date.now() - start}ms`);
  return true;
}

/**
 * Non-streaming fallback for textToSpeechMulaw (used if streaming not possible).
 */
async function textToSpeechMulaw(text: string): Promise<string> {
  if (!ELEVENLABS_API_KEY) { console.error("[voice] No ElevenLabs API key"); return ""; }

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=ulaw_8000`,
    {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );

  if (!response.ok) {
    console.error("[voice] ElevenLabs error:", response.status, await response.text());
    return "";
  }

  return Buffer.from(await response.arrayBuffer()).toString("base64");
}

/** Convert text to OGG/Opus audio via ElevenLabs (for Telegram voice messages). */
async function textToSpeechOgg(text: string): Promise<Buffer | null> {
  if (!ELEVENLABS_API_KEY) return null;

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=opus_48000_64`,
    {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );

  if (!response.ok) {
    console.error("[tts] ElevenLabs error:", response.status, await response.text());
    return null;
  }

  return Buffer.from(await response.arrayBuffer());
}

// ============================================================
// VOICE: Call session + audio processing
// ============================================================

// Compute average energy of a mulaw audio buffer.
// Mulaw encodes silence as 0xFF (positive zero) or 0x7F (negative zero).
// We decode each sample to linear and take the average absolute value.
function mulawEnergy(buf: Buffer): number {
  if (buf.length === 0) return 0;
  // Mulaw to linear magnitude lookup (simplified — just measures deviation from silence)
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    // Mulaw: bias = 0x84, sign bit = 0x80
    // Quick approximation: distance from silence points (0x7F or 0xFF)
    const dist = Math.min(Math.abs(byte - 0xFF), Math.abs(byte - 0x7F));
    sum += dist;
  }
  return sum / buf.length;
}

interface VoiceCallSession {
  ws: WebSocket;
  streamSid: string | null;
  callSid: string | null;
  audioChunks: Buffer[];
  silenceTimer: ReturnType<typeof setTimeout> | null;
  lastAudioTime: number;
  lastSpeechTime: number;
  hasSpeech: boolean;
  processing: boolean;
  speaking: boolean; // true while Ellie's TTS is playing back — ignore inbound audio
  conversationHistory: Array<{ role: string; content: string }>;
}

// Direct Anthropic API client for voice + intent classification
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Initialize intent classifier (ELLIE-50) with shared clients
if (anthropic && supabase) {
  initClassifier(anthropic, supabase);
}

// Initialize entailment classifier (ELLIE-92) for contradiction detection
if (anthropic) {
  initEntailmentClassifier(anthropic);
}

// ES forest sync listener started via initForestSync() at boot (ELLIE-104/ELLIE-107)

async function callClaudeVoice(systemPrompt: string, userMessage: string): Promise<string> {
  const start = Date.now();

  // Use direct API for voice — fast (~600ms) with full memory but no tools
  if (anthropic) {
    try {
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      });
      const text = response.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      console.log(`[voice] API responded in ${Date.now() - start}ms`);
      return text.trim();
    } catch (err) {
      console.error("[voice] API error, falling back to CLI:", err);
    }
  }

  // Fallback: CLI without tools (still faster than CLI with tools)
  const prompt = `${systemPrompt}\n\n${userMessage}`;
  const args = [CLAUDE_PATH, "-p", prompt, "--output-format", "text", "--model", "claude-haiku-4-5-20251001"];

  console.log(`[voice] Claude CLI fallback: ${userMessage.substring(0, 80)}...`);

  const proc = spawn(args, {
    stdin: "ignore",
    stdout: "pipe", stderr: "pipe",
    cwd: PROJECT_DIR || undefined,
    env: { ...process.env, CLAUDECODE: "", ANTHROPIC_API_KEY: "" },
  });

  const timeout = setTimeout(() => proc.kill(), 60_000);
  const output = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  clearTimeout(timeout);

  if (await proc.exited !== 0) {
    console.error("[voice] Claude CLI error:", stderr);
    return "Sorry, I had trouble processing that. Could you repeat?";
  }

  console.log(`[voice] CLI responded in ${Date.now() - start}ms`);
  return output.trim();
}

async function processVoiceAudio(session: VoiceCallSession): Promise<void> {
  if (session.processing || session.audioChunks.length === 0) return;
  session.processing = true;

  const chunks = session.audioChunks.splice(0);
  const pipelineStart = Date.now();

  try {
    // --- OPTIMIZATION: Start context retrieval IN PARALLEL with transcription ---
    // Context doesn't depend on the transcribed text (docket is cached, semantic search
    // uses the text but we can start the docket fetch and fall back gracefully).
    // We kick off the docket fetch now and do the text-dependent searches after transcription.
    const contextDocketPromise = getContextDocket();

    console.log(`[voice] Transcribing ${chunks.length} chunks...`);
    const text = await transcribeMulaw(chunks);

    if (!text || text.length < 2 || text.includes("[BLANK_AUDIO]") || text.includes("(blank audio)")) {
      console.log("[voice] Empty/blank transcription, skipping");
      session.processing = false;
      return;
    }

    console.log(`[voice] User said: "${text}" (transcribed in ${Date.now() - pipelineStart}ms)`);
    session.conversationHistory.push({ role: "user", content: text });

    // Fire-and-forget: save user message (don't block the pipeline)
    saveMessage("user", text, { callSid: session.callSid }, "voice").catch(() => {});
    broadcastExtension({ type: "message_in", channel: "voice", preview: text.substring(0, 200) });

    const conversationContext = session.conversationHistory
      .slice(-6)
      .map(m => `${m.role}: ${m.content}`)
      .join("\n");

    // Now that we have text, run text-dependent searches in parallel.
    // contextDocketPromise was already started during transcription.
    const [contextDocket, relevantContext, elasticContext, forestContext] = await Promise.all([
      contextDocketPromise,
      getRelevantContext(supabase, text),
      searchElastic(text, { limit: 3, recencyBoost: true }),
      getForestContext(text),
    ]);

    const systemParts = [
      "You are Ellie, Dave's AI assistant. You are on a VOICE CALL.",
      "Keep responses SHORT and natural for speech — 1-3 sentences max.",
      "No markdown, no bullet points, no formatting. Just spoken words.",
      "Be warm and conversational, like talking to a friend.",
    ];
    if (USER_NAME) systemParts.push(`You are speaking with ${USER_NAME}.`);
    if (contextDocket) systemParts.push(`\n${contextDocket}`);
    if (relevantContext) systemParts.push(`\n${relevantContext}`);
    if (elasticContext) systemParts.push(`\n${elasticContext}`);
    if (forestContext) systemParts.push(`\n${forestContext}`);

    const systemPrompt = systemParts.join("\n");

    const userPrompt = conversationContext
      ? `Conversation so far:\n${conversationContext}\n\nDave just said: ${text}`
      : `Dave said: ${text}`;

    const response = await callClaudeVoice(systemPrompt, userPrompt);
    const cleanResponse = response
      .replace(/\[REMEMBER:.*?\]/g, "")
      .replace(/\[GOAL:.*?\]/g, "")
      .replace(/\[DONE:.*?\]/g, "")
      .trim();

    console.log(`[voice] Ellie says: "${cleanResponse}" (LLM done at ${Date.now() - pipelineStart}ms)`);
    session.conversationHistory.push({ role: "assistant", content: cleanResponse });

    // Fire-and-forget: save assistant message
    saveMessage("assistant", cleanResponse, { callSid: session.callSid }, "voice").catch(() => {});
    broadcastExtension({ type: "message_out", channel: "voice", agent: "voice", preview: cleanResponse.substring(0, 200) });

    if (!session.streamSid) {
      console.error("[voice] No stream SID");
      session.processing = false;
      return;
    }

    // Mark as speaking — ignore inbound audio until playback finishes
    session.speaking = true;

    // Clear buffered audio then stream response
    session.ws.send(JSON.stringify({ event: "clear", streamSid: session.streamSid }));

    // --- OPTIMIZATION: Stream TTS chunks to Twilio as they arrive from ElevenLabs ---
    const streamed = await streamTTSToTwilio(cleanResponse, session.ws, session.streamSid);

    if (!streamed) {
      // Fallback to non-streaming TTS
      console.log("[voice] Streaming failed, falling back to buffered TTS");
      const audioBase64 = await textToSpeechMulaw(cleanResponse);
      if (!audioBase64) {
        console.error("[voice] No audio from fallback TTS");
        session.speaking = false;
        session.processing = false;
        return;
      }
      const CHUNK_SIZE = 160 * 20;
      const audioBuffer = Buffer.from(audioBase64, "base64");
      for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
        const chunk = audioBuffer.subarray(i, i + CHUNK_SIZE);
        session.ws.send(JSON.stringify({
          event: "media",
          streamSid: session.streamSid,
          media: { payload: chunk.toString("base64") },
        }));
      }
    }

    // Send mark to detect when playback finishes
    session.ws.send(JSON.stringify({
      event: "mark",
      streamSid: session.streamSid,
      mark: { name: `response_${Date.now()}` },
    }));

    console.log(`[voice] Total pipeline: ${Date.now() - pipelineStart}ms`);
  } catch (error) {
    console.error("[voice] Processing error:", error);
  }

  session.processing = false;
}

// ============================================================
// HTTP SERVER + VOICE WEBSOCKET
// ============================================================

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // Twilio TwiML webhook — tells Twilio to open a media stream
  if (url.pathname === "/voice" && req.method === "POST") {
    // Validate Twilio signature
    let voiceBody = "";
    req.on("data", (chunk: Buffer) => { voiceBody += chunk.toString(); });
    req.on("end", () => {
      if (!validateTwilioSignature(req, voiceBody)) {
        console.warn("[voice] Invalid Twilio signature — rejecting request");
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

    const wsUrl = PUBLIC_URL
      ? PUBLIC_URL.replace(/^https?/, "wss") + "/media-stream"
      : `wss://${req.headers.host}/media-stream`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you to Ellie.</Say>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(twiml);
    console.log("[voice] TwiML served, connecting media stream...");
    }); // end req.on("end")
    return;
  }

  // Google Chat webhook
  if (url.pathname === "/google-chat" && req.method === "POST") {
    // Read body
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const event: GoogleChatEvent = JSON.parse(body);

        // Handle card button clicks (approval actions)
        const cardAction = (event as any)?.chat?.cardClickedPayload ||
          ((event as any)?.type === "CARD_CLICKED" ? event : null);
        if (cardAction) {
          const actionFn = cardAction?.chat?.cardClickedPayload?.action?.actionMethodName ||
            (cardAction as any)?.action?.actionMethodName || "";
          const params = cardAction?.chat?.cardClickedPayload?.action?.parameters ||
            (cardAction as any)?.action?.parameters || [];
          const actionId = params.find((p: any) => p.key === "action_id")?.value;

          if (actionId && (actionFn === "approve_action" || actionFn === "deny_action")) {
            const pending = getPendingAction(actionId);
            if (pending) {
              const approved = actionFn === "approve_action";
              removePendingAction(actionId);
              console.log(`[gchat] Action ${approved ? "approved" : "denied"}: ${pending.description.substring(0, 60)}`);

              // Immediately acknowledge the button click with card update
              const ackText = `${approved ? "\u2705 Approved" : "\u274C Denied"}: ${pending.description}`;
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                actionResponse: { type: "UPDATE_MESSAGE" },
                cardsV2: [{
                  cardId: "approval_card",
                  card: {
                    header: { title: approved ? "Action Approved" : "Action Denied" },
                    sections: [{
                      widgets: [{ textParagraph: { text: ackText } }],
                    }],
                  },
                }],
              }));

              // Resume Claude with the decision asynchronously (don't block webhook)
              const decision = approved
                ? `The user APPROVED the action: "${pending.description}". Proceed with the action now.`
                : `The user DENIED the action: "${pending.description}". Do NOT proceed. Acknowledge and move on.`;

              // Use stored session ID from when the approval was created
              callClaude(decision, {
                resume: true,
                sessionId: pending.sessionId || undefined,
              }).then(async (followUp) => {
                const cleanFollowUp = await processMemoryIntents(supabase, followUp, pending.agentName || getActiveAgent("google-chat"));
                await saveMessage("assistant", cleanFollowUp, {}, "google-chat");

                // Send follow-up via REST API to the correct space
                if (pending.spaceName) {
                  await sendGoogleChatMessage(pending.spaceName, cleanFollowUp).catch((err) => {
                    console.error(`[gchat] Failed to send approval follow-up:`, err);
                  });
                }
                console.log(`[gchat] Approval follow-up sent: ${cleanFollowUp.substring(0, 80)}...`);
              }).catch((err) => {
                console.error(`[gchat] Approval Claude call failed:`, err);
                // Try to notify the user about the error
                if (pending.spaceName) {
                  sendGoogleChatMessage(pending.spaceName, "Sorry, I ran into an error processing that approval. Please try again.").catch(() => {});
                }
              });
              return;
            }

            // Expired action — update the card to show expiry
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              actionResponse: { type: "UPDATE_MESSAGE" },
              cardsV2: [{
                cardId: "approval_card",
                card: {
                  header: { title: "Action Expired" },
                  sections: [{
                    widgets: [{ textParagraph: { text: "This action has expired. Please try again." } }],
                  }],
                },
              }],
            }));
            return;
          }
        }

        const parsed = parseGoogleChatEvent(event);

        if (!parsed) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
          return;
        }

        if (!isAllowedSender(parsed.senderEmail)) {
          console.log(`[gchat] Unauthorized sender: ${parsed.senderEmail}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
          return;
        }

        console.log(`[gchat] ${parsed.senderName}: ${parsed.text.substring(0, 80)}...`);
        acknowledgeChannel("google-chat"); // User responded — clear pending responses

        await saveMessage("user", parsed.text, {
          sender: parsed.senderEmail,
          space: parsed.spaceName,
        }, "google-chat");
        broadcastExtension({ type: "message_in", channel: "google-chat", preview: parsed.text.substring(0, 200) });

        // Slash commands — direct responses, bypass Claude pipeline (ELLIE-113)
        if (parsed.text.startsWith("/search ")) {
          const query = parsed.text.slice(8).trim();
          let responseText = "Usage: /search <query>";
          if (query) {
            try {
              const { searchForestSafe } = await import("./elasticsearch/search-forest.ts");
              responseText = (await searchForestSafe(query, { limit: 10 })) || "No results found.";
            } catch (err) {
              console.error("[gchat /search] Error:", err);
              responseText = "Search failed — ES may be unavailable.";
            }
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: responseText } } } },
          }));
          return;
        }

        if (parsed.text === "/forest-metrics" || parsed.text.startsWith("/forest-metrics ")) {
          let responseText: string;
          try {
            const { getForestMetricsSafe } = await import("./elasticsearch/search-forest.ts");
            const now = new Date();
            const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            const metrics = await getForestMetricsSafe({
              timeRange: { from: weekAgo.toISOString(), to: now.toISOString() },
            });
            responseText = formatForestMetrics(metrics);
          } catch (err) {
            console.error("[gchat /forest-metrics] Error:", err);
            responseText = "Metrics failed — ES may be unavailable.";
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: responseText } } } },
          }));
          return;
        }

        const gchatAgentResult = await routeAndDispatch(supabase, parsed.text, "google-chat", parsed.senderEmail);
        const effectiveGchatText = gchatAgentResult?.route.strippedMessage || parsed.text;
        if (gchatAgentResult) {
          setActiveAgent("google-chat", gchatAgentResult.dispatch.agent.name);
          broadcastExtension({ type: "route", channel: "google-chat", agent: gchatAgentResult.dispatch.agent.name, mode: gchatAgentResult.route.execution_mode });
        }

        const [contextDocket, relevantContext, elasticContext, structuredContext, recentMessages, forestContext] = await Promise.all([
          getContextDocket(),
          getRelevantContext(supabase, effectiveGchatText),
          searchElastic(effectiveGchatText, { limit: 5, recencyBoost: true }),
          getAgentStructuredContext(supabase, getActiveAgent("google-chat")),
          getRecentMessages(supabase),
          getForestContext(effectiveGchatText),
        ]);

        // ── Sync response gate (shared by multi-step and single-agent paths) ──
        const GCHAT_SYNC_TIMEOUT_MS = 25_000;
        let respondedSync = false;

        function sendSyncResponse(text: string, cardsV2?: any[]) {
          if (respondedSync) return;
          respondedSync = true;
          res.writeHead(200, { "Content-Type": "application/json" });
          const message: Record<string, any> = { text };
          if (cardsV2?.length) message.cardsV2 = cardsV2;
          res.end(JSON.stringify({
            hostAppDataAction: { chatDataAction: { createMessageAction: { message } } },
          }));
        }

        // ── Google Chat multi-step branch (ELLIE-58) ──
        if (gchatAgentResult?.route.execution_mode !== "single" && gchatAgentResult?.route.skills?.length) {
          const gchatExecMode = gchatAgentResult.route.execution_mode;
          const gchatSteps: PipelineStep[] = gchatAgentResult.route.skills.map((s) => ({
            agent_name: s.agent,
            skill_name: s.skill !== "none" ? s.skill : undefined,
            instruction: s.instruction,
          }));

          const modeLabels: Record<string, string> = { pipeline: "Pipeline", "fan-out": "Fan-out", "critic-loop": "Critic loop" };
          const gchatAgentNames = [...new Set(gchatSteps.map((s) => s.agent_name))].join(" \u2192 ");

          // Multi-step will always exceed 25s — send sync response immediately, run async
          sendSyncResponse(`Working on it... (${modeLabels[gchatExecMode] || gchatExecMode}: ${gchatAgentNames}, ${gchatSteps.length} steps)`);

          const GCHAT_ORCHESTRATION_TIMEOUT_MS = 300_000; // 5 minutes max
          Promise.race([
            executeOrchestrated(gchatExecMode, gchatSteps, effectiveGchatText, {
              supabase,
              channel: "google-chat",
              userId: parsed.senderEmail,
              anthropicClient: anthropic,
              contextDocket, relevantContext, elasticContext,
              structuredContext, recentMessages, forestContext,
              buildPromptFn: buildPrompt,
              callClaudeFn: callClaude,
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Orchestration timeout (5m)")), GCHAT_ORCHESTRATION_TIMEOUT_MS),
            ),
          ]).then(async (result) => {
            const gchatOrcAgent = result.finalDispatch?.agent?.name || gchatAgentResult?.dispatch.agent.name || "general";
            const pipelineResponse = await processMemoryIntents(supabase, result.finalResponse, gchatOrcAgent);
            const { cleanedText: gchatClean } = extractApprovalTags(pipelineResponse);
            await saveMessage("assistant", gchatClean, { space: parsed.spaceName }, "google-chat");
            broadcastExtension({ type: "message_out", channel: "google-chat", agent: gchatOrcAgent, preview: gchatClean.substring(0, 200) });
            broadcastExtension({ type: "pipeline_complete", channel: "google-chat", mode: gchatExecMode, steps: result.stepResults.length, duration_ms: result.artifacts.total_duration_ms, cost_usd: result.artifacts.total_cost_usd });
            resetGchatIdleTimer();

            if (result.finalDispatch) {
              syncResponse(supabase, result.finalDispatch.session_id, gchatClean, {
                duration_ms: result.artifacts.total_duration_ms,
              }).catch(() => {});
            }

            console.log(`[gchat] ${gchatExecMode}: ${result.stepResults.length} steps in ${result.artifacts.total_duration_ms}ms, $${result.artifacts.total_cost_usd.toFixed(4)}`);

            await deliverMessage(supabase, gchatClean, {
              channel: "google-chat",
              spaceName: parsed.spaceName,
              threadName: null,
              telegramBot: bot,
              telegramChatId: ALLOWED_USER_ID,
              fallback: true,
            });
          }).catch((err) => {
            console.error("[gchat] Multi-step failed:", err);
            const errMsg = err instanceof PipelineStepError && err.partialOutput
              ? err.partialOutput + "\n\n(Execution incomplete.)"
              : "Sorry, I ran into an error processing your multi-step request.";
            deliverMessage(supabase, errMsg, {
              channel: "google-chat",
              spaceName: parsed.spaceName,
              threadName: null,
              telegramBot: bot,
              telegramChatId: ALLOWED_USER_ID,
              fallback: true,
            }).catch(() => {});
          });
          return;
        }

        // ── Google Chat single-agent path (default) ──
        const enrichedPrompt = buildPrompt(
          effectiveGchatText, contextDocket, relevantContext, elasticContext, "google-chat",
          gchatAgentResult?.dispatch.agent ? { system_prompt: gchatAgentResult.dispatch.agent.system_prompt, name: gchatAgentResult.dispatch.agent.name, tools_enabled: gchatAgentResult.dispatch.agent.tools_enabled } : undefined,
          undefined, structuredContext, recentMessages,
          gchatAgentResult?.dispatch.skill_context,
          forestContext,
        );

        const gchatAgentTools = gchatAgentResult?.dispatch.agent.tools_enabled;
        const gchatAgentModel = gchatAgentResult?.dispatch.agent.model;

        // Race Claude call against the sync timeout.
        // If Claude finishes fast, respond synchronously (best UX).
        // If it takes too long, send "working on it" synchronously, then post the
        // real result async via the Chat API when Claude finishes.

        // Start Claude call (runs in background if timeout fires first)
        const claudePromise = (async () => {
          const gchatStart = Date.now();
          const rawResponse = await callClaude(enrichedPrompt, {
            resume: true,
            allowedTools: gchatAgentTools?.length ? gchatAgentTools : undefined,
            model: gchatAgentModel || undefined,
          });
          const gchatDuration = Date.now() - gchatStart;
          const response = await processMemoryIntents(supabase, rawResponse, gchatAgentResult?.dispatch.agent.name || "general");

          if (gchatAgentResult) {
            syncResponse(supabase, gchatAgentResult.dispatch.session_id, response, {
              duration_ms: gchatDuration,
            }).catch(() => {});
          }

          return { response, gchatDuration };
        })();

        // Start timeout timer
        const timeoutPromise = new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), GCHAT_SYNC_TIMEOUT_MS)
        );

        const raceResult = await Promise.race([
          claudePromise.then((r) => ({ type: "done" as const, ...r })),
          timeoutPromise.then(() => ({ type: "timeout" as const })),
        ]);

        if (raceResult.type === "timeout") {
          // Claude is still working — send interim response, continue in background
          const agentLabel = gchatAgentResult?.dispatch.agent.name || "general";
          const preview = parsed.text.length > 60 ? parsed.text.substring(0, 57) + "..." : parsed.text;
          console.log(`[gchat] Timeout — sending interim response, continuing async`);
          sendSyncResponse(`Working on it... (${agentLabel} agent is processing your request)`);

          // Wait for Claude to finish, then deliver result with retry + fallback
          claudePromise
            .then(async ({ response }) => {
              const { cleanedText: gchatClean } = extractApprovalTags(response);
              const msgId = await saveMessage("assistant", gchatClean, { space: parsed.spaceName }, "google-chat");
              broadcastExtension({ type: "message_out", channel: "google-chat", agent: gchatAgentResult?.dispatch.agent.name || "general", preview: gchatClean.substring(0, 200) });
              resetGchatIdleTimer();
              console.log(`[gchat] Async reply (${gchatClean.length} chars) to ${parsed.spaceName} thread=${parsed.threadName || "none"}: ${gchatClean.substring(0, 80)}...`);

              // Don't use thread for async replies — thread replies in DMs get buried
              // and users don't see them. Send as top-level message instead.
              const result = await deliverMessage(supabase, gchatClean, {
                channel: "google-chat",
                messageId: msgId || undefined,
                spaceName: parsed.spaceName,
                threadName: null,
                telegramBot: bot,
                telegramChatId: ALLOWED_USER_ID,
                fallback: true,
              });

              if (result.status === "sent") {
                console.log(`[gchat] Async delivery complete → ${result.externalId}`);
              } else if (result.status === "fallback") {
                console.log(`[gchat] Async delivery via fallback (${result.channel}) → ${result.externalId}`);
              } else {
                console.error(`[gchat] Async delivery FAILED: ${result.error}`);
              }
            })
            .catch((err) => {
              console.error("[gchat] Async Claude/delivery error:", err);
              // Last resort — try to notify user something went wrong
              deliverMessage(supabase, "Sorry, I ran into an error while processing your request. Please try again.", {
                channel: "google-chat",
                spaceName: parsed.spaceName,
                threadName: parsed.threadName,
                telegramBot: bot,
                telegramChatId: ALLOWED_USER_ID,
                fallback: true,
                maxRetries: 1,
              }).catch(() => {});
            });
        } else {
          // Claude finished within timeout — respond synchronously (best UX)
          const { response } = raceResult;
          const { cleanedText: gchatClean, confirmations: gchatConfirms } = extractApprovalTags(response);

          await saveMessage("assistant", gchatClean, { space: parsed.spaceName }, "google-chat");
          broadcastExtension({ type: "message_out", channel: "google-chat", agent: gchatAgentResult?.dispatch.agent.name || "general", preview: gchatClean.substring(0, 200) });
          resetGchatIdleTimer();
          console.log(`[gchat] Replying: ${gchatClean.substring(0, 80)}...`);

          if (gchatConfirms.length > 0) {
            const cardSections = gchatConfirms.map((desc) => {
              const actionId = crypto.randomUUID();
              storePendingAction(actionId, desc, session.sessionId, 0, 0, {
                channel: "google-chat",
                spaceName: parsed.spaceName,
                agentName: gchatAgentResult?.dispatch.agent.name || getActiveAgent("google-chat"),
              });
              return {
                widgets: [
                  { textParagraph: { text: `<b>Action:</b> ${desc}` } },
                  {
                    buttonList: {
                      buttons: [
                        {
                          text: "Approve",
                          color: { red: 0.2, green: 0.7, blue: 0.3, alpha: 1 },
                          onClick: { action: { function: "approve_action", parameters: [{ key: "action_id", value: actionId }] } },
                        },
                        {
                          text: "Deny",
                          color: { red: 0.7, green: 0.2, blue: 0.2, alpha: 1 },
                          onClick: { action: { function: "deny_action", parameters: [{ key: "action_id", value: actionId }] } },
                        },
                      ],
                    },
                  },
                ],
              };
            });

            sendSyncResponse(gchatClean, [{
              cardId: "approval_card",
              card: {
                header: { title: "Action Confirmation Required" },
                sections: cardSections,
              },
            }]);
          } else {
            sendSyncResponse(gchatClean);
          }
        }

      } catch (err) {
        console.error("[gchat] Webhook error:", err);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          hostAppDataAction: {
            chatDataAction: {
              createMessageAction: {
                message: { text: "Sorry, I ran into an error. Please try again." },
              },
            },
          },
        }));
      }
    });
    return;
  }

  // Alexa Custom Skill webhook
  if (url.pathname === "/alexa" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        // Verify Alexa request signature (skip in dev if headers missing)
        const certUrl = req.headers["signaturecertchainurl"] as string;
        const signature = req.headers["signature-256"] as string;

        if (certUrl && signature) {
          const { verifyAlexaRequest } = await import("./alexa.ts");
          const valid = await verifyAlexaRequest(certUrl, signature, body);
          if (!valid) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid signature" }));
            return;
          }
        }

        const {
          parseAlexaRequest, handleAddTodo, handleGetTodos, handleGetBriefing,
          buildAlexaResponse, buildAlexaErrorResponse, textToSsml,
        } = await import("./alexa.ts");

        const alexaBody = JSON.parse(body);
        const parsed = parseAlexaRequest(alexaBody);

        console.log(`[alexa] ${parsed.type} ${parsed.intentName || ""}: ${parsed.text.substring(0, 80)}`);

        // Save user message
        await saveMessage("user", parsed.text, {
          userId: parsed.userId,
          sessionId: parsed.sessionId,
          intent: parsed.intentName,
        }, "alexa");
        broadcastExtension({ type: "message_in", channel: "alexa", preview: parsed.text.substring(0, 200) });

        // Handle request types
        if (parsed.type === "LaunchRequest") {
          const resp = buildAlexaResponse(
            "Hi! I'm Ellie. You can ask me anything, say add a todo, or ask for your briefing. What would you like?",
            false, // Keep session open
            "Ellie",
            "Ask me anything, add a todo, or get your briefing.",
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(resp));
          return;
        }

        if (parsed.type === "SessionEndedRequest") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ version: "1.0", response: {} }));
          return;
        }

        // IntentRequest
        const intent = parsed.intentName;
        let speechText: string;
        let shouldEndSession = true;

        switch (intent) {
          case "AddTodoIntent": {
            speechText = await handleAddTodo(parsed.slots);
            break;
          }
          case "GetTodosIntent": {
            speechText = await handleGetTodos();
            break;
          }
          case "GetBriefingIntent": {
            speechText = await handleGetBriefing();
            break;
          }
          case "AskEllieIntent": {
            const query = parsed.slots.query || parsed.text;

            // Gather context + call Claude with 6s timeout
            const [contextDocket, relevantContext, elasticContext, structuredContext, recentMessages, forestContext] = await Promise.all([
              getContextDocket(),
              getRelevantContext(supabase, query),
              searchElastic(query, { limit: 5, recencyBoost: true }),
              getAgentStructuredContext(supabase, getActiveAgent("google-chat")),
              getRecentMessages(supabase),
              getForestContext(query),
            ]);

            const agentResult = await routeAndDispatch(supabase, query, "alexa", parsed.userId);
            if (agentResult) broadcastExtension({ type: "route", channel: "alexa", agent: agentResult.dispatch.agent.name, mode: agentResult.route.execution_mode });
            const effectiveQuery = agentResult?.route.strippedMessage || query;
            const enrichedPrompt = buildPrompt(
              effectiveQuery, contextDocket, relevantContext, elasticContext, "alexa",
              agentResult?.dispatch.agent ? {
                system_prompt: agentResult.dispatch.agent.system_prompt,
                name: agentResult.dispatch.agent.name,
                tools_enabled: agentResult.dispatch.agent.tools_enabled,
              } : undefined,
              undefined, structuredContext, recentMessages,
              agentResult?.dispatch.skill_context,
              forestContext,
            );

            const ALEXA_TIMEOUT_MS = 6_000;
            const claudePromise = (async () => {
              const raw = await callClaude(enrichedPrompt, {
                resume: true,
                allowedTools: agentResult?.dispatch.agent.tools_enabled?.length
                  ? agentResult.dispatch.agent.tools_enabled : undefined,
                model: agentResult?.dispatch.agent.model || undefined,
              });
              return await processMemoryIntents(supabase, raw, agentResult?.dispatch.agent.name || "general");
            })();

            const timeoutPromise = new Promise<"timeout">((resolve) =>
              setTimeout(() => resolve("timeout"), ALEXA_TIMEOUT_MS)
            );

            const raceResult = await Promise.race([
              claudePromise.then((r) => ({ type: "done" as const, response: r })),
              timeoutPromise.then(() => ({ type: "timeout" as const })),
            ]);

            if (raceResult.type === "timeout") {
              // Claude still working — tell user, deliver via Telegram
              speechText = "I'm still thinking about that. I'll send the full answer to your Telegram.";
              claudePromise
                .then(async (response) => {
                  const clean = response.replace(/<[^>]+>/g, "").substring(0, 4000);
                  await saveMessage("assistant", clean, { source: "alexa-async" }, "alexa");
                  broadcastExtension({ type: "message_out", channel: "alexa", agent: agentResult?.dispatch.agent.name || "general", preview: clean.substring(0, 200) });
                  try {
                    await bot.api.sendMessage(ALLOWED_USER_ID, `[From Alexa] ${clean}`);
                  } catch (tgErr) {
                    console.error("[alexa] Telegram fallback failed:", tgErr);
                  }
                })
                .catch((err) => console.error("[alexa] Async Claude error:", err));
            } else {
              const clean = raceResult.response.replace(/<[^>]+>/g, "").substring(0, 6000);
              await saveMessage("assistant", clean, {}, "alexa");
              broadcastExtension({ type: "message_out", channel: "alexa", agent: agentResult?.dispatch.agent.name || "general", preview: clean.substring(0, 200) });
              speechText = clean;
            }
            break;
          }
          case "AMAZON.HelpIntent": {
            speechText = "You can ask me anything, say add a todo followed by your task, say what's on my todo list, or ask for your briefing. What would you like?";
            shouldEndSession = false;
            break;
          }
          case "AMAZON.StopIntent":
          case "AMAZON.CancelIntent": {
            speechText = "Goodbye!";
            break;
          }
          default: {
            speechText = "I'm not sure how to help with that. Try asking me a question, or say help for options.";
            shouldEndSession = false;
          }
        }

        const resp = buildAlexaResponse(speechText, shouldEndSession, "Ellie");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(resp));
      } catch (err) {
        console.error("[alexa] Webhook error:", err);
        const { buildAlexaErrorResponse } = await import("./alexa.ts");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(buildAlexaErrorResponse()));
      }
    });
    return;
  }

  // Health check
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      service: "ellie-relay",
      voice: !!ELEVENLABS_API_KEY,
      googleChat: isGoogleChatEnabled(),
      alexa: true,
    }));
    return;
  }

  // Queue status — returns current processing state and queued items
  if (url.pathname === "/queue-status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      busy,
      queueLength: messageQueue.length,
      current: currentItem
        ? {
            channel: currentItem.channel,
            preview: currentItem.preview,
            durationMs: Date.now() - currentItem.startedAt,
          }
        : null,
      queued: messageQueue.map((item, index) => ({
        position: index + 1,
        channel: item.channel,
        preview: item.preview,
        waitingMs: Date.now() - item.enqueuedAt,
      })),
    }));
    return;
  }

  // Token health check — tests Anthropic API key validity
  if (url.pathname === "/api/token-health") {
    (async () => {
      const result: Record<string, { status: string; latency_ms?: number; error?: string }> = {};

      // Anthropic
      if (!anthropic) {
        result.anthropic = { status: "not_configured" };
      } else {
        const start = Date.now();
        try {
          await anthropic.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1,
            messages: [{ role: "user", content: "ok" }],
          });
          result.anthropic = { status: "ok", latency_ms: Date.now() - start };
        } catch (err: any) {
          const msg = err?.message || String(err);
          let status = "error";
          if (msg.includes("credit balance")) status = "low_credits";
          else if (err?.status === 401) status = "invalid_key";
          result.anthropic = { status, latency_ms: Date.now() - start, error: msg };
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    })();
    return;
  }

  // Manual consolidation (close conversation)
  if (url.pathname === "/api/consolidate" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const channel = data.channel || undefined;
        console.log(`[consolidate] Manual trigger via API${channel ? ` (channel: ${channel})` : ""}`);
        await triggerConsolidation(channel);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error("[consolidate] API error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }

  // Execution plans — list or get details (ELLIE-58)
  if (url.pathname === "/api/execution-plans" && req.method === "GET") {
    (async () => {
      if (!supabase) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Supabase not configured" }));
        return;
      }
      const rawLimit = parseInt(url.searchParams.get("limit") || "20", 10);
      const rawOffset = parseInt(url.searchParams.get("offset") || "0", 10);
      if (isNaN(rawLimit) || isNaN(rawOffset)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid pagination parameters" }));
        return;
      }
      const limit = Math.min(Math.max(rawLimit, 1), 100);
      const offset = Math.max(rawOffset, 0);
      const status = url.searchParams.get("status");

      let query = supabase
        .from("execution_plans")
        .select("*")
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (status) query = query.eq("status", status);

      const { data, error } = await query;
      if (error) {
        console.error("[relay] execution-plans query error:", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data || []));
    })();
    return;
  }

  if (url.pathname.startsWith("/api/execution-plans/") && req.method === "GET") {
    (async () => {
      if (!supabase) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Supabase not configured" }));
        return;
      }
      const planId = url.pathname.split("/api/execution-plans/")[1];
      const { data, error } = await supabase
        .from("execution_plans")
        .select("*")
        .eq("id", planId)
        .single();

      if (error || !data) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    })();
    return;
  }

  // Close a specific conversation by ID
  if (url.pathname === "/api/conversation/close" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        if (!supabase) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Supabase not configured" }));
          return;
        }
        const data = body ? JSON.parse(body) : {};
        if (data.conversation_id) {
          await closeConversation(supabase, data.conversation_id);
        } else if (data.channel) {
          await closeActiveConversation(supabase, data.channel);
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Provide conversation_id or channel" }));
          return;
        }
        cachedContext = null;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error("[conversation] Close API error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }

  // Get active conversation context for a channel (used by ELLIE-50 classifier)
  if (url.pathname === "/api/conversation/context" && req.method === "GET") {
    (async () => {
      try {
        if (!supabase) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Supabase not configured" }));
          return;
        }
        const channel = url.searchParams.get("channel") || "telegram";
        const context = await getConversationContext(supabase, channel);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, context }));
      } catch (err) {
        console.error("[conversation] Context API error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    })();
    return;
  }

  // Extract ideas from recent conversations
  if (url.pathname === "/api/extract-ideas" && req.method === "POST") {
    (async () => {
      try {
        if (!supabase) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Supabase not configured" }));
          return;
        }

        console.log("[extract-ideas] Starting idea extraction from last 3 conversations");

        // Fetch last 3 conversations with their messages
        const { data: convos, error: convoErr } = await supabase
          .from("conversations")
          .select("id, summary, started_at, ended_at, channel")
          .order("started_at", { ascending: false })
          .limit(3);

        if (convoErr || !convos?.length) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ideas: [], message: "No conversations found" }));
          return;
        }

        // Fetch messages for each conversation
        const convoTranscripts: string[] = [];
        for (const convo of convos) {
          const { data: msgs } = await supabase
            .from("messages")
            .select("role, content, created_at")
            .eq("conversation_id", convo.id)
            .order("created_at", { ascending: true });

          const transcript = (msgs || [])
            .map((m: any) => `${m.role === "user" ? "Dave" : "Ellie"}: ${m.content}`)
            .join("\n");

          convoTranscripts.push(
            `### Conversation (${convo.channel || "unknown"}, ${convo.started_at})\n` +
            `Summary: ${convo.summary || "No summary"}\n\n` +
            `${transcript || "No messages"}`
          );
        }

        // Fetch open Plane items
        const openItems = await listOpenIssues("ELLIE", 50);
        const openItemsList = openItems.length
          ? openItems.map(i => `- ELLIE-${i.sequenceId}: ${i.name}`).join("\n")
          : "No open items";

        // Build prompt
        const prompt = `You are analyzing recent conversations between Dave and Ellie (an AI assistant) to extract potential work items for the ELLIE project.

## Recent Conversations

${convoTranscripts.join("\n\n---\n\n")}

## Currently Open Work Items

${openItemsList}

Extract actionable ideas (features, bugs, improvements, tasks) mentioned or implied in these conversations. For each idea, check if it matches or overlaps with an existing open item.

Return ONLY valid JSON (no markdown, no explanation) in this format:
{
  "ideas": [
    {
      "title": "Short title for the work item",
      "description": "1-2 sentence description of what needs to be done",
      "existing": "ELLIE-XX" or null
    }
  ]
}

If no actionable ideas are found, return: { "ideas": [] }`;

        // Call Claude CLI
        const cliArgs = [CLAUDE_PATH, "-p", prompt, "--output-format", "text"];
        const proc = spawn(cliArgs, {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, CLAUDECODE: "", ANTHROPIC_API_KEY: "" },
        });

        const TIMEOUT_MS = 90_000;
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          console.error("[extract-ideas] CLI timeout — killing");
          proc.kill();
        }, TIMEOUT_MS);

        const output = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        clearTimeout(timeout);

        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          const msg = timedOut ? "timed out" : stderr || `exit code ${exitCode}`;
          throw new Error(`Claude CLI failed: ${msg}`);
        }

        const cleaned = output.trim();

        // Parse JSON (with fallback for CLI preamble)
        let parsed: { ideas: Array<{ title: string; description: string; existing: string | null }> };
        try {
          parsed = JSON.parse(cleaned);
        } catch {
          const jsonMatch = cleaned.match(/\{[\s\S]*"ideas"[\s\S]*\}/);
          if (!jsonMatch) throw new Error("No JSON found in CLI response");
          parsed = JSON.parse(jsonMatch[0]);
        }

        const ideas = parsed.ideas || [];
        console.log(`[extract-ideas] Extracted ${ideas.length} ideas`);

        // Format and send to Google Chat
        const gchatSpace = process.env.GOOGLE_CHAT_SPACE_NAME;
        if (gchatSpace && ideas.length > 0) {
          let chatMsg = `*Idea Extraction — ${ideas.length} potential work items*\n\n`;
          for (const idea of ideas) {
            const tag = idea.existing ? `[EXISTS: ${idea.existing}]` : "[NEW]";
            chatMsg += `${tag} *${idea.title}*\n${idea.description}\n\n`;
          }
          const ideaResult = await deliverMessage(supabase, chatMsg.trim(), {
            channel: "google-chat",
            spaceName: gchatSpace,
            telegramBot: bot,
            telegramChatId: ALLOWED_USER_ID,
            fallback: true,
          });
          console.log(`[extract-ideas] Sent to ${ideaResult.channel} (${ideaResult.status})`);
        } else if (!gchatSpace) {
          console.warn("[extract-ideas] GOOGLE_CHAT_SPACE_NAME not set — skipping chat notification");
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, ideas }));
      } catch (err) {
        console.error("[extract-ideas] Error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    })();
    return;
  }

  // Memory analytics endpoints (GET requests)
  if (url.pathname.startsWith("/api/memory/") && req.method === "GET") {
    (async () => {
      try {
        const { handleGetStats, handleGetTimeline, handleGetByAgent } =
          await import("./api/memory-analytics.ts");

        // Parse query params
        const queryParams: Record<string, string> = {};
        url.searchParams.forEach((v, k) => { queryParams[k] = v; });

        // Extract endpoint and params
        const pathParts = url.pathname.replace("/api/memory/", "").split("/");
        const endpoint = pathParts[0]; // "stats", "timeline", or "by-agent"
        const param = pathParts[1] || null; // agent name for by-agent

        const mockReq = { query: queryParams, params: { agent: param } } as any;
        const mockRes = {
          status: (code: number) => ({
            json: (data: any) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: any) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        } as any;

        switch (endpoint) {
          case "stats":
            await handleGetStats(mockReq, mockRes);
            break;
          case "timeline":
            await handleGetTimeline(mockReq, mockRes);
            break;
          case "by-agent":
            if (!param) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Missing agent parameter" }));
              return;
            }
            await handleGetByAgent(mockReq, mockRes);
            break;
          default:
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unknown memory endpoint" }));
        }
      } catch (err) {
        console.error("[memory-analytics] Error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    })();
    return;
  }

  // Work session endpoints
  if (url.pathname.startsWith("/api/work-session/") && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        let data: any;
        try {
          data = JSON.parse(body);
        } catch (parseErr) {
          console.error("[work-session] JSON parse error:", parseErr, "body:", body.substring(0, 200));
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          return;
        }
        const endpoint = url.pathname.replace("/api/work-session/", "");

        // Import work-session handlers
        const { startWorkSession, updateWorkSession, logDecision, completeWorkSession, pauseWorkSession, resumeWorkSession } =
          await import("./api/work-session.ts");

        // Mock req/res objects that match Express signature
        const mockReq = { body: data } as any;
        const mockRes = {
          status: (code: number) => ({
            json: (data: any) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: any) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        } as any;

        switch (endpoint) {
          case "start":
            await startWorkSession(mockReq, mockRes, bot);
            break;
          case "update":
            await updateWorkSession(mockReq, mockRes, bot);
            break;
          case "decision":
            await logDecision(mockReq, mockRes, bot);
            break;
          case "complete":
            await completeWorkSession(mockReq, mockRes, bot);
            break;
          case "pause":
            await pauseWorkSession(mockReq, mockRes, bot);
            break;
          case "resume":
            await resumeWorkSession(mockReq, mockRes, bot);
            break;
          default:
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unknown work-session endpoint" }));
        }
      } catch (err) {
        console.error("[work-session] Error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
    return;
  }

  // Incident response endpoints (ELLIE-89)
  if (url.pathname.startsWith("/api/incident/") && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        let data: any;
        try {
          data = JSON.parse(body);
        } catch (parseErr) {
          console.error("[incident] JSON parse error:", parseErr, "body:", body.substring(0, 200));
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          return;
        }
        const endpoint = url.pathname.replace("/api/incident/", "");

        const { raiseIncident, updateIncident, resolveIncident } =
          await import("./api/incident.ts");

        const mockReq = { body: data } as any;
        const mockRes = {
          status: (code: number) => ({
            json: (data: any) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: any) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        } as any;

        switch (endpoint) {
          case "raise":
            await raiseIncident(mockReq, mockRes, bot);
            break;
          case "update":
            await updateIncident(mockReq, mockRes, bot);
            break;
          case "resolve":
            await resolveIncident(mockReq, mockRes, bot);
            break;
          default:
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unknown incident endpoint" }));
        }
      } catch (err) {
        console.error("[incident] Error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
    return;
  }

  // Forest shared memory endpoints (ELLIE-90)
  if (url.pathname.startsWith("/api/forest-memory/") && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        let data: any;
        try {
          data = JSON.parse(body);
        } catch (parseErr) {
          console.error("[forest-memory] JSON parse error:", parseErr, "body:", body.substring(0, 200));
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          return;
        }
        const endpoint = url.pathname.replace("/api/forest-memory/", "");

        const { writeMemoryEndpoint, readMemoryEndpoint, agentContextEndpoint,
          resolveContradictionEndpoint, askCriticEndpoint, creatureWriteMemoryEndpoint } =
          await import("./api/memory.ts");

        const mockReq = { body: data } as any;
        const mockRes = {
          status: (code: number) => ({
            json: (data: any) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: any) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        } as any;

        switch (endpoint) {
          case "write":
            await writeMemoryEndpoint(mockReq, mockRes, bot);
            break;
          case "read":
            await readMemoryEndpoint(mockReq, mockRes, bot);
            break;
          case "context":
            await agentContextEndpoint(mockReq, mockRes, bot);
            break;
          case "resolve":
            await resolveContradictionEndpoint(mockReq, mockRes, bot);
            break;
          case "ask-critic":
            await askCriticEndpoint(mockReq, mockRes, bot);
            break;
          case "creature-write":
            await creatureWriteMemoryEndpoint(mockReq, mockRes, bot);
            break;
          default:
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unknown forest-memory endpoint" }));
        }
      } catch (err) {
        console.error("[forest-memory] Error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
    return;
  }

  // Forest ES search, metrics & suggest endpoints (ELLIE-105)
  if (url.pathname.startsWith("/forest/api/") && req.method === "GET") {
    (async () => {
      try {
        const endpoint = url.pathname.replace("/forest/api/", "");
        const { searchForest, getForestMetrics, suggestTreeNames } =
          await import("./elasticsearch/search-forest.ts");
        const { withBreaker } = await import("./elasticsearch/circuit-breaker.ts");

        switch (endpoint) {
          case "search": {
            const q = url.searchParams.get("q") || "";
            if (!q) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Missing required query parameter: q" }));
              return;
            }
            const indices = url.searchParams.get("indices")?.split(",").filter(Boolean) as any;
            const limit = parseInt(url.searchParams.get("limit") || "20", 10);
            const results = await withBreaker(
              () => searchForest(q, {
                indices,
                limit,
                filters: {
                  treeType: url.searchParams.get("types") || undefined,
                  entityName: url.searchParams.get("entities") || undefined,
                  state: url.searchParams.get("states") || undefined,
                  dateFrom: url.searchParams.get("from") || undefined,
                  dateTo: url.searchParams.get("to") || undefined,
                },
              }),
              []
            );
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ results, count: results.length }));
            break;
          }

          case "metrics": {
            const metrics = await withBreaker(
              () => getForestMetrics({
                timeRange: url.searchParams.get("from") && url.searchParams.get("to")
                  ? { from: url.searchParams.get("from")!, to: url.searchParams.get("to")! }
                  : undefined,
                entityNames: url.searchParams.get("entities")?.split(",").filter(Boolean),
              }),
              {
                creaturesByEntity: {}, eventsByKind: {}, treesByType: {},
                creaturesByState: {}, failureRate: 0,
                totalEvents: 0, totalCreatures: 0, totalTrees: 0,
              }
            );
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(metrics));
            break;
          }

          case "suggest": {
            const q = url.searchParams.get("q") || "";
            if (!q) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Missing required query parameter: q" }));
              return;
            }
            const suggestions = await withBreaker(() => suggestTreeNames(q), []);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ suggestions }));
            break;
          }

          default:
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unknown forest API endpoint" }));
        }
      } catch (err) {
        console.error("[forest-api] Error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    })();
    return;
  }

  // Agent registry endpoints (ELLIE-91)
  if (url.pathname.startsWith("/api/agents") || url.pathname === "/api/capabilities") {
    (async () => {
      const queryParams: Record<string, string> = {};
      for (const [k, v] of url.searchParams.entries()) queryParams[k] = v;

      // Extract :name from path: /api/agents/:name or /api/agents/:name/skills
      const pathParts = url.pathname.replace("/api/agents", "").split("/").filter(Boolean);
      const agentName = pathParts[0] || undefined;
      const subResource = pathParts[1] || undefined;

      const mockReq: any = { query: { ...queryParams, name: agentName }, params: { name: agentName } };
      const mockRes: any = {
        statusCode: 200,
        status(code: number) { this.statusCode = code; return this; },
        json(data: any) {
          res.writeHead(this.statusCode, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        },
      };

      try {
        const { listAgentsEndpoint, getAgentEndpoint, getAgentSkillsEndpoint, findCapabilityEndpoint } =
          await import("./api/agents.ts");

        if (url.pathname === "/api/capabilities") {
          await findCapabilityEndpoint(mockReq, mockRes, supabase, bot);
        } else if (url.pathname === "/api/agents" || url.pathname === "/api/agents/") {
          if (queryParams.q) {
            await findCapabilityEndpoint(mockReq, mockRes, supabase, bot);
          } else {
            await listAgentsEndpoint(mockReq, mockRes, supabase, bot);
          }
        } else if (subResource === "skills") {
          await getAgentSkillsEndpoint(mockReq, mockRes, supabase, bot);
        } else if (agentName) {
          await getAgentEndpoint(mockReq, mockRes, supabase, bot);
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown agents endpoint" }));
        }
      } catch (err) {
        console.error("[agents-api] Error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    })();
    return;
  }

  // Vault credential endpoints (ELLIE-32)
  if (url.pathname.startsWith("/api/vault/")) {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        let data: any = {};
        if (body) {
          try {
            data = JSON.parse(body);
          } catch (parseErr) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return;
          }
        }

        const {
          createVaultCredential, listVaultCredentials, getVaultCredential,
          updateVaultCredential, deleteVaultCredential,
          resolveVaultCredential, authenticatedFetch,
        } = await import("./api/vault.ts");

        // Parse query params for GET requests
        const queryParams: Record<string, string> = {};
        url.searchParams.forEach((v, k) => { queryParams[k] = v; });

        // Extract ID from path: /api/vault/credentials/:id
        const pathParts = url.pathname.replace("/api/vault/", "").split("/");
        const segment = pathParts[0]; // "credentials", "resolve", or "fetch"
        const id = pathParts[1] || null;

        const mockReq = { body: data, params: { id }, query: queryParams } as any;
        const mockRes = {
          status: (code: number) => ({
            json: (data: any) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: any) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        } as any;

        if (!supabase) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Database not configured" }));
          return;
        }

        if (segment === "credentials") {
          if (req.method === "POST" && !id) {
            await createVaultCredential(mockReq, mockRes, supabase);
          } else if (req.method === "GET" && !id) {
            await listVaultCredentials(mockReq, mockRes, supabase);
          } else if (req.method === "GET" && id) {
            await getVaultCredential(mockReq, mockRes, supabase);
          } else if (req.method === "PATCH" && id) {
            await updateVaultCredential(mockReq, mockRes, supabase);
          } else if (req.method === "DELETE" && id) {
            await deleteVaultCredential(mockReq, mockRes, supabase);
          } else {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Method not allowed" }));
          }
        } else if (segment === "resolve" && req.method === "POST") {
          await resolveVaultCredential(mockReq, mockRes, supabase);
        } else if (segment === "fetch" && req.method === "POST") {
          await authenticatedFetch(mockReq, mockRes, supabase);
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown vault endpoint" }));
        }
      } catch (err) {
        console.error("[vault] Error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
    return;
  }

  // Rollup endpoints
  if (url.pathname.startsWith("/api/rollup/") && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const endpoint = url.pathname.replace("/api/rollup/", "");

        const { generateRollup } = await import("./api/rollup.ts");

        const mockReq = { body: data } as any;
        const mockRes = {
          status: (code: number) => ({
            json: (data: any) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: any) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        } as any;

        if (!supabase) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Database not configured" }));
          return;
        }

        switch (endpoint) {
          case "generate":
            await generateRollup(mockReq, mockRes, supabase, bot);
            break;
          case "latest": {
            const { getLatestRollup } = await import("./api/rollup.ts");
            await getLatestRollup(mockReq, mockRes, supabase);
            break;
          }
          default: {
            // Check for /api/rollup/YYYY-MM-DD
            if (/^\d{4}-\d{2}-\d{2}$/.test(endpoint)) {
              const { getRollupByDate } = await import("./api/rollup.ts");
              const dateReq = { body: data, params: { date: endpoint } } as any;
              await getRollupByDate(dateReq, mockRes, supabase);
            } else {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Unknown rollup endpoint" }));
            }
          }
        }
      } catch (err) {
        console.error("[rollup] Error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
    return;
  }

  // Rollup GET endpoints
  if (url.pathname.startsWith("/api/rollup/") && req.method === "GET") {
    (async () => {
      try {
        const endpoint = url.pathname.replace("/api/rollup/", "");

        const mockRes = {
          status: (code: number) => ({
            json: (data: any) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: any) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        } as any;

        if (!supabase) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Database not configured" }));
          return;
        }

        if (endpoint === "latest") {
          const { getLatestRollup } = await import("./api/rollup.ts");
          await getLatestRollup({} as any, mockRes, supabase);
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(endpoint)) {
          const { getRollupByDate } = await import("./api/rollup.ts");
          await getRollupByDate({ params: { date: endpoint } } as any, mockRes, supabase);
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown rollup endpoint" }));
        }
      } catch (err) {
        console.error("[rollup] Error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    })();
    return;
  }

  // Weekly review endpoint
  if (url.pathname === "/api/weekly-review/generate" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const { generateWeeklyReview } = await import("./api/weekly-review.ts");

        const mockReq = { body: data } as any;
        const mockRes = {
          status: (code: number) => ({
            json: (data: any) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: any) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        } as any;

        if (!supabase) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Database not configured" }));
          return;
        }

        await generateWeeklyReview(mockReq, mockRes, supabase, bot);
      } catch (err) {
        console.error("[weekly-review] Error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
    return;
  }

  // Security sweep
  if (url.pathname === "/api/security-sweep" && req.method === "GET") {
    (async () => {
      try {
        const { runSecuritySweep } = await import("../scripts/security-sweep.ts");
        const result = await runSecuritySweep();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error("[security-sweep] Error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    })();
    return;
  }

  // ── Outlook email API endpoints ──
  if (url.pathname.startsWith("/api/outlook/")) {
    if (!isOutlookConfigured()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Outlook not configured" }));
      return;
    }

    const endpoint = url.pathname.replace("/api/outlook/", "");

    if (endpoint === "unread" && req.method === "GET") {
      (async () => {
        try {
          const limit = parseInt(url.searchParams.get("limit") || "10");
          const messages = await outlookListUnread(limit);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ messages }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
      return;
    }

    if (endpoint === "search" && req.method === "GET") {
      (async () => {
        try {
          const q = url.searchParams.get("q") || "";
          const limit = parseInt(url.searchParams.get("limit") || "10");
          const messages = await outlookSearchMessages(q, limit);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ messages }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
      return;
    }

    if (endpoint.startsWith("message/") && req.method === "GET") {
      (async () => {
        try {
          const messageId = decodeURIComponent(endpoint.replace("message/", ""));
          const message = await outlookGetMessage(messageId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
      return;
    }

    if (endpoint === "send" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);
          await outlookSendEmail(payload);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (endpoint === "reply" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { messageId, comment } = JSON.parse(body);
          await outlookReplyToMessage(messageId, comment);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (endpoint.startsWith("read/") && req.method === "POST") {
      (async () => {
        try {
          const messageId = decodeURIComponent(endpoint.replace("read/", ""));
          await outlookMarkAsRead(messageId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
      return;
    }
  }

  // Memory dashboard (static HTML)
  if (url.pathname === "/memory" && req.method === "GET") {
    (async () => {
      try {
        const htmlPath = join(PROJECT_ROOT, "public", "memory-dashboard.html");
        const html = await readFile(htmlPath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } catch (err) {
        console.error("[memory-dashboard] Error serving dashboard:", err);
        res.writeHead(500);
        res.end("Error loading dashboard");
      }
    })();
    return;
  }

  // Forest UI proxy — forward /forest/* to Nuxt dev server
  if (url.pathname === "/forest" || url.pathname.startsWith("/forest/") || url.pathname.startsWith("/_nuxt/")) {
    const forestPort = process.env.FOREST_UI_PORT || "3002";
    const targetUrl = `http://127.0.0.1:${forestPort}${req.url}`;
    (async () => {
      try {
        const proxyRes = await fetch(targetUrl, {
          method: req.method,
          headers: Object.fromEntries(
            Object.entries(req.headers)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v!])
          ),
          body: ['GET', 'HEAD'].includes(req.method || 'GET') ? undefined : req as any,
        });
        res.writeHead(proxyRes.status, Object.fromEntries(proxyRes.headers.entries()));
        if (proxyRes.body) {
          const reader = proxyRes.body.getReader();
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
            res.end();
          };
          pump();
        } else {
          res.end(await proxyRes.text());
        }
      } catch (err) {
        // Nuxt dev server not running — show helpful message
        res.writeHead(502, { "Content-Type": "text/html" });
        res.end(`<html><body style="background:#111;color:#aaa;font-family:monospace;padding:2em">
          <h2>Forest UI not running</h2>
          <p>Start the dev server: <code style="color:#4ade80">cd forest-ui && bun run dev</code></p>
        </body></html>`);
      }
    })();
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const voiceWss = new WebSocketServer({ noServer: true });

voiceWss.on("connection", (ws: WebSocket) => {
  console.log("[voice] Media stream connected");
  const session: VoiceCallSession = {
    ws, streamSid: null, callSid: null,
    audioChunks: [], silenceTimer: null,
    lastAudioTime: 0, lastSpeechTime: 0,
    hasSpeech: false, processing: false, speaking: false,
    conversationHistory: [],
  };

  ws.on("message", async (data: Buffer | string) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.event) {
        case "connected":
          console.log("[voice] Stream connected:", msg.protocol);
          break;

        case "start":
          session.streamSid = msg.streamSid;
          session.callSid = msg.callSid;
          console.log(`[voice] Call started — streamSid: ${msg.streamSid}, callSid: ${msg.callSid}`);
          break;

        case "media": {
          // Ignore inbound audio while Ellie is speaking (prevents echo/feedback loop)
          if (session.speaking) break;

          const payload = Buffer.from(msg.media.payload, "base64");
          const now = Date.now();
          session.lastAudioTime = now;

          const energy = mulawEnergy(payload);
          const isSpeech = energy > MULAW_ENERGY_THRESHOLD;

          if (isSpeech) {
            // This packet has speech — accumulate it
            session.audioChunks.push(payload);
            session.lastSpeechTime = now;
            session.hasSpeech = true;

            // Clear any pending silence timer since we're still hearing speech
            if (session.silenceTimer) {
              clearTimeout(session.silenceTimer);
              session.silenceTimer = null;
            }
          } else if (session.hasSpeech && !session.processing) {
            // Silence after speech — start/reset silence timer
            // Still accumulate a little trailing audio for natural cutoff
            session.audioChunks.push(payload);

            if (!session.silenceTimer) {
              session.silenceTimer = setTimeout(() => {
                session.silenceTimer = null;
                const totalBytes = session.audioChunks.reduce((sum, c) => sum + c.length, 0);
                const estimatedMs = (totalBytes / 8000) * 1000;

                if (estimatedMs >= MIN_AUDIO_MS) {
                  session.hasSpeech = false;
                  processVoiceAudio(session);
                } else {
                  session.audioChunks = [];
                  session.hasSpeech = false;
                }
              }, SILENCE_THRESHOLD_MS);
            }
          }
          // If no speech yet and not after speech, just discard (background silence)
          break;
        }

        case "mark":
          console.log(`[voice] Playback mark: ${msg.mark?.name}`);
          session.speaking = false;
          // Clear any audio that leaked in during playback
          session.audioChunks = [];
          session.hasSpeech = false;
          break;

        case "stop":
          console.log("[voice] Stream stopped");
          if (session.silenceTimer) clearTimeout(session.silenceTimer);
          break;
      }
    } catch (error) {
      console.error("[voice] Message parse error:", error);
    }
  });

  ws.on("close", () => {
    console.log("[voice] WebSocket closed");
    if (session.silenceTimer) clearTimeout(session.silenceTimer);

    // Voice call ended — consolidate immediately
    if (session.conversationHistory.length > 0) {
      console.log("[voice] Call ended with messages — triggering consolidation...");
      triggerConsolidation("voice");
    }
  });

  ws.on("error", (error) => console.error("[voice] WebSocket error:", error));
});

// ============================================================
// CHROME EXTENSION LIVE FEED (WebSocket)
// ============================================================

const extensionWss = new WebSocketServer({ noServer: true });
const extensionClients = new Set<WebSocket>();

// Route WebSocket upgrades to the correct WSS
httpServer.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (pathname === "/media-stream") {
    voiceWss.handleUpgrade(req, socket, head, (ws) => {
      voiceWss.emit("connection", ws, req);
    });
  } else if (pathname === "/extension") {
    extensionWss.handleUpgrade(req, socket, head, (ws) => {
      extensionWss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

extensionWss.on("connection", (ws: WebSocket) => {
  let authenticated = false;

  // 5-second auth timeout
  const authTimer = setTimeout(() => {
    if (!authenticated) {
      ws.close(4001, "Auth timeout");
    }
  }, 5000);

  ws.on("message", (data: Buffer | string) => {
    try {
      const msg = JSON.parse(data.toString());

      if (!authenticated) {
        if (msg.type === "auth" && msg.key === EXTENSION_API_KEY && EXTENSION_API_KEY) {
          authenticated = true;
          clearTimeout(authTimer);
          extensionClients.add(ws);
          ws.send(JSON.stringify({ type: "auth_ok", ts: Date.now() }));
          console.log(`[extension] Client authenticated (${extensionClients.size} connected)`);
        } else {
          ws.close(4003, "Invalid key");
        }
        return;
      }

      // Handle pong from client keepalive
      if (msg.type === "pong") return;
    } catch {
      // Ignore parse errors
    }
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    extensionClients.delete(ws);
    if (authenticated) {
      console.log(`[extension] Client disconnected (${extensionClients.size} connected)`);
    }
  });

  ws.on("error", () => {
    clearTimeout(authTimer);
    extensionClients.delete(ws);
  });
});

// Server-side ping every 30s to keep connections alive through nginx
setInterval(() => {
  const ping = JSON.stringify({ type: "ping", ts: Date.now() });
  for (const ws of extensionClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(ping);
    } else {
      extensionClients.delete(ws);
    }
  }
}, 30_000);

/** Fire-and-forget broadcast to all connected extension clients. */
function broadcastExtension(event: Record<string, any>): void {
  if (extensionClients.size === 0) return;
  const payload = JSON.stringify({ ...event, ts: Date.now() });
  console.log(`[extension] Broadcasting ${event.type} to ${extensionClients.size} client(s)`);
  for (const ws of extensionClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    } else {
      console.log(`[extension] Client readyState=${ws.readyState}, skipping`);
    }
  }
}

// ============================================================
// START
// ============================================================

// Init Google Chat (optional — skips gracefully if not configured)
const gchatEnabled = await initGoogleChat();

// Init Microsoft Outlook (optional — skips gracefully if not configured)
const outlookEnabled = await initOutlook();

// Start delivery nudge checker — sends reminder if response wasn't acknowledged
startNudgeChecker(async (channel, count) => {
  const nudgeText = `Hey Dave — I sent you a response${count > 1 ? ` (${count} messages)` : ""} a few minutes ago. Did it come through?`;
  console.log(`[delivery] Nudging on ${channel} (${count} pending responses)`);
  try {
    if (channel === "google-chat" && gchatEnabled) {
      const gchatSpace = process.env.GOOGLE_CHAT_SPACE_NAME;
      if (gchatSpace) await sendGoogleChatMessage(gchatSpace, nudgeText);
    } else if (channel === "telegram" && ALLOWED_USER_ID) {
      await bot.api.sendMessage(ALLOWED_USER_ID, nudgeText);
    }
  } catch (err) {
    console.error(`[delivery] Nudge failed on ${channel}:`, err);
  }
});

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);
console.log(`Agent mode: ${AGENT_MODE ? "ON" : "OFF"}${AGENT_MODE ? ` (tools: ${ALLOWED_TOOLS.join(", ")})` : ""}`);
console.log(`Google Chat: ${gchatEnabled ? "ON" : "OFF"}`);
console.log(`Outlook: ${outlookEnabled ? "ON (" + getOutlookEmail() + ")" : "OFF"}`);

// Initialize ES forest sync (if configured)
await initForestSync();

// Start HTTP + WebSocket server
httpServer.listen(HTTP_PORT, () => {
  console.log(`[http] Server listening on port ${HTTP_PORT}`);
  console.log(`[voice] WebSocket: ws://localhost:${HTTP_PORT}/media-stream`);
  console.log(`[extension] WebSocket: ws://localhost:${HTTP_PORT}/extension`);
  console.log(`[voice] TwiML webhook: http://localhost:${HTTP_PORT}/voice`);
  if (PUBLIC_URL) {
    console.log(`[voice] Public URL: ${PUBLIC_URL}`);
    if (gchatEnabled) {
      console.log(`[gchat] Webhook URL: ${PUBLIC_URL}/google-chat`);
    }
  } else {
    console.log(`[voice] Warning: PUBLIC_URL not set in .env`);
  }
});

// Start Telegram bot (long-polling)
bot.start({
  onStart: () => {
    console.log("Telegram bot is running!");
  },
});
