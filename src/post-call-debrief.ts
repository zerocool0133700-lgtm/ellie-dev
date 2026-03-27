/**
 * Post-Call Debrief — ELLIE-1069
 * Compare meeting prep intention vs actual outcome.
 * Update relationship graph and commitment tracker.
 * Inspired by Minutes /minutes debrief command.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./logger.ts";
import { recordInteraction } from "./relationship-tracker.ts";
import { createCommitment } from "./commitment-tracker.ts";
import type { VoiceExtraction } from "./voice-extraction.ts";
import type { MeetingPrepBrief } from "./meeting-prep.ts";

const logger = log.child("debrief");

export interface DebriefResult {
  conversationId: string;
  personName: string;
  topicsAddressed: string[];
  topicsMissed: string[];
  newCommitments: number;
  newDecisions: number;
  openQuestions: string[];
  summary: string;
}

/**
 * Generate a post-call debrief by comparing prep vs extraction.
 */
export async function generateDebrief(
  supabase: SupabaseClient,
  opts: {
    conversationId: string;
    extraction: VoiceExtraction;
    prep?: MeetingPrepBrief | null;
    channel?: string;
  }
): Promise<DebriefResult> {
  const { conversationId, extraction, prep, channel = "voice" } = opts;

  // Compare topics: what was planned vs what was discussed
  const topicsAddressed: string[] = [];
  const topicsMissed: string[] = [];

  if (prep) {
    for (const topic of prep.topics) {
      const discussed = extraction.topics.some(t =>
        t.toLowerCase().includes(topic.toLowerCase()) ||
        topic.toLowerCase().includes(t.toLowerCase())
      );
      if (discussed) {
        topicsAddressed.push(topic);
      } else {
        topicsMissed.push(topic);
      }
    }
  }

  // Record interaction for each speaker
  const speakers = extraction.speakers.filter(s => s.toLowerCase() !== "dave" && s.toLowerCase() !== "ellie");
  for (const speaker of speakers) {
    await recordInteraction(supabase, {
      personName: speaker,
      channel,
      topics: extraction.topics,
    });
  }

  // Create new commitments from action items
  let newCommitments = 0;
  const personName = speakers[0] || "unknown";
  for (const item of extraction.actionItems) {
    await createCommitment(supabase, {
      content: item.task,
      personName,
      assignee: item.assignee || "dave",
      dueDate: item.due,
      sourceConversationId: conversationId,
      sourceChannel: channel,
    });
    newCommitments++;
  }

  // Build summary
  const summaryLines: string[] = [];
  summaryLines.push(`Call with ${speakers.join(", ") || "unknown"} complete.`);
  if (extraction.actionItems.length > 0) summaryLines.push(`${extraction.actionItems.length} action item(s).`);
  if (newCommitments > 0) summaryLines.push(`${newCommitments} new commitment(s).`);
  if (extraction.decisions.length > 0) summaryLines.push(`${extraction.decisions.length} decision(s) made.`);
  if (topicsMissed.length > 0) summaryLines.push(`Missed topics: ${topicsMissed.join(", ")}.`);
  if (extraction.openQuestions.length > 0) summaryLines.push(`${extraction.openQuestions.length} open question(s).`);

  const result: DebriefResult = {
    conversationId,
    personName,
    topicsAddressed,
    topicsMissed,
    newCommitments,
    newDecisions: extraction.decisions.length,
    openQuestions: extraction.openQuestions,
    summary: summaryLines.join(" "),
  };

  logger.info("Debrief generated", {
    conversationId,
    speakers,
    actionItems: extraction.actionItems.length,
    newCommitments,
    decisions: extraction.decisions.length,
    topicsMissed: topicsMissed.length,
  });

  return result;
}
