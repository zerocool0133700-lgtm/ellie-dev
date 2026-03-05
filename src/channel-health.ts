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
import { RELAY_BASE_URL } from "./relay-config.ts";

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

// ELLIE-462: Consecutive failure tracking for active restart decisions
let _telegramConsecutiveDown = 0;

export function getChannelHealth(): ChannelHealth {
  return { ..._health };
}

export function getTelegramConsecutiveDown(): number {
  return _telegramConsecutiveDown;
}

// ── Individual checks ─────────────────────────────────────────

// ELLIE-465: Use Supabase REST root endpoint instead of querying a business table
// ELLIE-491: Exported so recovery probe can reuse without duplicating logic
export async function checkSupabase(): Promise<ChannelHealthResult> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    return { status: "unknown", checkedAt: Date.now(), error: "SUPABASE_URL or SUPABASE_ANON_KEY not configured" };
  }
  const start = Date.now();
  try {
    const resp = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: key },
      signal: AbortSignal.timeout(3000),
    });
    const latencyMs = Date.now() - start;
    if (!resp.ok && resp.status !== 404) {
      // 404 = endpoint exists but no specific resource — still means the API is up
      return { status: "degraded", latencyMs, checkedAt: Date.now(), error: `HTTP ${resp.status}` };
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

const BRIDGE_URL = `${RELAY_BASE_URL}/api/bridge/read`;
// ELLIE-465: Key from env — hardcoded value is a fallback for backward compat only
const BRIDGE_KEY = process.env.BRIDGE_KEY ?? "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";

// ELLIE-491: Exported so recovery probe can reuse
export async function checkForest(): Promise<ChannelHealthResult> {
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

// ELLIE-491: ES is optional — returns "unknown" when not configured
export async function checkElasticsearch(): Promise<ChannelHealthResult> {
  const url = process.env.ELASTICSEARCH_URL;
  if (!url || process.env.ELASTICSEARCH_ENABLED === "false") {
    return { status: "unknown", checkedAt: Date.now(), error: "not configured" };
  }
  const start = Date.now();
  try {
    const resp = await fetch(`${url}/_cluster/health`, {
      signal: AbortSignal.timeout(3000),
    });
    const latencyMs = Date.now() - start;
    if (!resp.ok) return { status: "degraded", latencyMs, checkedAt: Date.now(), error: `HTTP ${resp.status}` };
    const data = await resp.json() as { status?: string };
    if (data.status === "red") return { status: "down", latencyMs, checkedAt: Date.now(), error: "cluster status: red" };
    if (data.status === "yellow") return { status: "degraded", latencyMs, checkedAt: Date.now() };
    return { status: "ok", latencyMs, checkedAt: Date.now() };
  } catch (err) {
    return { status: "down", latencyMs: Date.now() - start, checkedAt: Date.now(), error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Monitor ──────────────────────────────────────────────────

interface HealthMonitorDeps {
  getMe: () => Promise<unknown>;
  /**
   * ELLIE-462: Called after each check cycle with the new consecutive-down
   * count for Telegram. relay.ts uses this to trigger an active bot restart.
   * count = 0 means Telegram just recovered.
   */
  onTelegramDown?: (consecutiveDownCount: number) => void;
}

/**
 * Run a single health check cycle. Updates cached state.
 * Called periodically by relay.ts — never throws.
 */
export async function runHealthCheck(deps: HealthMonitorDeps): Promise<void> {
  const [supabaseResult, telegramResult, forestResult] = await Promise.allSettled([
    checkSupabase(),
    checkTelegram(deps.getMe),
    checkForest(),
  ]);

  _health = {
    supabase: supabaseResult.status === "fulfilled" ? supabaseResult.value : { status: "down", checkedAt: Date.now(), error: String((supabaseResult as PromiseRejectedResult).reason) },
    telegram: telegramResult.status === "fulfilled" ? telegramResult.value : { status: "down", checkedAt: Date.now(), error: String((telegramResult as PromiseRejectedResult).reason) },
    forest: forestResult.status === "fulfilled" ? forestResult.value : { status: "down", checkedAt: Date.now(), error: String((forestResult as PromiseRejectedResult).reason) },
  };

  // ELLIE-462: Update consecutive Telegram down counter and fire callback
  if (_health.telegram.status === "down") {
    _telegramConsecutiveDown++;
    deps.onTelegramDown?.(_telegramConsecutiveDown);
  } else {
    if (_telegramConsecutiveDown > 0) {
      logger.info("Telegram recovered", { after_consecutive_down: _telegramConsecutiveDown });
      _telegramConsecutiveDown = 0;
      deps.onTelegramDown?.(0); // signal recovery
    }
  }

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
