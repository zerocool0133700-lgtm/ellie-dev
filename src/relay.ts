/**
 * Claude Code Telegram Relay — Entry Point
 *
 * Orchestrates startup: creates clients, wires dependencies, starts servers.
 * Route handlers, WebSocket logic, and Telegram handlers live in separate modules.
 * Periodic background tasks live in periodic-tasks.ts (ELLIE-492).
 *
 * Run: bun run src/relay.ts
 *
 * ── Startup DAG (ELLIE-497) ──────────────────────────────────
 *
 * The initialization sequence forms a directed acyclic graph.
 * Phases are grouped by dependency depth — phases in the same group
 * can run in parallel; phases in later groups depend on earlier ones.
 *
 * DEPTH 0 — No dependencies (all run in parallel):
 *   config, directories, supabase, lock, anthropic, dead-letters,
 *   approval-expiry, plane-queue, plane-reconcile, job-vines,
 *   mode-restore, archetype-validate, bridge-write, slack,
 *   routing-rules, workflow-templates, voice-providers, skill-watcher,
 *   google-chat, outlook, http-server, forest-sync
 *
 * DEPTH 1 — Depends on depth-0 phases:
 *   bot (← config)
 *   orchestration (← supabase)
 *   discord (← supabase)
 *   model-costs (← supabase)
 *   classifiers (← anthropic + supabase)
 *
 * DEPTH 2 — Depends on depth-1:
 *   dep-wiring (← bot + anthropic + supabase) [CRITICAL]
 *   telegram-handlers (← bot)
 *   nudge-checker (← bot + google-chat)
 *
 * DEPTH 3:
 *   periodic-tasks (← dep-wiring)
 *   websocket-servers (← http-server + dep-wiring)
 *   bot-start (← telegram-handlers)
 *
 * DEPTH 4:
 *   http-listen (← http-server + websocket-servers)
 *
 * Critical phases (failure aborts startup):
 *   config, directories, lock, bot, dep-wiring, telegram-handlers,
 *   http-server, websocket-servers, http-listen, bot-start,
 *   orchestration (ELLIE-563)
 *
 * ── Shutdown (reverse order) ─────────────────────────────────
 *
 * 1. bot.stop() — stop accepting Telegram messages
 * 2. discord — stop Discord gateway
 * 3. periodic-tasks — stopAllTasks() (includes creature reaper, health checks, etc.)
 * 4. orchestration — stopWatchdog() + stopReconciler()
 * 5. plane-queue — stopPlaneQueueWorker()
 * 6. message-queues — drainQueues(20s) for in-flight tasks
 * 7. http-server — close HTTP + personality watchers
 * 8. lock — releaseLock() with 5s timeout
 *
 * See src/startup-dag.ts for the formal DAG engine and tests.
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
import { createWebSocketServers, stopWebSocketPings } from "./websocket-servers.ts";

// Extracted modules
import {
  acquireLock,
  setBroadcastExtension,
  setNotifyCtx,
  setAnthropicClient,
} from "./claude-cli.ts";
import { setQueueBroadcast, drainQueues, loadPersistedDeadLetters } from "./message-queue.ts";
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
import { reconcilePlaneState, isWorkItemDone } from "./plane.ts";
import { reconcileDashboard } from "./active-tickets-dashboard.ts";
import { setWatchdogNotify, stopWatchdog } from "./orchestration-tracker.ts";
import { stopReconciler } from "./orchestration-reconciler.ts";
import { restoreModeState } from "./context-mode.ts";
import { registerJobVines } from "./jobs-ledger.ts";
import { initOrchestration } from "./orchestration-init.ts";
import { onBridgeWrite } from "./api/bridge.ts";
import { setBroadcastToEllieChat } from "./tool-approval.ts";
import { stopAllTasks } from "./periodic-task.ts";
import { initPeriodicTasks, runStartupTasks } from "./periodic-tasks.ts";
import { initIdentitySystem, shutdownIdentitySystem } from "./identity-startup.ts";

// ── Startup phase timer (ELLIE-497) ─────────────────────────
const _startupBegin = Date.now();
const _phaseTimings: Array<{ name: string; ms: number }> = [];

function startPhase(name: string): () => void {
  const t0 = Date.now();
  logger.info(`START ${name}`);
  return () => {
    const ms = Date.now() - t0;
    _phaseTimings.push({ name, ms });
    logger.info(`DONE ${name}`, { ms });
  };
}

// ============================================================
// SETUP
// ============================================================

const _doneConfig = startPhase("config");
if (!BOT_TOKEN) {
  logger.error("TELEGRAM_BOT_TOKEN not set!");
  logger.info("To set up: 1. Message @BotFather on Telegram, 2. Create a new bot with /newbot, 3. Copy the token to .env");
  process.exit(1);
}
_doneConfig();

// Create directories
const _doneDirectories = startPhase("directories");
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });
_doneDirectories();

// ============================================================
// SUPABASE (optional — only if configured)
// ============================================================

const _doneSupabase = startPhase("supabase");
const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;
_doneSupabase();

// Acquire lock
const _doneLock = startPhase("lock");
if (!(await acquireLock())) {
  logger.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}
_doneLock();

const _doneBot = startPhase("bot");
export const bot = new Bot(BOT_TOKEN);
_doneBot();

// ELLIE-462: Bot restart gate — prevent concurrent restarts and rapid flap loops
// ELLIE-467: Added 5-min cooldown between restarts
let _botRestarting = false;
let _lastBotRestartAt = 0;

// ELLIE-490: Restore dead letters that survived previous process restart
{ const _done = startPhase("dead-letters");
  loadPersistedDeadLetters().then(() => _done()).catch(err => { _done(); logger.warn("DLQ restore failed (non-fatal)", err); });
}

// Start approval expiry cleanup
{ const _done = startPhase("approval-expiry"); startExpiryCleanup(); _done(); }

// Plane sync queue — persistent retry for failed Plane API calls (ELLIE-234)
{ const _done = startPhase("plane-queue"); startPlaneQueueWorker(); _done(); }
// ELLIE-483: Detect partial Plane states from prior crashes
{ const _done = startPhase("plane-reconcile");
  reconcilePlaneState().then(() => _done()).catch(err => { _done(); logger.warn("Plane reconciliation failed (non-fatal)", err); });
}

// ELLIE-580: Reconcile stale dashboard entries on startup
{ const _done = startPhase("dashboard-reconcile");
  const { getWorkSessionByPlaneId } = await import('../../ellie-forest/src/index');
  reconcileDashboard({
    isWorkItemDone,
    hasActiveSession: async (workItemId: string) => {
      const tree = await getWorkSessionByPlaneId(workItemId);
      return tree?.state === 'growing';
    },
  }).then(() => _done()).catch(err => { _done(); logger.warn("Dashboard reconciliation failed (non-fatal)", err); });
}

// Orchestration tracker — ELLIE-349: heartbeat watchdog + orphan recovery
// ELLIE-387: Wire proactive notifications to watchdog (deferred — needs setRelayDeps first)
// ELLIE-563: Marked critical — relay exits if orchestration fails to initialize
{ const _done = startPhase("orchestration");
  initOrchestration(supabase)
    .then(() => _done())
    .catch(err => {
      _done();
      logger.error("CRITICAL: Orchestration startup failed — relay cannot route messages", err);
      process.exit(1);
    });
}

// ELLIE-455: Register J scope tree-level vines on startup
{ const _done = startPhase("job-vines");
  registerJobVines().then(() => _done()).catch(err => { _done(); logger.warn("Startup registration failed", { err: err.message }); });
}

// ELLIE-395: Restore conversation mode state from disk
{ const _done = startPhase("mode-restore");
  restoreModeState().then(() => _done()).catch(err => { _done(); logger.warn("Mode state restore failed (non-fatal)", err); });
}

// ELLIE-374: Validate all archetype files on startup
{ const _done = startPhase("archetype-validate");
  import("./prompt-builder.ts").then(({ validateArchetypes }) => validateArchetypes()).then(() => _done()).catch(err => { _done(); logger.warn("Archetype validation failed", { error: err instanceof Error ? err.message : String(err) }); });
}

// ELLIE-615: Initialize ODS identity system (archetypes, roles, bindings, watchers)
{ const _done = startPhase("identity-system");
  try {
    initIdentitySystem();
    _done();
  } catch (err) {
    _done();
    logger.warn("Identity system init failed (non-fatal)", { error: err instanceof Error ? err.message : String(err) });
  }
}

// Bridge write notifications — Telegram + ellie-chat (ELLIE-199)
{ const _done = startPhase("bridge-write");
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
_done(); }

// ============================================================
// CLIENTS + DEPENDENCY WIRING
// ============================================================

const _doneAnthropic = startPhase("anthropic");
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;
_doneAnthropic();

// Wire shared dependencies for all extracted modules
const _doneDepWiring = startPhase("dep-wiring");
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
_doneDepWiring();

// ── ELLIE-492: Unified periodic task runner ──────────────────
// All background periodic tasks registered in one place.
// Must run after dependency wiring so supabase/anthropic/bot are available.
const _donePeriodicTasks = startPhase("periodic-tasks");
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
_donePeriodicTasks();

// ELLIE-469: Discord channel plugin — only activates if DISCORD_BOT_TOKEN is set
import { startDiscordGateway } from "./channels/discord/index.ts";
{ const _done = startPhase("discord"); startDiscordGateway(supabase); _done(); }

// ELLIE-443: Slack channel plugin — only activates if SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET are set
import { startSlackChannel } from "./channels/slack/index.ts";
{ const _done = startPhase("slack"); startSlackChannel(); _done(); }

// Initialize classifiers
{ const _done = startPhase("classifiers");
  if (anthropic && supabase) initClassifier(anthropic, supabase);
  if (anthropic) initEntailmentClassifier(anthropic);
  _done();
}

// ELLIE-435: Pre-warm orchestrator routing rules from Forest tree
{ const _done = startPhase("routing-rules");
  warmTreeRoutingRules().then(() => _done()).catch(err => { _done(); logger.warn("Tree routing warm failed", err); });
}

// ELLIE-388: Load workflow templates
import { loadWorkflowTemplates } from "./workflow-templates.ts";
{ const _done = startPhase("workflow-templates"); loadWorkflowTemplates(); _done(); }

// ELLIE-235: Preload model costs at startup (avoids first-request latency)
import { preloadModelCosts } from "./orchestrator.ts";
{ const _done = startPhase("model-costs");
  preloadModelCosts(supabase).then(() => _done()).catch(err => { _done(); logger.warn("Model cost preload failed", err); });
}

// ELLIE-229: Probe voice transcription providers at startup
import { probeVoiceProviders } from "./transcribe.ts";
{ const _done = startPhase("voice-providers");
  probeVoiceProviders().then(() => _done()).catch(err => { _done(); logger.warn("Voice provider probe failed", err); });
}

// Initialize SKILL.md watcher for hot-reload (ELLIE-217)
{ const _done = startPhase("skill-watcher");
  startSkillWatcher();
  getSkillSnapshot().then(s => {
    logger.info("Initial skill snapshot loaded", { skills: s.skills.length, totalChars: s.totalChars });
    _done();
  }).catch(err => { _done(); logger.warn("Initial snapshot failed", err); });
}

// Register Telegram handlers + create HTTP server
{ const _done = startPhase("telegram-handlers"); registerTelegramHandlers(bot); _done(); }
const _doneHttpServer = startPhase("http-server");
const httpServer = createServer(handleHttpRequest);
_doneHttpServer();

// Init Google Chat (optional — skips gracefully if not configured)
const _doneGchat = startPhase("google-chat");
const gchatEnabled = await initGoogleChat();
_doneGchat();

// Init Microsoft Outlook (optional — skips gracefully if not configured)
const _doneOutlook = startPhase("outlook");
const outlookEnabled = await initOutlook();
_doneOutlook();

// Start delivery nudge checker — sends reminder if response wasn't acknowledged
{ const _done = startPhase("nudge-checker");
startNudgeChecker(async (channel, count) => {
  const nudgeText = `Hey Dave \u2014 I sent you a response${count > 1 ? ` (${count} messages)` : ""} a few minutes ago. Did it come through?`;
  logger.info("Nudging user", { channel, pendingResponses: count });
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
_done(); }

logger.info("Starting Claude Telegram Relay...", {
  authorizedUser: ALLOWED_USER_ID || "ANY (not recommended)",
  projectDir: PROJECT_DIR || "(relay working directory)",
  agentMode: AGENT_MODE ? "ON" : "OFF",
  tools: AGENT_MODE ? ALLOWED_TOOLS : undefined,
  googleChat: gchatEnabled ? "ON" : "OFF",
  outlook: outlookEnabled ? "ON" : "OFF",
});

// Initialize ES forest sync (if configured)
{ const _done = startPhase("forest-sync"); await initForestSync(); _done(); }

// Set up WebSocket servers (voice, extension, ellie-chat)
{ const _done = startPhase("websocket-servers"); createWebSocketServers(httpServer); _done(); }

// ELLIE-803: Wire permission audit flush callback
{
  const { setFlushCallback } = await import("./permission-audit.ts");
  const { default: forestSql } = await import("../../ellie-forest/src/db");
  setFlushCallback(async (entries) => {
    if (entries.length === 0) return;
    const values = entries.map(e => ({
      event_type: e.event_type,
      entity_id: e.entity_id,
      entity_name: e.entity_name ?? null,
      resource: e.resource ?? null,
      action: e.action ?? null,
      scope: e.scope ?? null,
      result: e.result ?? null,
      changed_by: e.changed_by ?? null,
      metadata: e.metadata ? JSON.stringify(e.metadata) : null,
    }));
    await forestSql`
      INSERT INTO permission_audit_log ${forestSql(values, 'event_type', 'entity_id', 'entity_name', 'resource', 'action', 'scope', 'result', 'changed_by', 'metadata')}
    `;
  });
  logger.info("[rbac] Audit flush callback registered");
}

// Start HTTP + WebSocket server
const _doneHttpListen = startPhase("http-listen");
httpServer.listen(HTTP_PORT, () => {
  _doneHttpListen();
  logger.info("Server listening", { port: HTTP_PORT });
  logger.info("WebSocket endpoints ready", {
    voice: `ws://localhost:${HTTP_PORT}/media-stream`,
    extension: `ws://localhost:${HTTP_PORT}/extension`,
    ellieChat: `ws://localhost:${HTTP_PORT}/ws/ellie-chat`,
    twiml: `http://localhost:${HTTP_PORT}/voice`,
  });
  if (PUBLIC_URL) {
    logger.info("Public URL configured", { url: PUBLIC_URL, gchatWebhook: gchatEnabled ? `${PUBLIC_URL}/google-chat` : undefined });
  } else {
    logger.warn("PUBLIC_URL not set in .env");
  }
});

// Start Telegram bot (long-polling)
const _doneBotStart = startPhase("bot-start");
bot.start({
  onStart: () => {
    _doneBotStart();
    const totalMs = Date.now() - _startupBegin;
    logger.info("Telegram bot is running!");
    logger.info("All startup phases complete", {
      phases: _phaseTimings.length,
      totalMs,
    });
  },
});

// ── Graceful shutdown (ELLIE-225) ───────────────────────────

let shutdownInProgress = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  const shutdownStart = Date.now();
  logger.info("Shutting down gracefully...", { signal });

  // ── ELLIE-497: Shutdown mirrors startup in reverse ────────
  // Dependents shut down before their dependencies.
  // Order: bot → channels → background-tasks → queues → http → lock

  // 1. Stop accepting new messages (reverse of bot-start)
  logger.info("Stopping telegram bot...");
  try { await bot.stop(); } catch {}
  logger.info("Telegram bot stopped");
  logger.info("Stopping discord...");
  const { stopDiscordGateway } = await import("./channels/discord/index.ts");
  await stopDiscordGateway().catch(() => {});
  logger.info("Discord gateway stopped");

  // 2. Stop all background tasks (reverse of periodic-tasks + orchestration)
  logger.info("Stopping background tasks...");
  stopAllTasks();      // periodic-tasks
  stopWatchdog();      // orchestration watchdog
  stopReconciler();    // orchestration reconciler
  stopPlaneQueueWorker(); // plane-queue
  logger.info("Background tasks stopped");

  // 2b. Kill all active sub-agent spawns (ELLIE-949: graceful shutdown cascade kill)
  try {
    const { _getRegistryForTesting, killChildrenForParent } = await import("./session-spawn.ts");
    const registry = _getRegistryForTesting();
    const parentIds = new Set<string>();
    for (const record of registry.values()) {
      if (record.state === "pending" || record.state === "running") {
        parentIds.add(record.parentSessionId);
      }
    }
    let totalKilled = 0;
    for (const parentId of parentIds) {
      totalKilled += killChildrenForParent(parentId, "Relay shutting down").length;
    }
    if (totalKilled > 0) logger.info(`Shutdown: killed ${totalKilled} active spawn(s)`);
  } catch (err) {
    logger.warn("Shutdown spawn kill failed (non-fatal)", err);
  }

  // 3. Wait for active queue tasks to finish (ELLIE-460: graceful drain)
  logger.info("Draining message queues...");
  const drained = await drainQueues(20_000); // 20s max wait
  logger.info("Queue drain complete", { drained });

  // 4. Close HTTP server + file watchers + WS pings (reverse of http-listen + websocket-servers)
  logger.info("Closing HTTP server...");
  stopWebSocketPings(); // ELLIE-561
  httpServer.close();
  const { stopPersonalityWatchers } = await import("./prompt-builder.ts");
  stopPersonalityWatchers();
  shutdownIdentitySystem(); // ELLIE-615
  logger.info("HTTP server closed");

  // 5. Release lock file (reverse of lock — deepest foundation)
  logger.info("Releasing lock...");
  const { releaseLock } = await import("./claude-cli.ts");
  await Promise.race([
    releaseLock(),
    new Promise<void>(resolve => setTimeout(resolve, 5_000)),
  ]);

  const shutdownMs = Date.now() - shutdownStart;
  logger.info("Shutdown complete", { ms: shutdownMs });
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
  logger.error("Uncaught exception — process will exit", {
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
  logger.error("Unhandled rejection — logged and continuing", {
    reason: msg,
    stack,
    memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
  // Do NOT exit — unhandled rejections are common from fire-and-forget patterns.
  // Only uncaughtException (sync throws) warrants a hard exit.
});
