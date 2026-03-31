/**
 * Heartbeat Timer + Tick Orchestration — ELLIE-1164
 *
 * Manages the setInterval, gates on active hours, runs Phase 1 → Phase 2.
 */

import { log } from "../logger.ts";
import { isProcessingMessage } from "../relay-state.ts";
import {
  getHeartbeatState,
  atomicClaimTick,
  saveSnapshot,
  updateCooldown,
  logTick,
  isInActiveHours,
} from "./state.ts";
import { runPreCheck, filterCooledDown } from "./pre-check.ts";
import { buildHeartbeatPrompt } from "./prompt.ts";
import type { HeartbeatState, TickRecord } from "./types.ts";

const logger = log.child("heartbeat-timer");

// ── Module state ────────────────────────────────────────────

let _intervalHandle: ReturnType<typeof setInterval> | null = null;
let _relayStartedAt: number = 0;
let _phase2Running = false;

// ── Pure guard ──────────────────────────────────────────────

export function shouldSkipTick(opts: {
  relayStartedAt: number;
  startupGraceMs: number;
  isProcessingMessage: boolean;
  isPhase2Running: boolean;
  isInActiveHours: boolean;
}): string | null {
  if (Date.now() - opts.relayStartedAt < opts.startupGraceMs) return "startup_grace";
  if (!opts.isInActiveHours) return "outside_active_hours";
  if (opts.isProcessingMessage) return "message_processing";
  if (opts.isPhase2Running) return "phase2_running";
  return null;
}

// ── Tick logic (private) ────────────────────────────────────

async function tick(): Promise<void> {
  const tickStart = Date.now();
  let state: HeartbeatState | null;

  try {
    state = await getHeartbeatState();
  } catch (err) {
    logger.warn("tick: failed to read heartbeat_state", { error: String(err) });
    return;
  }

  if (!state || !state.enabled) return;

  // Resolve foundation name for logging
  let foundationName = "unknown";
  try {
    const { FoundationRegistry, createSupabaseFoundationStore } = await import("../foundation-registry.ts");
    const { getRelayDeps } = await import("../relay-state.ts");
    const { supabase } = getRelayDeps();
    if (supabase) {
      const reg = new FoundationRegistry(createSupabaseFoundationStore(supabase));
      await reg.refresh();
      foundationName = reg.getActive()?.name || "unknown";
    }
  } catch { /* fall back to "unknown" */ }

  // Check skip guards
  const skipReason = shouldSkipTick({
    relayStartedAt: _relayStartedAt,
    startupGraceMs: state.startup_grace_ms,
    isProcessingMessage: isProcessingMessage(),
    isPhase2Running: _phase2Running,
    isInActiveHours: isInActiveHours(state.active_start, state.active_end),
  });

  if (skipReason) {
    logger.debug("tick skipped", { reason: skipReason });
    await logTick({
      phase_reached: 1,
      deltas: [],
      cost_usd: 0,
      duration_ms: Date.now() - tickStart,
      foundation: foundationName,
      skipped_reason: skipReason,
    });
    return;
  }

  // Atomic claim — prevents overlapping ticks
  const beforeTimestamp = new Date(Date.now() - state.interval_ms).toISOString();
  const claimed = await atomicClaimTick(beforeTimestamp);
  if (!claimed) {
    logger.debug("tick: another tick already running");
    return;
  }

  // Phase 1: run pre-check
  const { deltas, newSnapshot } = await runPreCheck(state.sources, state.last_snapshot);
  await saveSnapshot(newSnapshot);

  // Filter through cooldowns
  const triggeringDeltas = filterCooledDown(
    deltas,
    state.source_cooldowns,
    state.min_phase2_interval_ms,
  );

  if (triggeringDeltas.length === 0) {
    logger.info("Phase 1 complete — no triggering deltas", {
      sources: state.sources,
      totalDeltas: deltas.length,
    });
    await logTick({
      phase_reached: 1,
      deltas,
      cost_usd: 0,
      duration_ms: Date.now() - tickStart,
      foundation: foundationName,
    });
    return;
  }

  // Phase 2: build prompt and run coordinator loop
  _phase2Running = true;
  let costUsd = 0;
  let actionsTaken: unknown = null;

  try {
    const { runCoordinatorLoop, buildCoordinatorDeps } = await import("../coordinator.ts");
    const { FoundationRegistry, createSupabaseFoundationStore } = await import("../foundation-registry.ts");
    const { getRelayDeps } = await import("../relay-state.ts");

    const { supabase } = getRelayDeps();
    let registry: InstanceType<typeof FoundationRegistry> | undefined;
    if (supabase) {
      registry = new FoundationRegistry(createSupabaseFoundationStore(supabase));
      await registry.refresh();
    }

    const intervalMinutes = Math.round(state.interval_ms / 60_000);
    const heartbeatPrompt = buildHeartbeatPrompt(triggeringDeltas, intervalMinutes);

    if (!heartbeatPrompt) {
      // buildHeartbeatPrompt returns "" if no changed deltas — shouldn't happen here, but guard
      _phase2Running = false;
      return;
    }

    // Update foundationName from Phase 2 registry (more specific fallback)
    foundationName = registry?.getActive()?.name || foundationName || "software-dev";
    const systemPrompt = registry
      ? await registry.getCoordinatorPrompt()
      : "You are Ellie, a coordinator. Review the heartbeat changes and act as needed.";

    const result = await runCoordinatorLoop({
      message: heartbeatPrompt,
      channel: "heartbeat",
      userId: "system",
      foundation: foundationName,
      systemPrompt: systemPrompt || "You are Ellie, a coordinator. Review the heartbeat changes and act as needed.",
      model: registry?.getBehavior()?.coordinator_model || "claude-sonnet-4-6",
      agentRoster: registry?.getAgentRoster() || [],
      registry,
      deps: buildCoordinatorDeps({
        sessionId: "coordinator:heartbeat",
        channel: "heartbeat",
        sendFn: state.dry_run
          ? async (_ch: string, msg: string) => {
              logger.info("DRY RUN would send", { msg: msg.slice(0, 200) });
            }
          : async (_ch: string, msg: string) => {
              // Deliver to Telegram via the notify context
              try {
                const { getNotifyCtx } = await import("../relay-state.ts");
                const notifyCtx = getNotifyCtx();
                if (notifyCtx?.bot && notifyCtx?.telegramUserId) {
                  await notifyCtx.bot.api.sendMessage(Number(notifyCtx.telegramUserId), msg);
                  return;
                }
              } catch { /* fallback to log */ }
              logger.info("Heartbeat Phase 2 message (no delivery channel)", { msg: msg.slice(0, 200) });
            },
        forestReadFn: async (query) => {
          try {
            const res = await fetch("http://localhost:3001/api/bridge/read", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-bridge-key": process.env.BRIDGE_KEY || "",
              },
              body: JSON.stringify({ query, scope_path: "2" }),
            });
            const data = await res.json() as { memories?: Array<{ content: string }> };
            return data.memories?.map((m) => m.content).join("\n") || "No results.";
          } catch {
            return "Forest read failed.";
          }
        },
        registry,
      }),
    });

    costUsd = result.totalCost ?? 0;
    actionsTaken = result.actions ?? null;

    // Update cooldowns for sources that triggered
    for (const delta of triggeringDeltas) {
      await updateCooldown(delta.source, state.source_cooldowns);
    }

    logger.info("Phase 2 complete", {
      cost_usd: costUsd,
      triggeringSources: triggeringDeltas.map((d) => d.source),
      duration_ms: Date.now() - tickStart,
    });
  } catch (err) {
    logger.error("Phase 2 failed", { error: String(err) });
  } finally {
    _phase2Running = false;
  }

  await logTick({
    phase_reached: 2,
    deltas,
    actions_taken: actionsTaken,
    cost_usd: costUsd,
    duration_ms: Date.now() - tickStart,
    foundation: "unknown",
  });
}

// ── Public API ──────────────────────────────────────────────

export function startHeartbeat(): void {
  if (_intervalHandle) {
    logger.warn("startHeartbeat called but already running — restarting");
    clearInterval(_intervalHandle);
  }

  _relayStartedAt = Date.now();

  // Read interval from state asynchronously, default to 15 min
  getHeartbeatState().then((state) => {
    const intervalMs = state?.interval_ms ?? 15 * 60_000;
    _intervalHandle = setInterval(() => {
      tick().catch((err) => logger.error("Tick unhandled error", { error: String(err) }));
    }, intervalMs);
    logger.info("Heartbeat started", { interval_ms: intervalMs });
  }).catch((err) => {
    logger.warn("Failed to read heartbeat state for interval — using 15 min default", { error: String(err) });
    _intervalHandle = setInterval(() => {
      tick().catch((err) => logger.error("Tick unhandled error", { error: String(err) }));
    }, 15 * 60_000);
  });
}

export function stopHeartbeat(): void {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
    logger.info("Heartbeat stopped");
  }
}

export function _resetForTesting(): void {
  stopHeartbeat();
  _relayStartedAt = 0;
  _phase2Running = false;
}
