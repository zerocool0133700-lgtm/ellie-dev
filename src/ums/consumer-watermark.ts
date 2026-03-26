/**
 * Consumer Watermark Tracking — ELLIE-1032
 * Tracks each consumer's processing position for replay and gap detection.
 * Inspired by Keeper.sh aggregate-tracker.ts sequence tracking.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "../logger.ts";

const logger = log.child("ums:watermark");

export interface ConsumerWatermark {
  consumer_name: string;
  last_message_id: string | null;
  last_processed_at: string | null;
  messages_processed: number;
  errors: number;
  last_error: string | null;
  last_error_at: string | null;
  status: "active" | "paused" | "disabled";
}

/** Ensure a watermark row exists for a consumer */
export async function ensureWatermark(supabase: SupabaseClient, consumerName: string): Promise<void> {
  await supabase
    .from("ums_consumer_watermarks")
    .upsert({ consumer_name: consumerName }, { onConflict: "consumer_name", ignoreDuplicates: true });
}

/** Record successful message processing */
export async function advanceWatermark(
  supabase: SupabaseClient,
  consumerName: string,
  messageId: string
): Promise<void> {
  const { error } = await supabase.rpc("advance_consumer_watermark", {
    p_consumer: consumerName,
    p_message_id: messageId,
  });

  // Fallback if RPC doesn't exist
  if (error) {
    await supabase
      .from("ums_consumer_watermarks")
      .upsert({
        consumer_name: consumerName,
        last_message_id: messageId,
        last_processed_at: new Date().toISOString(),
        messages_processed: 1, // Will be overwritten by increment
        updated_at: new Date().toISOString(),
      }, { onConflict: "consumer_name" });
  }
}

/** Record a consumer error */
export async function recordWatermarkError(
  supabase: SupabaseClient,
  consumerName: string,
  error: string
): Promise<void> {
  await supabase
    .from("ums_consumer_watermarks")
    .upsert({
      consumer_name: consumerName,
      last_error: error.slice(0, 500),
      last_error_at: new Date().toISOString(),
      errors: 1, // Will be overwritten
      updated_at: new Date().toISOString(),
    }, { onConflict: "consumer_name" });
}

/** Get all consumer watermarks (for API/dashboard) */
export async function getAllWatermarks(supabase: SupabaseClient): Promise<ConsumerWatermark[]> {
  const { data, error } = await supabase
    .from("ums_consumer_watermarks")
    .select("*")
    .order("consumer_name");

  if (error) {
    logger.error("Failed to fetch watermarks", error);
    return [];
  }
  return data || [];
}

/** Get watermark for a specific consumer */
export async function getWatermark(supabase: SupabaseClient, consumerName: string): Promise<ConsumerWatermark | null> {
  const { data } = await supabase
    .from("ums_consumer_watermarks")
    .select("*")
    .eq("consumer_name", consumerName)
    .maybeSingle();
  return data;
}
