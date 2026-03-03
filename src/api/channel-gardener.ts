/**
 * Channel Gardener — ELLIE-335
 *
 * Nightly job that collects per-channel usage snapshots and runs Claude
 * analysis to suggest tree improvements: archives, splits, merges, new
 * sub-channels.
 *
 * Schedule: 3 AM CST nightly (triggered by relay.ts interval).
 * HTTP:     POST /api/channel-gardener/run       — on-demand trigger
 *           GET  /api/channel-gardener/suggestions — list pending suggestions
 *           POST /api/channel-gardener/suggestions/:id/approve
 *           POST /api/channel-gardener/suggestions/:id/dismiss
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { IncomingMessage, ServerResponse } from "http";
import Anthropic from "@anthropic-ai/sdk";
import { log } from "../logger.ts";
import { getRelayDeps, getNotifyCtx } from "../relay-state.ts";
import { notify } from "../notification-policy.ts";

const logger = log.child("channel-gardener");

// ── Types ──────────────────────────────────────────────────────────────────

interface ChannelRow {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  is_ephemeral: boolean;
  work_item_id: string | null;
  description: string | null;
}

interface SnapshotRow {
  channel_id: string;
  snapshot_date: string;
  message_count: number;
  conversation_count: number;
}

interface GardenerSuggestion {
  channel_id: string | null;
  suggestion_type: "archive" | "split" | "new_channel" | "reclassify" | "merge";
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  confidence: number;
}

// ── Snapshot Collection ────────────────────────────────────────────────────

/**
 * Collect usage metrics for all active channels for a given date and upsert
 * into channel_usage_snapshots. Run for yesterday's date (complete day data).
 */
export async function collectDailySnapshot(supabase: SupabaseClient, date: string): Promise<number> {
  // Date window: midnight-to-midnight UTC for the given date
  const dayStart = `${date}T00:00:00.000Z`;
  const dayEnd   = `${date}T23:59:59.999Z`;

  const { data: channels, error: chErr } = await supabase
    .from("chat_channels")
    .select("id, name, slug")
    .is("archived_at", null);

  if (chErr || !channels?.length) {
    logger.warn("collectDailySnapshot: no channels found", chErr);
    return 0;
  }

  let saved = 0;
  for (const ch of channels) {
    const { data: convs, error: convErr } = await supabase
      .from("conversations")
      .select("id, message_count, last_message_at")
      .eq("channel_id", ch.id)
      .gte("started_at", dayStart)
      .lte("started_at", dayEnd);

    if (convErr) {
      logger.warn("collectDailySnapshot: conversation query failed", { channel: ch.slug, error: convErr.message });
      continue;
    }

    const convList = convs ?? [];
    const message_count = convList.reduce((acc, c) => acc + (c.message_count ?? 0), 0);
    const conversation_count = convList.length;
    const last_activity_at = convList.reduce((max: string | null, c) => {
      if (!c.last_message_at) return max;
      return !max || c.last_message_at > max ? c.last_message_at : max;
    }, null);

    const { error: upsertErr } = await supabase
      .from("channel_usage_snapshots")
      .upsert({
        channel_id: ch.id,
        snapshot_date: date,
        message_count,
        conversation_count,
        last_activity_at,
        metadata: { collected_at: new Date().toISOString() },
      }, { onConflict: "channel_id,snapshot_date" });

    if (upsertErr) {
      logger.warn("collectDailySnapshot: upsert failed", { channel: ch.slug, error: upsertErr.message });
    } else {
      saved++;
    }
  }

  logger.info(`collectDailySnapshot: saved ${saved}/${channels.length} channel snapshots for ${date}`);
  return saved;
}

// ── Pattern Analysis ───────────────────────────────────────────────────────

/**
 * Build a per-channel 30-day summary for Claude to analyse.
 */
async function buildChannelProfiles(
  supabase: SupabaseClient,
): Promise<Array<ChannelRow & { last_30_days: SnapshotRow[]; total_messages_30d: number; active_days_30d: number; last_seen: string | null }>> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString().slice(0, 10);

  const { data: channels } = await supabase
    .from("chat_channels")
    .select("id, name, slug, parent_id, is_ephemeral, work_item_id, description")
    .is("archived_at", null)
    .order("slug");

  if (!channels?.length) return [];

  const { data: snapshots } = await supabase
    .from("channel_usage_snapshots")
    .select("channel_id, snapshot_date, message_count, conversation_count")
    .gte("snapshot_date", since)
    .order("snapshot_date", { ascending: true });

  const snapByChannel: Record<string, SnapshotRow[]> = {};
  for (const s of snapshots ?? []) {
    (snapByChannel[s.channel_id] ??= []).push(s);
  }

  return channels.map((ch: ChannelRow) => {
    const days = snapByChannel[ch.id] ?? [];
    const total_messages_30d = days.reduce((acc, d) => acc + d.message_count, 0);
    const active_days_30d = days.filter(d => d.message_count > 0).length;
    const last_seen = days.filter(d => d.message_count > 0).at(-1)?.snapshot_date ?? null;
    return { ...ch, last_30_days: days, total_messages_30d, active_days_30d, last_seen };
  });
}

/**
 * Deduplicate: skip if an identical (channel_id + suggestion_type) suggestion
 * is still pending or was dismissed less than 14 days ago.
 */
async function isDuplicateSuggestion(
  supabase: SupabaseClient,
  channelId: string | null,
  type: string,
): Promise<boolean> {
  let q = supabase
    .from("channel_gardener_suggestions")
    .select("id, status, dismissed_until")
    .eq("suggestion_type", type);

  if (channelId) {
    q = q.eq("channel_id", channelId);
  } else {
    q = q.is("channel_id", null);
  }

  const { data } = await q;
  if (!data?.length) return false;

  const cutoff = new Date().toISOString();
  return data.some(r =>
    r.status === "pending" ||
    (r.status === "dismissed" && r.dismissed_until && r.dismissed_until > cutoff),
  );
}

// ── Claude Analysis ────────────────────────────────────────────────────────

const GARDENER_SYSTEM = `You are Ellie's Channel Gardener — an expert in information architecture.
You receive a JSON summary of chat channel usage for the past 30 days and produce
structured suggestions for improving the channel tree.

Rules:
- Only suggest changes you are confident are warranted by the data.
- Archive confidence must be ≥ 0.85 (strong evidence of disuse).
- New channel confidence must be ≥ 0.75 (strong recurring demand).
- Do not suggest changes to core channels (General, Personal) unless truly critical.
- Return a valid JSON array, no markdown fences.

Output format — array of suggestion objects:
[
  {
    "channel_id": "<uuid or null for global suggestions>",
    "suggestion_type": "archive" | "split" | "new_channel" | "reclassify" | "merge",
    "title": "<short action title>",
    "description": "<1-3 sentence explanation>",
    "confidence": <0.0–1.0>,
    "evidence": { "key": "value, ..." }
  }
]

Return an empty array [] if no suggestions are warranted.`;

async function runClaudeAnalysis(
  anthropic: Anthropic,
  profiles: Awaited<ReturnType<typeof buildChannelProfiles>>,
): Promise<GardenerSuggestion[]> {
  const payload = profiles.map(p => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    parent_id: p.parent_id,
    is_ephemeral: p.is_ephemeral,
    work_item_id: p.work_item_id,
    description: p.description,
    stats: {
      total_messages_30d: p.total_messages_30d,
      active_days_30d: p.active_days_30d,
      last_seen: p.last_seen,
      daily_counts: p.last_30_days.map(d => ({ date: d.snapshot_date, msgs: d.message_count, convs: d.conversation_count })),
    },
  }));

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    system: GARDENER_SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(payload, null, 2) }],
  });

  const text = response.content.find(b => b.type === "text")?.text ?? "[]";
  const parsed = JSON.parse(text.trim());
  if (!Array.isArray(parsed)) throw new Error("Claude returned non-array response");
  return parsed as GardenerSuggestion[];
}

// ── Suggestion Persistence ─────────────────────────────────────────────────

async function saveSuggestions(
  supabase: SupabaseClient,
  suggestions: GardenerSuggestion[],
): Promise<number> {
  let saved = 0;
  for (const s of suggestions) {
    if (await isDuplicateSuggestion(supabase, s.channel_id, s.suggestion_type)) {
      logger.info("Skipping duplicate suggestion", { type: s.suggestion_type, channel_id: s.channel_id });
      continue;
    }
    const { error } = await supabase.from("channel_gardener_suggestions").insert({
      channel_id: s.channel_id,
      suggestion_type: s.suggestion_type,
      title: s.title,
      description: s.description,
      evidence: s.evidence,
      confidence: Math.max(0, Math.min(1, s.confidence)),
      status: "pending",
    });
    if (error) {
      logger.warn("Failed to save suggestion", { title: s.title, error: error.message });
    } else {
      saved++;
    }
  }
  return saved;
}

// ── Main Runner ────────────────────────────────────────────────────────────

/**
 * Full nightly gardener run:
 * 1. Collect yesterday's usage snapshots.
 * 2. Analyze 30-day patterns via Claude.
 * 3. Save de-duplicated suggestions.
 * 4. Notify if new suggestions were generated.
 */
export async function runNightlyGardener(
  supabase: SupabaseClient,
  anthropic: Anthropic | null,
): Promise<{ snapshots: number; suggestions: number }> {
  const yesterday = new Date(Date.now() - 24 * 60 * 60_000).toISOString().slice(0, 10);

  // Step 1: collect snapshots
  const snapshots = await collectDailySnapshot(supabase, yesterday);

  // Step 2: analysis requires Anthropic
  if (!anthropic) {
    logger.warn("runNightlyGardener: Anthropic not available — skipping analysis");
    return { snapshots, suggestions: 0 };
  }

  // Step 3: build profiles + call Claude
  const profiles = await buildChannelProfiles(supabase);
  if (!profiles.length) {
    logger.info("runNightlyGardener: no channel profiles — nothing to analyse");
    return { snapshots, suggestions: 0 };
  }

  let rawSuggestions: GardenerSuggestion[] = [];
  try {
    rawSuggestions = await runClaudeAnalysis(anthropic, profiles);
    logger.info(`runNightlyGardener: Claude returned ${rawSuggestions.length} suggestion(s)`);
  } catch (err: unknown) {
    logger.error("runNightlyGardener: Claude analysis failed", err);
    return { snapshots, suggestions: 0 };
  }

  // Step 4: persist
  const suggestions = await saveSuggestions(supabase, rawSuggestions);

  // Step 5: notify if anything new
  if (suggestions > 0) {
    notify(getNotifyCtx(), {
      event: "rollup",
      telegramMessage: `~ Channel Gardener: ${suggestions} new suggestion${suggestions !== 1 ? "s" : ""} added. Check the morning briefing.`,
    });
  }

  logger.info(`runNightlyGardener: done — snapshots=${snapshots} suggestions=${suggestions}`);
  return { snapshots, suggestions };
}

// ── HTTP Handlers ──────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/** POST /api/channel-gardener/run — trigger on-demand */
export async function gardenerRunHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { supabase, anthropic } = getRelayDeps();
  if (!supabase) return sendJson(res, 503, { error: "Supabase not configured" });

  // Optional body: { date: "YYYY-MM-DD" } to collect a specific day's snapshot
  let body = "";
  await new Promise<void>(resolve => {
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", resolve);
  });
  const parsed = body ? (() => { try { return JSON.parse(body); } catch { return {}; } })() : {};
  const date: string = parsed.date ?? new Date(Date.now() - 24 * 60 * 60_000).toISOString().slice(0, 10);

  try {
    const result = await runNightlyGardener(supabase, anthropic ?? null);
    sendJson(res, 200, { ok: true, date, ...result });
  } catch (err: unknown) {
    logger.error("gardenerRunHandler error", err);
    sendJson(res, 500, { error: "Gardener run failed" });
  }
}

/** GET /api/channel-gardener/suggestions — list pending suggestions */
export async function gardenerSuggestionsHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { supabase } = getRelayDeps();
  if (!supabase) return sendJson(res, 503, { error: "Supabase not configured" });

  const { data, error } = await supabase
    .from("channel_gardener_suggestions")
    .select(`
      id, suggestion_type, title, description, evidence, confidence,
      status, dismissed_until, created_at,
      channel:channel_id ( id, name, slug )
    `)
    .eq("status", "pending")
    .order("confidence", { ascending: false })
    .limit(50);

  if (error) return sendJson(res, 500, { error: error.message });
  sendJson(res, 200, { suggestions: data ?? [] });
}

/** POST /api/channel-gardener/suggestions/:id/approve|dismiss */
export async function gardenerActionHandler(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  action: "approve" | "dismiss",
): Promise<void> {
  const { supabase } = getRelayDeps();
  if (!supabase) return sendJson(res, 503, { error: "Supabase not configured" });

  // Read optional body for dismiss cooldown
  let body = "";
  await new Promise<void>(resolve => {
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", resolve);
  });
  const parsed = body ? (() => { try { return JSON.parse(body); } catch { return {}; } })() : {};

  const newStatus = action === "approve" ? "approved" : "dismissed";
  const update: Record<string, unknown> = {
    status: newStatus,
    actioned_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (action === "dismiss") {
    // Default 14-day cooldown, caller can override
    const cooldownDays: number = parsed.cooldown_days ?? 14;
    update.dismissed_until = new Date(Date.now() + cooldownDays * 24 * 60 * 60_000).toISOString();
  }

  const { error } = await supabase
    .from("channel_gardener_suggestions")
    .update(update)
    .eq("id", id);

  if (error) return sendJson(res, 500, { error: error.message });
  sendJson(res, 200, { ok: true, id, status: newStatus });
}
