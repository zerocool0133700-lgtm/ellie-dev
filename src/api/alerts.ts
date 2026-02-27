/**
 * Alerts API — CRUD for alert rules, recent alerts, acknowledgement
 *
 * ELLIE-317: Alert Module endpoints
 *
 * Endpoints:
 *   GET    /api/alerts/rules       — list all rules
 *   POST   /api/alerts/rules       — create a rule
 *   PATCH  /api/alerts/rules/:id   — update a rule
 *   DELETE /api/alerts/rules/:id   — delete a rule
 *   GET    /api/alerts/recent      — recent fired alerts
 *   POST   /api/alerts/acknowledge/:id — acknowledge an alert
 *   GET    /api/alerts/preferences — get alert preferences
 *   PUT    /api/alerts/preferences — update alert preferences
 *   POST   /api/alerts/test        — test a rule against recent messages
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiRequest, ApiResponse } from "./types.ts";
import { invalidateRulesCache, decrementActiveCount, syncAlertCount } from "../ums/consumers/alert.ts";
import { log } from "../logger.ts";

const logger = log.child("alerts-api");

const VALID_TYPES = ["vip_sender", "keyword", "ci_failure", "calendar_conflict", "security", "gtd_overdue", "stale_thread", "custom"];
const VALID_PRIORITIES = ["critical", "high", "normal"];

// ── Rules CRUD ───────────────────────────────────────────────

export async function listRules(_req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase
    .from("alert_rules")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ success: true, rules: data || [] });
}

export async function createRule(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const { name, type, config, priority, enabled, cooldown_minutes } = req.body || {};

  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!type || !VALID_TYPES.includes(type as string)) {
    res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(", ")}` });
    return;
  }
  if (priority && !VALID_PRIORITIES.includes(priority as string)) {
    res.status(400).json({ error: `priority must be one of: ${VALID_PRIORITIES.join(", ")}` });
    return;
  }

  const { data, error } = await supabase
    .from("alert_rules")
    .insert({
      name,
      type,
      config: config || {},
      priority: priority || "high",
      enabled: enabled !== false,
      cooldown_minutes: typeof cooldown_minutes === "number" ? cooldown_minutes : 30,
    })
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  await invalidateRulesCache();
  res.json({ success: true, rule: data });
}

export async function updateRule(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const id = req.params?.id;
  if (!id) {
    res.status(400).json({ error: "Rule ID required" });
    return;
  }

  const updates: Record<string, unknown> = {};
  const body = req.body || {};

  if (body.name !== undefined) updates.name = body.name;
  if (body.type !== undefined) {
    if (!VALID_TYPES.includes(body.type as string)) {
      res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(", ")}` });
      return;
    }
    updates.type = body.type;
  }
  if (body.config !== undefined) updates.config = body.config;
  if (body.priority !== undefined) {
    if (!VALID_PRIORITIES.includes(body.priority as string)) {
      res.status(400).json({ error: `priority must be one of: ${VALID_PRIORITIES.join(", ")}` });
      return;
    }
    updates.priority = body.priority;
  }
  if (body.enabled !== undefined) updates.enabled = body.enabled;
  if (body.cooldown_minutes !== undefined) updates.cooldown_minutes = body.cooldown_minutes;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("alert_rules")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  if (!data) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }

  await invalidateRulesCache();
  res.json({ success: true, rule: data });
}

export async function deleteRule(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const id = req.params?.id;
  if (!id) {
    res.status(400).json({ error: "Rule ID required" });
    return;
  }

  const { error } = await supabase
    .from("alert_rules")
    .delete()
    .eq("id", id);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  await invalidateRulesCache();
  res.json({ success: true, deleted: id });
}

// ── Recent Alerts ────────────────────────────────────────────

export async function getRecentAlerts(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const limit = Math.min(Number(req.query?.limit) || 20, 100);
  const unacked = req.query?.unacked === "true";

  let query = supabase
    .from("alerts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (unacked) {
    query = query.eq("acknowledged", false);
  }

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ success: true, alerts: data || [] });
}

// ── Acknowledge ──────────────────────────────────────────────

export async function acknowledgeAlert(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const id = req.params?.id;
  if (!id) {
    res.status(400).json({ error: "Alert ID required" });
    return;
  }

  const note = (req.body?.note as string) || null;

  const { data, error } = await supabase
    .from("alerts")
    .update({
      acknowledged: true,
      acknowledged_at: new Date().toISOString(),
      ack_note: note,
    })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  if (!data) {
    res.status(404).json({ error: "Alert not found" });
    return;
  }

  decrementActiveCount();
  res.json({ success: true, alert: data });
}

// ── Preferences ──────────────────────────────────────────────

export async function getPreferences(_req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase
    .from("alert_preferences")
    .select("key, value");

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const prefs: Record<string, unknown> = {};
  for (const row of data || []) {
    prefs[row.key] = row.value;
  }
  res.json({ success: true, preferences: prefs });
}

export async function updatePreferences(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const body = req.body || {};
  const entries = Object.entries(body);

  if (entries.length === 0) {
    res.status(400).json({ error: "No preferences to update" });
    return;
  }

  for (const [key, value] of entries) {
    const { error } = await supabase
      .from("alert_preferences")
      .upsert({
        key,
        value: typeof value === "string" ? value : JSON.stringify(value),
        updated_at: new Date().toISOString(),
      }, { onConflict: "key" });

    if (error) {
      logger.error("Failed to update preference", { key, error });
    }
  }

  res.json({ success: true });
}

// ── Test Rule ────────────────────────────────────────────────

export async function testRule(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const { rule_id, hours_back } = req.body || {};

  if (!rule_id) {
    res.status(400).json({ error: "rule_id is required" });
    return;
  }

  // Fetch the rule
  const { data: rule, error: ruleErr } = await supabase
    .from("alert_rules")
    .select("*")
    .eq("id", rule_id)
    .single();

  if (ruleErr || !rule) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }

  // Fetch recent messages
  const since = new Date(Date.now() - (Number(hours_back) || 24) * 60 * 60 * 1000).toISOString();
  const { data: messages } = await supabase
    .from("unified_messages")
    .select("*")
    .gte("received_at", since)
    .order("received_at", { ascending: false })
    .limit(200);

  // Test each message against the rule (replicating matchRule logic inline)
  const matches: Array<{ id: string; provider: string; content: string | null; sender: unknown }> = [];

  for (const msg of messages || []) {
    if (wouldMatch(rule, msg)) {
      matches.push({
        id: msg.id,
        provider: msg.provider,
        content: msg.content?.slice(0, 150) || null,
        sender: msg.sender,
      });
    }
  }

  res.json({
    success: true,
    rule_name: rule.name,
    rule_type: rule.type,
    messages_scanned: (messages || []).length,
    matches: matches.length,
    sample_matches: matches.slice(0, 10),
  });
}

/** Simplified rule matching for testing — mirrors consumer logic. */
function wouldMatch(rule: Record<string, unknown>, msg: Record<string, unknown>): boolean {
  const type = rule.type as string;
  const config = (rule.config || {}) as Record<string, unknown>;
  const content = msg.content as string | null;
  const provider = msg.provider as string;
  const sender = msg.sender as Record<string, string> | null;
  const metadata = msg.metadata as Record<string, unknown> | null;

  switch (type) {
    case "ci_failure":
      return provider === "github" && metadata?.event_type === "ci" && metadata?.ci_conclusion === "failure";

    case "vip_sender": {
      const senders = (config.senders as string[]) || [];
      if (senders.length === 0 || !sender) return false;
      const set = new Set(senders.map(s => s.toLowerCase()));
      return set.has((sender.email || "").toLowerCase()) ||
             set.has((sender.username || "").toLowerCase()) ||
             set.has((sender.name || "").toLowerCase());
    }

    case "keyword": {
      if (!content) return false;
      const keywords = (config.keywords as string[]) || [];
      const pattern = (config.pattern as string) || "";
      if (pattern) {
        try { return new RegExp(pattern, "i").test(content); } catch { return false; }
      }
      return keywords.some(kw => {
        try {
          return new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(content);
        } catch { return false; }
      });
    }

    case "security":
      return provider === "github" &&
        (metadata?.event_type === "security_advisory" || metadata?.event_type === "dependabot" ||
         (content || "").toLowerCase().includes("security"));

    case "calendar_conflict":
      return provider === "calendar" &&
        (metadata?.change_type === "conflict" || metadata?.change_type === "cancelled");

    case "custom": {
      const providers = (config.providers as string[]) || [];
      if (providers.length > 0 && !providers.includes(provider)) return false;
      const customPattern = (config.pattern as string) || "";
      if (!customPattern || !content) return false;
      try { return new RegExp(customPattern, "i").test(content); } catch { return false; }
    }

    default:
      return false;
  }
}
