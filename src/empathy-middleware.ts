/**
 * Empathy Middleware — Message analysis pipeline for EI detection
 *
 * Analyzes user messages, stores emotion history, returns guidance for prompt injection.
 * Uses BERT-based detector (ELLIE-989) with keyword/VADER fallback.
 */

import { detectEmpathyNeeds, extractPrimaryEmotion, formatResponseGuidance } from "./empathy-detector.ts";
import { detectEmpathyNeedsBert, extractPrimaryEmotionBert, formatBertResponseGuidance, isBertModelReady } from "./empathy-detector-bert.ts";
import { log } from "./logger.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

const logger = log.child("empathy-middleware");

export interface EmotionRecord {
  user_id: string;
  conversation_id?: string;
  channel: string;
  turn_number?: number;
  emotion: string;
  intensity: number;
  empathy_score: number;
  message_text: string;
}

/**
 * Analyze message for empathy needs, store emotion history, return prompt guidance
 */
export async function analyzeAndStoreEmpathy(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  channel: string = "telegram",
  conversationId?: string,
  turnNumber?: number
): Promise<string | null> {
  try {
    // 1. Run empathy detection — BERT if available, keyword fallback
    const detection = await detectEmpathyNeedsBert(message);
    const usedBert = detection.bert_signals.model_used === "bert";

    // 2. Extract primary emotion for timeline tracking
    const primaryEmotion = await extractPrimaryEmotionBert(message);

    // If no emotion detected and empathy score is very low, skip storage
    if (!primaryEmotion && detection.empathy_score < 0.1) {
      logger.debug("No significant emotion detected, skipping storage", {
        empathy_score: detection.empathy_score,
        model: usedBert ? "bert" : "keyword",
      });
      return null;
    }

    // 3. Store to emotion_history table
    const emotionRecord: EmotionRecord = {
      user_id: userId,
      conversation_id: conversationId,
      channel,
      turn_number: turnNumber,
      emotion: primaryEmotion?.emotion || "neutral",
      intensity: primaryEmotion?.intensity || 0,
      empathy_score: detection.empathy_score,
      message_text: message.substring(0, 500) // Truncate for storage
    };

    const { error } = await supabase
      .from("emotion_history")
      .insert(emotionRecord);

    if (error) {
      logger.warn("Failed to store emotion history (non-critical)", { error: error.message });
    } else {
      logger.debug("Stored emotion history", {
        emotion: emotionRecord.emotion,
        intensity: emotionRecord.intensity,
        empathy_score: detection.empathy_score,
        tier: detection.tier,
        model: usedBert ? "bert" : "keyword",
      });
    }

    // 4. Return formatted guidance for prompt injection
    return formatBertResponseGuidance(detection);
  } catch (error) {
    logger.error("Empathy analysis failed (non-critical)", {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

/**
 * Get recent emotion timeline for user (for temporal analysis)
 */
export async function getRecentEmotionTimeline(
  supabase: SupabaseClient,
  userId: string,
  limit: number = 10
): Promise<EmotionRecord[]> {
  try {
    const { data, error } = await supabase
      .from("emotion_history")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    return data || [];
  } catch (error) {
    logger.warn("Failed to fetch emotion timeline", {
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}

/**
 * Detect emotion transitions (for rings layer — temporal tracking)
 */
export function detectEmotionTransitions(timeline: EmotionRecord[]): Array<{
  from: string;
  to: string;
  pattern?: string;
}> {
  if (timeline.length < 2) return [];

  const transitions: Array<{ from: string; to: string; pattern?: string }> = [];

  for (let i = 0; i < timeline.length - 1; i++) {
    const current = timeline[i];
    const previous = timeline[i + 1];

    if (current.emotion !== previous.emotion) {
      const pattern = `${previous.emotion} → ${current.emotion}`;
      transitions.push({
        from: previous.emotion,
        to: current.emotion,
        pattern
      });
    }
  }

  return transitions;
}
