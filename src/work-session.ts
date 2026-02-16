/**
 * Work Session API Integration
 *
 * Handles communication between Claude Code sessions and Ellie Home unified system.
 * Endpoints:
 * - POST /api/work-session/start
 * - POST /api/work-session/update
 * - POST /api/work-session/decision
 * - POST /api/work-session/complete
 */

import { supabase } from "./supabase";

interface WorkSessionStart {
  work_item_id: string;
  work_item_title: string;
  agent: string;
  repository: string;
  session_id: string;
  timestamp: string;
}

interface WorkSessionUpdate {
  session_id: string;
  work_item_id: string;
  timestamp: string;
  update_type: "progress" | "decision" | "milestone" | "blocker";
  summary: string;
  details?: {
    files_changed?: string[];
    lines_added?: number;
    lines_removed?: number;
    commits?: string[];
  };
}

interface WorkSessionDecision {
  session_id: string;
  work_item_id: string;
  timestamp: string;
  decision: string;
  reasoning: string;
  alternatives_considered?: string[];
  impact: string;
}

interface WorkSessionComplete {
  session_id: string;
  work_item_id: string;
  timestamp: string;
  status: "completed" | "blocked" | "paused";
  summary: string;
  deliverables?: {
    files_changed?: string[];
    tests_added?: number;
    commits?: string[];
  };
  next_steps?: string;
  time_spent_minutes?: number;
}

/**
 * Log work session start
 */
export async function logWorkSessionStart(data: WorkSessionStart): Promise<void> {
  const { error } = await supabase.from("work_sessions").insert({
    session_id: data.session_id,
    work_item_id: data.work_item_id,
    work_item_title: data.work_item_title,
    agent: data.agent,
    repository: data.repository,
    status: "in_progress",
    started_at: data.timestamp,
  });

  if (error) {
    console.error("Failed to log work session start:", error);
    throw error;
  }

  // Store in memory for context
  await supabase.from("memory").insert({
    user_id: process.env.TELEGRAM_USER_ID,
    type: "fact",
    text: `Started work on ${data.work_item_id}: ${data.work_item_title} using ${data.agent} agent`,
    context: {
      session_id: data.session_id,
      work_item_id: data.work_item_id,
      agent: data.agent,
      repository: data.repository,
    },
  });
}

/**
 * Log work session progress update
 */
export async function logWorkSessionUpdate(data: WorkSessionUpdate): Promise<void> {
  // Log to work_session_updates table
  const { error: updateError } = await supabase.from("work_session_updates").insert({
    session_id: data.session_id,
    work_item_id: data.work_item_id,
    update_type: data.update_type,
    summary: data.summary,
    details: data.details,
    timestamp: data.timestamp,
  });

  if (updateError) {
    console.error("Failed to log work session update:", updateError);
    throw updateError;
  }

  // Update session last_activity_at
  await supabase
    .from("work_sessions")
    .update({ last_activity_at: data.timestamp })
    .eq("session_id", data.session_id);

  // For blockers, send Telegram notification
  if (data.update_type === "blocker") {
    // TODO: Send Telegram notification via existing bot
    console.log(`BLOCKER on ${data.work_item_id}: ${data.summary}`);
  }
}

/**
 * Log architectural or implementation decision
 */
export async function logWorkSessionDecision(data: WorkSessionDecision): Promise<void> {
  const { error } = await supabase.from("work_session_decisions").insert({
    session_id: data.session_id,
    work_item_id: data.work_item_id,
    decision: data.decision,
    reasoning: data.reasoning,
    alternatives_considered: data.alternatives_considered,
    impact: data.impact,
    timestamp: data.timestamp,
  });

  if (error) {
    console.error("Failed to log work session decision:", error);
    throw error;
  }

  // Store in memory as a notable fact
  await supabase.from("memory").insert({
    user_id: process.env.TELEGRAM_USER_ID,
    type: "fact",
    text: `Decision on ${data.work_item_id}: ${data.decision}. Reasoning: ${data.reasoning}`,
    context: {
      session_id: data.session_id,
      work_item_id: data.work_item_id,
      impact: data.impact,
      alternatives: data.alternatives_considered,
    },
  });
}

/**
 * Complete work session and update Plane
 */
export async function completeWorkSession(data: WorkSessionComplete): Promise<void> {
  // Update work session record
  const { error: sessionError } = await supabase
    .from("work_sessions")
    .update({
      status: data.status,
      completed_at: data.timestamp,
      summary: data.summary,
      deliverables: data.deliverables,
      next_steps: data.next_steps,
      time_spent_minutes: data.time_spent_minutes,
    })
    .eq("session_id", data.session_id);

  if (sessionError) {
    console.error("Failed to complete work session:", sessionError);
    throw sessionError;
  }

  // Store completion in memory
  await supabase.from("memory").insert({
    user_id: process.env.TELEGRAM_USER_ID,
    type: "fact",
    text: `Completed work on ${data.work_item_id}: ${data.summary}`,
    context: {
      session_id: data.session_id,
      work_item_id: data.work_item_id,
      status: data.status,
      time_spent_minutes: data.time_spent_minutes,
      deliverables: data.deliverables,
      next_steps: data.next_steps,
    },
  });

  // TODO: Update Plane issue status via MCP
  // TODO: Send Telegram notification with summary
}

/**
 * Get recent work session activity for context
 */
export async function getRecentWorkSessions(limit: number = 10) {
  const { data, error } = await supabase
    .from("work_sessions")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("Failed to fetch recent work sessions:", error);
    return [];
  }

  return data;
}
