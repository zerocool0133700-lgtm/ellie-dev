/**
 * Claude Code Telegram Relay — Entry Point
 *
 * Orchestrates startup: creates clients, wires dependencies, starts servers.
 * Route handlers, WebSocket logic, and Telegram handlers live in separate modules.
 *
 * Run: bun run src/relay.ts
 */

import { Bot } from "grammy";
import { mkdir } from "fs/promises";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createServer } from "http";
import Anthropic from "@anthropic-ai/sdk";
import { log } from "./logger.ts";

const logger = log.child("relay");

// Relay modules (ELLIE-184)
import {
  BOT_TOKEN, ALLOWED_USER_ID, PROJECT_DIR, AGENT_MODE, ALLOWED_TOOLS,
  HTTP_PORT, PUBLIC_URL, TEMP_DIR, UPLOADS_DIR,
  getContextDocket,
} from "./relay-config.ts";
import {
  getActiveAgent, broadcastExtension, broadcastToEllieChatClients,
  setRelayDeps, getNotifyCtx,
} from "./relay-state.ts";
import { triggerConsolidation } from "./relay-idle.ts";
import { handleHttpRequest } from "./http-routes.ts";
import { registerTelegramHandlers } from "./telegram-handlers.ts";
import { createWebSocketServers } from "./websocket-servers.ts";

// Extracted modules
import {
  acquireLock,
  setBroadcastExtension,
  setNotifyCtx,
  setAnthropicClient,
} from "./claude-cli.ts";
import { setQueueBroadcast } from "./message-queue.ts";
import { setVoicePipelineDeps } from "./voice-pipeline.ts";
import { ellieChatPendingActions, setSenderDeps } from "./message-sender.ts";
import { initForestSync } from "./elasticsearch/context.ts";
import { initGoogleChat, sendGoogleChatMessage } from "./google-chat.ts";
import { startNudgeChecker } from "./delivery.ts";
import { initClassifier } from "./intent-classifier.ts";
import { initEntailmentClassifier } from "./entailment-classifier.ts";
import { startSkillWatcher, getSkillSnapshot } from "./skills/index.ts";
import { syncAllCalendars } from "./calendar-sync.ts";
import { initOutlook, getOutlookEmail } from "./outlook.ts";
import { startExpiryCleanup } from "./approval.ts";
import { notify } from "./notification-policy.ts";
import { expireIdleConversations } from "./conversations.ts";
import { expireStaleItems } from "./api/agent-queue.ts";
import { startPlaneQueueWorker, purgeCompleted as purgePlaneQueue } from "./plane-queue.ts";
import { onBridgeWrite } from "./api/bridge.ts";
import { setBroadcastToEllieChat } from "./tool-approval.ts";
import { getSummaryState } from "./ums/consumers/summary.ts";

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  logger.error("TELEGRAM_BOT_TOKEN not set!");
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

// Acquire lock
if (!(await acquireLock())) {
  logger.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

export const bot = new Bot(BOT_TOKEN);

// Start approval expiry cleanup
startExpiryCleanup();

// Periodic idle conversation expiry (every 5 minutes)
// ELLIE-232: Now uses expireIdleConversations() which has atomic claim protection
// to prevent duplicate memory extraction from racing close paths.
setInterval(async () => {
  if (supabase) {
    try {
      await expireIdleConversations(supabase);
    } catch (err: unknown) {
      logger.error("Stale conversation cleanup error", { error: err instanceof Error ? err.message : String(err) });
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
  } catch (err: unknown) {
    logger.error("Periodic sync error", { error: err instanceof Error ? err.message : String(err) });
  }
}, 5 * 60_000);

// Stale queue item expiry — every hour (ELLIE-201)
setInterval(() => {
  expireStaleItems().catch(err => logger.error("Stale expiry error", err));
}, 60 * 60_000);
// Run once on startup (10s delay)
setTimeout(() => {
  expireStaleItems().catch(err => logger.error("Initial stale expiry error", err));
}, 10_000);

// Plane sync queue — persistent retry for failed Plane API calls (ELLIE-234)
startPlaneQueueWorker();
// Purge completed queue items weekly
setInterval(() => {
  purgePlaneQueue().catch(err => logger.error("Plane queue purge error", err));
}, 24 * 60 * 60_000);

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
  }).catch(err => logger.error("Bridge notify failed", err));

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
  } catch (err: unknown) {
    logger.error("Initial sync error", { error: err instanceof Error ? err.message : String(err) });
  }
}, 10_000);

// Memory maintenance: expire short-term memories (every 15 minutes)
setInterval(async () => {
  try {
    const { expireShortTermMemories } = await import('../../ellie-forest/src/shared-memory');
    const expired = await expireShortTermMemories();
    if (expired > 0) console.log(`[memory-maintenance] Expired ${expired} short-term memories`);
  } catch (err: unknown) {
    logger.error("Short-term expiry error", { error: err instanceof Error ? err.message : String(err) });
  }
}, 15 * 60_000);

// Memory maintenance: refresh weights (every hour)
setInterval(async () => {
  try {
    const { refreshWeights } = await import('../../ellie-forest/src/shared-memory');
    const refreshed = await refreshWeights({ limit: 500 });
    if (refreshed > 0) console.log(`[memory-maintenance] Refreshed weights for ${refreshed} memories`);
  } catch (err: unknown) {
    logger.error("Weight refresh error", { error: err instanceof Error ? err.message : String(err) });
  }
}, 60 * 60_000);

// Summary Bar push — broadcast module summary state to Ellie Chat clients (ELLIE-315)
// Runs every 30 seconds when clients are connected; skips if no listeners.
setInterval(async () => {
  if (!supabase) return;
  // Only compute if someone is listening (check done inside broadcastToEllieChatClients)
  try {
    const summary = await getSummaryState(supabase);
    broadcastToEllieChatClients({
      type: "summary_update",
      summary,
      ts: Date.now(),
    });
  } catch (err: unknown) {
    // Non-critical — don't spam logs
    logger.debug("Summary push error", { error: err instanceof Error ? err.message : String(err) });
  }
}, 30_000);

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
    logger.error("agent_sessions expire error", error);
    return;
  }
  if (data && data.length > 0) {
    console.log(`[session-cleanup] Expired ${data.length} stale agent session(s)`);
  }
}

// ============================================================
// CLIENTS + DEPENDENCY WIRING
// ============================================================

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Wire shared dependencies for all extracted modules
setRelayDeps({ bot, anthropic, supabase });
setBroadcastExtension(broadcastExtension);
setNotifyCtx(getNotifyCtx);
setAnthropicClient(anthropic);
setQueueBroadcast(broadcastExtension);
setSenderDeps({ supabase, getActiveAgent });
setVoicePipelineDeps({ supabase, getActiveAgent, broadcastExtension, getContextDocket, triggerConsolidation });
setBroadcastToEllieChat(broadcastToEllieChatClients);

// Initialize classifiers
if (anthropic && supabase) initClassifier(anthropic, supabase);
if (anthropic) initEntailmentClassifier(anthropic);

// ELLIE-235: Preload model costs at startup (avoids first-request latency)
import { preloadModelCosts } from "./orchestrator.ts";
preloadModelCosts(supabase).catch(err => logger.warn("Model cost preload failed", err));

// Initialize SKILL.md watcher for hot-reload (ELLIE-217)
startSkillWatcher();
getSkillSnapshot().then(s => {
  console.log(`[skills] Initial snapshot: ${s.skills.length} skills, ${s.totalChars} chars`);
}).catch(err => logger.warn("Initial snapshot failed", err));

// Register Telegram handlers + create HTTP server
registerTelegramHandlers(bot);
const httpServer = createServer(handleHttpRequest);

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
    logger.error("Nudge failed", { channel }, err);
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

// Set up WebSocket servers (voice, extension, ellie-chat)
createWebSocketServers(httpServer);

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

// ── Graceful shutdown (ELLIE-225) ───────────────────────────

let shutdownInProgress = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log(`[relay] ${signal} received — shutting down gracefully...`);

  // 1. Stop accepting new Telegram messages
  try { await bot.stop(); } catch {}
  console.log("[relay] Telegram bot stopped");

  // 2. Close HTTP server + file watchers
  httpServer.close();
  const { stopPersonalityWatchers } = await import("./prompt-builder.ts");
  stopPersonalityWatchers();
  console.log("[relay] HTTP server closed, personality watchers stopped");

  // 3. Release lock file
  const { releaseLock } = await import("./claude-cli.ts");
  await releaseLock();

  console.log("[relay] Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
