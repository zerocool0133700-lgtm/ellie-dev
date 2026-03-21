/**
 * Periodic task definitions — ELLIE-492
 *
 * All background periodic tasks in one place. Each task is registered
 * with the unified task runner (periodic-task.ts) which handles backoff,
 * jitter, re-entrancy, recovery, and graceful shutdown.
 *
 * relay.ts calls initPeriodicTasks() once after dependency wiring.
 */

import type { Bot } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import { log } from "./logger.ts";
import { periodicTask, _startedAt, STARTUP_GRACE_MS } from "./periodic-task.ts";

const logger = log.child("tasks");

export interface PeriodicTaskDeps {
  supabase: SupabaseClient | null;
  bot: Bot;
  anthropic: Anthropic | null;
  /** Bot restart state — relay owns the mutable flags, tasks just call through */
  botRestart: {
    isRestarting: () => boolean;
    setRestarting: (v: boolean) => void;
    lastRestartAt: () => number;
    setLastRestartAt: (t: number) => void;
  };
}

export function initPeriodicTasks(deps: PeriodicTaskDeps): void {
  const { supabase, bot, anthropic, botRestart } = deps;

  // ── 5-minute cycle: conversation expiry + recovery probe + action cleanup + health ──

  periodicTask(async () => {
    if (supabase) {
      const { expireIdleConversations } = await import("./conversations.ts");
      await expireIdleConversations(supabase);

      const { expireStaleAgentSessions } = await import("./periodic-tasks-helpers.ts");
      await expireStaleAgentSessions(supabase);
    }
  }, 5 * 60_000, "conversation-expiry");

  // ELLIE-491: Full-stack recovery probe — checks all critical deps, not just Anthropic
  periodicTask(async () => {
    if (!anthropic) return;
    const { isFallbackActive, shouldProbeRecovery, markRecoveryProbeAttempted, recordAnthropicSuccess } = await import("./llm-provider.ts");
    if (!isFallbackActive() || !shouldProbeRecovery()) return;
    markRecoveryProbeAttempted();

    const { checkSupabase, checkForest, checkElasticsearch } = await import("./channel-health.ts");

    // Probe all deps in parallel
    const [anthropicResult, supabaseResult, forestResult, esResult] = await Promise.allSettled([
      anthropic.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
      checkSupabase(),
      checkForest(),
      checkElasticsearch(),
    ]);

    const anthropicOk = anthropicResult.status === "fulfilled";
    const supabaseOk = supabaseResult.status === "fulfilled" && supabaseResult.value.status !== "down";
    const forestOk = forestResult.status === "fulfilled" && forestResult.value.status !== "down";
    // ES is optional — "unknown" (not configured) counts as ok
    const esStatus = esResult.status === "fulfilled" ? esResult.value.status : "down";
    const esOk = esStatus !== "down";

    if (!anthropicOk) return; // still down, stay in fallback

    if (!supabaseOk || !forestOk) {
      // Anthropic recovered but critical deps still unhealthy — log, stay in fallback
      const failures = ([!supabaseOk && "supabase", !forestOk && "forest"] as (string | false)[]).filter(Boolean);
      logger.warn("Anthropic up but critical deps still down — staying in fallback", { failures });
      return;
    }

    // All critical deps healthy — declare recovery
    recordAnthropicSuccess();
    const esDegraded = !esOk ? " (ES search degraded)" : "";
    const { broadcastToEllieChatClients, getNotifyCtx } = await import("./relay-state.ts");
    broadcastToEllieChatClients({
      type: "response",
      text: `\u2713 Claude is back \u2014 resuming normal operation.${esDegraded}`,
      agent: "system",
      ts: Date.now(),
    });
    const { notify } = await import("./notification-policy.ts");
    notify(getNotifyCtx(), {
      event: "incident_resolved",
      telegramMessage: `\u2713 Claude recovered \u2014 Ellie back to normal${esDegraded}`,
    });
    if (!esOk) logger.warn("Recovered with ES degraded");
  }, 5 * 60_000, "recovery-probe");

  periodicTask(async () => {
    const { ellieChatPendingActions } = await import("./message-sender.ts");
    const now = Date.now();
    for (const [id, action] of ellieChatPendingActions) {
      if (now - action.createdAt > 15 * 60_000) {
        ellieChatPendingActions.delete(id);
        logger.info(`Expired: ${action.description.substring(0, 60)}`);
      }
    }
  }, 5 * 60_000, "action-expiry");

  // ELLIE-459/465/462: Channel health check + active Telegram restart
  const BOT_RESTART_COOLDOWN_MS = 5 * 60_000;
  periodicTask(async () => {
    const { runHealthCheck } = await import("./channel-health.ts");
    await runHealthCheck({
      getMe: () => bot.api.getMe(),
      onTelegramDown: (count) => {
        const cooldownOk = Date.now() - botRestart.lastRestartAt() > BOT_RESTART_COOLDOWN_MS;
        if (count >= 2 && !botRestart.isRestarting() && cooldownOk) {
          botRestart.setRestarting(true);
          botRestart.setLastRestartAt(Date.now());
          logger.warn("Telegram down 2+ checks — restarting bot", { count });
          bot.stop()
            .then(() => bot.start())
            .then(() => {
              logger.info("Bot restarted successfully");
              botRestart.setRestarting(false);
            })
            .catch(err => {
              logger.error("Bot restart failed", { error: err instanceof Error ? err.message : String(err) });
              botRestart.setRestarting(false);
            });
        } else if (count === 0) {
          botRestart.setRestarting(false);
        }
      },
    });
  }, 5 * 60_000, "channel-health");

  // Calendar sync (every 5 minutes)
  periodicTask(async () => {
    const { syncAllCalendars } = await import("./calendar-sync.ts");
    await syncAllCalendars();
  }, 5 * 60_000, "calendar-sync");

  // Stale queue item expiry — every hour (ELLIE-201)
  periodicTask(async () => {
    const { expireStaleItems } = await import("./api/agent-queue.ts");
    await expireStaleItems();
  }, 60 * 60_000, "stale-expiry");

  // Plane sync queue purge — weekly (ELLIE-234)
  periodicTask(async () => {
    const { purgeCompleted } = await import("./plane-queue.ts");
    await purgeCompleted();
  }, 24 * 60 * 60_000, "plane-queue-purge");

  // Phone history TTL sweep — hourly (ELLIE-489)
  // Removes ellieChatPhoneHistories entries unused for >24h to prevent memory leak.
  periodicTask(async () => {
    const { sweepPhoneHistories } = await import("./relay-state.ts");
    sweepPhoneHistories();
  }, 60 * 60_000, "phone-history-sweep");

  // ELLIE-942: Spawn timeout check — mark timed-out sub-agent spawns (every 30 seconds)
  periodicTask(async () => {
    const { checkTimeouts, getSpawnRecord, buildAnnouncement } = await import("./session-spawn.ts");
    const timedOut = checkTimeouts();
    if (timedOut.length > 0) {
      logger.info(`Spawn timeout: ${timedOut.length} sub-agent(s) timed out`);
      const { notify } = await import("./notification-policy.ts");
      const { getNotifyCtx } = await import("./relay-state.ts");
      for (const spawnId of timedOut) {
        const record = getSpawnRecord(spawnId);
        if (record) {
          notify(getNotifyCtx(), {
            event: "run_failed",
            workItemId: record.workItemId || "",
            telegramMessage: `Sub-agent ${record.targetAgentName} timed out after ${record.timeoutSeconds}s`,
          }).catch(() => {});
        }
      }
    }
  }, 30_000, "spawn-timeout-check");

  // ELLIE-447/499/500: Creature reaper — mark timed-out, exhausted-retry, and preempted creatures as failed (every 5 minutes)
  periodicTask(async () => {
    const { reapTimedOutCreatures, reapExhaustedRetryCreatures } = await import("../../ellie-forest/src/work-sessions");
    const { reapPreemptedCreatures, cleanupReapedCreatures } = await import("./creature-preemption.ts");

    const [reaped, exhausted, preempted] = await Promise.all([
      reapTimedOutCreatures(),
      reapExhaustedRetryCreatures(),
      reapPreemptedCreatures(supabase),
    ]);

    if (reaped.length > 0) logger.info(`Reaped ${reaped.length} timed-out creature(s)`);
    if (exhausted.length > 0) logger.info(`Reaped ${exhausted.length} exhausted-retry creature(s)`);
    if (preempted.length > 0) logger.info(`Preempted ${preempted.length} orphaned creature(s)`);

    // ELLIE-499: Post-reap cleanup — mark work sessions incomplete, roll back Plane tickets
    const allReaped = [
      ...reaped.map((r: { creature_id: string }) => ({ ...r, tree_id: "" })),
      ...exhausted.map((r: { creature_id: string }) => ({ ...r, tree_id: "" })),
      ...preempted.map((r) => ({ creature_id: r.creature_id, tree_id: r.tree_id, action: r.action })),
    ];

    // For timeout/exhausted reaped creatures, we need to look up their tree_ids
    if (reaped.length > 0 || exhausted.length > 0) {
      const forestSql = (await import("../../ellie-forest/src/db")).default;
      const ids = [
        ...reaped.map((r: { creature_id: string }) => r.creature_id),
        ...exhausted.map((r: { creature_id: string }) => r.creature_id),
      ];
      if (ids.length > 0) {
        const rows = await forestSql<{ id: string; tree_id: string }[]>`
          SELECT id, tree_id FROM creatures WHERE id = ANY(${ids})
        `;
        const treeMap = new Map(rows.map((r) => [r.id, r.tree_id]));
        for (const item of allReaped) {
          if (!item.tree_id) {
            item.tree_id = treeMap.get(item.creature_id) || "";
          }
        }
      }
    }

    const validReaped = allReaped.filter((r) => r.tree_id);
    if (validReaped.length > 0) {
      const cleanup = await cleanupReapedCreatures(validReaped);
      if (cleanup.sessionsCleanedUp > 0) {
        logger.info(`Cleaned up ${cleanup.sessionsCleanedUp} work session(s)`);
      }
      if (cleanup.planeRolledBack > 0) {
        logger.info(`Rolled back ${cleanup.planeRolledBack} Plane ticket(s)`);
      }
    }
  }, 5 * 60_000, "creature-reaper");

  // Memory maintenance: expire short-term memories (every 15 minutes)
  periodicTask(async () => {
    const { expireShortTermMemories } = await import("../../ellie-forest/src/shared-memory");
    const expired = await expireShortTermMemories();
    if (expired > 0) logger.info(`Expired ${expired} short-term memories`);
  }, 15 * 60_000, "memory-expiry");

  // Memory maintenance: refresh weights (every hour)
  periodicTask(async () => {
    const { refreshWeights } = await import("../../ellie-forest/src/shared-memory");
    const refreshed = await refreshWeights({ limit: 500 });
    if (refreshed > 0) logger.info(`Refreshed weights for ${refreshed} memories`);
  }, 60 * 60_000, "weight-refresh");

  // Working memory idle archive — archive sessions idle >24h (every 2 hours — ELLIE-540)
  periodicTask(async () => {
    const { archiveIdleWorkingMemory } = await import("./working-memory.ts");
    const archived = await archiveIdleWorkingMemory();
    if (archived > 0) logger.info(`Archived ${archived} idle session(s)`);
  }, 2 * 60 * 60_000, "working-memory-archive");

  // ELLIE-933: Auto-promote qualifying memories to Core tier (every 6 hours)
  periodicTask(async () => {
    const { autoPromoteToCore } = await import("../../ellie-forest/src/shared-memory.ts");
    const promoted = await autoPromoteToCore();
    if (promoted > 0) logger.info(`Promoted ${promoted} memory(s) to Core tier`);
  }, 6 * 60 * 60_000, "memory-tier-promotion");

  // ELLIE-936: Memory graduation — promote Supabase facts to Forest (daily)
  periodicTask(async () => {
    if (!supabase) return;
    const { graduateMemories } = await import("./periodic-tasks-helpers.ts");
    const graduated = await graduateMemories(supabase);
    if (graduated > 0) logger.info(`Graduated ${graduated} Supabase fact(s) to Forest`);
  }, 24 * 60 * 60_000, "memory-graduation");

  // ELLIE-934: Memory arc auto-detection — chains + clusters (every 12 hours)
  periodicTask(async () => {
    const { detectArcsFromChains, detectArcsFromClusters } = await import("../../ellie-forest/src/arcs.ts");
    const chains = await detectArcsFromChains();
    const clusters = await detectArcsFromClusters();
    if (chains > 0 || clusters > 0) {
      logger.info(`Memory arcs: ${chains} from chains, ${clusters} from clusters`);
    }
  }, 12 * 60 * 60_000, "memory-arc-detection");

  // ELLIE-937: Backfill memory categories + cognitive types (daily, runs until caught up)
  periodicTask(async () => {
    const { backfillClassifications } = await import("../../ellie-forest/src/shared-memory.ts");
    const result = await backfillClassifications();
    if (result.categories > 0 || result.cognitiveTypes > 0) {
      logger.info(`Backfill: reclassified ${result.categories} categories, ${result.cognitiveTypes} cognitive types`);
    }
  }, 24 * 60 * 60_000, "memory-classification-backfill");

  // ELLIE-457: Oak Catalog — daily QMD scan → R/1 manifest (every 24 hours)
  periodicTask(async () => {
    const { syncOakCatalog } = await import("./api/bridge-river.ts");
    await syncOakCatalog();
  }, 24 * 60 * 60_000, "oak-catalog-sync");

  // Summary Bar push — broadcast module summary state to Ellie Chat clients (ELLIE-315)
  periodicTask(async () => {
    if (!supabase) return;
    const { getSummaryState } = await import("./ums/consumers/summary.ts");
    const { broadcastToEllieChatClients } = await import("./relay-state.ts");
    const summary = await getSummaryState(supabase);
    broadcastToEllieChatClients({ type: "summary_update", summary, ts: Date.now() });
  }, 30_000, "summary-push");

  // Morning briefing — check every 15 minutes, deliver once at ~7:00 AM CST (ELLIE-316)
  periodicTask(async () => {
    if (!supabase) return;
    const { USER_TIMEZONE } = await import("./timezone.ts");
    const cst = new Date(new Date().toLocaleString("en-US", { timeZone: USER_TIMEZONE }));
    if (cst.getHours() === 7 && cst.getMinutes() < 15) {
      const { runMorningBriefing } = await import("./api/briefing.ts");
      await runMorningBriefing(supabase, bot);
    }
  }, 15 * 60_000, "morning-briefing");

  // Data integrity audit — weekly, Sunday 11 PM CST (ELLIE-406)
  periodicTask(async () => {
    if (!supabase) return;
    const { USER_TIMEZONE } = await import("./timezone.ts");
    const cst = new Date(new Date().toLocaleString("en-US", { timeZone: USER_TIMEZONE }));
    if (cst.getDay() === 0 && cst.getHours() === 23 && cst.getMinutes() < 15) {
      const { runDataIntegrityAudit } = await import("./api/data-integrity-audit.ts");
      const result = await runDataIntegrityAudit(supabase, { lookbackDays: 7 });
      if (!result.clean) {
        const { notify } = await import("./notification-policy.ts");
        const { getNotifyCtx } = await import("./relay-state.ts");
        notify(getNotifyCtx(), { event: "incident_raised", text: `\u26a0\ufe0f Weekly data integrity audit found issues:\n${result.summary}`, workItemId: "data-integrity" });
      } else {
        logger.info("Weekly audit passed — all clear.");
      }
    }
  }, 15 * 60_000, "data-integrity-audit");

  // Channel Gardener — nightly at 3 AM CST (ELLIE-335)
  periodicTask(async () => {
    if (!supabase) return;
    const { USER_TIMEZONE } = await import("./timezone.ts");
    const cst = new Date(new Date().toLocaleString("en-US", { timeZone: USER_TIMEZONE }));
    if (cst.getHours() === 3 && cst.getMinutes() < 15) {
      const { runNightlyGardener } = await import("./api/channel-gardener.ts");
      const { getRelayDeps } = await import("./relay-state.ts");
      const { anthropic: a } = getRelayDeps();
      const result = await runNightlyGardener(supabase, a ?? null);
      logger.info("Nightly run complete", result);
    }
  }, 15 * 60_000, "channel-gardener");

  // Work Item Gardener — nightly at 3:15 AM CST (ELLIE-407)
  periodicTask(async () => {
    const { USER_TIMEZONE } = await import("./timezone.ts");
    const cst = new Date(new Date().toLocaleString("en-US", { timeZone: USER_TIMEZONE }));
    if (cst.getHours() === 3 && cst.getMinutes() >= 15 && cst.getMinutes() < 30) {
      const { runWorkItemGardener } = await import("./api/work-item-gardener.ts");
      const result = await runWorkItemGardener();
      logger.info("Work item gardener complete", result);
    }
  }, 15 * 60_000, "work-item-gardener");

  // Job Intelligence — nightly at 3:30 AM CST (ELLIE-456)
  periodicTask(async () => {
    const { USER_TIMEZONE } = await import("./timezone.ts");
    const cst = new Date(new Date().toLocaleString("en-US", { timeZone: USER_TIMEZONE }));
    if (cst.getHours() === 3 && cst.getMinutes() >= 30 && cst.getMinutes() < 45) {
      const { runNightlyJobIntelligence } = await import("./api/job-intelligence.ts");
      const result = await runNightlyJobIntelligence();
      logger.info("Nightly run complete", result);
    }
  }, 15 * 60_000, "job-intelligence");

  // ELLIE-338: Cognitive load monitor — refresh detection every 5 minutes
  periodicTask(async () => {
    if (supabase) {
      const { runCognitiveLoadDetection } = await import("./api/cognitive-load.ts");
      await runCognitiveLoadDetection(supabase);
    }
  }, 5 * 60_000, "cognitive-load-monitor");

  // ELLIE-543: Check-in monitor — proactive notifications for long-running agent sessions (every 5 minutes)
  periodicTask(async () => {
    const { getActiveRunStates } = await import("./orchestration-tracker.ts");
    const { runCheckInMonitor } = await import("./check-in-monitor.ts");
    const { notify } = await import("./notification-policy.ts");
    const { getNotifyCtx } = await import("./relay-state.ts");

    const runs = getActiveRunStates();
    if (runs.length === 0) return;

    const ctx = getNotifyCtx();
    const { checkedIn, escalated } = await runCheckInMonitor(
      runs,
      (opts) => notify(ctx, {
        event: opts.event as import("./notification-policy.ts").NotificationEvent,
        workItemId: opts.workItemId,
        telegramMessage: opts.telegramMessage,
        gchatMessage: opts.gchatMessage,
      }),
    );

    if (checkedIn > 0 || escalated > 0) {
      logger.info("Cycle complete", { checkedIn, escalated });
    }
  }, 5 * 60_000, "check-in-monitor");

  // ELLIE-496: ES reconciliation — detect and backfill Supabase/Forest → ES gaps (every 30 minutes)
  periodicTask(async () => {
    const { runReconciliation } = await import("./elasticsearch/reconcile.ts");
    const { notify } = await import("./notification-policy.ts");
    const { getNotifyCtx } = await import("./relay-state.ts");

    // Build Forest SQL connection (same pattern as sync-listener)
    let forestSql = null;
    try {
      const postgres = (await import("postgres")).default;
      const pgConfig = process.env.DATABASE_URL
        ? process.env.DATABASE_URL
        : {
            host: process.env.DB_HOST || "/var/run/postgresql",
            database: process.env.DB_NAME || "ellie-forest",
            username: process.env.DB_USER || "ellie",
            password: process.env.DB_PASS,
            port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
          };
      forestSql = postgres(pgConfig as string, { max: 1, idle_timeout: 30, connect_timeout: 10 });
    } catch {
      logger.warn("Could not connect to Forest DB — skipping forest indices");
    }

    try {
      await runReconciliation({
        supabase: supabase as import("./elasticsearch/reconcile.ts").SupabaseClientLike | null,
        forestSql,
        onAlert: (message) => {
          notify(getNotifyCtx(), {
            event: "incident_raised",
            workItemId: "es-reconciliation",
            telegramMessage: `⚠️ ${message}`,
          });
        },
      });
    } finally {
      if (forestSql) {
        try { await forestSql.end({ timeout: 5 }); } catch { /* ignore */ }
      }
    }
  }, 30 * 60_000, "es-reconciliation");

  logger.info("All background tasks registered");
}

/**
 * Run one-time startup tasks — things that fire once after a delay.
 * Separated from periodic tasks so relay.ts stays clean.
 */
export function runStartupTasks(deps: PeriodicTaskDeps): void {
  const { supabase } = deps;

  // Initial calendar sync (10s delay)
  setTimeout(async () => {
    try {
      const { syncAllCalendars } = await import("./calendar-sync.ts");
      await syncAllCalendars();
      logger.info("Initial sync complete");
    } catch (err: unknown) {
      logger.error("Initial sync error", { error: err instanceof Error ? err.message : String(err) });
    }
  }, 10_000);

  // Initial stale queue expiry (10s delay)
  setTimeout(async () => {
    try {
      const { expireStaleItems } = await import("./api/agent-queue.ts");
      await expireStaleItems();
    } catch (err) {
      logger.error("Initial stale expiry error", err);
    }
  }, 10_000);

  // UMS consumers — only if supabase is available
  if (supabase) {
    initUmsConsumers(supabase, deps.bot);
  }
}

async function initUmsConsumers(supabase: SupabaseClient, bot: Bot): Promise<void> {
  // Comms consumer (ELLIE-318)
  try {
    const { initCommsConsumer } = await import("./ums/consumers/comms.ts");
    initCommsConsumer(supabase);
    logger.info("Comms consumer initialized with DB-backed threads");
  } catch (err) {
    logger.error("Comms consumer init failed", err);
  }

  // Calendar Intel consumer (ELLIE-319)
  try {
    const { initCalendarIntelConsumer } = await import("./ums/consumers/calendar-intel.ts");
    initCalendarIntelConsumer(supabase);
    logger.info("Calendar Intel consumer initialized with DB-backed intel");
  } catch (err) {
    logger.error("Calendar Intel consumer init failed", err);
  }

  // Relationship consumer (ELLIE-320)
  try {
    const { initRelationshipConsumer } = await import("./ums/consumers/relationship.ts");
    initRelationshipConsumer(supabase);
    logger.info("Relationship consumer initialized with DB-backed profiles");
  } catch (err) {
    logger.error("Relationship consumer init failed", err);
  }

  // Alert consumer (ELLIE-317)
  try {
    const { initAlertConsumer } = await import("./ums/consumers/alert.ts");
    const { ALLOWED_USER_ID } = await import("./relay-config.ts");
    const { isGoogleChatEnabled, sendGoogleChatMessage } = await import("./google-chat.ts");
    const GOOGLE_CHAT_SPACE = process.env.GOOGLE_CHAT_SPACE_NAME || "";

    initAlertConsumer(supabase, async (text: string, priority: string) => {
      const channels: string[] = [];
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
    logger.info("Alert consumer initialized with DB-backed rules");
  } catch (err) {
    logger.error("Alert consumer init failed", err);
  }
}
