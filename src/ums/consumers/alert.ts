/**
 * UMS Consumer: Alerts
 *
 * ELLIE-307: Push subscriber — watches for high-priority events
 * ELLIE-317: Expanded with DB-backed rules, dedup, quiet hours, severity routing
 *
 * Listens to: all providers
 * Action: evaluates DB-backed rules, logs alerts, delivers via notification policy
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UnifiedMessage } from "../types.ts";
import { subscribe } from "../events.ts";
import { log } from "../../logger.ts";

const logger = log.child("ums-consumer-alert");

// ── Types ────────────────────────────────────────────────────

export interface AlertRuleRow {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  priority: "critical" | "high" | "normal";
  enabled: boolean;
  cooldown_minutes: number;
  created_at: string;
  updated_at: string;
}

export interface AlertRow {
  id: string;
  rule_id: string | null;
  rule_name: string;
  message_id: string | null;
  severity: string;
  summary: string;
  provider: string | null;
  sender: Record<string, unknown> | null;
  acknowledged: boolean;
  acknowledged_at: string | null;
  ack_note: string | null;
  delivered_at: string;
  delivery_channels: string[];
  created_at: string;
}

interface QuietHoursConfig {
  enabled: boolean;
  start: string;   // "HH:MM"
  end: string;     // "HH:MM"
  timezone: string;
  bypass_critical: boolean;
}

// ── State ────────────────────────────────────────────────────

type AlertDeliveryFn = (text: string, priority: string) => Promise<string[]>;
let deliverAlert: AlertDeliveryFn | null = null;
let supabaseRef: SupabaseClient | null = null;

/** Cached rules — refreshed from DB periodically. */
let cachedRules: AlertRuleRow[] = [];
let lastRuleRefresh = 0;
const RULE_REFRESH_INTERVAL = 60_000; // 1 minute

/** Dedup: track recent alerts by rule+provider+sender to prevent spam. */
const recentAlerts = new Map<string, number>(); // key -> timestamp

/** In-memory alert state for summary bar. */
let activeAlertCount = 0;
let lastAlertAt: string | null = null;

// ── Initialization ───────────────────────────────────────────

/**
 * Initialize the Alert consumer.
 *
 * @param supabase Supabase client for DB queries
 * @param deliveryFn Callback to deliver alert text. Returns list of channels delivered to.
 */
export function initAlertConsumer(
  supabase: SupabaseClient,
  deliveryFn: AlertDeliveryFn,
): void {
  supabaseRef = supabase;
  deliverAlert = deliveryFn;

  // Load rules on startup
  refreshRules().catch(err => logger.error("Initial rule load failed", err));

  // Load active alert count for summary
  refreshAlertCount().catch(err => logger.error("Initial alert count failed", err));

  subscribe("consumer:alert", {}, async (message) => {
    try {
      await handleMessage(message);
    } catch (err) {
      logger.error("Alert consumer failed", { messageId: message.id, err });
    }
  });

  // Periodic rule refresh
  setInterval(() => {
    refreshRules().catch(err => logger.error("Rule refresh failed", err));
  }, RULE_REFRESH_INTERVAL);

  // Periodic dedup cleanup
  setInterval(() => {
    const cutoff = Date.now() - 60 * 60_000; // 1 hour
    for (const [key, ts] of recentAlerts) {
      if (ts < cutoff) recentAlerts.delete(key);
    }
  }, 5 * 60_000);

  logger.info("Alert consumer initialized (ELLIE-317)");
}

// ── Rule Loading ─────────────────────────────────────────────

async function refreshRules(): Promise<void> {
  if (!supabaseRef) return;
  const { data, error } = await supabaseRef
    .from("alert_rules")
    .select("*")
    .eq("enabled", true)
    .order("priority", { ascending: true }); // critical first

  if (error) {
    logger.error("Failed to load alert rules", error);
    return;
  }
  cachedRules = (data || []) as AlertRuleRow[];
  lastRuleRefresh = Date.now();
  logger.debug("Rules refreshed", { count: cachedRules.length });
}

async function refreshAlertCount(): Promise<void> {
  if (!supabaseRef) return;
  const { count } = await supabaseRef
    .from("alerts")
    .select("*", { count: "exact", head: true })
    .eq("acknowledged", false);
  activeAlertCount = count ?? 0;

  const { data: latest } = await supabaseRef
    .from("alerts")
    .select("created_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  lastAlertAt = latest?.created_at || null;
}

/** Force refresh rules cache (after CRUD operations). */
export async function invalidateRulesCache(): Promise<void> {
  lastRuleRefresh = 0;
  await refreshRules();
}

// ── Rule Matching ────────────────────────────────────────────

function matchRule(rule: AlertRuleRow, msg: UnifiedMessage): boolean {
  switch (rule.type) {
    case "ci_failure":
      return msg.provider === "github" &&
        msg.metadata?.event_type === "ci" &&
        msg.metadata?.ci_conclusion === "failure";

    case "vip_sender": {
      const senders = (rule.config.senders as string[]) || [];
      if (senders.length === 0) return false;
      const sender = msg.sender;
      if (!sender) return false;
      const senderSet = new Set(senders.map(s => s.toLowerCase()));
      return senderSet.has((sender.email || "").toLowerCase()) ||
             senderSet.has((sender.username || "").toLowerCase()) ||
             senderSet.has((sender.name || "").toLowerCase());
    }

    case "keyword": {
      if (!msg.content) return false;
      const keywords = (rule.config.keywords as string[]) || [];
      const pattern = (rule.config.pattern as string) || "";
      if (pattern) {
        try {
          return new RegExp(pattern, "i").test(msg.content);
        } catch { return false; }
      }
      return keywords.some(kw =>
        new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(msg.content!)
      );
    }

    case "security":
      return msg.provider === "github" &&
        (msg.metadata?.event_type === "security_advisory" ||
         msg.metadata?.event_type === "dependabot" ||
         (msg.content || "").toLowerCase().includes("security"));

    case "calendar_conflict":
      return msg.provider === "calendar" &&
        (msg.metadata?.change_type === "conflict" || msg.metadata?.change_type === "cancelled");

    case "gtd_overdue":
      // Cross-module: handled by briefing/gtd, not UMS stream
      return false;

    case "stale_thread":
      // Cross-module: handled by comms consumer
      return false;

    case "custom": {
      // Custom rules use provider + pattern matching
      const providers = (rule.config.providers as string[]) || [];
      if (providers.length > 0 && !providers.includes(msg.provider)) return false;
      const customPattern = (rule.config.pattern as string) || "";
      if (!customPattern || !msg.content) return false;
      try {
        return new RegExp(customPattern, "i").test(msg.content);
      } catch { return false; }
    }

    default:
      return false;
  }
}

function formatAlert(rule: AlertRuleRow, msg: UnifiedMessage): string {
  const who = msg.sender?.name || msg.sender?.username || msg.sender?.email || msg.provider;
  const content = msg.content?.slice(0, 200) || "(no content)";

  switch (rule.type) {
    case "ci_failure":
      return `\u{1F534} CI Failed: ${content}`;
    case "vip_sender":
      return `\u2B50 ${who}: ${content}`;
    case "keyword":
      return `\u26A0\uFE0F Urgent [${msg.provider}]: ${content}`;
    case "security":
      return `\u{1F6A8} Security [${msg.provider}]: ${content}`;
    case "calendar_conflict":
      return `\u{1F4C5} Calendar: ${content}`;
    case "custom":
      return `\u{1F514} ${rule.name}: ${content}`;
    default:
      return `\u{1F514} ${rule.name} [${msg.provider}]: ${content}`;
  }
}

// ── Dedup & Quiet Hours ──────────────────────────────────────

function dedupKey(rule: AlertRuleRow, msg: UnifiedMessage): string {
  const sender = msg.sender?.email || msg.sender?.username || "";
  return `${rule.id}:${msg.provider}:${sender}`;
}

function isDuplicate(rule: AlertRuleRow, msg: UnifiedMessage): boolean {
  if (rule.cooldown_minutes <= 0) return false;
  const key = dedupKey(rule, msg);
  const lastFired = recentAlerts.get(key);
  if (!lastFired) return false;
  return Date.now() - lastFired < rule.cooldown_minutes * 60_000;
}

function markFired(rule: AlertRuleRow, msg: UnifiedMessage): void {
  recentAlerts.set(dedupKey(rule, msg), Date.now());
}

async function isQuietHours(priority: string): Promise<boolean> {
  if (!supabaseRef) return false;
  try {
    const { data } = await supabaseRef
      .from("alert_preferences")
      .select("value")
      .eq("key", "quiet_hours")
      .single();

    if (!data?.value) return false;
    const config = (typeof data.value === "string" ? JSON.parse(data.value) : data.value) as QuietHoursConfig;
    if (!config.enabled) return false;
    if (config.bypass_critical && priority === "critical") return false;

    const now = new Date();
    const cst = new Date(now.toLocaleString("en-US", { timeZone: config.timezone || "America/Chicago" }));
    const currentMinutes = cst.getHours() * 60 + cst.getMinutes();

    const [startH, startM] = config.start.split(":").map(Number);
    const [endH, endM] = config.end.split(":").map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    // Handle overnight quiet hours (e.g., 22:00 - 07:00)
    if (startMinutes > endMinutes) {
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } catch {
    return false;
  }
}

// ── Message Handler ──────────────────────────────────────────

async function handleMessage(message: UnifiedMessage): Promise<void> {
  // Refresh rules if stale
  if (Date.now() - lastRuleRefresh > RULE_REFRESH_INTERVAL) {
    await refreshRules();
  }

  for (const rule of cachedRules) {
    if (!matchRule(rule, message)) continue;

    // Dedup check
    if (isDuplicate(rule, message)) {
      logger.debug("Alert suppressed (dedup)", { rule: rule.name, messageId: message.id });
      continue; // Check next rule instead of returning
    }

    // Quiet hours check
    if (await isQuietHours(rule.priority)) {
      logger.debug("Alert suppressed (quiet hours)", { rule: rule.name, priority: rule.priority });
      // Still log the alert, just don't deliver
      await logAlert(rule, message, formatAlert(rule, message), []);
      markFired(rule, message);
      continue;
    }

    const text = formatAlert(rule, message);
    logger.info("Alert triggered", { rule: rule.name, priority: rule.priority, messageId: message.id });

    // Deliver
    let channels: string[] = [];
    if (deliverAlert) {
      channels = await deliverAlert(text, rule.priority);
    } else {
      logger.warn("No delivery function configured", { text });
    }

    // Log to DB
    await logAlert(rule, message, text, channels);
    markFired(rule, message);

    // Update in-memory state
    activeAlertCount++;
    lastAlertAt = new Date().toISOString();

    // Only fire the highest-priority matching rule
    return;
  }
}

async function logAlert(
  rule: AlertRuleRow,
  message: UnifiedMessage,
  summary: string,
  channels: string[],
): Promise<void> {
  if (!supabaseRef) return;
  try {
    await supabaseRef.from("alerts").insert({
      rule_id: rule.id,
      rule_name: rule.name,
      message_id: message.id || null,
      severity: rule.priority,
      summary,
      provider: message.provider,
      sender: message.sender || null,
      delivery_channels: channels,
    });
  } catch (err) {
    logger.error("Failed to log alert", err);
  }
}

// ── Exports for Summary Bar & API ────────────────────────────

/** Get active (unacknowledged) alert count. */
export function getActiveAlertCount(): number {
  return activeAlertCount;
}

/** Get last alert timestamp. */
export function getLastAlertTime(): string | null {
  return lastAlertAt;
}

/** Get cached rules (for API). */
export function getCachedRules(): AlertRuleRow[] {
  return cachedRules;
}

/** Decrement active count (after acknowledge). */
export function decrementActiveCount(): void {
  if (activeAlertCount > 0) activeAlertCount--;
}

/** Refresh active alert count from DB. */
export async function syncAlertCount(): Promise<void> {
  await refreshAlertCount();
}
