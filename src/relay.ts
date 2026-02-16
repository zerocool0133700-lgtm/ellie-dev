/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context, InputFile } from "grammy";
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
const MCP_TOOLS = "mcp__google-workspace__*,mcp__github__*,mcp__memory__*,mcp__sequential-thinking__*";
const ALLOWED_TOOLS = (process.env.ALLOWED_TOOLS || `${DEFAULT_TOOLS},${MCP_TOOLS}`).split(",").map(t => t.trim());

// Voice call config
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
const HTTP_PORT = parseInt(process.env.HTTP_PORT || "3000");
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const SILENCE_THRESHOLD_MS = 1200; // ms of silence after speech to trigger processing
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
    await supabase.from("messages").insert({
      role,
      content,
      channel,
      metadata: metadata || {},
    });
  } catch (error) {
    console.error("Supabase save error:", error);
  }
}

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

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
  options?: { resume?: boolean; imagePath?: string }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  // Resume previous session if available and requested
  if (options?.resume && session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  args.push("--output-format", "text");

  // Agent mode: allow tools without interactive prompts
  if (AGENT_MODE) {
    args.push("--allowedTools", ...ALLOWED_TOOLS);
  }

  console.log(`Calling Claude: ${prompt.substring(0, 50)}...`);

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || undefined,
      env: {
        ...process.env,
        CLAUDECODE: "", // Prevent nested session detection
      },
    });

    // Agentic tasks can take 2+ minutes (tool use, multi-step reasoning)
    const TIMEOUT_MS = AGENT_MODE ? 180_000 : 60_000;
    const timeout = setTimeout(() => proc.kill(), TIMEOUT_MS);

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    clearTimeout(timeout);

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error("Claude error:", stderr);
      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
    }

    // Extract session ID from output if present (for --resume)
    const sessionMatch = output.match(/Session ID: ([a-f0-9-]+)/i);
    if (sessionMatch) {
      session.sessionId = sessionMatch[1];
      session.lastActivity = new Date().toISOString();
      await saveSession(session);
    }

    return output.trim();
  } catch (error) {
    console.error("Spawn error:", error);
    return `Error: Could not run Claude CLI`;
  }
}

// ============================================================
// TYPING HEARTBEAT + CONCURRENCY
// ============================================================

async function callClaudeWithTyping(
  ctx: Context,
  prompt: string,
  options?: { resume?: boolean; imagePath?: string }
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
  console.log(`Message: ${text.substring(0, 50)}...`);

  await ctx.replyWithChatAction("typing");

  await saveMessage("user", text);

  // Gather context: docket + semantic search for this specific message
  const [contextDocket, relevantContext] = await Promise.all([
    getContextDocket(),
    getRelevantContext(supabase, text),
  ]);

  const enrichedPrompt = buildPrompt(text, contextDocket, relevantContext);
  const rawResponse = await callClaudeWithTyping(ctx, enrichedPrompt, { resume: true });

  // Parse and save any memory intents, strip tags from response
  const response = await processMemoryIntents(supabase, rawResponse);

  await saveMessage("assistant", response);
  await sendResponse(ctx, response);
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

    const [contextDocket, relevantContext] = await Promise.all([
      getContextDocket(),
      getRelevantContext(supabase, transcription),
    ]);

    const enrichedPrompt = buildPrompt(
      `[Voice message transcribed]: ${transcription}`,
      contextDocket,
      relevantContext
    );
    const rawResponse = await callClaudeWithTyping(ctx, enrichedPrompt, { resume: true });
    const claudeResponse = await processMemoryIntents(supabase, rawResponse);

    await saveMessage("assistant", claudeResponse);
    await sendResponse(ctx, claudeResponse);
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
    await saveMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
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
    await saveMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
    resetTelegramIdleTimer();
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  }
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
): string {
  const parts = [
    "You are a personal AI assistant responding via Telegram. Keep responses concise and conversational.",
  ];

  if (AGENT_MODE) {
    parts.push(
      "You have full tool access: Read, Edit, Write, Bash, Glob, Grep, WebSearch, WebFetch. " +
      "You also have MCP tools: Google Workspace (Gmail, Calendar, Drive, Docs, Sheets, Tasks — user_google_email is zerocool0133700@gmail.com), " +
      "GitHub, Memory, and Sequential Thinking. " +
      "Use them freely to answer questions — read files, run commands, search code, browse the web, check email, manage calendar. " +
      "IMPORTANT: NEVER run sudo commands, NEVER install packages (apt, npm -g, brew), NEVER run commands that require interactive input or confirmation. " +
      "If a task would require sudo or installing software, tell the user what to run instead. " +
      "The user is reading on a phone. After using tools, give a concise final answer (not the raw tool output). " +
      "If a task requires multiple steps, just do them — don't ask for permission."
    );
  }

  if (USER_NAME) parts.push(`You are speaking with ${USER_NAME}.`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (contextDocket) parts.push(`\nCONTEXT:\n${contextDocket}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);

  parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]"
  );

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
    stdout: "pipe", stderr: "pipe",
    cwd: PROJECT_DIR || undefined,
    env: { ...process.env, CLAUDECODE: "" },
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

  try {
    console.log(`[voice] Transcribing ${chunks.length} chunks...`);
    const text = await transcribeMulaw(chunks);

    if (!text || text.length < 2 || text.includes("[BLANK_AUDIO]") || text.includes("(blank audio)")) {
      console.log("[voice] Empty/blank transcription, skipping");
      session.processing = false;
      return;
    }

    console.log(`[voice] User said: "${text}"`);
    session.conversationHistory.push({ role: "user", content: text });
    await saveMessage("user", text, { callSid: session.callSid }, "voice");

    const conversationContext = session.conversationHistory
      .slice(-6)
      .map(m => `${m.role}: ${m.content}`)
      .join("\n");

    // Pull context docket + semantic search for this specific utterance
    const [contextDocket, relevantContext] = await Promise.all([
      getContextDocket(),
      getRelevantContext(supabase, text),
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

    console.log(`[voice] Ellie says: "${cleanResponse}"`);
    session.conversationHistory.push({ role: "assistant", content: cleanResponse });
    await saveMessage("assistant", cleanResponse, { callSid: session.callSid }, "voice");

    const audioBase64 = await textToSpeechMulaw(cleanResponse);

    if (!audioBase64 || !session.streamSid) {
      console.error("[voice] No audio or no stream SID");
      session.processing = false;
      return;
    }

    // Mark as speaking — ignore inbound audio until playback finishes
    session.speaking = true;

    // Clear buffered audio then send response
    session.ws.send(JSON.stringify({ event: "clear", streamSid: session.streamSid }));

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

    session.ws.send(JSON.stringify({
      event: "mark",
      streamSid: session.streamSid,
      mark: { name: `response_${Date.now()}` },
    }));
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

  // Health check
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "ellie-relay", voice: !!ELEVENLABS_API_KEY }));
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

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);
console.log(`Agent mode: ${AGENT_MODE ? "ON" : "OFF"}${AGENT_MODE ? ` (tools: ${ALLOWED_TOOLS.join(", ")})` : ""}`);

// Start HTTP + WebSocket server
httpServer.listen(HTTP_PORT, () => {
  console.log(`[http] Server listening on port ${HTTP_PORT}`);
  console.log(`[voice] WebSocket: ws://localhost:${HTTP_PORT}/media-stream`);
  console.log(`[voice] TwiML webhook: http://localhost:${HTTP_PORT}/voice`);
  if (PUBLIC_URL) {
    console.log(`[voice] Public URL: ${PUBLIC_URL}`);
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
