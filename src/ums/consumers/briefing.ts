/**
 * UMS Consumer: Daily Briefing
 *
 * ELLIE-306: Pull consumer — queries UMS for recent activity
 * and aggregates into a daily briefing summary.
 *
 * Pattern: pull-based (called on schedule, not push)
 * Action: queries unified_messages for past 24h, groups by provider/type, returns summary
 *
 * Cross-ref: src/ums/events.ts queryMessages() for the pull API
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UnifiedMessage, Provider } from "../types.ts";
import { queryMessages } from "../events.ts";
import { log } from "../../logger.ts";

const logger = log.child("ums-consumer-briefing");

export interface BriefingSection {
  title: string;
  provider: string;
  items: BriefingItem[];
  count: number;
}

export interface BriefingItem {
  content: string;
  channel: string | null;
  sender: string | null;
  timestamp: string | null;
  metadata: Record<string, unknown>;
}

export interface DailyBriefing {
  generated_at: string;
  period_start: string;
  period_end: string;
  sections: BriefingSection[];
  total_messages: number;
  summary: string;
}

/**
 * Generate a daily briefing from UMS messages.
 * Called on schedule (e.g., every morning) — not a push subscriber.
 *
 * @param hoursBack How many hours to look back (default: 24)
 */
export async function generateBriefing(
  supabase: SupabaseClient,
  hoursBack = 24,
): Promise<DailyBriefing> {
  const now = new Date();
  const since = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);

  const messages = await queryMessages(supabase, {
    since: since.toISOString(),
    before: now.toISOString(),
    limit: 500,
  });

  logger.info("Briefing: fetched messages", { count: messages.length, hoursBack });

  const sections = buildSections(messages);
  const summary = buildSummary(sections, messages.length);

  return {
    generated_at: now.toISOString(),
    period_start: since.toISOString(),
    period_end: now.toISOString(),
    sections,
    total_messages: messages.length,
    summary,
  };
}

function buildSections(messages: UnifiedMessage[]): BriefingSection[] {
  // Group by provider
  const grouped = new Map<Provider, UnifiedMessage[]>();
  for (const msg of messages) {
    const list = grouped.get(msg.provider) || [];
    list.push(msg);
    grouped.set(msg.provider, list);
  }

  const sections: BriefingSection[] = [];
  const providerTitles: Record<string, string> = {
    telegram: "Telegram Messages",
    gmail: "Emails",
    gchat: "Google Chat",
    github: "GitHub Activity",
    calendar: "Calendar Events",
    "google-tasks": "Tasks",
    voice: "Voice Notes",
    documents: "Document Activity",
  };

  for (const [provider, msgs] of grouped) {
    const items: BriefingItem[] = msgs.slice(0, 20).map(msg => ({
      content: msg.content?.slice(0, 200) || "(no content)",
      channel: msg.channel,
      sender: formatSender(msg),
      timestamp: msg.provider_timestamp || msg.received_at,
      metadata: msg.metadata,
    }));

    sections.push({
      title: providerTitles[provider] || `${provider} Activity`,
      provider,
      items,
      count: msgs.length,
    });
  }

  // Sort by count descending — busiest channels first
  sections.sort((a, b) => b.count - a.count);

  return sections;
}

function formatSender(message: UnifiedMessage): string | null {
  const s = message.sender;
  if (!s) return null;
  return s.name || s.username || s.email || s.id || null;
}

function buildSummary(sections: BriefingSection[], total: number): string {
  if (total === 0) return "No activity in the past period.";

  const parts = sections.map(s => `${s.count} ${s.title.toLowerCase()}`);
  return `${total} total messages: ${parts.join(", ")}.`;
}
