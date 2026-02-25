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
import { createHmac } from "crypto";
import { writeFile, appendFile, mkdir, readFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { WebSocketServer, WebSocket } from "ws";
import Anthropic from "@anthropic-ai/sdk";
import { transcribe } from "./transcribe.ts";
import {
  textToSpeechOgg,
  textToSpeechFast,
} from "./tts.ts";
import {
  buildPrompt,
  getArchetypeContext,
  getPsyContext,
  getPhaseContext,
  getHealthContext,
  runPostMessageAssessment,
  getPlanningMode,
  setPlanningMode,
  USER_NAME,
  USER_TIMEZONE,
} from "./prompt-builder.ts";
import {
  callClaude,
  callClaudeWithTyping,
  callClaudeVoice,
  session,
  saveSession,
  acquireLock,
  releaseLock,
  setBroadcastExtension,
  setNotifyCtx,
  setAnthropicClient,
  type SessionState,
} from "./claude-cli.ts";
import {
  enqueue,
  enqueueEllieChat,
  withQueue,
  getQueueStatus,
  setQueueBroadcast,
} from "./message-queue.ts";
import { handleVoiceConnection, setVoicePipelineDeps } from "./voice-pipeline.ts";
import {
  saveMessage,
  sendResponse,
  sendWithApprovals,
  sendWithApprovalsEllieChat,
  ellieChatPendingActions,
  setSenderDeps,
} from "./message-sender.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
} from "./memory.ts";
import { consolidateNow } from "./consolidate-inline.ts";
import { searchElastic } from "./elasticsearch.ts";
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
  type RouteResult,
} from "./agent-router.ts";
import { initClassifier } from "./intent-classifier.ts";
import { initEntailmentClassifier } from "./entailment-classifier.ts";
import {
  trimSearchContext,
  getSpecialistAck,
  formatForestMetrics,
  estimateTokens,
} from "./relay-utils.ts";
import { getStructuredContext, getAgentStructuredContext, getAgentMemoryContext, getMaxMemoriesForModel, getGoogleTasksJSON, getLiveForestContext } from "./context-sources.ts";
import { syncAllCalendars } from "./calendar-sync.ts";
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
  getPendingAction,
  removePendingAction,
  startExpiryCleanup,
} from "./approval.ts";
import {
  isPlaneConfigured,
  fetchWorkItemDetails,
  listOpenIssues,
  setTimeoutRecoveryLock,
  createPlaneIssue,
} from "./plane.ts";
import { extractPlaybookCommands, executePlaybookCommands, type PlaybookContext } from "./playbook.ts";
import { notify, type NotifyContext } from "./notification-policy.ts";
import {
  getOrCreateConversation,
  closeActiveConversation,
  closeConversation,
  expireIdleConversations,
  getConversationContext,
  getConversationMessages,
} from "./conversations.ts";
import {
  getQueueContext,
  acknowledgeQueueItems,
  expireStaleItems,
  getQueueStats,
  getAndAcknowledgeReadouts,
} from "./api/agent-queue.ts";
import { onBridgeWrite } from "./api/bridge.ts";
import {
  handleToolApprovalHTTP,
  resolveToolApproval,
  setBroadcastToEllieChat,
  clearSessionApprovals,
} from "./tool-approval.ts";

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
const MCP_TOOLS = "mcp__google-workspace__*,mcp__github__*,mcp__memory__*,mcp__sequential-thinking__*,mcp__plane__*,mcp__claude_ai_Miro__*,mcp__brave-search__*,mcp__excalidraw__*,mcp__forest-bridge__*";
const ALLOWED_TOOLS = (process.env.ALLOWED_TOOLS || `${DEFAULT_TOOLS},${MCP_TOOLS}`).split(",").map(t => t.trim());

// Voice call config
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
const HTTP_PORT = parseInt(process.env.HTTP_PORT || "3000");
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const EXTENSION_API_KEY = process.env.EXTENSION_API_KEY || "";
const ALLOWED_CALLERS: Set<string> = new Set(
  [process.env.DAVE_PHONE_NUMBER, ...(process.env.ALLOWED_CALLERS || "").split(",")]
    .map(n => n?.trim().replace(/\D/g, ""))
    .filter(Boolean)
);

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
// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// SessionState, session, saveSession, acquireLock, releaseLock
// imported from ./claude-cli.ts (ELLIE-205)

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

const IDLE_MS_DEFAULT = 10 * 60_000;     // 10 minutes of silence = conversation over
const IDLE_MS_PLANNING = 60 * 60_000;   // 60 minutes in planning mode
// planningMode state managed in prompt-builder.ts (getPlanningMode/setPlanningMode)

function getIdleMs(): number {
  return getPlanningMode() ? IDLE_MS_PLANNING : IDLE_MS_DEFAULT;
}

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
  const ms = getIdleMs();
  telegramIdleTimer = setTimeout(() => {
    console.log(`[consolidate] Telegram idle for ${ms / 60_000} minutes — consolidating...`);
    triggerConsolidation("telegram");
  }, ms);
}

function resetGchatIdleTimer(): void {
  if (gchatIdleTimer) clearTimeout(gchatIdleTimer);
  const ms = getIdleMs();
  gchatIdleTimer = setTimeout(() => {
    console.log(`[consolidate] Google Chat idle for ${ms / 60_000} minutes — consolidating...`);
    triggerConsolidation("google-chat");
  }, ms);
}

let ellieChatIdleTimer: ReturnType<typeof setTimeout> | null = null;
function resetEllieChatIdleTimer(): void {
  if (ellieChatIdleTimer) clearTimeout(ellieChatIdleTimer);
  const ms = getIdleMs();
  ellieChatIdleTimer = setTimeout(() => {
    console.log(`[consolidate] Ellie Chat idle for ${ms / 60_000} minutes — consolidating...`);
    triggerConsolidation("ellie-chat");
  }, ms);
}

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

// saveMessage extracted to ./message-sender.ts (ELLIE-207)

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

export const bot = new Bot(BOT_TOKEN);

// Notification policy context — used by notify() for dispatch confirms + error alerts (ELLIE-80)
const GCHAT_SPACE_NOTIFY = process.env.GOOGLE_CHAT_SPACE_NAME || "";
function getNotifyCtx(): NotifyContext {
  return { bot, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY };
}

// Start approval expiry cleanup
startExpiryCleanup();

// Periodic idle conversation expiry (every 5 minutes)
setInterval(async () => {
  if (supabase) {
    // Properly close stale conversations with memory extraction (replaces blind DB expiry)
    try {
      const { data: stale } = await supabase
        .from("conversations")
        .select("id, channel, message_count, last_message_at")
        .eq("status", "active")
        .lt("last_message_at", new Date(Date.now() - 30 * 60_000).toISOString());
      for (const convo of stale || []) {
        console.log(`[conversation] Expiring stale ${convo.channel} conversation (${convo.message_count} msgs, last activity: ${convo.last_message_at})`);
        if (convo.message_count >= 2) {
          await closeConversation(supabase, convo.id);
        } else {
          await supabase.rpc("close_conversation", { p_conversation_id: convo.id });
        }
      }
    } catch (err: any) {
      console.error("[conversation] Stale conversation cleanup error:", err?.message);
    }
    expireStaleAgentSessions(supabase).catch(() => {});
  }
  // Expire Ellie Chat pending confirm actions (15-min TTL)
  const now = Date.now();
  for (const [id, action] of ellieChatPendingActions) {
    if (now - action.createdAt > 15 * 60_000) {
      ellieChatPendingActions.delete(id);
      console.log(`[ellie-chat approval] Expired: ${action.description.substring(0, 60)}`);
    }
  }
}, 5 * 60_000);

// Calendar sync (every 5 minutes)
setInterval(async () => {
  try {
    await syncAllCalendars();
  } catch (err: any) {
    console.error("[calendar-sync] Periodic sync error:", err?.message);
  }
}, 5 * 60_000);

// Stale queue item expiry — every hour (ELLIE-201)
setInterval(() => {
  expireStaleItems().catch(err => console.error("[agent-queue] Stale expiry error:", err));
}, 60 * 60_000);
// Run once on startup (10s delay)
setTimeout(() => {
  expireStaleItems().catch(err => console.error("[agent-queue] Initial stale expiry error:", err));
}, 10_000);

// Bridge write notifications — Telegram + ellie-chat (ELLIE-199)
onBridgeWrite(({ collaborator, content, memoryId, type, workItemId }) => {
  const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
  const ticket = workItemId ? ` (${workItemId})` : '';
  const label = type === 'decision' ? 'decided' : type === 'hypothesis' ? 'hypothesized' : 'logged';

  // Telegram notification
  notify(getNotifyCtx(), {
    event: "dispatch_confirm",
    workItemId: memoryId,
    telegramMessage: `📋 *${collaborator}* ${label}${ticket}: ${preview}`,
    gchatMessage: `${collaborator} ${label}${ticket}: ${preview}`,
  }).catch(err => console.error("[bridge-notify]", err.message));

  // Push to ellie-chat clients (lazy ref — ellieChatClients defined later in file)
  broadcastToEllieChatClients({
    type: "finding",
    collaborator,
    content,
    memoryId,
    findingType: type,
    workItemId,
    ts: Date.now(),
  });
});

// Initial calendar sync (10s after startup)
setTimeout(async () => {
  try {
    await syncAllCalendars();
    console.log("[calendar-sync] Initial sync complete");
  } catch (err: any) {
    console.error("[calendar-sync] Initial sync error:", err?.message);
  }
}, 10_000);

// Memory maintenance: expire short-term memories (every 15 minutes)
setInterval(async () => {
  try {
    const { expireShortTermMemories } = await import('../../ellie-forest/src/shared-memory');
    const expired = await expireShortTermMemories();
    if (expired > 0) console.log(`[memory-maintenance] Expired ${expired} short-term memories`);
  } catch (err: any) {
    console.error("[memory-maintenance] Short-term expiry error:", err?.message);
  }
}, 15 * 60_000);

// Memory maintenance: refresh weights (every hour)
setInterval(async () => {
  try {
    const { refreshWeights } = await import('../../ellie-forest/src/shared-memory');
    const refreshed = await refreshWeights({ limit: 500 });
    if (refreshed > 0) console.log(`[memory-maintenance] Refreshed weights for ${refreshed} memories`);
  } catch (err: any) {
    console.error("[memory-maintenance] Weight refresh error:", err?.message);
  }
}, 60 * 60_000);

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

// callClaude, callClaudeWithTyping, callClaudeVoice, session management
// extracted to ./claude-cli.ts (ELLIE-205)

// Queue (enqueue, enqueueEllieChat, withQueue, getQueueStatus)
// extracted to ./message-queue.ts (ELLIE-206)

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

  await saveMessage("user", text, undefined, "telegram", userId);
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

  // /plan on|off — toggle planning mode
  const planMatch = text.match(/^\/plan\s+(on|off)$/i);
  if (planMatch) {
    setPlanningMode(planMatch[1].toLowerCase() === "on");
    const msg = getPlanningMode()
      ? "Planning mode ON — conversation will persist for up to 60 minutes of idle time."
      : "Planning mode OFF — reverting to 10-minute idle timeout.";
    console.log(`[planning] ${msg}`);
    await ctx.reply(msg);
    resetTelegramIdleTimer();
    resetGchatIdleTimer();
    resetEllieChatIdleTimer();
    broadcastExtension({ type: "planning_mode", active: getPlanningMode() });
    return;
  }

  // ELLIE:: user-typed commands — bypass classifier, execute directly
  const { cleanedText: userPlaybookClean, commands: userPlaybookCmds } = extractPlaybookCommands(text);
  if (userPlaybookCmds.length > 0) {
    console.log(`[telegram] ELLIE:: commands in user message: ${userPlaybookCmds.map(c => c.type).join(", ")}`);
    await ctx.reply(`Processing ${userPlaybookCmds.length} playbook command(s)...`);
    const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "telegram", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
    executePlaybookCommands(userPlaybookCmds, pbCtx).catch(err => console.error("[playbook]", err));
    return;
  }

  // Route message to appropriate agent via LLM classifier (falls back gracefully)
  const detectedWorkItem = text.match(/\b([A-Z]+-\d+)\b/)?.[1];
  const agentResult = await routeAndDispatch(supabase, text, "telegram", userId, detectedWorkItem);
  const effectiveText = agentResult?.route.strippedMessage || text;
  if (agentResult) {
    setActiveAgent("telegram", agentResult.dispatch.agent.name);
    broadcastExtension({ type: "route", channel: "telegram", agent: agentResult.dispatch.agent.name, mode: agentResult.route.execution_mode, confidence: agentResult.route.confidence });

    // Dispatch confirmation — routed through notification policy (ELLIE-80)
    if (agentResult.dispatch.agent.name !== "general" && agentResult.dispatch.is_new) {
      const agentName = agentResult.dispatch.agent.name;
      notify(getNotifyCtx(), {
        event: "dispatch_confirm",
        workItemId: agentName,
        telegramMessage: `🤖 ${agentName} agent`,
        gchatMessage: `🤖 ${agentName} agent dispatched`,
      }).catch((err) => console.error("[notify] dispatch_confirm:", err.message));
    }
  }

  // Gather context: full conversation (primary) + docket + search (excluding current conversation) + structured + forest + agent memory + queue
  const activeAgent = getActiveAgent("telegram");
  const activeConvoId = await getOrCreateConversation(supabase!, "telegram") || undefined;
  const [conversationContext, contextDocket, relevantContext, elasticContext, structuredContext, forestContext, agentMemory, queueContext, liveForest] = await Promise.all([
    activeConvoId && supabase ? getConversationMessages(supabase, activeConvoId) : Promise.resolve({ text: "", messageCount: 0, conversationId: "" }),
    getContextDocket(),
    getRelevantContext(supabase, effectiveText, "telegram", activeAgent, activeConvoId),
    searchElastic(effectiveText, { limit: 5, recencyBoost: true, channel: "telegram", sourceAgent: activeAgent, excludeConversationId: activeConvoId }),
    getAgentStructuredContext(supabase, activeAgent),
    getForestContext(effectiveText),
    getAgentMemoryContext(activeAgent, detectedWorkItem, getMaxMemoriesForModel(agentResult?.dispatch.agent.model)),
    agentResult?.dispatch.is_new ? getQueueContext(activeAgent) : Promise.resolve(""),
    getLiveForestContext(effectiveText),
  ]);
  const recentMessages = conversationContext.text;
  // Auto-acknowledge queue items on new session (fire-and-forget)
  if (agentResult?.dispatch.is_new && queueContext) {
    acknowledgeQueueItems(activeAgent).catch(() => {});
  }

  // Detect work item mentions (ELLIE-5, EVE-3, etc.)
  let workItemContext = "";
  const workItemMatch = effectiveText.match(/\b([A-Z]+-\d+)\b/);
  const isWorkIntent = agentResult?.route.skill_name === "code_changes" ||
    agentResult?.route.skill_name === "code_review" ||
    agentResult?.route.skill_name === "debugging";
  if (workItemMatch && isPlaneConfigured()) {
    const details = await fetchWorkItemDetails(workItemMatch[1]);
    if (details) {
      const label = isWorkIntent ? "ACTIVE WORK ITEM" : "REFERENCED WORK ITEM";
      workItemContext = `\n${label}: ${workItemMatch[1]}\n` +
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
      const pipelineResponse = await processMemoryIntents(supabase, result.finalResponse, agentName, "shared", agentMemory.sessionIds);
      const { cleanedText: playbookClean, commands: playbookCommands } = extractPlaybookCommands(pipelineResponse);
      const cleanedPipelineResponse = await sendWithApprovals(ctx, playbookClean, session.sessionId, agentName);
      await saveMessage("assistant", cleanedPipelineResponse, undefined, "telegram", userId);
      runPostMessageAssessment(text, cleanedPipelineResponse, anthropic).catch(err => console.error("[assessment]", err));
      broadcastExtension({ type: "pipeline_complete", channel: "telegram", mode: execMode, steps: result.stepResults.length, duration_ms: result.artifacts.total_duration_ms, cost_usd: result.artifacts.total_cost_usd });

      if (result.finalDispatch) {
        syncResponse(supabase, result.finalDispatch.session_id, cleanedPipelineResponse, {
          duration_ms: result.artifacts.total_duration_ms,
        }).catch(() => {});
      }

      // Fire playbook commands async (ELLIE:: tags)
      if (playbookCommands.length > 0) {
        const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "telegram", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
        executePlaybookCommands(playbookCommands, pbCtx).catch(err => console.error("[playbook]", err));
      }

      console.log(
        `[orchestrator] ${execMode}: ${result.stepResults.length} steps in ${result.artifacts.total_duration_ms}ms, ` +
        `$${result.artifacts.total_cost_usd.toFixed(4)}`,
      );
    } catch (err) {
      clearInterval(typingInterval);
      if (err instanceof PipelineStepError && err.partialOutput) {
        console.error(`[orchestrator] Step ${err.stepIndex} failed (${err.errorType}), sending partial results`);
        const partialResponse = await processMemoryIntents(supabase, err.partialOutput, agentResult?.dispatch.agent.name || "general", "shared", agentMemory.sessionIds);
        await sendResponse(ctx, partialResponse + "\n\n(Execution incomplete \u2014 showing partial results.)");
        await saveMessage("assistant", partialResponse, undefined, "telegram", userId);
        runPostMessageAssessment(text, partialResponse, anthropic).catch(err2 => console.error("[assessment]", err2));
      } else {
        console.error("[orchestrator] Multi-step failed, falling back to single agent:", err);
        const fallbackPrompt = buildPrompt(
          effectiveText, contextDocket, relevantContext, elasticContext, "telegram",
          agentResult?.dispatch.agent ? { system_prompt: agentResult.dispatch.agent.system_prompt, name: agentResult.dispatch.agent.name, tools_enabled: agentResult.dispatch.agent.tools_enabled } : undefined,
          workItemContext, structuredContext, recentMessages,
          agentResult?.dispatch.skill_context,
          forestContext,
          agentMemory.memoryContext || undefined,
          agentMemory.sessionIds,
          await getArchetypeContext(),
          await getPsyContext(),
          await getPhaseContext(),
          await getHealthContext(),
          queueContext || undefined,
          liveForest.incidents || undefined,
          liveForest.awareness || undefined,
        );
        const fallbackRaw = await callClaudeWithTyping(ctx, fallbackPrompt, { resume: true });
        const fallbackAgentName = agentResult?.dispatch.agent.name || "general";
        const fallbackResponse = await processMemoryIntents(supabase, fallbackRaw, fallbackAgentName, "shared", agentMemory.sessionIds);
        const cleaned = await sendWithApprovals(ctx, fallbackResponse, session.sessionId, fallbackAgentName);
        await saveMessage("assistant", cleaned, undefined, "telegram", userId);
        runPostMessageAssessment(text, cleaned, anthropic).catch(err2 => console.error("[assessment]", err2));
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
    agentMemory.memoryContext || undefined,
    agentMemory.sessionIds,
    await getArchetypeContext(),
    await getPsyContext(),
    await getPhaseContext(),
    await getHealthContext(),
    queueContext || undefined,
    liveForest.incidents || undefined,
    liveForest.awareness || undefined,
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

  // Late-resolve sessionIds if not available at context-build time
  let effectiveSessionIds = agentMemory.sessionIds;
  if (!effectiveSessionIds && agentResult?.dispatch.agent.name) {
    try {
      const { default: forestSql } = await import('../../ellie-forest/src/db');
      const { getEntity } = await import('../../ellie-forest/src/index');
      const AGENT_ENTITY_MAP: Record<string, string> = { dev: "dev_agent", general: "general_agent" };
      const entityName = AGENT_ENTITY_MAP[agentResult.dispatch.agent.name] ?? agentResult.dispatch.agent.name;
      const entity = await getEntity(entityName);
      if (entity) {
        const [tree] = await forestSql<any[]>`
          SELECT t.id, t.work_item_id FROM trees t
          JOIN creatures c ON c.tree_id = t.id
          WHERE t.type = 'work_session' AND t.state IN ('growing', 'dormant')
            AND t.last_activity > NOW() - INTERVAL '5 minutes' AND c.entity_id = ${entity.id}
          ORDER BY t.last_activity DESC LIMIT 1
        `;
        if (tree) {
          const [creature] = await forestSql<{ id: string }[]>`
            SELECT id FROM creatures WHERE tree_id = ${tree.id} AND entity_id = ${entity.id}
            ORDER BY created_at DESC LIMIT 1
          `;
          effectiveSessionIds = { tree_id: tree.id, creature_id: creature?.id, entity_id: entity.id, work_item_id: tree.work_item_id };
          console.log(`[telegram] Late-resolved sessionIds: tree=${tree.id.slice(0, 8)}`);
        }
      }
    } catch (err: any) {
      console.warn(`[telegram] Late-resolve sessionIds failed:`, err?.message || err);
    }
  }

  // Parse and save any memory intents, strip tags from response
  const response = await processMemoryIntents(supabase, rawResponse, agentResult?.dispatch.agent.name || "general", "shared", effectiveSessionIds);

  // Extract ELLIE:: playbook commands before sending to user
  const { cleanedText: playbookCleanedResponse, commands: tgPlaybookCommands } = extractPlaybookCommands(response);

  const cleanedResponse = await sendWithApprovals(ctx, playbookCleanedResponse, session.sessionId, agentResult?.dispatch.agent.name);

  await saveMessage("assistant", cleanedResponse, undefined, "telegram", userId);
  runPostMessageAssessment(text, cleanedResponse, anthropic).catch(err => console.error("[assessment]", err));
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

  // Fire playbook commands async (ELLIE:: tags)
  if (tgPlaybookCommands.length > 0) {
    const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "telegram", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
    executePlaybookCommands(tgPlaybookCommands, pbCtx).catch(err => console.error("[playbook]", err));
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

    const voiceUserId = ctx.from?.id.toString() || "";
    await saveMessage("user", `[Voice ${voice.duration}s]: ${transcription}`, undefined, "telegram", voiceUserId);
    broadcastExtension({ type: "message_in", channel: "telegram", preview: `[Voice ${voice.duration}s]: ${transcription.substring(0, 150)}` });
    const voiceWorkItem = transcription.match(/\b([A-Z]+-\d+)\b/)?.[1];
    const agentResult = await routeAndDispatch(supabase, transcription, "telegram", voiceUserId, voiceWorkItem);
    const effectiveTranscription = agentResult?.route.strippedMessage || transcription;
    if (agentResult) {
      setActiveAgent("telegram", agentResult.dispatch.agent.name);
      broadcastExtension({ type: "route", channel: "telegram", agent: agentResult.dispatch.agent.name, mode: agentResult.route.execution_mode });

      // Dispatch confirmation for voice (matches text handler)
      if (agentResult.dispatch.agent.name !== "general" && agentResult.dispatch.is_new) {
        const agentName = agentResult.dispatch.agent.name;
        notify(getNotifyCtx(), {
          event: "dispatch_confirm",
          workItemId: agentName,
          telegramMessage: `🤖 ${agentName} agent`,
          gchatMessage: `🤖 ${agentName} agent dispatched`,
        }).catch((err) => console.error("[notify] dispatch_confirm:", err.message));
      }
    }

    const voiceActiveAgent = getActiveAgent("telegram");
    const voiceConvoId = await getOrCreateConversation(supabase!, "telegram") || undefined;
    const [voiceConvoContext, contextDocket, relevantContext, elasticContext, structuredContext, forestContext, agentMemory, voiceQueueContext, liveForest] = await Promise.all([
      voiceConvoId && supabase ? getConversationMessages(supabase, voiceConvoId) : Promise.resolve({ text: "", messageCount: 0, conversationId: "" }),
      getContextDocket(),
      getRelevantContext(supabase, effectiveTranscription, "telegram", voiceActiveAgent, voiceConvoId),
      searchElastic(effectiveTranscription, { limit: 5, recencyBoost: true, channel: "telegram", sourceAgent: voiceActiveAgent, excludeConversationId: voiceConvoId }),
      getAgentStructuredContext(supabase, voiceActiveAgent),
      getForestContext(effectiveTranscription),
      getAgentMemoryContext(voiceActiveAgent, voiceWorkItem, getMaxMemoriesForModel(agentResult?.dispatch.agent.model)),
      agentResult?.dispatch.is_new ? getQueueContext(voiceActiveAgent) : Promise.resolve(""),
      getLiveForestContext(effectiveTranscription),
    ]);
    const recentMessages = voiceConvoContext.text;
    if (agentResult?.dispatch.is_new && voiceQueueContext) {
      acknowledgeQueueItems(voiceActiveAgent).catch(() => {});
    }

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
        const pipelineResponse = await processMemoryIntents(supabase, result.finalResponse, voiceAgentName, "shared", agentMemory.sessionIds);
        const cleaned = await sendWithApprovals(ctx, pipelineResponse, session.sessionId, voiceAgentName);
        await saveMessage("assistant", cleaned, undefined, "telegram", voiceUserId);
        runPostMessageAssessment(transcription, cleaned, anthropic).catch(err => console.error("[assessment]", err));

        if (result.finalDispatch) {
          syncResponse(supabase, result.finalDispatch.session_id, cleaned, {
            duration_ms: result.artifacts.total_duration_ms,
          }).catch(() => {});
        }

        console.log(
          `[orchestrator] Voice ${execMode}: ${result.stepResults.length} steps in ${result.artifacts.total_duration_ms}ms, $${result.artifacts.total_cost_usd.toFixed(4)}`,
        );
      } catch (err) {
        clearInterval(typingInterval);
        if (err instanceof PipelineStepError && err.partialOutput) {
          const partialResponse = await processMemoryIntents(supabase, err.partialOutput, agentResult?.dispatch.agent.name || "general", "shared", agentMemory.sessionIds);
          await sendResponse(ctx, partialResponse + "\n\n(Execution incomplete \u2014 showing partial results.)");
          await saveMessage("assistant", partialResponse, undefined, "telegram", voiceUserId);
          runPostMessageAssessment(transcription, partialResponse, anthropic).catch(err2 => console.error("[assessment]", err2));
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
            agentMemory.memoryContext || undefined,
            agentMemory.sessionIds,
            await getArchetypeContext(),
            await getPsyContext(),
            await getPhaseContext(),
            await getHealthContext(),
            voiceQueueContext || undefined,
            liveForest.incidents || undefined,
            liveForest.awareness || undefined,
          );
          const fallbackRaw = await callClaudeWithTyping(ctx, fallbackPrompt, { resume: true });
          const voiceFallbackAgent = agentResult?.dispatch.agent.name || "general";
          const fallbackResponse = await processMemoryIntents(supabase, fallbackRaw, voiceFallbackAgent, "shared", agentMemory.sessionIds);
          const cleaned = await sendWithApprovals(ctx, fallbackResponse, session.sessionId, voiceFallbackAgent);
          await saveMessage("assistant", cleaned, undefined, "telegram", voiceUserId);
          runPostMessageAssessment(transcription, cleaned, anthropic).catch(err2 => console.error("[assessment]", err2));
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
      agentMemory.memoryContext || undefined,
      agentMemory.sessionIds,
      await getArchetypeContext(),
      await getPsyContext(),
      await getPhaseContext(),
      await getHealthContext(),
      voiceQueueContext || undefined,
      liveForest.incidents || undefined,
      liveForest.awareness || undefined,
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
    const claudeResponse = await processMemoryIntents(supabase, rawResponse, agentResult?.dispatch.agent.name || "general", "shared", agentMemory.sessionIds);

    // Try voice response for short replies without approval buttons
    const TTS_MAX_CHARS = 1500;
    const { cleanedText, confirmations } = extractApprovalTags(claudeResponse);

    if (confirmations.length === 0 && cleanedText.length <= TTS_MAX_CHARS && ELEVENLABS_API_KEY) {
      const audioBuffer = await textToSpeechOgg(cleanedText);
      if (audioBuffer) {
        await ctx.replyWithVoice(new InputFile(audioBuffer, "response.ogg"));
        await sendResponse(ctx, cleanedText);
        await saveMessage("assistant", cleanedText, undefined, "telegram", voiceUserId);
        runPostMessageAssessment(transcription, cleanedText, anthropic).catch(err => console.error("[assessment]", err));

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

    await saveMessage("assistant", cleanedResponse, undefined, "telegram", voiceUserId);
    runPostMessageAssessment(transcription, cleanedResponse, anthropic).catch(err => console.error("[assessment]", err));

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

    const imgUserId = ctx.from?.id.toString() || "";
    await saveMessage("user", `[Image]: ${caption}`, undefined, "telegram", imgUserId);

    const claudeResponse = await callClaudeWithTyping(ctx, prompt, { resume: true });

    // Cleanup after processing
    await unlink(filePath).catch(() => {});

    // Use the last-routed agent for context (photo/doc handlers don't route independently)
    const activeAgent = getActiveAgent("telegram");
    const cleanResponse = await processMemoryIntents(supabase, claudeResponse, activeAgent);
    const finalResponse = await sendWithApprovals(ctx, cleanResponse, session.sessionId, activeAgent);
    await saveMessage("assistant", finalResponse, undefined, "telegram", imgUserId);
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

    const docUserId = ctx.from?.id.toString() || "";
    await saveMessage("user", `[Document: ${doc.file_name}]: ${caption}`, undefined, "telegram", docUserId);

    const claudeResponse = await callClaudeWithTyping(ctx, prompt, { resume: true });

    await unlink(filePath).catch(() => {});

    const activeAgent = getActiveAgent("telegram");
    const cleanResponse = await processMemoryIntents(supabase, claudeResponse, activeAgent);
    const finalResponse = await sendWithApprovals(ctx, cleanResponse, session.sessionId, activeAgent);
    await saveMessage("assistant", finalResponse, undefined, "telegram", docUserId);
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

  const approveUserId = ctx.from?.id.toString() || "";
  await saveMessage("user", `[Approved action: ${action.description}]`, undefined, "telegram", approveUserId);

  const resumePrompt = `The user APPROVED the following action: "${action.description}". Proceed with executing it now.`;

  await ctx.replyWithChatAction("typing");
  const rawResponse = await callClaudeWithTyping(ctx, resumePrompt, { resume: true });
  const approveAgent = action.agentName || getActiveAgent("telegram");
  const response = await processMemoryIntents(supabase, rawResponse, approveAgent);
  const cleanedResponse = await sendWithApprovals(ctx, response, session.sessionId, approveAgent);
  await saveMessage("assistant", cleanedResponse, undefined, "telegram", approveUserId);
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

  const denyUserId = ctx.from?.id.toString() || "";
  await saveMessage("user", `[Denied action: ${action.description}]`, undefined, "telegram", denyUserId);

  const resumePrompt = `The user DENIED the following action: "${action.description}". Do NOT proceed with this action. Acknowledge briefly.`;

  await ctx.replyWithChatAction("typing");
  const rawResponse = await callClaudeWithTyping(ctx, resumePrompt, { resume: true });
  const denyAgent = action.agentName || getActiveAgent("telegram");
  const response = await processMemoryIntents(supabase, rawResponse, denyAgent);
  const cleanedResponse = await sendWithApprovals(ctx, response, session.sessionId, denyAgent);
  await saveMessage("assistant", cleanedResponse, undefined, "telegram", denyUserId);
  resetTelegramIdleTimer();
}, () => "[Denial]"));

// ============================================================
// HELPERS
// ============================================================

// formatForestMetrics is imported from relay-utils.ts

// sendResponse, sendWithApprovals, sendWithApprovalsEllieChat
// extracted to ./message-sender.ts (ELLIE-207)

// VoiceCallSession + processVoiceAudio + handleVoiceConnection
// extracted to ./voice-pipeline.ts (ELLIE-211)

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

      // Caller whitelist — only allow known numbers
      if (ALLOWED_CALLERS.size > 0) {
        const params = new URLSearchParams(voiceBody);
        const caller = (params.get("From") || "").replace(/\D/g, "");
        if (!ALLOWED_CALLERS.has(caller)) {
          console.warn(`[voice] Rejected call from ${params.get("From")} — not in whitelist`);
          const rejectTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Sorry, this number is not authorized.</Say><Hangup/></Response>`;
          res.writeHead(200, { "Content-Type": "application/xml" });
          res.end(rejectTwiml);
          return;
        }
        console.log(`[voice] Accepted call from ${params.get("From")}`);
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
        }, "google-chat", parsed.senderEmail);
        broadcastExtension({ type: "message_in", channel: "google-chat", preview: parsed.text.substring(0, 200) });

        // /plan on|off — planning mode toggle
        const gchatPlanMatch = parsed.text.match(/^\/plan\s+(on|off)$/i);
        if (gchatPlanMatch) {
          setPlanningMode(gchatPlanMatch[1].toLowerCase() === "on");
          const msg = getPlanningMode()
            ? "Planning mode ON — conversation will persist for up to 60 minutes of idle time."
            : "Planning mode OFF — reverting to 10-minute idle timeout.";
          resetTelegramIdleTimer();
          resetGchatIdleTimer();
          resetEllieChatIdleTimer();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: msg } } } },
          }));
          return;
        }

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

        // Immediately acknowledge — all routing + Claude work happens async.
        // This prevents Google Chat's ~30s webhook timeout from showing "not responding".
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: "Working on it..." } } } },
        }));

        // All remaining work is async — response delivered via Chat API
        (async () => {
          try {
            const gchatWorkItem = parsed.text.match(/\b([A-Z]+-\d+)\b/)?.[1];
            const gchatAgentResult = await routeAndDispatch(supabase, parsed.text, "google-chat", parsed.senderEmail, gchatWorkItem);
            const effectiveGchatText = gchatAgentResult?.route.strippedMessage || parsed.text;
            if (gchatAgentResult) {
              setActiveAgent("google-chat", gchatAgentResult.dispatch.agent.name);
              broadcastExtension({ type: "route", channel: "google-chat", agent: gchatAgentResult.dispatch.agent.name, mode: gchatAgentResult.route.execution_mode });

              // Dispatch confirmation — routed through notification policy (ELLIE-80)
              if (gchatAgentResult.dispatch.agent.name !== "general" && gchatAgentResult.dispatch.is_new) {
                const agentName = gchatAgentResult.dispatch.agent.name;
                notify(getNotifyCtx(), {
                  event: "dispatch_confirm",
                  workItemId: agentName,
                  telegramMessage: `🤖 ${agentName} agent`,
                  gchatMessage: `🤖 ${agentName} agent dispatched`,
                }).catch((err) => console.error("[notify] dispatch_confirm:", err.message));
              }
            }

            const gchatActiveAgent = getActiveAgent("google-chat");
            const gchatConvoId = await getOrCreateConversation(supabase!, "google-chat") || undefined;
            const [gchatConvoContext, contextDocket, relevantContext, elasticContext, structuredContext, forestContext, agentMemory, gchatQueueContext, liveForest] = await Promise.all([
              gchatConvoId && supabase ? getConversationMessages(supabase, gchatConvoId) : Promise.resolve({ text: "", messageCount: 0, conversationId: "" }),
              getContextDocket(),
              getRelevantContext(supabase, effectiveGchatText, "google-chat", gchatActiveAgent, gchatConvoId),
              searchElastic(effectiveGchatText, { limit: 5, recencyBoost: true, channel: "google-chat", sourceAgent: gchatActiveAgent, excludeConversationId: gchatConvoId }),
              getAgentStructuredContext(supabase, gchatActiveAgent),
              getForestContext(effectiveGchatText),
              getAgentMemoryContext(gchatActiveAgent, gchatWorkItem, getMaxMemoriesForModel(gchatAgentResult?.dispatch.agent.model)),
              gchatAgentResult?.dispatch.is_new ? getQueueContext(gchatActiveAgent) : Promise.resolve(""),
              getLiveForestContext(effectiveGchatText),
            ]);
            const recentMessages = gchatConvoContext.text;
            if (gchatAgentResult?.dispatch.is_new && gchatQueueContext) {
              acknowledgeQueueItems(gchatActiveAgent).catch(() => {});
            }

            // Detect work item mentions (ELLIE-5, EVE-3, etc.) — matches Telegram text handler
            let workItemContext = "";
            const workItemMatch = effectiveGchatText.match(/\b([A-Z]+-\d+)\b/);
            const isGchatWorkIntent = gchatAgentResult?.route.skill_name === "code_changes" ||
              gchatAgentResult?.route.skill_name === "code_review" ||
              gchatAgentResult?.route.skill_name === "debugging";
            if (workItemMatch && isPlaneConfigured()) {
              const details = await fetchWorkItemDetails(workItemMatch[1]);
              if (details) {
                const label = isGchatWorkIntent ? "ACTIVE WORK ITEM" : "REFERENCED WORK ITEM";
                workItemContext = `\n${label}: ${workItemMatch[1]}\n` +
                  `Title: ${details.name}\n` +
                  `Priority: ${details.priority}\n` +
                  `Description: ${details.description}\n`;
              }
            }

            // ── Google Chat multi-step branch (ELLIE-58) ──
            if (gchatAgentResult?.route.execution_mode !== "single" && gchatAgentResult?.route.skills?.length) {
              const gchatExecMode = gchatAgentResult.route.execution_mode;
              const gchatSteps: PipelineStep[] = gchatAgentResult.route.skills.map((s) => ({
                agent_name: s.agent,
                skill_name: s.skill !== "none" ? s.skill : undefined,
                instruction: s.instruction,
              }));

              const GCHAT_ORCHESTRATION_TIMEOUT_MS = 300_000; // 5 minutes max
              const result = await Promise.race([
                executeOrchestrated(gchatExecMode, gchatSteps, effectiveGchatText, {
                  supabase,
                  channel: "google-chat",
                  userId: parsed.senderEmail,
                  anthropicClient: anthropic,
                  contextDocket, relevantContext, elasticContext,
                  structuredContext, recentMessages, workItemContext, forestContext,
                  buildPromptFn: buildPrompt,
                  callClaudeFn: callClaude,
                }),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error("Orchestration timeout (5m)")), GCHAT_ORCHESTRATION_TIMEOUT_MS),
                ),
              ]);

              const gchatOrcAgent = result.finalDispatch?.agent?.name || gchatAgentResult?.dispatch.agent.name || "general";
              const pipelineResponse = await processMemoryIntents(supabase, result.finalResponse, gchatOrcAgent, "shared", agentMemory.sessionIds);
              const { cleanedText: gchatOrcPlaybookClean, commands: gchatOrcPlaybookCmds } = extractPlaybookCommands(pipelineResponse);
              const { cleanedText: gchatClean } = extractApprovalTags(gchatOrcPlaybookClean);
              await saveMessage("assistant", gchatClean, { space: parsed.spaceName }, "google-chat", parsed.senderEmail);
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

              // Fire playbook commands async (ELLIE:: tags)
              if (gchatOrcPlaybookCmds.length > 0) {
                const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "google-chat", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
                executePlaybookCommands(gchatOrcPlaybookCmds, pbCtx).catch(err => console.error("[playbook]", err));
              }
              return;
            }

            // ── Google Chat single-agent path (default) ──
            const enrichedPrompt = buildPrompt(
              effectiveGchatText, contextDocket, relevantContext, elasticContext, "google-chat",
              gchatAgentResult?.dispatch.agent ? { system_prompt: gchatAgentResult.dispatch.agent.system_prompt, name: gchatAgentResult.dispatch.agent.name, tools_enabled: gchatAgentResult.dispatch.agent.tools_enabled } : undefined,
              workItemContext || undefined, structuredContext, recentMessages,
              gchatAgentResult?.dispatch.skill_context,
              forestContext,
              agentMemory.memoryContext || undefined,
              agentMemory.sessionIds,
              await getArchetypeContext(),
              await getPsyContext(),
              await getPhaseContext(),
              await getHealthContext(),
              gchatQueueContext || undefined,
              liveForest.incidents || undefined,
              liveForest.awareness || undefined,
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
            const response = await processMemoryIntents(supabase, rawResponse, gchatAgentResult?.dispatch.agent.name || "general", "shared", agentMemory.sessionIds);
            const { cleanedText: gchatPlaybookClean, commands: gchatPlaybookCmds } = extractPlaybookCommands(response);

            if (gchatAgentResult) {
              syncResponse(supabase, gchatAgentResult.dispatch.session_id, gchatPlaybookClean, {
                duration_ms: gchatDuration,
              }).catch(() => {});
            }

            const { cleanedText: gchatClean } = extractApprovalTags(gchatPlaybookClean);
            const msgId = await saveMessage("assistant", gchatClean, { space: parsed.spaceName }, "google-chat", parsed.senderEmail);
            broadcastExtension({ type: "message_out", channel: "google-chat", agent: gchatAgentResult?.dispatch.agent.name || "general", preview: gchatClean.substring(0, 200) });
            resetGchatIdleTimer();
            console.log(`[gchat] Async reply (${gchatClean.length} chars) to ${parsed.spaceName}: ${gchatClean.substring(0, 80)}...`);

            const gchatDeliverResult = await deliverMessage(supabase, gchatClean, {
              channel: "google-chat",
              messageId: msgId || undefined,
              spaceName: parsed.spaceName,
              threadName: null,
              telegramBot: bot,
              telegramChatId: ALLOWED_USER_ID,
              fallback: true,
            });

            if (gchatDeliverResult.status === "sent") {
              console.log(`[gchat] Async delivery complete → ${gchatDeliverResult.externalId}`);
            } else if (gchatDeliverResult.status === "fallback") {
              console.log(`[gchat] Async delivery via fallback (${gchatDeliverResult.channel}) → ${gchatDeliverResult.externalId}`);
            } else {
              console.error(`[gchat] Async delivery FAILED: ${gchatDeliverResult.error}`);
            }

            // Fire playbook commands async (ELLIE:: tags)
            if (gchatPlaybookCmds.length > 0) {
              const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "google-chat", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
              executePlaybookCommands(gchatPlaybookCmds, pbCtx).catch(err => console.error("[playbook]", err));
            }
          } catch (err) {
            console.error("[gchat] Async processing error:", err);
            const errMsg = err instanceof PipelineStepError && err.partialOutput
              ? err.partialOutput + "\n\n(Execution incomplete.)"
              : "Sorry, I ran into an error while processing your request. Please try again.";
            deliverMessage(supabase, errMsg, {
              channel: "google-chat",
              spaceName: parsed.spaceName,
              threadName: null,
              telegramBot: bot,
              telegramChatId: ALLOWED_USER_ID,
              fallback: true,
              maxRetries: 1,
            }).catch(() => {});
          }
        })();

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
        }, "alexa", parsed.userId);
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

            // Route first, then gather context with correct agent
            const alexaWorkItem = query.match(/\b([A-Z]+-\d+)\b/)?.[1];
            const agentResult = await routeAndDispatch(supabase, query, "alexa", parsed.userId, alexaWorkItem);
            if (agentResult) {
              setActiveAgent("alexa", agentResult.dispatch.agent.name);
              broadcastExtension({ type: "route", channel: "alexa", agent: agentResult.dispatch.agent.name, mode: agentResult.route.execution_mode });
            }
            const effectiveQuery = agentResult?.route.strippedMessage || query;

            // Gather context with correct active agent
            const alexaActiveAgent = getActiveAgent("alexa");
            const alexaConvoId = await getOrCreateConversation(supabase!, "alexa") || undefined;
            const [alexaConvoContext, contextDocket, relevantContext, elasticContext, structuredContext, forestContext, agentMemory, alexaQueueContext, liveForest] = await Promise.all([
              alexaConvoId && supabase ? getConversationMessages(supabase, alexaConvoId) : Promise.resolve({ text: "", messageCount: 0, conversationId: "" }),
              getContextDocket(),
              getRelevantContext(supabase, effectiveQuery, "alexa", alexaActiveAgent, alexaConvoId),
              searchElastic(effectiveQuery, { limit: 5, recencyBoost: true, channel: "alexa", sourceAgent: alexaActiveAgent, excludeConversationId: alexaConvoId }),
              getAgentStructuredContext(supabase, alexaActiveAgent),
              getForestContext(effectiveQuery),
              getAgentMemoryContext(alexaActiveAgent, alexaWorkItem, getMaxMemoriesForModel(agentResult?.dispatch.agent.model)),
              agentResult?.dispatch.is_new ? getQueueContext(alexaActiveAgent) : Promise.resolve(""),
              getLiveForestContext(effectiveQuery),
            ]);
            const recentMessages = alexaConvoContext.text;
            if (agentResult?.dispatch.is_new && alexaQueueContext) {
              acknowledgeQueueItems(alexaActiveAgent).catch(() => {});
            }
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
              agentMemory.memoryContext || undefined,
              agentMemory.sessionIds,
              await getArchetypeContext(),
              await getPsyContext(),
              await getPhaseContext(),
              await getHealthContext(),
              alexaQueueContext || undefined,
              liveForest.incidents || undefined,
              liveForest.awareness || undefined,
            );

            const ALEXA_TIMEOUT_MS = 6_000;
            const claudePromise = (async () => {
              const raw = await callClaude(enrichedPrompt, {
                resume: true,
                allowedTools: agentResult?.dispatch.agent.tools_enabled?.length
                  ? agentResult.dispatch.agent.tools_enabled : undefined,
                model: agentResult?.dispatch.agent.model || undefined,
              });
              return await processMemoryIntents(supabase, raw, agentResult?.dispatch.agent.name || "general", "shared", agentMemory.sessionIds);
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
                  await saveMessage("assistant", clean, { source: "alexa-async" }, "alexa", parsed.userId);
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
              await saveMessage("assistant", clean, {}, "alexa", parsed.userId);
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
    res.end(JSON.stringify(getQueueStatus()));
    return;
  }

  // TTS endpoint — returns OGG audio for dashboard playback
  if (url.pathname === "/api/tts" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const authKey = req.headers["x-api-key"] as string;
        if (!authKey || authKey !== EXTENSION_API_KEY || !EXTENSION_API_KEY) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        const data = JSON.parse(body);
        if (!data.text || typeof data.text !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing 'text' field" }));
          return;
        }
        const fast = data.fast === true || url.searchParams.get("fast") === "1";
        const audioBuffer = fast
          ? await textToSpeechFast(data.text)
          : await textToSpeechOgg(data.text);
        if (!audioBuffer) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "TTS unavailable" }));
          return;
        }
        const contentType = fast ? "audio/mpeg" : "audio/ogg";
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": audioBuffer.length.toString(),
        });
        res.end(audioBuffer);
      } catch (err: any) {
        console.error("[tts] API error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  // STT endpoint — accepts audio, returns transcription
  if (url.pathname === "/api/stt" && req.method === "POST") {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    req.on("end", async () => {
      try {
        const authKey = req.headers["x-api-key"] as string;
        if (!authKey || authKey !== EXTENSION_API_KEY || !EXTENSION_API_KEY) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        const audioBuffer = Buffer.concat(chunks);
        if (audioBuffer.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No audio data" }));
          return;
        }
        const text = await transcribe(audioBuffer);
        if (!text) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ text: "", error: "Could not transcribe" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text }));
      } catch (err: any) {
        console.error("[stt] API error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
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

  // GTD — return pending Google Tasks as JSON
  if (url.pathname === "/api/gtd" && req.method === "GET") {
    (async () => {
      try {
        const data = await getGoogleTasksJSON();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Failed to fetch tasks" }));
      }
    })();
    return;
  }

  // Calendar sync — manual trigger
  if (url.pathname === "/api/calendar-sync" && req.method === "POST") {
    (async () => {
      try {
        await syncAllCalendars();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Sync failed" }));
      }
    })();
    return;
  }

  // Calendar events — read from ellie-forest DB
  if (url.pathname === "/api/calendar" && req.method === "GET") {
    (async () => {
      try {
        const { sql: forestSql } = await import("../../ellie-forest/src/index.ts");
        const now = new Date().toISOString();
        const weekOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const data = await forestSql`
          SELECT * FROM calendar_events
          WHERE end_time >= ${now} AND start_time <= ${weekOut} AND status != 'cancelled'
          ORDER BY start_time ASC
        `;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data || []));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([]));
      }
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

  // Create Plane ticket from context (messages, memories, or freeform text)
  if (url.pathname === "/api/ticket/from-context" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const contextParts: string[] = [];

        if (data.messages?.length) {
          contextParts.push("CONVERSATION:\n" + data.messages.join("\n---\n"));
        }

        if (data.memory_ids?.length && supabase) {
          const { data: mems } = await supabase.from("memory")
            .select("type, content")
            .in("id", data.memory_ids);
          if (mems?.length) {
            contextParts.push("MEMORIES:\n" + mems.map((m: any) => `[${m.type}] ${m.content}`).join("\n"));
          }
        }

        if (data.text) {
          contextParts.push("CONTEXT:\n" + data.text);
        }

        if (contextParts.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No context provided. Include messages, memory_ids, or text." }));
          return;
        }

        const context = contextParts.join("\n\n");
        const prompt = `Generate a Plane project ticket from this context. Return ONLY valid JSON with no markdown formatting:\n{"title": "concise title under 80 chars", "description": "detailed description with requirements as bullet points", "priority": "medium"}\n\nPriority must be one of: urgent, high, medium, low, none.\n\nContext:\n${context}`;

        console.log(`[ticket] Generating ticket from ${contextParts.length} context source(s)...`);
        const raw = await callClaude(prompt);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("Could not parse ticket JSON from Claude response");
        const ticket = JSON.parse(jsonMatch[0]);

        if (!ticket.title) throw new Error("Generated ticket has no title");

        const result = await createPlaneIssue("ELLIE", ticket.title, ticket.description, ticket.priority);
        if (!result) throw new Error("Plane API failed to create issue");

        console.log(`[ticket] Created ${result.identifier}: ${ticket.title}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, identifier: result.identifier, title: ticket.title, description: ticket.description }));
      } catch (err: any) {
        console.error("[ticket] Error:", err?.message || err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Failed to create ticket" }));
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

        // Send extracted ideas to ellie-chat for interactive triage
        if (ideas.length > 0) {
          const newIdeas = ideas.filter((i: any) => !i.existing);
          const existingIdeas = ideas.filter((i: any) => i.existing);

          let chatMsg = `**Idea Extraction** — ${ideas.length} potential work items\n\n`;
          for (const idea of ideas) {
            const tag = idea.existing ? `[EXISTS: ${idea.existing}]` : "**[NEW]**";
            chatMsg += `${tag} **${idea.title}**\n${idea.description}\n\n`;
          }
          if (newIdeas.length > 0) {
            chatMsg += `\n${newIdeas.length} new idea${newIdeas.length > 1 ? "s" : ""} ready to work — reply to discuss, create tickets, or refine.`;
          }

          // Save as assistant message and broadcast to connected clients
          await saveMessage("assistant", chatMsg.trim(), {}, "ellie-chat");
          const payload = JSON.stringify({
            type: "response",
            text: chatMsg.trim(),
            agent: "general",
            ts: Date.now(),
          });
          for (const ws of ellieChatClients) {
            if (ws.readyState === WebSocket.OPEN) ws.send(payload);
          }
          console.log(`[extract-ideas] Sent ${ideas.length} ideas to ellie-chat (${newIdeas.length} new, ${existingIdeas.length} existing)`);
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

  // Tool approval endpoint (called by PreToolUse hook — ELLIE-213)
  if (url.pathname === "/internal/tool-approval" && req.method === "POST") {
    handleToolApprovalHTTP(req, res);
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
            await startWorkSession(mockReq, mockRes, bot, supabase);
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

  // Ellie Chat broadcast endpoint
  if (url.pathname === "/api/ellie-chat/send" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const { message, agent = "general" } = data;

        if (!message) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing required field: message" }));
          return;
        }

        // Broadcast to all connected Ellie Chat clients
        const payload = JSON.stringify({
          type: "response",
          text: message,
          agent,
          ts: Date.now(),
        });

        let sentCount = 0;
        for (const ws of ellieChatClients) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
            sentCount++;
          }
        }

        console.log(`[ellie-chat] Broadcast message to ${sentCount} client(s)`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, sent_to: sentCount }));
      } catch (err) {
        console.error("[ellie-chat] Error:", err);
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
          resolveContradictionEndpoint, askCriticEndpoint, creatureWriteMemoryEndpoint,
          arcsEndpoint } =
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
          case "arcs":
            await arcsEndpoint(mockReq, mockRes, bot);
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

  // Forest Bridge API — external collaborator endpoints (ELLIE-177)
  if (url.pathname.startsWith("/api/bridge/") && (req.method === "POST" || req.method === "GET")) {
    const isPost = req.method === "POST";

    const handleBridgeRequest = async (body?: string) => {
      try {
        let data: any = {};
        if (isPost && body) {
          try {
            data = JSON.parse(body);
          } catch (parseErr) {
            console.error("[bridge] JSON parse error:", parseErr);
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return;
          }
        }

        const endpoint = url.pathname.replace("/api/bridge/", "");

        const {
          bridgeReadEndpoint, bridgeWriteEndpoint,
          bridgeListEndpoint, bridgeScopesEndpoint,
          bridgeWhoamiEndpoint, bridgeTagsEndpoint,
        } = await import("./api/bridge.ts");

        const queryParams: Record<string, string> = {};
        url.searchParams.forEach((v, k) => { queryParams[k] = v; });

        const mockReq = {
          body: data,
          query: queryParams,
          bridgeKey: req.headers["x-bridge-key"] as string,
        } as any;

        const mockRes = {
          status: (code: number) => ({
            json: (resData: any) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(resData));
            },
          }),
          json: (resData: any) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(resData));
          },
        } as any;

        switch (endpoint) {
          case "read":
            if (!isPost) { res.writeHead(405); res.end(); return; }
            await bridgeReadEndpoint(mockReq, mockRes);
            break;
          case "write":
            if (!isPost) { res.writeHead(405); res.end(); return; }
            await bridgeWriteEndpoint(mockReq, mockRes);
            break;
          case "list":
            if (isPost) { res.writeHead(405); res.end(); return; }
            await bridgeListEndpoint(mockReq, mockRes);
            break;
          case "scopes":
            if (isPost) { res.writeHead(405); res.end(); return; }
            await bridgeScopesEndpoint(mockReq, mockRes);
            break;
          case "whoami":
            if (isPost) { res.writeHead(405); res.end(); return; }
            await bridgeWhoamiEndpoint(mockReq, mockRes);
            break;
          case "tags":
            if (isPost) { res.writeHead(405); res.end(); return; }
            await bridgeTagsEndpoint(mockReq, mockRes);
            break;
          default:
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unknown bridge endpoint" }));
        }
      } catch (err) {
        console.error("[bridge] Error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    };

    if (isPost) {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => handleBridgeRequest(body));
    } else {
      handleBridgeRequest();
    }
    return;
  }

  // App Auth API — phone app onboarding (ELLIE-176)
  if (url.pathname.startsWith("/api/app-auth/") && (req.method === "POST" || req.method === "GET")) {
    const isPost = req.method === "POST";

    const handleAppAuthRequest = async (body?: string) => {
      try {
        let data: any = {};
        if (isPost && body) {
          try { data = JSON.parse(body); } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return;
          }
        }

        const endpoint = url.pathname.replace("/api/app-auth/", "");

        const {
          sendCodeEndpoint, verifyCodeEndpoint,
          meEndpoint, updateProfileEndpoint,
        } = await import("./api/app-auth.ts");

        const mockReq = {
          body: data,
          headers: { authorization: req.headers["authorization"] || "" },
        } as any;

        const mockRes = {
          status: (code: number) => ({
            json: (resData: any) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(resData));
            },
          }),
          json: (resData: any) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(resData));
          },
        } as any;

        switch (endpoint) {
          case "send-code":
            if (!isPost) { res.writeHead(405); res.end(); return; }
            await sendCodeEndpoint(mockReq, mockRes);
            break;
          case "verify-code":
            if (!isPost) { res.writeHead(405); res.end(); return; }
            await verifyCodeEndpoint(mockReq, mockRes);
            break;
          case "me":
            if (isPost) { res.writeHead(405); res.end(); return; }
            await meEndpoint(mockReq, mockRes);
            break;
          case "update-profile":
            if (!isPost) { res.writeHead(405); res.end(); return; }
            await updateProfileEndpoint(mockReq, mockRes);
            break;
          default:
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unknown app-auth endpoint" }));
        }
      } catch (err) {
        console.error("[app-auth] Error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    };

    if (isPost) {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => handleAppAuthRequest(body));
    } else {
      handleAppAuthRequest();
    }
    return;
  }

  // ── Agent Queue API (ELLIE-200) ──────────────────────────────
  if (url.pathname.startsWith("/api/queue/")) {
    const handleQueueRequest = async (body?: string) => {
      try {
        const { createQueueItem, listQueueItems, updateQueueStatus, deleteQueueItem, getQueueStats } = await import("./api/agent-queue.ts");

        let data: any = {};
        if (body) { try { data = JSON.parse(body); } catch { /* empty */ } }

        const mockReq = { body: data, url: `http://localhost${url.pathname}${url.search}`, headers: req.headers } as any;
        const mockRes = {
          status: (code: number) => ({ json: (d: any) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); } }),
          json: (d: any) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); },
        } as any;

        const path = url.pathname.replace("/api/queue/", "");

        if (path === "create" && req.method === "POST") {
          await createQueueItem(mockReq, mockRes);
        } else if (path === "list" && req.method === "GET") {
          await listQueueItems(mockReq, mockRes);
        } else if (path === "stats" && req.method === "GET") {
          await getQueueStats(mockReq, mockRes);
        } else if (path.match(/^[0-9a-f-]+\/status$/) && req.method === "POST") {
          const id = path.replace("/status", "");
          await updateQueueStatus(mockReq, mockRes, id);
        } else if (path.match(/^[0-9a-f-]+$/) && req.method === "DELETE") {
          await deleteQueueItem(mockReq, mockRes, path);
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown queue endpoint" }));
        }
      } catch (err) {
        console.error("[agent-queue] Error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    };

    if (req.method === "POST" || req.method === "DELETE") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => handleQueueRequest(body));
    } else {
      handleQueueRequest();
    }
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
voiceWss.on("connection", handleVoiceConnection);

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
  } else if (pathname === "/ws/ellie-chat" || pathname === "/ws/la-comms") {
    ellieChatWss.handleUpgrade(req, socket, head, (ws) => {
      ellieChatWss.emit("connection", ws, req);
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

      // Save feed to log file
      if (msg.type === "save_feed" && msg.content) {
        const logPath = `${import.meta.dir}/../logs/ellie-feed-log`;
        const header = `\n--- Feed saved ${new Date().toISOString()} ---\n`;
        appendFile(logPath, header + msg.content + "\n")
          .then(() => console.log(`[extension] Feed saved to ${logPath}`))
          .catch((err) => console.error(`[extension] Failed to save feed:`, err.message));
        return;
      }
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

// ============================================================
// ELLIE CHAT — Dashboard WebSocket Chat
// ============================================================

const ellieChatWss = new WebSocketServer({ noServer: true });
const ellieChatClients = new Set<WebSocket>();

/** Broadcast a JSON message to all connected ellie-chat clients (ELLIE-199). */
function broadcastToEllieChatClients(event: Record<string, any>): void {
  if (ellieChatClients.size === 0) return;
  const payload = JSON.stringify(event);
  for (const ws of ellieChatClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

/** Deliver pending readout queue items on ellie-chat connect (ELLIE-199). */
async function deliverPendingReadouts(ws: WebSocket): Promise<void> {
  try {
    const items = await getAndAcknowledgeReadouts();
    if (items.length === 0) return;

    // Format as a single assistant message summarizing all findings
    const lines = items.map((item: any) => {
      const ticket = item.work_item_id ? ` (${item.work_item_id})` : '';
      return `**${item.source}** ${item.category}${ticket}: ${item.content}`;
    });

    const summary = items.length === 1
      ? `${items[0].source} has a new finding for you:\n\n${lines[0]}`
      : `${items[0].source} has ${items.length} new findings:\n\n${lines.join('\n\n')}`;

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "response",
        text: summary,
        agent: "general",
        ts: Date.now(),
      }));
    }

    console.log(`[ellie-chat] Delivered ${items.length} readout finding(s) on connect`);
  } catch (err) {
    console.error("[ellie-chat] Readout delivery error:", err);
  }
}

// App user tracking for phone app connections (ELLIE-176, ELLIE-196)
interface WsAppUser { id: string; name: string | null; email: string | null; onboarding_state: string; anonymous_id: string | null; token?: string }
const wsAppUserMap = new WeakMap<WebSocket, WsAppUser>();

// Per-user phone mode history (ELLIE-197) — keyed by user id or anonymous_id
const ellieChatPhoneHistories = new Map<string, Array<{ role: string; content: string }>>();

// ellieChatPendingActions imported from ./message-sender.ts (ELLIE-207)

ellieChatWss.on("connection", (ws: WebSocket) => {
  let authenticated = false;

  const authTimer = setTimeout(() => {
    if (!authenticated) ws.close(4001, "Auth timeout");
  }, 5000);

  ws.on("message", (data: Buffer | string) => {
    try {
      const msg = JSON.parse(data.toString());

      if (!authenticated) {
        if (msg.type !== "auth") { ws.close(4003, "Expected auth"); return; }

        // Mode 1: Shared key (dashboard/extension) — maps to system-dashboard user (ELLIE-197)
        if (msg.key && msg.key === EXTENSION_API_KEY && EXTENSION_API_KEY) {
          authenticated = true;
          clearTimeout(authTimer);
          ellieChatClients.add(ws);
          wsAppUserMap.set(ws, { id: 'system-dashboard', name: 'Dashboard', email: null, onboarding_state: 'system', anonymous_id: null });
          ws.send(JSON.stringify({ type: "auth_ok", ts: Date.now() }));
          console.log(`[ellie-chat] Client authenticated via key (${ellieChatClients.size} connected)`);
          deliverPendingReadouts(ws).catch(() => {});
          return;
        }

        // Mode 2: Authenticated app user (session token)
        if (msg.token) {
          (async () => {
            try {
              const { getUserByToken } = await import("./api/app-auth.ts");
              const user = await getUserByToken(msg.token);
              if (!user) { ws.close(4003, "Invalid token"); return; }
              authenticated = true;
              clearTimeout(authTimer);
              ellieChatClients.add(ws);
              wsAppUserMap.set(ws, { id: user.id, name: user.name, email: user.email, onboarding_state: user.onboarding_state, anonymous_id: user.anonymous_id, token: msg.token });
              ws.send(JSON.stringify({ type: "auth_ok", ts: Date.now(), user: { id: user.id, name: user.name, onboarding_state: user.onboarding_state } }));
              console.log(`[ellie-chat] App user authenticated: ${user.name || user.id} (${ellieChatClients.size} connected)`);
              deliverPendingReadouts(ws).catch(() => {});
            } catch (err) {
              console.error("[ellie-chat] Token auth error:", err);
              ws.close(4003, "Auth error");
            }
          })();
          return;
        }

        // Mode 3: Anonymous app user (new visitor)
        if (msg.anonymous_id) {
          authenticated = true;
          clearTimeout(authTimer);
          ellieChatClients.add(ws);
          wsAppUserMap.set(ws, { id: '', name: null, email: null, onboarding_state: 'anonymous', anonymous_id: msg.anonymous_id });
          ws.send(JSON.stringify({ type: "auth_ok", ts: Date.now(), user: { id: null, name: null, onboarding_state: 'anonymous' } }));
          console.log(`[ellie-chat] Anonymous app user connected: ${msg.anonymous_id} (${ellieChatClients.size} connected)`);
          return;
        }

        ws.close(4003, "Invalid auth");
        return;
      }

      if (msg.type === "pong") return;

      // Session upgrade: anonymous → authenticated (ELLIE-176)
      if (msg.type === "session_upgrade" && msg.token) {
        (async () => {
          try {
            const { getUserByToken } = await import("./api/app-auth.ts");
            const user = await getUserByToken(msg.token);
            if (!user) {
              ws.send(JSON.stringify({ type: "error", text: "Invalid session token" }));
              return;
            }
            wsAppUserMap.set(ws, { id: user.id, name: user.name, email: user.email, onboarding_state: user.onboarding_state, anonymous_id: user.anonymous_id, token: msg.token });
            ws.send(JSON.stringify({ type: "session_upgraded", ts: Date.now(), user: { id: user.id, name: user.name, onboarding_state: user.onboarding_state } }));
            console.log(`[ellie-chat] Session upgraded: ${user.name || user.id}`);
          } catch (err) {
            console.error("[ellie-chat] Session upgrade error:", err);
          }
        })();
        return;
      }

      if (msg.type === "message" && (msg.text || msg.image)) {
        handleEllieChatMessage(ws, msg.text || "", !!msg.phone_mode, msg.image);
        return;
      }

      // New chat: close current conversation + agent sessions so next message starts fresh
      if (msg.type === "new_chat") {
        (async () => {
          try {
            const ncUser = wsAppUserMap.get(ws);
            const ncUserId = ncUser?.id || ncUser?.anonymous_id || undefined;
            if (supabase) {
              // Close conversations scoped to this user (ELLIE-197)
              let convQuery = supabase
                .from("conversations")
                .update({ status: "closed" })
                .in("channel", ["ellie-chat", "la-comms"])
                .eq("status", "active");
              if (ncUserId) convQuery = convQuery.eq("user_id", ncUserId);
              await convQuery;

              let sessQuery = supabase
                .from("agent_sessions")
                .update({ state: "completed", completed_at: new Date().toISOString() })
                .in("channel", ["ellie-chat", "la-comms"])
                .eq("state", "active");
              if (ncUserId) sessQuery = sessQuery.eq("user_id", ncUserId);
              await sessQuery;
            }
            // Clear per-user phone history
            if (ncUserId) ellieChatPhoneHistories.delete(ncUserId);
            clearSessionApprovals(); // Reset tool approvals for new chat (ELLIE-213)
            ws.send(JSON.stringify({ type: "new_chat_ok", ts: Date.now() }));
            console.log(`[ellie-chat] New chat started for ${ncUser?.name || ncUserId || 'unknown'}`);
          } catch (err: any) {
            console.error("[ellie-chat] New chat error:", err?.message);
          }
        })();
        return;
      }

      // Confirm/Deny response from frontend approve/deny buttons
      if (msg.type === "confirm_response" && msg.id && typeof msg.approved === "boolean") {
        const action = ellieChatPendingActions.get(msg.id);
        if (!action) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "response", text: "That confirmation has expired.", agent: "system", ts: Date.now() }));
          }
          return;
        }
        ellieChatPendingActions.delete(msg.id);

        const verb = msg.approved ? "Approved" : "Denied";
        const resumePrompt = msg.approved
          ? `The user APPROVED the following action: "${action.description}". Proceed with executing it now.`
          : `The user DENIED the following action: "${action.description}". Do NOT proceed. Acknowledge briefly.`;

        const confirmUser = wsAppUserMap.get(ws);
        const confirmUserId = confirmUser?.id || confirmUser?.anonymous_id || undefined;
        saveMessage("user", `[${verb} action: ${action.description}]`, {}, "ellie-chat", confirmUserId).catch(() => {});

        enqueueEllieChat(async () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "typing", ts: Date.now() }));
          }
          const rawResponse = await callClaude(resumePrompt, { resume: true });
          const processed = await processMemoryIntents(supabase, rawResponse, action.agentName, "shared", undefined);
          const { cleanedText: pbClean, commands: pbCmds } = extractPlaybookCommands(processed);
          const { cleanedText, hadConfirmations } = sendWithApprovalsEllieChat(ws, pbClean, session.sessionId, action.agentName);

          await saveMessage("assistant", cleanedText, {}, "ellie-chat", confirmUserId);

          if (!hadConfirmations && ws.readyState === WebSocket.OPEN && cleanedText) {
            ws.send(JSON.stringify({
              type: "response",
              text: cleanedText,
              agent: action.agentName,
              ts: Date.now(),
            }));
          }

          if (pbCmds.length > 0) {
            const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "ellie-chat", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
            executePlaybookCommands(pbCmds, pbCtx).catch(err => console.error("[playbook]", err));
          }

          resetEllieChatIdleTimer();
        }, `[${verb} action]`);
        return;
      }

      // Tool approval response from frontend (ELLIE-213)
      if (msg.type === "tool_approval_response" && msg.id && typeof msg.approved === "boolean") {
        const resolved = resolveToolApproval(msg.id, msg.approved, msg.remember === true);
        if (!resolved) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "response", text: "That tool approval has expired.", agent: "system", ts: Date.now() }));
          }
        }
        return;
      }
    } catch {
      // Ignore parse errors
    }
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    ellieChatClients.delete(ws);
    if (authenticated) {
      const dcUser = wsAppUserMap.get(ws);
      // Clean up phone history if no other connections for this user (ELLIE-197)
      const dcUserId = dcUser?.id || dcUser?.anonymous_id;
      if (dcUserId) {
        let hasOtherConn = false;
        for (const client of ellieChatClients) {
          const cu = wsAppUserMap.get(client);
          if ((cu?.id || cu?.anonymous_id) === dcUserId) { hasOtherConn = true; break; }
        }
        if (!hasOtherConn) ellieChatPhoneHistories.delete(dcUserId);
      }
      console.log(`[ellie-chat] ${dcUser?.name || 'Client'} disconnected (${ellieChatClients.size} connected)`);
    }
  });

  ws.on("error", () => {
    clearTimeout(authTimer);
    ellieChatClients.delete(ws);
  });
});

// Server-side ping every 30s + token re-validation (ELLIE-196)
setInterval(async () => {
  const ping = JSON.stringify({ type: "ping", ts: Date.now() });
  for (const ws of ellieChatClients) {
    if (ws.readyState !== WebSocket.OPEN) {
      ellieChatClients.delete(ws);
      continue;
    }
    ws.send(ping);
    // Re-validate session tokens (skip shared-key and anonymous clients)
    const user = wsAppUserMap.get(ws);
    if (user?.token) {
      try {
        const { getUserByToken } = await import("./api/app-auth.ts");
        const current = await getUserByToken(user.token);
        if (!current) {
          console.log(`[ellie-chat] Token expired for ${user.name || user.id} — disconnecting`);
          ws.close(4002, "Session expired");
          ellieChatClients.delete(ws);
        }
      } catch { /* db hiccup — don't disconnect on transient errors */ }
    }
  }
}, 30_000);

// Phone mode history moved to per-user Map: ellieChatPhoneHistories (ELLIE-197)

async function handleEllieChatMessage(
  ws: WebSocket,
  text: string,
  phoneMode: boolean = false,
  image?: { data: string; mime_type: string; name: string },
): Promise<void> {
  console.log(`[ellie-chat] User${phoneMode ? " (phone)" : ""}${image ? " [+image]" : ""}: ${text.substring(0, 80)}...`);
  acknowledgeChannel("ellie-chat");

  const ecUser = wsAppUserMap.get(ws);
  const ecUserId = ecUser?.id || ecUser?.anonymous_id || undefined;

  await saveMessage("user", text, image ? { image_name: image.name, image_mime: image.mime_type } : {}, "ellie-chat", ecUserId);
  broadcastExtension({ type: "message_in", channel: "ellie-chat", preview: text.substring(0, 200) });

  // Write image to temp file if present (same pattern as Telegram photo handler)
  let imagePath: string | null = null;
  if (image?.data) {
    try {
      const ext = image.mime_type === "image/png" ? ".png"
        : image.mime_type === "image/gif" ? ".gif"
        : image.mime_type === "image/webp" ? ".webp"
        : ".jpg";
      imagePath = join(UPLOADS_DIR, `ellie-chat_${Date.now()}${ext}`);
      await writeFile(imagePath, Buffer.from(image.data, "base64"));
      console.log(`[ellie-chat] Image saved: ${imagePath} (${image.name})`);
    } catch (err) {
      console.error("[ellie-chat] Failed to save image:", err);
      imagePath = null;
    }
  }

  // Send typing indicator
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "typing", ts: Date.now() }));
  }

  // /plan on|off — toggle planning mode
  const ecPlanMatch = text.match(/^\/plan\s+(on|off)$/i);
  if (ecPlanMatch) {
    setPlanningMode(ecPlanMatch[1].toLowerCase() === "on");
    const msg = getPlanningMode()
      ? "Planning mode ON — conversation will persist for up to 60 minutes of idle time."
      : "Planning mode OFF — reverting to 10-minute idle timeout.";
    console.log(`[planning] ${msg}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "response", text: msg, agent: "system", ts: Date.now() }));
    }
    resetTelegramIdleTimer();
    resetGchatIdleTimer();
    resetEllieChatIdleTimer();
    broadcastExtension({ type: "planning_mode", active: getPlanningMode() });
    return;
  }

  // /ticket — create Plane ticket from context
  if (text.startsWith("/ticket")) {
    const ticketText = text.slice(7).trim();
    (async () => {
      try {
        let contextMessages: string[];
        if (ticketText) {
          contextMessages = [ticketText];
        } else if (supabase) {
          const { data: recent } = await supabase.from("messages")
            .select("role, content").in("channel", ["ellie-chat", "la-comms"])
            .order("created_at", { ascending: false }).limit(5);
          contextMessages = (recent || []).reverse().map((m: any) => `[${m.role}]: ${m.content}`);
        } else {
          contextMessages = ["No context available"];
        }

        const context = contextMessages.join("\n---\n");
        const prompt = `Generate a Plane project ticket from this context. Return ONLY valid JSON with no markdown formatting:\n{"title": "concise title under 80 chars", "description": "detailed description with requirements as bullet points", "priority": "medium"}\n\nPriority must be one of: urgent, high, medium, low, none.\n\nContext:\n${context}`;

        console.log(`[ticket] /ticket command — generating from ${ticketText ? "user text" : "last 5 messages"}...`);
        const raw = await callClaude(prompt);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("Could not parse ticket JSON");
        const ticket = JSON.parse(jsonMatch[0]);

        const result = await createPlaneIssue("ELLIE", ticket.title, ticket.description, ticket.priority);
        if (!result) throw new Error("Plane API failed");

        const msg = `Created ${result.identifier}: ${ticket.title}`;
        console.log(`[ticket] ${msg}`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "response", text: msg, agent: "system", ts: Date.now() }));
        }
      } catch (err: any) {
        console.error("[ticket] /ticket error:", err?.message);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "response", text: `Failed to create ticket: ${err?.message?.slice(0, 200) || "unknown error"}`, agent: "system", ts: Date.now() }));
        }
      }
    })();
    return;
  }

  // ELLIE:: user-typed commands — bypass classifier, execute directly
  const { cleanedText: ellieChatPlaybookClean, commands: ellieChatPlaybookCmds } = extractPlaybookCommands(text);
  if (ellieChatPlaybookCmds.length > 0) {
    console.log(`[ellie-chat] ELLIE:: commands in user message: ${ellieChatPlaybookCmds.map(c => c.type).join(", ")}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "response", text: `Processing ${ellieChatPlaybookCmds.length} playbook command(s)...`, agent: "system", ts: Date.now() }));
    }
    const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "ellie-chat", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
    executePlaybookCommands(ellieChatPlaybookCmds, pbCtx)
      .then(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "response", text: `Playbook command(s) completed.`, agent: "system", ts: Date.now() }));
        }
      })
      .catch(err => {
        console.error("[playbook]", err);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "response", text: `Playbook error: ${err?.message?.slice(0, 200) || "unknown"}`, agent: "system", ts: Date.now() }));
        }
      });
    return;
  }

  // ── Verification code detection (ELLIE-176) ──
  // If app user is in email_sent state and message looks like a 6-digit code, auto-verify
  const appUser = wsAppUserMap.get(ws);
  if (appUser && appUser.onboarding_state === 'email_sent' && /^\d{6}$/.test(text.trim())) {
    await enqueueEllieChat(async () => {
      try {
        const { sql: forestSql } = await import("../../ellie-forest/src/index");
        const code = text.trim();

        // Find matching code for this user's email
        const [codeRow] = await forestSql<{ id: string; attempts: number }[]>`
          SELECT id, attempts FROM verification_codes
          WHERE email = ${appUser.email} AND code = ${code}
            AND used = FALSE AND expires_at > NOW()
          ORDER BY created_at DESC LIMIT 1
        `;

        if (codeRow && codeRow.attempts < 5) {
          // Mark code as used
          await forestSql`UPDATE verification_codes SET used = TRUE WHERE id = ${codeRow.id}`;

          // Upgrade user
          const { getUserByToken, generateToken } = await import("./api/app-auth.ts");
          const { createPerson } = await import("../../ellie-forest/src/people");
          const token = generateToken();

          // Create person record if needed
          let personId: string | null = null;
          if (appUser.name) {
            try {
              const person = await createPerson({ name: appUser.name, relationship_type: 'app-user', contact_methods: { email: appUser.email } });
              personId = person.id;
            } catch { /* person may already exist */ }
          }

          await forestSql`
            UPDATE app_users SET
              session_token = ${token},
              onboarding_state = 'verified',
              verified_at = NOW(),
              person_id = COALESCE(person_id, ${personId}),
              last_seen_at = NOW()
            WHERE email = ${appUser.email}
          `;

          // Update wsAppUserMap
          appUser.onboarding_state = 'verified';
          wsAppUserMap.set(ws, appUser);

          // Notify client
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "session_upgraded", ts: Date.now(), token, user: { id: appUser.id, name: appUser.name, onboarding_state: 'verified' } }));
            ws.send(JSON.stringify({ type: "response", text: `Perfect, ${appUser.name || 'friend'}! Your account is verified. I'll remember our conversations from now on.`, agent: "general", ts: Date.now() }));
          }
          const verifyHistKey = ecUserId || 'anonymous';
          if (!ellieChatPhoneHistories.has(verifyHistKey)) ellieChatPhoneHistories.set(verifyHistKey, []);
          const verifyHist = ellieChatPhoneHistories.get(verifyHistKey)!;
          verifyHist.push({ role: "user", content: text });
          verifyHist.push({ role: "assistant", content: `Perfect, ${appUser.name || 'friend'}! Your account is verified. I'll remember our conversations from now on.` });
          console.log(`[ellie-chat] Code verified for ${appUser.email} — session upgraded`);
        } else {
          // Wrong code — increment attempts, fall through to Claude
          if (appUser.email) {
            await forestSql`
              UPDATE verification_codes SET attempts = attempts + 1
              WHERE email = ${appUser.email} AND used = FALSE AND expires_at > NOW()
            `;
          }
          // Let Claude handle it naturally — the onboarding context will remind about the code
        }
      } catch (err) {
        console.error("[ellie-chat] Code detection error:", err);
      }
    }, "code-verify");
    // If code was valid, we already sent the response — check if state changed
    const updatedUser = wsAppUserMap.get(ws);
    if (updatedUser && updatedUser.onboarding_state === 'verified') return;
  }

  if (phoneMode) {
    // ── Phone mode fast path: 6-turn context, Haiku, brevity prompt, no agent routing ──
    await enqueueEllieChat(async () => {
      // Per-user phone history (ELLIE-197)
      const phoneHistKey = ecUserId || 'anonymous';
      if (!ellieChatPhoneHistories.has(phoneHistKey)) ellieChatPhoneHistories.set(phoneHistKey, []);
      const phoneHistory = ellieChatPhoneHistories.get(phoneHistKey)!;
      phoneHistory.push({ role: "user", content: text });

      const conversationContext = phoneHistory
        .slice(-6)
        .map(m => `${m.role}: ${m.content}`)
        .join("\n");

      // Lightweight context — skip structured context, recent messages, agent routing
      const [contextDocket, relevantContext, elasticContext] = await Promise.all([
        getContextDocket(),
        getRelevantContext(supabase, text, "ellie-chat", getActiveAgent("ellie-chat")),
        searchElastic(text, { limit: 3, recencyBoost: true, channel: "ellie-chat", sourceAgent: getActiveAgent("ellie-chat") }),
      ]);

      const systemParts = [
        "You are Ellie, a personal AI assistant. You are in a VOICE CONVERSATION via the phone app.",
        "Keep responses SHORT and natural for speech — 1-3 sentences max.",
        "No markdown, no bullet points, no formatting. Just spoken words.",
        "Be warm and conversational, like talking to a friend.",
      ];

      // Onboarding context injection (ELLIE-176)
      const wsUser = wsAppUserMap.get(ws);
      if (wsUser) {
        if (wsUser.name) systemParts.push(`You are speaking with ${wsUser.name}.`);
        switch (wsUser.onboarding_state) {
          case 'anonymous':
            systemParts.push("\nThis is a new user you haven't met before. After 2-3 natural exchanges, ask what you should call them. Don't rush it — let the conversation flow first.");
            break;
          case 'named':
            systemParts.push(`\n${wsUser.name} has told you their name but hasn't verified their email yet. After a few more exchanges, naturally suggest that you could remember conversations across sessions if they share their email. Frame it as a benefit, not a requirement.`);
            break;
          case 'email_sent':
            systemParts.push(`\nYou sent a verification code to ${wsUser.email}. Gently remind them to check their email and type the 6-digit code here. Don't be pushy — just mention it if the conversation allows.`);
            break;
          case 'verified':
            systemParts.push(`\n${wsUser.name || 'This user'} just verified their account! You can now remember conversations. Over the next few exchanges, learn their timezone and interests naturally. Don't interrogate — weave it into conversation.`);
            systemParts.push(`\nWhen you learn their timezone, include ELLIE::SET_TIMEZONE <timezone> at the END of your response (e.g., ELLIE::SET_TIMEZONE America/Chicago). When you feel onboarding is complete, add ELLIE::ONBOARDING_COMPLETE at the end.`);
            break;
          default:
            if (wsUser.name) systemParts.push(`You are speaking with ${wsUser.name}.`);
        }
        if (wsUser.onboarding_state === 'anonymous' || wsUser.onboarding_state === 'named') {
          systemParts.push(`\nWhen the user tells you their name, include ELLIE::SET_NAME <name> at the END of your response.`);
          systemParts.push(`When the user shares their email, include ELLIE::REQUEST_EMAIL <email> at the END of your response.`);
          systemParts.push(`These ELLIE:: commands are invisible to the user — they trigger backend actions.`);
        }
      } else {
        if (USER_NAME) systemParts.push(`You are speaking with ${USER_NAME}.`);
      }

      if (contextDocket) systemParts.push(`\n${contextDocket}`);
      const ellieChatSearchBlock = trimSearchContext([relevantContext || '', elasticContext || '']);
      if (ellieChatSearchBlock) systemParts.push(`\n${ellieChatSearchBlock}`);

      const systemPrompt = systemParts.join("\n");
      const userName = wsUser?.name || USER_NAME || "the user";
      const userPrompt = conversationContext
        ? `Conversation so far:\n${conversationContext}\n\n${userName} just said: ${text}`
        : `${userName} said: ${text}`;

      const startTime = Date.now();
      const rawResponse = await callClaudeVoice(systemPrompt, userPrompt);
      const durationMs = Date.now() - startTime;

      // Process ELLIE:: onboarding commands (ELLIE-176)
      let responseText = rawResponse.trim();
      if (wsUser) {
        const ellieCommands = responseText.match(/ELLIE::\S+.*$/gm) || [];
        for (const cmd of ellieCommands) {
          responseText = responseText.replace(cmd, '').trim();
          try {
            const { sql: forestSql } = await import("../../ellie-forest/src/index");

            if (cmd.startsWith('ELLIE::SET_NAME ')) {
              const name = cmd.replace('ELLIE::SET_NAME ', '').trim();
              if (name) {
                wsUser.name = name;
                // Create or update app_user record
                if (wsUser.anonymous_id && !wsUser.id) {
                  const [existing] = await forestSql<{ id: string }[]>`SELECT id FROM app_users WHERE anonymous_id = ${wsUser.anonymous_id}`;
                  if (existing) {
                    await forestSql`UPDATE app_users SET name = ${name}, onboarding_state = 'named' WHERE id = ${existing.id}`;
                    wsUser.id = existing.id;
                  } else {
                    const [newUser] = await forestSql<{ id: string }[]>`
                      INSERT INTO app_users (name, anonymous_id, onboarding_state) VALUES (${name}, ${wsUser.anonymous_id}, 'named') RETURNING id
                    `;
                    wsUser.id = newUser.id;
                  }
                } else if (wsUser.id) {
                  await forestSql`UPDATE app_users SET name = ${name}, onboarding_state = 'named' WHERE id = ${wsUser.id}`;
                }
                wsUser.onboarding_state = 'named';
                wsAppUserMap.set(ws, wsUser);
                console.log(`[ellie-chat] SET_NAME: ${name}`);
              }
            }

            if (cmd.startsWith('ELLIE::REQUEST_EMAIL ')) {
              const email = cmd.replace('ELLIE::REQUEST_EMAIL ', '').trim().toLowerCase();
              if (email && email.includes('@')) {
                wsUser.email = email;
                // Update user record with email
                if (wsUser.id) {
                  await forestSql`UPDATE app_users SET email = ${email}, onboarding_state = 'email_sent' WHERE id = ${wsUser.id}`;
                }
                // Generate and send verification code
                const { sendVerificationCode } = await import("./email.ts");
                const code = String(Math.floor(100000 + Math.random() * 900000));
                const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
                await forestSql`INSERT INTO verification_codes (email, code, expires_at) VALUES (${email}, ${code}, ${expiresAt})`;
                await sendVerificationCode(email, code);
                wsUser.onboarding_state = 'email_sent';
                wsAppUserMap.set(ws, wsUser);
                console.log(`[ellie-chat] REQUEST_EMAIL: code sent to ${email}`);
              }
            }

            if (cmd.startsWith('ELLIE::SET_TIMEZONE ')) {
              const tz = cmd.replace('ELLIE::SET_TIMEZONE ', '').trim();
              if (tz && wsUser.id) {
                await forestSql`UPDATE app_users SET timezone = ${tz} WHERE id = ${wsUser.id}`;
                console.log(`[ellie-chat] SET_TIMEZONE: ${tz}`);
              }
            }

            if (cmd.startsWith('ELLIE::ONBOARDING_COMPLETE')) {
              if (wsUser.id) {
                await forestSql`UPDATE app_users SET onboarding_state = 'onboarded' WHERE id = ${wsUser.id}`;
                wsUser.onboarding_state = 'onboarded';
                wsAppUserMap.set(ws, wsUser);
                console.log(`[ellie-chat] ONBOARDING_COMPLETE for ${wsUser.name}`);
              }
            }
          } catch (err) {
            console.error(`[ellie-chat] ELLIE:: command error (${cmd}):`, err);
          }
        }
      }

      const cleanedText = responseText;
      phoneHistory.push({ role: "assistant", content: cleanedText });

      // Cap per-user history at 20 entries to prevent memory growth
      if (phoneHistory.length > 20) phoneHistory.splice(0, phoneHistory.length - 20);

      await saveMessage("assistant", cleanedText, {}, "ellie-chat", ecUserId);
      broadcastExtension({
        type: "message_out", channel: "ellie-chat",
        agent: "general",
        preview: cleanedText.substring(0, 200),
      });

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "response",
          text: cleanedText,
          agent: "general",
          ts: Date.now(),
          duration_ms: durationMs,
        }));
      }

      resetEllieChatIdleTimer();
    }, text.substring(0, 100));
    return;
  }

  // ── Normal text mode: full agent routing + context gathering (mirrors Google Chat) ──
  await enqueueEllieChat(async () => {
    const ellieChatWorkItem = text.match(/\b([A-Z]+-\d+)\b/)?.[1];
    const agentResult = await routeAndDispatch(supabase, text, "ellie-chat", "dashboard", ellieChatWorkItem);
    let effectiveText = agentResult?.route.strippedMessage || text;
    // Prepend image file reference so Claude Code CLI can see the image
    if (imagePath) {
      effectiveText = `[Image: ${imagePath}]\n\n${effectiveText || "Analyze this image."}`;
    }
    if (agentResult) {
      setActiveAgent("ellie-chat", agentResult.dispatch.agent.name);
      broadcastExtension({
        type: "route", channel: "ellie-chat",
        agent: agentResult.dispatch.agent.name,
        mode: agentResult.route.execution_mode,
      });

      // Dispatch notification (ELLIE-80 pattern from Google Chat)
      if (agentResult.dispatch.agent.name !== "general" && agentResult.dispatch.is_new) {
        notify(getNotifyCtx(), {
          event: "dispatch_confirm",
          workItemId: agentResult.dispatch.agent.name,
          telegramMessage: `🤖 ${agentResult.dispatch.agent.name} agent`,
          gchatMessage: `🤖 ${agentResult.dispatch.agent.name} agent dispatched`,
        }).catch((err) => console.error("[notify] dispatch_confirm:", err.message));
      }
    }

    // ── ASYNC SPECIALIST PATH: ack immediately, run in background ──
    const ecRouteAgent = agentResult?.dispatch?.agent?.name || "general";
    const isSpecialist = ecRouteAgent !== "general";
    const isMultiStep = agentResult?.route.execution_mode !== "single" && agentResult?.route.skills?.length;

    if (isSpecialist && !isMultiStep && agentResult) {
      const ack = getSpecialistAck(ecRouteAgent);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "response", text: ack, agent: "general", ts: Date.now() }));
      }
      await saveMessage("assistant", ack, {}, "ellie-chat", ecUserId);
      broadcastExtension({ type: "message_out", channel: "ellie-chat", agent: "general", preview: ack });

      // Fire-and-forget: specialist runs outside the queue
      runSpecialistAsync(ws, supabase, effectiveText, text, agentResult, imagePath, ellieChatWorkItem).catch(err => {
        console.error(`[ellie-chat] specialist async error:`, err);
      });

      resetEllieChatIdleTimer();
      return; // queue task done — queue is free for next message
    }

    const ellieChatActiveAgent = getActiveAgent("ellie-chat");
    const ecConvoId = await getOrCreateConversation(supabase!, "ellie-chat") || undefined;
    const [ecConvoContext, contextDocket, relevantContext, elasticContext, structuredContext, forestContext, agentMemory, ecQueueContext, liveForest] = await Promise.all([
      ecConvoId && supabase ? getConversationMessages(supabase, ecConvoId) : Promise.resolve({ text: "", messageCount: 0, conversationId: "" }),
      getContextDocket(),
      getRelevantContext(supabase, effectiveText, "ellie-chat", ellieChatActiveAgent, ecConvoId),
      searchElastic(effectiveText, { limit: 5, recencyBoost: true, channel: "ellie-chat", sourceAgent: ellieChatActiveAgent, excludeConversationId: ecConvoId }),
      getAgentStructuredContext(supabase, ellieChatActiveAgent),
      getForestContext(effectiveText),
      getAgentMemoryContext(ellieChatActiveAgent, ellieChatWorkItem, getMaxMemoriesForModel(agentResult?.dispatch.agent.model)),
      agentResult?.dispatch.is_new ? getQueueContext(ellieChatActiveAgent) : Promise.resolve(""),
      getLiveForestContext(effectiveText),
    ]);
    const recentMessages = ecConvoContext.text;
    if (agentResult?.dispatch.is_new && ecQueueContext) {
      acknowledgeQueueItems(ellieChatActiveAgent).catch(() => {});
    }

    // Detect work item mentions (ELLIE-5, EVE-3, etc.) — matches Telegram text handler
    let workItemContext = "";
    const workItemMatch = effectiveText.match(/\b([A-Z]+-\d+)\b/);
    const isEllieChatWorkIntent = agentResult?.route.skill_name === "code_changes" ||
      agentResult?.route.skill_name === "code_review" ||
      agentResult?.route.skill_name === "debugging";
    if (workItemMatch && isPlaneConfigured()) {
      const details = await fetchWorkItemDetails(workItemMatch[1]);
      if (details) {
        const label = isEllieChatWorkIntent ? "ACTIVE WORK ITEM" : "REFERENCED WORK ITEM";
        workItemContext = `\n${label}: ${workItemMatch[1]}\n` +
          `Title: ${details.name}\n` +
          `Priority: ${details.priority}\n` +
          `Description: ${details.description}\n`;
      }
    }

    // ── Multi-step orchestration (pipeline, fan-out, critic-loop) ──
    if (agentResult?.route.execution_mode !== "single" && agentResult?.route.skills?.length) {
      const execMode = agentResult.route.execution_mode;
      const steps: PipelineStep[] = agentResult.route.skills.map((s) => ({
        agent_name: s.agent,
        skill_name: s.skill !== "none" ? s.skill : undefined,
        instruction: s.instruction,
      }));

      const agentNames = [...new Set(steps.map((s) => s.agent_name))].join(" → ");
      const modeLabels: Record<string, string> = { pipeline: "Pipeline", "fan-out": "Fan-out", "critic-loop": "Critic loop" };

      // Notify client that multi-step is starting
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "response",
          text: `Working on it... (${modeLabels[execMode] || execMode}: ${agentNames}, ${steps.length} steps)`,
          agent: agentResult.dispatch.agent.name,
          ts: Date.now(),
        }));
      }
      broadcastExtension({ type: "pipeline_start", channel: "ellie-chat", mode: execMode, steps: steps.length });

      try {
        const result = await executeOrchestrated(execMode, steps, effectiveText, {
          supabase,
          channel: "ellie-chat",
          userId: "dashboard",
          anthropicClient: anthropic,
          contextDocket, relevantContext, elasticContext,
          structuredContext, recentMessages, workItemContext, forestContext,
          buildPromptFn: buildPrompt,
          callClaudeFn: callClaude,
        });

        const orcAgent = result.finalDispatch?.agent?.name || agentResult.dispatch.agent.name || "general";
        const pipelineResponse = await processMemoryIntents(supabase, result.finalResponse, orcAgent, "shared", agentMemory.sessionIds);
        const { cleanedText: ellieChatOrcPlaybookClean, commands: ellieChatOrcPlaybookCmds } = extractPlaybookCommands(pipelineResponse);
        const { cleanedText, hadConfirmations } = sendWithApprovalsEllieChat(ws, ellieChatOrcPlaybookClean, session.sessionId, orcAgent);

        await saveMessage("assistant", cleanedText, {}, "ellie-chat", ecUserId);
        broadcastExtension({
          type: "message_out", channel: "ellie-chat", agent: orcAgent,
          preview: cleanedText.substring(0, 200),
        });
        broadcastExtension({
          type: "pipeline_complete", channel: "ellie-chat",
          mode: execMode, steps: result.stepResults.length,
          duration_ms: result.artifacts.total_duration_ms,
          cost_usd: result.artifacts.total_cost_usd,
        });

        if (!hadConfirmations && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "response",
            text: cleanedText,
            agent: orcAgent,
            ts: Date.now(),
            duration_ms: result.artifacts.total_duration_ms,
          }));
        }

        if (result.finalDispatch) {
          syncResponse(supabase, result.finalDispatch.session_id, cleanedText, {
            duration_ms: result.artifacts.total_duration_ms,
          }).catch(() => {});
        }

        // Fire playbook commands async (ELLIE:: tags)
        if (ellieChatOrcPlaybookCmds.length > 0) {
          const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "ellie-chat", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
          executePlaybookCommands(ellieChatOrcPlaybookCmds, pbCtx).catch(err => console.error("[playbook]", err));
        }
      } catch (err) {
        console.error("[ellie-chat] Multi-step failed:", err);
        const errMsg = err instanceof PipelineStepError && err.partialOutput
          ? err.partialOutput + "\n\n(Execution incomplete.)"
          : "Sorry, I ran into an error processing your multi-step request.";

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "response",
            text: errMsg,
            agent: agentResult.dispatch.agent.name || "general",
            ts: Date.now(),
          }));
        }
      }

      // Cleanup temp image file
      if (imagePath) unlink(imagePath).catch(() => {});

      resetEllieChatIdleTimer();
      return;
    }

    // ── Single-agent path ──
    const enrichedPrompt = buildPrompt(
      effectiveText, contextDocket, relevantContext, elasticContext, "ellie-chat",
      agentResult?.dispatch.agent ? {
        system_prompt: agentResult.dispatch.agent.system_prompt,
        name: agentResult.dispatch.agent.name,
        tools_enabled: agentResult.dispatch.agent.tools_enabled,
      } : undefined,
      workItemContext || undefined, structuredContext, recentMessages,
      agentResult?.dispatch.skill_context,
      forestContext,
      agentMemory.memoryContext || undefined,
      agentMemory.sessionIds,
      await getArchetypeContext(),
      await getPsyContext(),
      await getPhaseContext(),
      await getHealthContext(),
      ecQueueContext || undefined,
      liveForest.incidents || undefined,
      liveForest.awareness || undefined,
    );

    const agentTools = agentResult?.dispatch.agent.tools_enabled;
    const agentModel = agentResult?.dispatch.agent.model;
    const startTime = Date.now();

    // Send typing heartbeat every 4s so the user knows we're still working
    const typingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "typing", ts: Date.now() }));
      }
    }, 4_000);

    let rawResponse: string;
    try {
      rawResponse = await callClaude(enrichedPrompt, {
        resume: true,
        allowedTools: agentTools?.length ? agentTools : undefined,
        model: agentModel || undefined,
        timeoutMs: 600_000, // 10 min — async coordinator needs time for multi-step work
      });
    } finally {
      clearInterval(typingInterval);
    }
    const durationMs = Date.now() - startTime;

    // If sessionIds weren't available at context-build time (tree created during agent run),
    // look up the most recently active tree for this agent's entity
    let effectiveSessionIds = agentMemory.sessionIds;
    if (!effectiveSessionIds && agentResult?.dispatch.agent.name) {
      try {
        const { default: forestSql } = await import('../../ellie-forest/src/db');
        const { getEntity } = await import('../../ellie-forest/src/index');
        const AGENT_ENTITY_MAP: Record<string, string> = { dev: "dev_agent", general: "general_agent" };
        const entityName = AGENT_ENTITY_MAP[agentResult.dispatch.agent.name] ?? agentResult.dispatch.agent.name;
        const entity = await getEntity(entityName);
        if (entity) {
          // Find most recently active tree (growing or dormant within last 5 min)
          const [tree] = await forestSql<any[]>`
            SELECT t.id, t.work_item_id FROM trees t
            JOIN creatures c ON c.tree_id = t.id
            WHERE t.type = 'work_session'
              AND t.state IN ('growing', 'dormant')
              AND t.last_activity > NOW() - INTERVAL '5 minutes'
              AND c.entity_id = ${entity.id}
            ORDER BY t.last_activity DESC LIMIT 1
          `;
          if (tree) {
            const [branch] = await forestSql<{ id: string }[]>`
              SELECT id FROM branches WHERE tree_id = ${tree.id} AND entity_id = ${entity.id} AND state = 'open' LIMIT 1
            `;
            const [creature] = await forestSql<{ id: string }[]>`
              SELECT id FROM creatures WHERE tree_id = ${tree.id} AND entity_id = ${entity.id}
              ORDER BY created_at DESC LIMIT 1
            `;
            effectiveSessionIds = {
              tree_id: tree.id,
              branch_id: branch?.id,
              creature_id: creature?.id,
              entity_id: entity.id,
              work_item_id: tree.work_item_id,
            };
            console.log(`[ellie-chat] Late-resolved sessionIds: tree=${tree.id.slice(0, 8)}, creature=${creature?.id?.slice(0, 8) || 'none'}`);
          }
        }
      } catch (err: any) {
        console.warn(`[ellie-chat] Late-resolve sessionIds failed:`, err?.message || err);
      }
    } else if (!effectiveSessionIds) {
      console.log(`[ellie-chat] No sessionIds and no agent to late-resolve (agent=${agentResult?.dispatch.agent.name})`);
    }

    const response = await processMemoryIntents(supabase, rawResponse, agentResult?.dispatch.agent.name || "general", "shared", effectiveSessionIds);
    const { cleanedText: ecPlaybookClean, commands: ecPlaybookCmds } = extractPlaybookCommands(response);
    const ecAgent = agentResult?.dispatch.agent.name || "general";
    const { cleanedText, hadConfirmations } = sendWithApprovalsEllieChat(ws, ecPlaybookClean, session.sessionId, ecAgent);

    await saveMessage("assistant", cleanedText, {}, "ellie-chat", ecUserId);
    broadcastExtension({
      type: "message_out", channel: "ellie-chat",
      agent: ecAgent,
      preview: cleanedText.substring(0, 200),
    });

    if (!hadConfirmations && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "response",
        text: cleanedText,
        agent: ecAgent,
        ts: Date.now(),
        duration_ms: durationMs,
      }));
    }

    if (agentResult) {
      syncResponse(supabase, agentResult.dispatch.session_id, cleanedText, {
        duration_ms: durationMs,
      }).catch(() => {});
    }

    // Fire playbook commands async (ELLIE:: tags)
    if (ecPlaybookCmds.length > 0) {
      const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "ellie-chat", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
      executePlaybookCommands(ecPlaybookCmds, pbCtx).catch(err => console.error("[playbook]", err));
    }

    // Cleanup temp image file
    if (imagePath) unlink(imagePath).catch(() => {});

    resetEllieChatIdleTimer();
  }, text.substring(0, 100));
}

// getSpecialistAck is imported from relay-utils.ts

/** Run a specialist agent asynchronously (outside the ellie-chat queue). */
async function runSpecialistAsync(
  ws: WebSocket,
  supabase: SupabaseClient | null,
  effectiveText: string,
  originalText: string,
  agentResult: { route: RouteResult; dispatch: DispatchResult },
  imagePath: string | undefined,
  workItemId: string | undefined,
): Promise<void> {
  const agentName = agentResult.dispatch.agent.name;
  const specUser = wsAppUserMap.get(ws);
  const ecUserId = specUser?.id || specUser?.anonymous_id || undefined;
  const startTime = Date.now();
  console.log(`[ellie-chat] Specialist ${agentName} starting async`);

  try {
    // Typing heartbeat while specialist works
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "typing", ts: Date.now() }));
      } else {
        clearInterval(heartbeat);
      }
    }, 4_000);

    // Gather context (same sources as sync path)
    const ellieChatActiveAgent = getActiveAgent("ellie-chat");
    const specConvoId = await getOrCreateConversation(supabase!, "ellie-chat") || undefined;
    const [specConvoContext, contextDocket, relevantContext, elasticContext, structuredContext, forestContext, agentMemory, specQueueContext, liveForest] = await Promise.all([
      specConvoId && supabase ? getConversationMessages(supabase, specConvoId) : Promise.resolve({ text: "", messageCount: 0, conversationId: "" }),
      getContextDocket(),
      getRelevantContext(supabase, effectiveText, "ellie-chat", ellieChatActiveAgent, specConvoId),
      searchElastic(effectiveText, { limit: 5, recencyBoost: true, channel: "ellie-chat", sourceAgent: ellieChatActiveAgent, excludeConversationId: specConvoId }),
      getAgentStructuredContext(supabase, ellieChatActiveAgent),
      getForestContext(effectiveText),
      getAgentMemoryContext(ellieChatActiveAgent, workItemId, getMaxMemoriesForModel(agentResult.dispatch.agent.model)),
      agentResult.dispatch.is_new ? getQueueContext(ellieChatActiveAgent) : Promise.resolve(""),
      getLiveForestContext(effectiveText),
    ]);
    const recentMessages = specConvoContext.text;
    if (agentResult.dispatch.is_new && specQueueContext) {
      acknowledgeQueueItems(ellieChatActiveAgent).catch(() => {});
    }

    // Work item context
    let workItemContext = "";
    const workItemMatch = effectiveText.match(/\b([A-Z]+-\d+)\b/);
    const isWorkIntent = agentResult.route.skill_name === "code_changes" ||
      agentResult.route.skill_name === "code_review" ||
      agentResult.route.skill_name === "debugging";
    if (workItemMatch && isPlaneConfigured()) {
      const details = await fetchWorkItemDetails(workItemMatch[1]);
      if (details) {
        const label = isWorkIntent ? "ACTIVE WORK ITEM" : "REFERENCED WORK ITEM";
        workItemContext = `\n${label}: ${workItemMatch[1]}\n` +
          `Title: ${details.name}\n` +
          `Priority: ${details.priority}\n` +
          `Description: ${details.description}\n`;
      }
    }

    const enrichedPrompt = buildPrompt(
      effectiveText, contextDocket, relevantContext, elasticContext, "ellie-chat",
      {
        system_prompt: agentResult.dispatch.agent.system_prompt,
        name: agentResult.dispatch.agent.name,
        tools_enabled: agentResult.dispatch.agent.tools_enabled,
      },
      workItemContext || undefined, structuredContext, recentMessages,
      agentResult.dispatch.skill_context,
      forestContext,
      agentMemory.memoryContext || undefined,
      agentMemory.sessionIds,
      await getArchetypeContext(),
      await getPsyContext(),
      await getPhaseContext(),
      await getHealthContext(),
      specQueueContext || undefined,
      liveForest.incidents || undefined,
      liveForest.awareness || undefined,
    );

    const agentTools = agentResult.dispatch.agent.tools_enabled;
    const agentModel = agentResult.dispatch.agent.model;

    let rawResponse: string;
    try {
      rawResponse = await callClaude(enrichedPrompt, {
        resume: false, // own session — doesn't pollute the general agent's context
        allowedTools: agentTools?.length ? agentTools : undefined,
        model: agentModel || undefined,
        timeoutMs: 600_000, // 10 min — specialists may do multi-step tool use
      });
    } finally {
      clearInterval(heartbeat);
    }

    const durationMs = Date.now() - startTime;
    console.log(`[ellie-chat] Specialist ${agentName} completed in ${durationMs}ms`);

    const response = await processMemoryIntents(supabase, rawResponse, agentName, "shared", agentMemory.sessionIds);
    const { cleanedText: playClean, commands: playCmds } = extractPlaybookCommands(response);
    const { cleanedText, hadConfirmations } = sendWithApprovalsEllieChat(ws, playClean, session.sessionId, agentName);

    await saveMessage("assistant", cleanedText, {}, "ellie-chat", ecUserId);
    broadcastExtension({
      type: "message_out", channel: "ellie-chat",
      agent: agentName,
      preview: cleanedText.substring(0, 200),
    });

    if (!hadConfirmations && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "response",
        text: cleanedText,
        agent: agentName,
        ts: Date.now(),
        duration_ms: durationMs,
      }));
    } else if (!hadConfirmations) {
      // Original WS closed — send to same user's other connections only (ELLIE-197)
      const payload = JSON.stringify({
        type: "response", text: cleanedText, agent: agentName,
        ts: Date.now(), duration_ms: durationMs,
      });
      for (const client of ellieChatClients) {
        if (client.readyState === WebSocket.OPEN) {
          const clientUser = wsAppUserMap.get(client);
          const clientId = clientUser?.id || clientUser?.anonymous_id;
          if (clientId && clientId === ecUserId) {
            client.send(payload);
          }
        }
      }
    }

    syncResponse(supabase, agentResult.dispatch.session_id, cleanedText, {
      duration_ms: durationMs,
    }).catch(() => {});

    // Fire playbook commands async (ELLIE:: tags)
    if (playCmds.length > 0) {
      const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "ellie-chat", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
      executePlaybookCommands(playCmds, pbCtx).catch(err => console.error("[playbook]", err));
    }

    // Cleanup temp image file
    if (imagePath) unlink(imagePath).catch(() => {});
  } catch (err) {
    const durationMs = Date.now() - startTime;
    console.error(`[ellie-chat] Specialist ${agentName} failed after ${durationMs}ms:`, err);
    const errorMsg = `Sorry, the ${agentName} specialist ran into an issue. You can try again or rephrase.`;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "response", text: errorMsg, agent: agentName, ts: Date.now() }));
    }
    await saveMessage("assistant", errorMsg, {}, "ellie-chat", ecUserId).catch(() => {});
  }
}

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

// Register external dependencies for extracted modules (ELLIE-205, ELLIE-206, ELLIE-207, ELLIE-211)
setBroadcastExtension(broadcastExtension);
setNotifyCtx(getNotifyCtx);
setAnthropicClient(anthropic);
setQueueBroadcast(broadcastExtension);
setSenderDeps({ supabase, getActiveAgent });
setVoicePipelineDeps({ supabase, getActiveAgent, broadcastExtension, getContextDocket, triggerConsolidation });
setBroadcastToEllieChat(broadcastToEllieChatClients);

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
  console.log(`[ellie-chat] WebSocket: ws://localhost:${HTTP_PORT}/ws/ellie-chat`);
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
