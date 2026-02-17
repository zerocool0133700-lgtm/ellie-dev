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
import {
  initGoogleChat,
  parseGoogleChatEvent,
  sendGoogleChatMessage,
  isAllowedSender,
  isGoogleChatEnabled,
  type GoogleChatEvent,
} from "./google-chat.ts";
import {
  routeAndDispatch,
  syncResponse,
  type DispatchResult,
} from "./agent-router.ts";
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
} from "./plane.ts";

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
const DEFAULT_TOOLS = "Read,Edit,Write,Bash,Glob,Grep,WebSearch,WebFetch";
const MCP_TOOLS = "mcp__google-workspace__*,mcp__github__*,mcp__memory__*,mcp__sequential-thinking__*,mcp__plane__*,mcp__claude_ai_Miro__*,mcp__brave-search__*";
const ALLOWED_TOOLS = (process.env.ALLOWED_TOOLS || `${DEFAULT_TOOLS},${MCP_TOOLS}`).split(",").map(t => t.trim());

// Voice call config
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
const HTTP_PORT = parseInt(process.env.HTTP_PORT || "3000");
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const SILENCE_THRESHOLD_MS = 800; // ms of silence after speech to trigger processing
const MIN_AUDIO_MS = 400;
const TMP_DIR = process.env.TMPDIR || "/tmp";

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
 * Run consolidation for a channel, then invalidate the context cache
 * so the next interaction gets fresh data.
 */
async function triggerConsolidation(channel?: string): Promise<void> {
  if (!supabase || !process.env.ANTHROPIC_API_KEY) return;
  try {
    const created = await consolidateNow(supabase, process.env.ANTHROPIC_API_KEY, {
      channel,
      onComplete: () => {
        // Invalidate context cache so next message gets fresh docket
        cachedContext = null;
      },
    });
    if (created) {
      console.log(`[consolidate] Conversation ended (${channel || "all"}) — context cache cleared`);
    }
  } catch (err) {
    console.error("[consolidate] Inline consolidation error:", err);
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
): Promise<void> {
  if (!supabase) return;
  try {
    const { data } = await supabase.from("messages").insert({
      role,
      content,
      channel,
      metadata: metadata || {},
    }).select("id").single();

    // Index to ES (fire-and-forget)
    if (data?.id) {
      indexMessage({
        id: data.id,
        content, role, channel,
        created_at: new Date().toISOString(),
      }).catch(() => {});
    }
  } catch (error) {
    console.error("Supabase save error:", error);
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
  options?: { resume?: boolean; imagePath?: string; allowedTools?: string[]; model?: string }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  // Resume previous session if available and requested
  if (options?.resume && session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  args.push("--output-format", "text");

  // Per-agent model override — disabled for now (specifying a model ID
  // routes to API credits instead of the Max subscription default)
  // if (options?.model) { args.push("--model", options.model); }

  // Agent mode: allow tools without interactive prompts
  if (AGENT_MODE) {
    const tools = options?.allowedTools?.length ? options.allowedTools : ALLOWED_TOOLS;
    args.push("--allowedTools", ...tools);
  }

  // Log CLI invocation details (redact prompt, show flags)
  const flagArgs = args.slice(1).filter(a => a.startsWith("--"));
  const resumeId = options?.resume && session.sessionId ? session.sessionId.slice(0, 8) : null;
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
    const timeout = setTimeout(() => {
      timedOut = true;
      console.error(`[claude] Timeout after ${TIMEOUT_MS / 1000}s — killing process`);
      proc.kill();
    }, TIMEOUT_MS);

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    clearTimeout(timeout);

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error(
        `[claude] Exit code ${exitCode}` +
        `${timedOut ? " (timed out)" : ""}` +
        `${stderr ? ` — stderr: ${stderr.substring(0, 500)}` : " — no stderr"}` +
        `${output ? ` — stdout preview: ${output.substring(0, 200)}` : ""}`
      );
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
let busy = false;
const messageQueue: Array<() => Promise<void>> = [];

async function processQueue(): Promise<void> {
  while (messageQueue.length > 0) {
    const next = messageQueue.shift()!;
    await next();
  }
  busy = false;
}

/**
 * Enqueue a task for the shared Claude pipeline.
 * Used by non-Telegram channels (Google Chat) that don't have a grammY ctx.
 * Returns a promise that resolves when the task completes.
 */
function enqueue(task: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const wrapped = async () => {
      try {
        await task();
        resolve();
      } catch (err) {
        reject(err);
      }
    };

    if (busy) {
      messageQueue.push(wrapped);
      return;
    }
    busy = true;
    wrapped().finally(() => processQueue());
  });
}

function withQueue(handler: (ctx: Context) => Promise<void>) {
  return async (ctx: Context) => {
    if (busy) {
      const position = messageQueue.length + 1;
      await ctx.reply(`I'm working on something — I'll get to this next. (Queue position: ${position})`);
      messageQueue.push(() => handler(ctx));
      return;
    }
    busy = true;
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

  await saveMessage("user", text);

  // Route message to appropriate agent (falls back gracefully)
  const agentResult = await routeAndDispatch(supabase, text, "telegram", userId);

  // Gather context: docket + semantic search + ES full-text search
  const [contextDocket, relevantContext, elasticContext] = await Promise.all([
    getContextDocket(),
    getRelevantContext(supabase, text),
    searchElastic(text, { limit: 5, recencyBoost: true }),
  ]);

  // Detect work item mentions (ELLIE-5, EVE-3, etc.)
  let workItemContext = "";
  const workItemMatch = text.match(/\b([A-Z]+-\d+)\b/);
  if (workItemMatch && isPlaneConfigured()) {
    const details = await fetchWorkItemDetails(workItemMatch[1]);
    if (details) {
      workItemContext = `\nACTIVE WORK ITEM: ${workItemMatch[1]}\n` +
        `Title: ${details.name}\n` +
        `Priority: ${details.priority}\n` +
        `Description: ${details.description}\n`;
    }
  }

  const enrichedPrompt = buildPrompt(
    text, contextDocket, relevantContext, elasticContext, "telegram",
    agentResult?.dispatch.agent ? { system_prompt: agentResult.dispatch.agent.system_prompt, name: agentResult.dispatch.agent.name, tools_enabled: agentResult.dispatch.agent.tools_enabled } : undefined,
    workItemContext,
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
  const response = await processMemoryIntents(supabase, rawResponse);

  // Show agent indicator on new sessions (not "general")
  if (agentResult && agentResult.dispatch.agent.name !== "general" && agentResult.dispatch.is_new) {
    await ctx.reply(`\u{1F916} ${agentResult.dispatch.agent.name} agent`);
  }

  const cleanedResponse = await sendWithApprovals(ctx, response, session.sessionId);

  await saveMessage("assistant", cleanedResponse);

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

    const voiceUserId = ctx.from?.id.toString() || "";
    const agentResult = await routeAndDispatch(supabase, transcription, "telegram", voiceUserId);

    const [contextDocket, relevantContext, elasticContext] = await Promise.all([
      getContextDocket(),
      getRelevantContext(supabase, transcription),
      searchElastic(transcription, { limit: 5, recencyBoost: true }),
    ]);

    const enrichedPrompt = buildPrompt(
      `[Voice message transcribed]: ${transcription}`,
      contextDocket,
      relevantContext,
      elasticContext,
      "telegram",
      agentResult?.dispatch.agent ? { system_prompt: agentResult.dispatch.agent.system_prompt, name: agentResult.dispatch.agent.name, tools_enabled: agentResult.dispatch.agent.tools_enabled } : undefined,
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
    const claudeResponse = await processMemoryIntents(supabase, rawResponse);

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
    const cleanedResponse = await sendWithApprovals(ctx, claudeResponse, session.sessionId);

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
}));

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

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
    const finalResponse = await sendWithApprovals(ctx, cleanResponse, session.sessionId);
    await saveMessage("assistant", finalResponse);
    resetTelegramIdleTimer();
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  }
}));

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

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
    const finalResponse = await sendWithApprovals(ctx, cleanResponse, session.sessionId);
    await saveMessage("assistant", finalResponse);
    resetTelegramIdleTimer();
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  }
}));

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
  const response = await processMemoryIntents(supabase, rawResponse);
  const cleanedResponse = await sendWithApprovals(ctx, response, session.sessionId);
  await saveMessage("assistant", cleanedResponse);
  resetTelegramIdleTimer();
}));

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
  const response = await processMemoryIntents(supabase, rawResponse);
  const cleanedResponse = await sendWithApprovals(ctx, response, session.sessionId);
  await saveMessage("assistant", cleanedResponse);
  resetTelegramIdleTimer();
}));

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

function buildPrompt(
  userMessage: string,
  contextDocket?: string,
  relevantContext?: string,
  elasticContext?: string,
  channel: string = "telegram",
  agentConfig?: { system_prompt?: string | null; name?: string; tools_enabled?: string[] },
  workItemContext?: string,
): string {
  const channelLabel = channel === "google-chat" ? "Google Chat" : "Telegram";

  // Use agent-specific system prompt if available, otherwise default
  const basePrompt = agentConfig?.system_prompt
    ? `${agentConfig.system_prompt}\nYou are responding via ${channelLabel}. Keep responses concise and conversational.`
    : `You are a personal AI assistant responding via ${channelLabel}. Keep responses concise and conversational.`;

  const parts = [basePrompt];

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
        "You also have MCP tools: Google Workspace (Gmail, Calendar, Drive, Docs, Sheets, Tasks — user_google_email is zerocool0133700@gmail.com), " +
        "GitHub, Memory, Sequential Thinking, and Plane (project management — workspace: evelife at plane.ellie-labs.dev). " +
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
  if (contextDocket) parts.push(`\nCONTEXT:\n${contextDocket}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);
  if (elasticContext) parts.push(`\n${elasticContext}`);

  parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]"
  );

  parts.push(
    "\nACTION CONFIRMATIONS:" +
      "\nWhen about to take a significant action affecting external systems " +
      "(sending emails, creating calendar events, posting to channels, " +
      "git push, modifying databases, or any difficult-to-undo action), " +
      "include a [CONFIRM: description] tag in your response INSTEAD of executing the action." +
      "\nThe user will see Approve/Deny buttons on Telegram. " +
      "If approved, you will be resumed with instructions to proceed. " +
      "If denied, you will be told not to proceed." +
      "\nDo NOT use [CONFIRM:] for read-only actions like searching, reading files, or checking status." +
      "\nDo NOT use [CONFIRM:] for trivial actions the user explicitly and directly asked you to do." +
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

// Direct Anthropic API client for voice (much faster than CLI spawn)
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

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

    const conversationContext = session.conversationHistory
      .slice(-6)
      .map(m => `${m.role}: ${m.content}`)
      .join("\n");

    // Now that we have text, run text-dependent searches in parallel.
    // contextDocketPromise was already started during transcription.
    const [contextDocket, relevantContext, elasticContext] = await Promise.all([
      contextDocketPromise,
      getRelevantContext(supabase, text),
      searchElastic(text, { limit: 3, recencyBoost: true }),
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

        // Process synchronously — Google Chat requires the response in the webhook body
        // to appear as the bot (async API sends would appear as the user, not the bot)
        await saveMessage("user", parsed.text, {
          sender: parsed.senderEmail,
          space: parsed.spaceName,
        }, "google-chat");

        const gchatAgentResult = await routeAndDispatch(supabase, parsed.text, "google-chat", parsed.senderEmail);

        const [contextDocket, relevantContext, elasticContext] = await Promise.all([
          getContextDocket(),
          getRelevantContext(supabase, parsed.text),
          searchElastic(parsed.text, { limit: 5, recencyBoost: true }),
        ]);

        const enrichedPrompt = buildPrompt(
          parsed.text, contextDocket, relevantContext, elasticContext, "google-chat",
          gchatAgentResult?.dispatch.agent ? { system_prompt: gchatAgentResult.dispatch.agent.system_prompt, name: gchatAgentResult.dispatch.agent.name, tools_enabled: gchatAgentResult.dispatch.agent.tools_enabled } : undefined,
        );

        const gchatAgentTools = gchatAgentResult?.dispatch.agent.tools_enabled;
        const gchatAgentModel = gchatAgentResult?.dispatch.agent.model;

        const gchatStart = Date.now();
        const rawResponse = await callClaude(enrichedPrompt, {
          resume: true,
          allowedTools: gchatAgentTools?.length ? gchatAgentTools : undefined,
          model: gchatAgentModel || undefined,
        });
        const gchatDuration = Date.now() - gchatStart;
        const response = await processMemoryIntents(supabase, rawResponse);

        if (gchatAgentResult) {
          syncResponse(supabase, gchatAgentResult.dispatch.session_id, response, {
            duration_ms: gchatDuration,
          }).catch(() => {});
        }

        await saveMessage("assistant", response, {
          space: parsed.spaceName,
        }, "google-chat");
        resetGchatIdleTimer();

        // Return response synchronously — Workspace Add-on format
        console.log(`[gchat] Replying: ${response.substring(0, 80)}...`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          hostAppDataAction: {
            chatDataAction: {
              createMessageAction: {
                message: { text: response },
              },
            },
          },
        }));

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

  // Health check
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      service: "ellie-relay",
      voice: !!ELEVENLABS_API_KEY,
      googleChat: isGoogleChatEnabled(),
    }));
    return;
  }

  // Work session endpoints
  if (url.pathname.startsWith("/api/work-session/") && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const endpoint = url.pathname.replace("/api/work-session/", "");

        // Import work-session handlers
        const { startWorkSession, updateWorkSession, logDecision, completeWorkSession } =
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

        if (!supabase) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Database not configured" }));
          return;
        }

        switch (endpoint) {
          case "start":
            await startWorkSession(mockReq, mockRes, supabase, bot);
            break;
          case "update":
            await updateWorkSession(mockReq, mockRes, supabase, bot);
            break;
          case "decision":
            await logDecision(mockReq, mockRes, supabase, bot);
            break;
          case "complete":
            await completeWorkSession(mockReq, mockRes, supabase, bot);
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

  res.writeHead(404);
  res.end("Not found");
});

const voiceWss = new WebSocketServer({ server: httpServer, path: "/media-stream" });

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
// START
// ============================================================

// Init Google Chat (optional — skips gracefully if not configured)
const gchatEnabled = await initGoogleChat();

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);
console.log(`Agent mode: ${AGENT_MODE ? "ON" : "OFF"}${AGENT_MODE ? ` (tools: ${ALLOWED_TOOLS.join(", ")})` : ""}`);
console.log(`Google Chat: ${gchatEnabled ? "ON" : "OFF"}`);

// Start HTTP + WebSocket server
httpServer.listen(HTTP_PORT, () => {
  console.log(`[http] Server listening on port ${HTTP_PORT}`);
  console.log(`[voice] WebSocket: ws://localhost:${HTTP_PORT}/media-stream`);
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
