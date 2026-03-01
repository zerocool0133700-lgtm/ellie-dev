/**
 * UMS — Unified Messaging System
 *
 * ELLIE-292: Dumb pipe + source of truth for every inbound message.
 * Provider-agnostic, zero intelligence. Normalizes everything into
 * UnifiedMessage so downstream systems consume from a single source.
 *
 * Usage:
 *   import { ingest, subscribe, queryMessages } from "./ums/index.ts";
 *
 *   // Register a connector (once at startup)
 *   registerConnector(telegramConnector);
 *
 *   // Subscribe a consumer (once at startup)
 *   subscribe("gtd", { content_type: "task" }, handleGtdTask);
 *
 *   // Ingest a raw message (on every webhook/event)
 *   await ingest(supabase, "telegram", rawPayload);
 *
 *   // Pull messages on demand
 *   const recent = await queryMessages(supabase, { provider: "gmail", since: "2026-02-27T00:00:00Z" });
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UnifiedMessage, UnifiedMessageInsert } from "./types.ts";
import { normalizePayload } from "./connector.ts";
import { notify } from "./events.ts";
import { log } from "../logger.ts";

const logger = log.child("ums");

/**
 * Ingest a raw payload from a provider.
 *
 * 1. Normalize via the registered connector
 * 2. Insert into unified_messages (idempotent — duplicates are ignored)
 * 3. Notify push subscribers
 *
 * Returns the inserted UnifiedMessage, or null if skipped/duplicate.
 */
export async function ingest(
  supabase: SupabaseClient,
  provider: string,
  rawPayload: unknown,
): Promise<UnifiedMessage | null> {
  // Normalize
  const insert = normalizePayload(provider, rawPayload);
  if (!insert) {
    logger.debug("UMS: connector skipped payload", { provider });
    return null;
  }

  return ingestNormalized(supabase, insert);
}

/**
 * Ingest a pre-normalized message (when the caller already built the insert).
 * Useful when the ingestion layer does its own normalization outside a connector.
 */
export async function ingestNormalized(
  supabase: SupabaseClient,
  insert: UnifiedMessageInsert,
): Promise<UnifiedMessage | null> {
  // Insert (ON CONFLICT DO NOTHING via the unique index on provider+provider_id)
  const { data, error } = await supabase
    .from("unified_messages")
    .upsert(insert, { onConflict: "provider,provider_id", ignoreDuplicates: true })
    .select()
    .single();

  if (error) {
    // "no rows returned" means duplicate — not an error
    if (error.code === "PGRST116") {
      logger.debug("UMS: duplicate message ignored", { provider: insert.provider, providerId: insert.provider_id });
      return null;
    }
    logger.error("UMS: insert failed", { provider: insert.provider, error: error.message });
    return null;
  }

  const message = data as UnifiedMessage;
  logger.info("UMS: message ingested", {
    id: message.id,
    provider: message.provider,
    contentType: message.content_type,
    channel: message.channel,
  });

  // Notify push subscribers (fire-and-forget — failures logged, not propagated)
  notify(message).catch(() => {});

  return message;
}

// ── Re-export core ─────────────────────────────────────────────
export { registerConnector, getConnector, listProviders } from "./connector.ts";
export { subscribe, unsubscribe, listSubscribers, queryMessages } from "./events.ts";
export type { UMSConnector } from "./connector.ts";
export type { SubscriptionFilter, MessageHandler } from "./events.ts";
export type { UnifiedMessage, UnifiedMessageInsert, MessageQueryFilters, Provider, ContentType, Sender } from "./types.ts";

// ── Connectors ─────────────────────────────────────────────────
export { telegramConnector } from "./connectors/telegram.ts";
export { googleChatConnector } from "./connectors/google-chat.ts";
export { gmailConnector } from "./connectors/gmail.ts";
export { calendarConnector } from "./connectors/calendar.ts";
export { googleTasksConnector } from "./connectors/google-tasks.ts";
export { voiceConnector } from "./connectors/voice.ts";
export { githubConnector } from "./connectors/github.ts";
export { documentsConnector } from "./connectors/documents.ts";
export { microsoftGraphConnector } from "./connectors/microsoft-graph.ts";
export { imapConnector } from "./connectors/imap.ts";

// ── Consumers (push) ──────────────────────────────────────────
export { initGtdConsumer } from "./consumers/gtd.ts";
export { initMemoryConsumer } from "./consumers/memory.ts";
export { initForestConsumer } from "./consumers/forest.ts";
export { initAlertConsumer } from "./consumers/alert.ts";
export { initCommsConsumer } from "./consumers/comms.ts";
export { initCalendarIntelConsumer } from "./consumers/calendar-intel.ts";
export { initRelationshipConsumer } from "./consumers/relationship.ts";

// ── Consumers (pull) ──────────────────────────────────────────
export { generateBriefing } from "./consumers/briefing.ts";
export type { DailyBriefing, BriefingSection, BriefingItem } from "./consumers/briefing.ts";
export { generateRelationshipReport, getProfileCount, getFollowUpProfiles, getHealthBreakdown, getTopContacts, invalidateRelationshipCache } from "./consumers/relationship.ts";
export type { RelationshipReport, ContactStats, RelationshipProfile } from "./consumers/relationship.ts";
export { initAnalyticsConsumer, generateAnalyticsReport, getDailySummary, getTimeDistribution, getPatterns, getFocusBlocks, rollupDay, getTodayMinutes, getTodayFocusMin, getTodayMeetingMin, getTodayMessages, getAnalyticsStats, getTrends, detectAnomalies, getEnergyCurve, assessBurnoutRisk, getBestFocusWindows, getCommTimeBySource } from "./consumers/analytics.ts";
export type { ActivityReport, ChannelVolume, HourlyDistribution, DaySummary, TimeDistribution, WeeklyPattern, FocusBlock, TrendAnalysis, AnomalyDay, HourlyEnergy, BurnoutSignals } from "./consumers/analytics.ts";
export { getStaleThreads, getActiveThreads } from "./consumers/comms.ts";
export { getCalendarInsights, getCalendarAlerts, clearInsights, getUpcomingIntel, getEventsNeedingPrep, getConflictingEvents, suggestFocusBlocks, generatePrepForEvent } from "./consumers/calendar-intel.ts";
export type { CalendarInsight, CalendarIntelRow, CalendarPattern } from "./consumers/calendar-intel.ts";
export { getFactCount, getGoalCount, getConflictCount, getOverdueGoalCount, getLastExtraction, getMemoryHealth, getMemoryStats } from "./consumers/memory.ts";
export type { ConversationFact, MemoryHealth } from "./consumers/memory.ts";

// ── Summary Bar (ELLIE-315) ──────────────────────────────────
export { getSummaryState } from "./consumers/summary.ts";
export type { SummaryState, ModuleSummary, ModuleStatus } from "./consumers/summary.ts";
