/**
 * UMS Consumer: Relationship Tracker
 *
 * ELLIE-310: Pull consumer — analyzes contact interaction patterns,
 * communication frequency, and relationship health.
 *
 * Pattern: pull-based (called on schedule, not push)
 * Action: queries unified_messages, aggregates per-contact stats
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UnifiedMessage } from "../types.ts";
import { queryMessages } from "../events.ts";
import { log } from "../../logger.ts";

const logger = log.child("ums-consumer-relationship");

export interface ContactStats {
  identifier: string; // email, username, or name
  display_name: string | null;
  message_count: number;
  last_contact: string;
  first_contact: string;
  channels: string[]; // which providers they communicate through
  avg_messages_per_day: number;
  days_since_last_contact: number;
}

export interface RelationshipReport {
  generated_at: string;
  period_days: number;
  contacts: ContactStats[];
  total_unique_contacts: number;
  most_active: ContactStats | null;
  dormant: ContactStats[]; // contacts with no recent activity
}

/**
 * Generate a relationship report from UMS messages.
 * Called on schedule — not a push subscriber.
 *
 * @param daysBack How many days to analyze (default: 30)
 * @param dormantThresholdDays Days of silence before marking dormant (default: 14)
 */
export async function generateRelationshipReport(
  supabase: SupabaseClient,
  daysBack = 30,
  dormantThresholdDays = 14,
): Promise<RelationshipReport> {
  const now = new Date();
  const since = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);

  const messages = await queryMessages(supabase, {
    since: since.toISOString(),
    limit: 500,
  });

  logger.info("Relationship tracker: fetched messages", { count: messages.length, daysBack });

  const contacts = aggregateContacts(messages, daysBack);

  // Sort by message count descending
  contacts.sort((a, b) => b.message_count - a.message_count);

  const dormant = contacts.filter(c => c.days_since_last_contact > dormantThresholdDays);

  return {
    generated_at: now.toISOString(),
    period_days: daysBack,
    contacts,
    total_unique_contacts: contacts.length,
    most_active: contacts[0] || null,
    dormant,
  };
}

function aggregateContacts(messages: UnifiedMessage[], periodDays: number): ContactStats[] {
  const contactMap = new Map<string, {
    display_name: string | null;
    messages: number;
    first: Date;
    last: Date;
    channels: Set<string>;
  }>();

  const now = new Date();

  for (const msg of messages) {
    const sender = msg.sender;
    if (!sender) continue;

    // Pick the best identifier
    const id = sender.email || sender.username || sender.name || sender.id;
    if (!id) continue;

    const key = id.toLowerCase();
    const timestamp = new Date(msg.provider_timestamp || msg.received_at);

    const existing = contactMap.get(key);
    if (existing) {
      existing.messages++;
      if (timestamp < existing.first) existing.first = timestamp;
      if (timestamp > existing.last) existing.last = timestamp;
      existing.channels.add(msg.provider);
      if (!existing.display_name && sender.name) existing.display_name = sender.name;
    } else {
      contactMap.set(key, {
        display_name: sender.name || null,
        messages: 1,
        first: timestamp,
        last: timestamp,
        channels: new Set([msg.provider]),
      });
    }
  }

  const stats: ContactStats[] = [];
  for (const [id, data] of contactMap) {
    const daysSinceLast = Math.floor((now.getTime() - data.last.getTime()) / (1000 * 60 * 60 * 24));

    stats.push({
      identifier: id,
      display_name: data.display_name,
      message_count: data.messages,
      last_contact: data.last.toISOString(),
      first_contact: data.first.toISOString(),
      channels: Array.from(data.channels),
      avg_messages_per_day: Math.round((data.messages / periodDays) * 100) / 100,
      days_since_last_contact: daysSinceLast,
    });
  }

  return stats;
}
