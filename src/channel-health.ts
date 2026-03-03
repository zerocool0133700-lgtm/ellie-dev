/**
 * Channel Health Monitor — ELLIE-459
 *
 * Periodic health checks for the three critical external dependencies:
 *   - Supabase (DB)
 *   - Telegram (bot API)
 *   - Forest bridge (localhost:3001)
 *
 * Results are cached and exposed via getChannelHealth() for status endpoints.
 * Failures are logged but never throw — the monitor is advisory only.
 */

import { log } from "./logger.ts";

const logger = log.child("channel-health");

// ── Types ─────────────────────────────────────────────────────

export type HealthStatus = "ok" | "degraded" | "down" | "unknown";

export interface ChannelHealthResult {
  status: HealthStatus;
  latencyMs?: number;
  checkedAt: number;
  error?: string;
}

export interface ChannelHealth {
  supabase: ChannelHealthResult;
  telegram: ChannelHealthResult;
  forest: ChannelHealthResult;
}

// ── State ─────────────────────────────────────────────────────

const UNKNOWN: ChannelHealthResult = { status: "unknown", checkedAt: 0 };

let _health: ChannelHealth = {
  supabase: { ...UNKNOWN },
  telegram: { ...UNKNOWN },
  forest: { ...UNKNOWN },
};

export function getChannelHealth(): ChannelHealth {
  return { ..._health };
}

// ── Individual checks ─────────────────────────────────────────

async function checkSupabase(
  supabase: { from: (table: string) => { select: (col: string) => { limit: (n: number) => Promise<{ error: unknown }> } } },
): Promise<ChannelHealthResult> {
  const start = Date.now();
  try {
    const { error } = await supabase.from("goals").select("id").limit(1);
    const latencyMs = Date.now() - start;
    if (error) {
      return { status: "degraded", latencyMs, checkedAt: Date.now(), error: String(error) };
    }
    return { status: latencyMs > 3000 ? "degraded" : "ok", latencyMs, checkedAt: Date.now() };
  } catch (err) {
    return { status: "down", latencyMs: Date.now() - start, checkedAt: Date.now(), error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkTelegram(
  getMe: () => Promise<unknown>,
): Promise<ChannelHealthResult> {
  const start = Date.now();
  try {
    await getMe();
    const latencyMs = Date.now() - start;
    return { status: latencyMs > 5000 ? "degraded" : "ok", latencyMs, checkedAt: Date.now() };
  } catch (err) {
    return { status: "down", latencyMs: Date.now() - start, checkedAt: Date.now(), error: err instanceof Error ? err.message : String(err) };
  }
}

const BRIDGE_URL = "http://localhost:3001/api/bridge/read";
const BRIDGE_KEY = "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";

async function checkForest(): Promise<ChannelHealthResult> {
  const start = Date.now();
  try {
    const resp = await fetch(BRIDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bridge-key": BRIDGE_KEY },
      body: JSON.stringify({ query: "health", scope_path: "2", limit: 1 }),
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - start;
    if (!resp.ok) {
      return { status: "degraded", latencyMs, checkedAt: Date.now(), error: `HTTP ${resp.status}` };
    }
    return { status: latencyMs > 4000 ? "degraded" : "ok", latencyMs, checkedAt: Date.now() };
  } catch (err) {
    return { status: "down", latencyMs: Date.now() - start, checkedAt: Date.now(), error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Monitor ──────────────────────────────────────────────────

interface HealthMonitorDeps {
  supabase: Parameters<typeof checkSupabase>[0] | null;
  getMe: () => Promise<unknown>;
}

/**
 * Run a single health check cycle. Updates cached state.
 * Called periodically by relay.ts — never throws.
 */
export async function runHealthCheck(deps: HealthMonitorDeps): Promise<void> {
  const [supabaseResult, telegramResult, forestResult] = await Promise.allSettled([
    deps.supabase ? checkSupabase(deps.supabase) : Promise.resolve<ChannelHealthResult>({ status: "unknown", checkedAt: Date.now() }),
    checkTelegram(deps.getMe),
    checkForest(),
  ]);

  _health = {
    supabase: supabaseResult.status === "fulfilled" ? supabaseResult.value : { status: "down", checkedAt: Date.now(), error: String((supabaseResult as PromiseRejectedResult).reason) },
    telegram: telegramResult.status === "fulfilled" ? telegramResult.value : { status: "down", checkedAt: Date.now(), error: String((telegramResult as PromiseRejectedResult).reason) },
    forest: forestResult.status === "fulfilled" ? forestResult.value : { status: "down", checkedAt: Date.now(), error: String((forestResult as PromiseRejectedResult).reason) },
  };

  const degraded = Object.entries(_health)
    .filter(([, v]) => v.status !== "ok" && v.status !== "unknown")
    .map(([k, v]) => `${k}=${v.status}(${v.latencyMs ?? "?"}ms)`);

  if (degraded.length > 0) {
    logger.warn("Channel health degraded", { channels: degraded });
  } else {
    logger.info("Channel health ok", {
      supabase_ms: _health.supabase.latencyMs,
      telegram_ms: _health.telegram.latencyMs,
      forest_ms: _health.forest.latencyMs,
    });
  }
}
