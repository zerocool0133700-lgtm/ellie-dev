/**
 * Claude Code Telegram Relay — Entry Point
 *
 * Orchestrates startup: creates clients, wires dependencies, starts servers.
 * Route handlers, WebSocket logic, and Telegram handlers live in separate modules.
 * Periodic background tasks live in periodic-tasks.ts (ELLIE-492).
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
import { setQueueBroadcast, drainQueues } from "./message-queue.ts";
import { setVoicePipelineDeps } from "./voice-pipeline.ts";
import { setSenderDeps } from "./message-sender.ts";
import { initDelivery } from "./ws-delivery.ts";
import { initForestSync } from "./elasticsearch/context.ts";
import { initGoogleChat, sendGoogleChatMessage, isGoogleChatEnabled } from "./google-chat.ts";
import { startNudgeChecker } from "./delivery.ts";
import { initClassifier, warmTreeRoutingRules } from "./intent-classifier.ts";
import { initEntailmentClassifier } from "./entailment-classifier.ts";
import { startSkillWatcher, getSkillSnapshot } from "./skills/index.ts";
import { initOutlook, getOutlookEmail } from "./outlook.ts";
import { startExpiryCleanup } from "./approval.ts";
import { notify } from "./notification-policy.ts";
import { startPlaneQueueWorker, stopPlaneQueueWorker } from "./plane-queue.ts";
import { startWatchdog, recoverActiveRuns, setWatchdogNotify, stopWatchdog } from "./orchestration-tracker.ts";
import { reconcileOnStartup, startReconciler, stopReconciler } from "./orchestration-reconciler.ts";
import { restoreModeState } from "./context-mode.ts";
import { cleanupOrphanedJobs, registerJobVines } from "./jobs-ledger.ts";
import { onBridgeWrite } from "./api/bridge.ts";
import { setBroadcastToEllieChat } from "./tool-approval.ts";
import { stopAllTasks } from "./periodic-task.ts";
import { initPeriodicTasks, runStartupTasks } from "./periodic-tasks.ts";

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

// ELLIE-462: Bot restart gate — prevent concurrent restarts and rapid flap loops
// ELLIE-467: Added 5-min cooldown between restarts
let _botRestarting = false;
let _lastBotRestartAt = 0;

// Start approval expiry cleanup
startExpiryCleanup();

// Plane sync queue — persistent retry for failed Plane API calls (ELLIE-234)
startPlaneQueueWorker();

// Orchestration tracker — ELLIE-349: heartbeat watchdog + orphan recovery
// ELLIE-387: Wire proactive notifications to watchdog (deferred — needs setRelayDeps first)
recoverActiveRuns()
  .then(() => cleanupOrphanedJobs())
  .then(count => { if (count > 0) console.log(`[jobs] Cleaned up ${count} orphaned job(s) on startup`); })
  .then(() => reconcileOnStartup(supabase))
  .then(() => {
    startWatchdog();
    startReconciler(supabase);
  })
  .catch(err => logger.error("Orchestration startup error", err));

// ELLIE-455: Register J scope tree-level vines on startup
registerJobVines().catch(err => logger.warn("[job-vines] Startup registration failed", { err: err.message }));

// ELLIE-395: Restore conversation mode state from disk
restoreModeState().catch(err => logger.warn("Mode state restore failed (non-fatal)", err));

// ELLIE-374: Validate all archetype files on startup
import("./prompt-builder.ts").then(({ validateArchetypes }) => validateArchetypes()).catch(err => logger.warn("Archetype validation failed", { error: err instanceof Error ? err.message : String(err) }));

// Bridge write notifications — Telegram + ellie-chat (ELLIE-199)
onBridgeWrite(({ collaborator, content, memoryId, type, workItemId }) => {
  const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
  const ticket = workItemId ? ` (${workItemId})` : '';
  const label = type === 'decision' ? 'decided' : type === 'hypothesis' ? 'hypothesized' : 'logged';

  // Telegram notification
  notify(getNotifyCtx(), {
    event: "dispatch_confirm",
    workItemId: memoryId,
    telegramMessage: `\ud83d\udccb *${collaborator}* ${label}${ticket}: ${preview}`,
    gchatMessage: `${collaborator} ${label}${ticket}: ${preview}`,
  }).catch(err => logger.error("Bridge notify failed", err));

  // Push to ellie-chat clients
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
// ELLIE-387: Wire watchdog notifications (after setRelayDeps so getNotifyCtx works)
setWatchdogNotify(notify, getNotifyCtx());
setAnthropicClient(anthropic);
setQueueBroadcast(broadcastExtension);
setSenderDeps({ supabase, getActiveAgent });
initDelivery(supabase);
setVoicePipelineDeps({ supabase, getActiveAgent, broadcastExtension, getContextDocket, triggerConsolidation });
setBroadcastToEllieChat(broadcastToEllieChatClients);

// ── ELLIE-492: Unified periodic task runner ──────────────────
// All background periodic tasks registered in one place.
// Must run after dependency wiring so supabase/anthropic/bot are available.
initPeriodicTasks({
  supabase,
  bot,
  anthropic,
  botRestart: {
    isRestarting: () => _botRestarting,
    setRestarting: (v) => { _botRestarting = v; },
    lastRestartAt: () => _lastBotRestartAt,
    setLastRestartAt: (t) => { _lastBotRestartAt = t; },
  },
});
runStartupTasks({ supabase, bot, anthropic, botRestart: {
  isRestarting: () => _botRestarting,
  setRestarting: (v) => { _botRestarting = v; },
  lastRestartAt: () => _lastBotRestartAt,
  setLastRestartAt: (t) => { _lastBotRestartAt = t; },
}});

// ELLIE-469: Discord channel plugin — only activates if DISCORD_BOT_TOKEN is set
import { startDiscordGateway } from "./channels/discord/index.ts";
startDiscordGateway(supabase);

// ELLIE-443: Slack channel plugin — only activates if SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET are set
import { startSlackChannel } from "./channels/slack/index.ts";
startSlackChannel();

// Initialize classifiers
if (anthropic && supabase) initClassifier(anthropic, supabase);
if (anthropic) initEntailmentClassifier(anthropic);

// ELLIE-435: Pre-warm orchestrator routing rules from Forest tree
warmTreeRoutingRules().catch(err => logger.warn("[ELLIE-435] Tree routing warm failed", err));

// ELLIE-388: Load workflow templates
import { loadWorkflowTemplates } from "./workflow-templates.ts";
loadWorkflowTemplates();

// ELLIE-235: Preload model costs at startup (avoids first-request latency)
import { preloadModelCosts } from "./orchestrator.ts";
preloadModelCosts(supabase).catch(err => logger.warn("Model cost preload failed", err));

// ELLIE-229: Probe voice transcription providers at startup
import { probeVoiceProviders } from "./transcribe.ts";
probeVoiceProviders().catch(err => logger.warn("Voice provider probe failed", err));

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
  const nudgeText = `Hey Dave \u2014 I sent you a response${count > 1 ? ` (${count} messages)` : ""} a few minutes ago. Did it come through?`;
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
  console.log(`[relay] ${signal} received \u2014 shutting down gracefully...`);

  // 1. Stop accepting new messages
  try { await bot.stop(); } catch {}
  console.log("[relay] Telegram bot stopped");
  const { stopDiscordGateway } = await import("./channels/discord/index.ts");
  await stopDiscordGateway().catch(() => {});
  console.log("[relay] Discord gateway stopped");

  // 2. Stop all background tasks (ELLIE-487/492)
  stopAllTasks();
  stopWatchdog();
  stopReconciler();
  stopPlaneQueueWorker();
  console.log("[relay] Background tasks stopped (periodic, watchdog, reconciler, plane queue)");

  // 3. Wait for active queue tasks to finish (ELLIE-460: graceful drain)
  const drained = await drainQueues(20_000); // 20s max wait
  if (drained) {
    console.log("[relay] Queues drained cleanly");
  } else {
    console.log("[relay] Queue drain timed out \u2014 proceeding anyway");
  }

  // 4. Close HTTP server + file watchers
  httpServer.close();
  const { stopPersonalityWatchers } = await import("./prompt-builder.ts");
  stopPersonalityWatchers();
  console.log("[relay] HTTP server closed, personality watchers stopped");

  // 5. Release lock file with timeout — guards against hung FS or slow cleanup (ELLIE-487)
  const { releaseLock } = await import("./claude-cli.ts");
  await Promise.race([
    releaseLock(),
    new Promise<void>(resolve => setTimeout(resolve, 5_000)),
  ]);

  console.log("[relay] Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// ── ELLIE-460: Process-level crash capture ───────────────────
// Catches hard crashes that bypass individual .catch() handlers.
// Logs then allows the process to exit so systemd restarts cleanly.

process.on("uncaughtException", (err: Error, origin: string) => {
  // ELLIE-465: Sync write first — logger may be async and drop the crash log if we exit too fast
  const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  process.stderr.write(
    JSON.stringify({ level: "fatal", event: "UNCAUGHT EXCEPTION", error: err.message, stack: err.stack, origin, memory_mb: mem, ts: new Date().toISOString() }) + "\n"
  );
  logger.error("[UNCAUGHT EXCEPTION] Process will exit", {
    error: err.message,
    stack: err.stack,
    origin,
    memory_mb: mem,
  });
  // Allow the process to exit — systemd restarts us
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  logger.error("[UNHANDLED REJECTION] Non-fatal \u2014 logged and continuing", {
    reason: msg,
    stack,
    memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
  // Do NOT exit — unhandled rejections are common from fire-and-forget patterns.
  // Only uncaughtException (sync throws) warrants a hard exit.
});
