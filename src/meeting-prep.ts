/**
 * Meeting Prep — ELLIE-1068
 * Generate pre-meeting relationship briefs.
 * Inspired by Minutes /minutes prep command.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./logger.ts";
import { getPersonProfile } from "./relationship-tracker.ts";
import { getCommitmentSummary } from "./commitment-tracker.ts";

const logger = log.child("meeting-prep");

export interface MeetingPrepBrief {
  personName: string;
  relationship: {
    meetingCount: number;
    lastSeen: string | null;
    channels: string[];
    score: number;
    status: string;
  } | null;
  commitments: {
    open: number;
    overdue: number;
    items: Array<{ content: string; status: string; due_date: string | null }>;
  };
  topics: string[];
  talkingPoints: string[];
  formatted: string;
}

/**
 * Generate a meeting prep brief for a person.
 */
export async function generateMeetingPrep(
  supabase: SupabaseClient,
  personName: string
): Promise<MeetingPrepBrief> {
  // Fetch relationship profile
  const profile = await getPersonProfile(supabase, personName);

  // Fetch commitments
  const commitmentSummary = await getCommitmentSummary(supabase, personName);

  // Build talking points
  const talkingPoints: string[] = [];

  // Add overdue commitments as top priority
  for (const c of commitmentSummary.items.filter(i => i.status === "overdue")) {
    talkingPoints.push(`Follow up on overdue: ${c.content}`);
  }

  // Add open commitments
  for (const c of commitmentSummary.items.filter(i => i.status === "open").slice(0, 3)) {
    talkingPoints.push(`Check status: ${c.content}`);
  }

  // Add recent topics as discussion starters
  const topics = profile?.top_topics ?? [];
  for (const topic of topics.slice(0, 3)) {
    talkingPoints.push(`Discuss: ${topic}`);
  }

  // Format the brief
  const lines: string[] = [];
  lines.push(`## Prep: Meeting with ${personName}`);
  lines.push("");

  if (profile) {
    lines.push(`**Last contact:** ${profile.last_seen_at ? new Date(profile.last_seen_at).toLocaleDateString() : "Never"} via ${profile.channels.join(", ") || "unknown"}`);
    lines.push(`**Meeting count:** ${profile.meeting_count} interactions`);
    lines.push(`**Relationship:** ${profile.relationship_score} (${profile.status})`);
  } else {
    lines.push(`**First meeting** — no prior interaction history`);
  }

  lines.push("");
  if (commitmentSummary.items.length > 0) {
    lines.push("### Open Commitments");
    for (const c of commitmentSummary.items.filter(i => i.status !== "done" && i.status !== "cancelled")) {
      const due = c.due_date ? ` (due: ${new Date(c.due_date).toLocaleDateString()})` : "";
      const marker = c.status === "overdue" ? "⚠️" : "☐";
      lines.push(`- ${marker} ${c.content}${due}`);
    }
    lines.push("");
  }

  if (topics.length > 0) {
    lines.push("### Recent Topics");
    for (const t of topics) {
      lines.push(`- ${t}`);
    }
    lines.push("");
  }

  if (talkingPoints.length > 0) {
    lines.push("### Suggested Talking Points");
    for (const tp of talkingPoints) {
      lines.push(`- ${tp}`);
    }
  }

  const formatted = lines.join("\n");

  logger.info("Meeting prep generated", { personName, commitments: commitmentSummary.open, topics: topics.length });

  return {
    personName,
    relationship: profile ? {
      meetingCount: profile.meeting_count,
      lastSeen: profile.last_seen_at,
      channels: profile.channels,
      score: profile.relationship_score,
      status: profile.status,
    } : null,
    commitments: {
      open: commitmentSummary.open,
      overdue: commitmentSummary.overdue,
      items: commitmentSummary.items.map(c => ({
        content: c.content,
        status: c.status,
        due_date: c.due_date,
      })),
    },
    topics,
    talkingPoints,
    formatted,
  };
}
