/**
 * UMS Consumer: Analytics
 *
 * ELLIE-311: Pull consumer — analyzes activity patterns, channel volume,
 * and communication trends from unified messages.
 *
 * Pattern: pull-based (called on schedule, not push)
 * Action: queries unified_messages, computes per-channel and per-hour stats
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UnifiedMessage, Provider, ContentType } from "../types.ts";
import { queryMessages } from "../events.ts";
import { log } from "../../logger.ts";

const logger = log.child("ums-consumer-analytics");

export interface ChannelVolume {
  provider: string;
  count: number;
  percentage: number;
}

export interface HourlyDistribution {
  hour: number; // 0-23
  count: number;
}

export interface ContentTypeBreakdown {
  content_type: string;
  count: number;
  percentage: number;
}

export interface ActivityReport {
  generated_at: string;
  period_start: string;
  period_end: string;
  total_messages: number;
  channel_volume: ChannelVolume[];
  hourly_distribution: HourlyDistribution[];
  content_types: ContentTypeBreakdown[];
  busiest_hour: number | null;
  busiest_provider: string | null;
  daily_average: number;
}

/**
 * Generate an analytics report from UMS messages.
 * Called on schedule — not a push subscriber.
 *
 * @param daysBack How many days to analyze (default: 7)
 */
export async function generateAnalyticsReport(
  supabase: SupabaseClient,
  daysBack = 7,
): Promise<ActivityReport> {
  const now = new Date();
  const since = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);

  const messages = await queryMessages(supabase, {
    since: since.toISOString(),
    before: now.toISOString(),
    limit: 500,
  });

  logger.info("Analytics: fetched messages", { count: messages.length, daysBack });

  const total = messages.length;
  const channelVolume = computeChannelVolume(messages, total);
  const hourlyDistribution = computeHourlyDistribution(messages);
  const contentTypes = computeContentTypes(messages, total);

  const busiestHourEntry = hourlyDistribution.reduce(
    (max, entry) => entry.count > max.count ? entry : max,
    { hour: -1, count: 0 },
  );

  const busiestChannel = channelVolume[0] || null;

  return {
    generated_at: now.toISOString(),
    period_start: since.toISOString(),
    period_end: now.toISOString(),
    total_messages: total,
    channel_volume: channelVolume,
    hourly_distribution: hourlyDistribution,
    content_types: contentTypes,
    busiest_hour: busiestHourEntry.hour >= 0 ? busiestHourEntry.hour : null,
    busiest_provider: busiestChannel?.provider || null,
    daily_average: daysBack > 0 ? Math.round((total / daysBack) * 10) / 10 : 0,
  };
}

function computeChannelVolume(messages: UnifiedMessage[], total: number): ChannelVolume[] {
  const counts = new Map<string, number>();
  for (const msg of messages) {
    counts.set(msg.provider, (counts.get(msg.provider) || 0) + 1);
  }

  const volumes: ChannelVolume[] = [];
  for (const [provider, count] of counts) {
    volumes.push({
      provider,
      count,
      percentage: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
    });
  }

  return volumes.sort((a, b) => b.count - a.count);
}

function computeHourlyDistribution(messages: UnifiedMessage[]): HourlyDistribution[] {
  const hours = new Array(24).fill(0);

  for (const msg of messages) {
    const ts = msg.provider_timestamp || msg.received_at;
    const hour = new Date(ts).getHours();
    hours[hour]++;
  }

  return hours.map((count, hour) => ({ hour, count }));
}

function computeContentTypes(messages: UnifiedMessage[], total: number): ContentTypeBreakdown[] {
  const counts = new Map<string, number>();
  for (const msg of messages) {
    counts.set(msg.content_type, (counts.get(msg.content_type) || 0) + 1);
  }

  const types: ContentTypeBreakdown[] = [];
  for (const [content_type, count] of counts) {
    types.push({
      content_type,
      count,
      percentage: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
    });
  }

  return types.sort((a, b) => b.count - a.count);
}
