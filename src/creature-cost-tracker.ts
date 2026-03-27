/**
 * Per-Creature Cost Tracking — ELLIE-1060
 * Tracks token usage and estimated cost per creature per session.
 * Enforces session budgets and alerts on threshold.
 * Inspired by Context-Gateway internal/costcontrol/
 */

import { log } from "./logger.ts";

const logger = log.child("cost:tracker");

// Model pricing (per million tokens, USD) — as of March 2026
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }> = {
  "claude-opus-4-6":     { input: 15.0,  output: 75.0, cacheRead: 1.5,  cacheWrite: 18.75 },
  "claude-sonnet-4-6":   { input: 3.0,   output: 15.0, cacheRead: 0.3,  cacheWrite: 3.75 },
  "claude-haiku-4-5":    { input: 0.8,   output: 4.0,  cacheRead: 0.08, cacheWrite: 1.0 },
  // Aliases
  "opus":   { input: 15.0,  output: 75.0, cacheRead: 1.5,  cacheWrite: 18.75 },
  "sonnet": { input: 3.0,   output: 15.0, cacheRead: 0.3,  cacheWrite: 3.75 },
  "haiku":  { input: 0.8,   output: 4.0,  cacheRead: 0.08, cacheWrite: 1.0 },
};

const DEFAULT_SESSION_BUDGET_USD = 5.0;  // $5 per session
const DEFAULT_DAILY_BUDGET_USD = 50.0;   // $50 daily across all creatures
const ALERT_THRESHOLD = 0.8;             // Alert at 80% of budget

interface SessionCost {
  creature: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  dispatches: number;
  startedAt: number;
}

interface DailyCost {
  date: string; // YYYY-MM-DD
  totalCostUsd: number;
  byCreature: Record<string, number>;
  dispatches: number;
}

// In-memory tracking
const activeSessions = new Map<string, SessionCost>();
let dailyCost: DailyCost = { date: todayStr(), totalCostUsd: 0, byCreature: {}, dispatches: 0 };

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

function resetDailyIfNeeded(): void {
  const today = todayStr();
  if (dailyCost.date !== today) {
    logger.info("Daily cost reset", { previous: dailyCost });
    dailyCost = { date: today, totalCostUsd: 0, byCreature: {}, dispatches: 0 };
  }
}

/**
 * Calculate cost for a given token usage.
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0
): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING["sonnet"];
  const cost =
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output +
    (cacheReadTokens / 1_000_000) * (pricing.cacheRead || 0) +
    (cacheWriteTokens / 1_000_000) * (pricing.cacheWrite || 0);
  return Math.round(cost * 10000) / 10000; // 4 decimal places
}

/**
 * Record token usage for a creature dispatch.
 */
export function recordUsage(opts: {
  creature: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): { cost: number; sessionTotal: number; dailyTotal: number; alerts: string[] } {
  resetDailyIfNeeded();

  const cost = calculateCost(
    opts.model,
    opts.inputTokens,
    opts.outputTokens,
    opts.cacheReadTokens || 0,
    opts.cacheWriteTokens || 0
  );

  // Update session
  const sessionKey = `${opts.creature}:${todayStr()}`;
  const session = activeSessions.get(sessionKey) || {
    creature: opts.creature,
    model: opts.model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
    dispatches: 0,
    startedAt: Date.now(),
  };
  session.inputTokens += opts.inputTokens;
  session.outputTokens += opts.outputTokens;
  session.cacheReadTokens += opts.cacheReadTokens || 0;
  session.cacheWriteTokens += opts.cacheWriteTokens || 0;
  session.estimatedCostUsd += cost;
  session.dispatches++;
  activeSessions.set(sessionKey, session);

  // Update daily
  dailyCost.totalCostUsd += cost;
  dailyCost.byCreature[opts.creature] = (dailyCost.byCreature[opts.creature] || 0) + cost;
  dailyCost.dispatches++;

  // Check alerts
  const alerts: string[] = [];
  const sessionBudget = parseFloat(process.env.CREATURE_SESSION_BUDGET_USD || String(DEFAULT_SESSION_BUDGET_USD));
  const dailyBudget = parseFloat(process.env.CREATURE_DAILY_BUDGET_USD || String(DEFAULT_DAILY_BUDGET_USD));

  if (session.estimatedCostUsd >= sessionBudget * ALERT_THRESHOLD) {
    alerts.push(`${opts.creature} session at ${Math.round(session.estimatedCostUsd / sessionBudget * 100)}% of $${sessionBudget} budget`);
  }
  if (dailyCost.totalCostUsd >= dailyBudget * ALERT_THRESHOLD) {
    alerts.push(`Daily spend at ${Math.round(dailyCost.totalCostUsd / dailyBudget * 100)}% of $${dailyBudget} budget`);
  }

  if (alerts.length > 0) {
    logger.warn("Cost alert", { creature: opts.creature, alerts, sessionCost: session.estimatedCostUsd, dailyCost: dailyCost.totalCostUsd });
  }

  return {
    cost,
    sessionTotal: session.estimatedCostUsd,
    dailyTotal: dailyCost.totalCostUsd,
    alerts,
  };
}

/**
 * Check if a creature should be blocked (over budget).
 */
export function shouldBlock(creature: string): { blocked: boolean; reason?: string } {
  resetDailyIfNeeded();
  const sessionKey = `${creature}:${todayStr()}`;
  const session = activeSessions.get(sessionKey);
  const sessionBudget = parseFloat(process.env.CREATURE_SESSION_BUDGET_USD || String(DEFAULT_SESSION_BUDGET_USD));
  const dailyBudget = parseFloat(process.env.CREATURE_DAILY_BUDGET_USD || String(DEFAULT_DAILY_BUDGET_USD));

  if (session && session.estimatedCostUsd >= sessionBudget) {
    return { blocked: true, reason: `${creature} exceeded session budget ($${session.estimatedCostUsd.toFixed(2)} / $${sessionBudget})` };
  }
  if (dailyCost.totalCostUsd >= dailyBudget) {
    return { blocked: true, reason: `Daily budget exceeded ($${dailyCost.totalCostUsd.toFixed(2)} / $${dailyBudget})` };
  }
  return { blocked: false };
}

/**
 * Get cost summary for API/dashboard.
 */
export function getCostSummary(): {
  daily: DailyCost;
  sessions: Array<SessionCost & { sessionKey: string }>;
  modelPricing: typeof MODEL_PRICING;
} {
  resetDailyIfNeeded();
  const sessions: Array<SessionCost & { sessionKey: string }> = [];
  for (const [key, session] of activeSessions) {
    if (key.endsWith(todayStr())) {
      sessions.push({ ...session, sessionKey: key });
    }
  }
  return { daily: { ...dailyCost }, sessions, modelPricing: MODEL_PRICING };
}

/** Reset session costs (for testing) */
export function _resetForTesting(): void {
  activeSessions.clear();
  dailyCost = { date: todayStr(), totalCostUsd: 0, byCreature: {}, dispatches: 0 };
}

// Export for testing
export { MODEL_PRICING, DEFAULT_SESSION_BUDGET_USD, DEFAULT_DAILY_BUDGET_USD, ALERT_THRESHOLD };
