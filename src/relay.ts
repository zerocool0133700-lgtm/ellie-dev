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
import {
  isFallbackActive, shouldProbeRecovery, markRecoveryProbeAttempted, recordAnthropicSuccess,
} from "./llm-provider.ts";
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
import { USER_TIMEZONE } from "./timezone.ts";
import { setVoicePipelineDeps } from "./voice-pipeline.ts";
import { ellieChatPendingActions, setSenderDeps } from "./message-sender.ts";
import { initDelivery } from "./ws-delivery.ts";
import { initForestSync } from "./elasticsearch/context.ts";
import { initGoogleChat, sendGoogleChatMessage, isGoogleChatEnabled } from "./google-chat.ts";
const GOOGLE_CHAT_SPACE = process.env.GOOGLE_CHAT_SPACE_NAME || "";
import { startNudgeChecker } from "./delivery.ts";
import { initClassifier, warmTreeRoutingRules } from "./intent-classifier.ts";
import { initEntailmentClassifier } from "./entailment-classifier.ts";
import { startSkillWatcher, getSkillSnapshot } from "./skills/index.ts";
import { syncAllCalendars } from "./calendar-sync.ts";
import { initOutlook, getOutlookEmail } from "./outlook.ts";
import { startExpiryCleanup } from "./approval.ts";
import { notify } from "./notification-policy.ts";
import { expireIdleConversations } from "./conversations.ts";
import { expireStaleItems } from "./api/agent-queue.ts";
import { startPlaneQueueWorker, purgeCompleted as purgePlaneQueue } from "./plane-queue.ts";
import { startWatchdog, recoverActiveRuns, setWatchdogNotify } from "./orchestration-tracker.ts";
import { reconcileOnStartup, startReconciler } from "./orchestration-reconciler.ts";
import { restoreModeState } from "./context-mode.ts";
import { cleanupOrphanedJobs, registerJobVines } from "./jobs-ledger.ts";
import { onBridgeWrite } from "./api/bridge.ts";
import { setBroadcastToEllieChat } from "./tool-approval.ts";
import { getSummaryState } from "./ums/consumers/summary.ts";
import { runHealthCheck } from "./channel-health.ts";
import { periodicTask, _startedAt, STARTUP_GRACE_MS } from "./periodic-task.ts";

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

// ── periodicTask imported from ./periodic-task.ts (ELLIE-465) ─

// Start approval expiry cleanup
startExpiryCleanup();

// Periodic idle conversation expiry (every 5 minutes)
// ELLIE-232: Now uses expireIdleConversations() which has atomic claim protection
// to prevent duplicate memory extraction from racing close paths.
setInterval(async () => {
  if (Date.now() - _startedAt < STARTUP_GRACE_MS) return; // startup gate
  if (supabase) {
    try {
      await expireIdleConversations(supabase);
    } catch (err: unknown) {
      logger.error("Stale conversation cleanup error", { error: err instanceof Error ? err.message : String(err) });
    }
    expireStaleAgentSessions(supabase).catch(() => {});
  }
  // ELLIE-408: Probe Anthropic recovery while in fallback mode
  if (isFallbackActive() && shouldProbeRecovery() && anthropic) {
    markRecoveryProbeAttempted();
    anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "ok" }],
    }).then(() => {
      recordAnthropicSuccess();
      broadcastToEllieChatClients({
        type: "response",
        text: "✓ Claude is back — resuming normal operation.",
        agent: "system",
        ts: Date.now(),
      });
      notify(getNotifyCtx(), {
        event: "incident_resolved",
        telegramMessage: "✓ Claude recovered — Ellie back to normal",
      });
    }).catch(() => {}); // still down, stay in fallback
  }
  // Expire Ellie Chat pending confirm actions (15-min TTL)
  const now = Date.now();
  for (const [id, action] of ellieChatPendingActions) {
    if (now - action.createdAt > 15 * 60_000) {
      ellieChatPendingActions.delete(id);
      console.log(`[ellie-chat approval] Expired: ${action.description.substring(0, 60)}`);
    }
  }
  // ELLIE-459/465: Channel health check
  runHealthCheck({ getMe: () => bot.api.getMe() }).catch(() => {});
}, 5 * 60_000);

// Calendar sync (every 5 minutes)
periodicTask(() => syncAllCalendars(), 5 * 60_000, "calendar-sync");

// Stale queue item expiry — every hour (ELLIE-201)
periodicTask(() => expireStaleItems(), 60 * 60_000, "stale-expiry");
// Run once on startup (10s delay)
setTimeout(() => {
  expireStaleItems().catch(err => logger.error("Initial stale expiry error", err));
}, 10_000);

// Plane sync queue — persistent retry for failed Plane API calls (ELLIE-234)
startPlaneQueueWorker();
// Purge completed queue items weekly
periodicTask(() => purgePlaneQueue(), 24 * 60 * 60_000, "plane-queue-purge");

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
import("./prompt-builder.ts").then(({ validateArchetypes }) => validateArchetypes()).catch(() => {});

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

// ELLIE-447: Creature reaper — mark timed-out creatures as failed (every 5 minutes)
periodicTask(async () => {
  const { reapTimedOutCreatures } = await import('../../ellie-forest/src/work-sessions');
  const reaped = await reapTimedOutCreatures();
  if (reaped.length > 0) console.log(`[creature-reaper] Reaped ${reaped.length} timed-out creature(s)`);
}, 5 * 60_000, "creature-reaper");

// Memory maintenance: expire short-term memories (every 15 minutes)
periodicTask(async () => {
  const { expireShortTermMemories } = await import('../../ellie-forest/src/shared-memory');
  const expired = await expireShortTermMemories();
  if (expired > 0) console.log(`[memory-maintenance] Expired ${expired} short-term memories`);
}, 15 * 60_000, "memory-expiry");

// Memory maintenance: refresh weights (every hour)
periodicTask(async () => {
  const { refreshWeights } = await import('../../ellie-forest/src/shared-memory');
  const refreshed = await refreshWeights({ limit: 500 });
  if (refreshed > 0) console.log(`[memory-maintenance] Refreshed weights for ${refreshed} memories`);
}, 60 * 60_000, "weight-refresh");

// Summary Bar push — broadcast module summary state to Ellie Chat clients (ELLIE-315)
// Runs every 30 seconds when clients are connected; skips if no listeners.
periodicTask(async () => {
  if (!supabase) return;
  const summary = await getSummaryState(supabase);
  broadcastToEllieChatClients({ type: "summary_update", summary, ts: Date.now() });
}, 30_000, "summary-push");

// Comms consumer — DB-backed thread tracking (ELLIE-318)
if (supabase) {
  (async () => {
    try {
      const { initCommsConsumer } = await import("./ums/consumers/comms.ts");
      initCommsConsumer(supabase);
      console.log("[comms] Comms consumer initialized with DB-backed threads");
    } catch (err) {
      logger.error("Comms consumer init failed", err);
    }
  })();
}

// Calendar Intel consumer — DB-backed event intel, conflict detection, prep tracking (ELLIE-319)
if (supabase) {
  (async () => {
    try {
      const { initCalendarIntelConsumer } = await import("./ums/consumers/calendar-intel.ts");
      initCalendarIntelConsumer(supabase);
      console.log("[calendar-intel] Calendar Intel consumer initialized with DB-backed intel");
    } catch (err) {
      logger.error("Calendar Intel consumer init failed", err);
    }
  })();
}

// Relationship consumer — DB-backed contact profiles, health scoring, follow-up detection (ELLIE-320)
if (supabase) {
  (async () => {
    try {
      const { initRelationshipConsumer } = await import("./ums/consumers/relationship.ts");
      initRelationshipConsumer(supabase);
      console.log("[relationship] Relationship consumer initialized with DB-backed profiles");
    } catch (err) {
      logger.error("Relationship consumer init failed", err);
    }
  })();
}

// Alert consumer — DB-backed rules, severity routing, dedup (ELLIE-317)
if (supabase) {
  (async () => {
    try {
      const { initAlertConsumer } = await import("./ums/consumers/alert.ts");
      initAlertConsumer(supabase, async (text: string, priority: string) => {
        const channels: string[] = [];
        // Critical + High: Telegram + Google Chat; Normal: Google Chat only
        if (priority === "critical" || priority === "high") {
          try {
            await bot.api.sendMessage(ALLOWED_USER_ID, text);
            channels.push("telegram");
          } catch (err) { logger.warn("Alert telegram send failed", err); }
        }
        if (GOOGLE_CHAT_SPACE && isGoogleChatEnabled()) {
          try {
            await sendGoogleChatMessage(GOOGLE_CHAT_SPACE, text);
            channels.push("google-chat");
          } catch (err) { logger.warn("Alert gchat send failed", err); }
        }
        return channels;
      });
      console.log("[alert] Alert consumer initialized with DB-backed rules");
    } catch (err) {
      logger.error("Alert consumer init failed", err);
    }
  })();
}

// Morning briefing — check every 15 minutes, deliver once at ~7:00 AM CST (ELLIE-316)
periodicTask(async () => {
  if (!supabase) return;
  const cst = new Date(new Date().toLocaleString("en-US", { timeZone: USER_TIMEZONE }));
  if (cst.getHours() === 7 && cst.getMinutes() < 15) {
    const { runMorningBriefing } = await import("./api/briefing.ts");
    await runMorningBriefing(supabase, bot);
  }
}, 15 * 60_000, "morning-briefing");

// Data integrity audit — weekly, Sunday 11 PM CST (ELLIE-406)
periodicTask(async () => {
  if (!supabase) return;
  const cst = new Date(new Date().toLocaleString("en-US", { timeZone: USER_TIMEZONE }));
  if (cst.getDay() === 0 && cst.getHours() === 23 && cst.getMinutes() < 15) {
    const { runDataIntegrityAudit } = await import("./api/data-integrity-audit.ts");
    const result = await runDataIntegrityAudit(supabase, { lookbackDays: 7 });
    if (!result.clean) {
      notify(getNotifyCtx(), { event: "incident_raised", text: `⚠️ Weekly data integrity audit found issues:\n${result.summary}`, workItemId: "data-integrity" });
    } else {
      logger.info("[audit] Weekly audit passed — all clear.");
    }
  }
}, 15 * 60_000, "data-integrity-audit");

// Channel Gardener — nightly at 3 AM CST (ELLIE-335)
periodicTask(async () => {
  if (!supabase) return;
  const cst = new Date(new Date().toLocaleString("en-US", { timeZone: USER_TIMEZONE }));
  if (cst.getHours() === 3 && cst.getMinutes() < 15) {
    const { runNightlyGardener } = await import("./api/channel-gardener.ts");
    const { anthropic } = getRelayDeps();
    const result = await runNightlyGardener(supabase, anthropic ?? null);
    logger.info("[gardener] Nightly run complete", result);
  }
}, 15 * 60_000, "channel-gardener");

// Job Intelligence — nightly at 3:30 AM CST (ELLIE-456)
periodicTask(async () => {
  const cst = new Date(new Date().toLocaleString("en-US", { timeZone: USER_TIMEZONE }));
  if (cst.getHours() === 3 && cst.getMinutes() >= 30 && cst.getMinutes() < 45) {
    const { runNightlyJobIntelligence } = await import("./api/job-intelligence.ts");
    const result = await runNightlyJobIntelligence();
    logger.info("[job-intel] Nightly run complete", result);
  }
}, 15 * 60_000, "job-intelligence");

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
// ELLIE-387: Wire watchdog notifications (after setRelayDeps so getNotifyCtx works)
setWatchdogNotify(notify, getNotifyCtx());
setAnthropicClient(anthropic);
setQueueBroadcast(broadcastExtension);
setSenderDeps({ supabase, getActiveAgent });
initDelivery(supabase);
setVoicePipelineDeps({ supabase, getActiveAgent, broadcastExtension, getContextDocket, triggerConsolidation });
setBroadcastToEllieChat(broadcastToEllieChatClients);

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

  // 2. Wait for active queue tasks to finish (ELLIE-460: graceful drain)
  const drained = await drainQueues(20_000); // 20s max wait
  if (drained) {
    console.log("[relay] Queues drained cleanly");
  } else {
    console.log("[relay] Queue drain timed out — proceeding anyway");
  }

  // 3. Close HTTP server + file watchers
  httpServer.close();
  const { stopPersonalityWatchers } = await import("./prompt-builder.ts");
  stopPersonalityWatchers();
  console.log("[relay] HTTP server closed, personality watchers stopped");

  // 4. Release lock file
  const { releaseLock } = await import("./claude-cli.ts");
  await releaseLock();

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
  logger.error("[UNHANDLED REJECTION] Non-fatal — logged and continuing", {
    reason: msg,
    stack,
    memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
  // Do NOT exit — unhandled rejections are common from fire-and-forget patterns.
  // Only uncaughtException (sync throws) warrants a hard exit.
});
