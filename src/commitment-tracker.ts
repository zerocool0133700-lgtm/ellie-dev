/**
 * Commitment Tracking — ELLIE-1067
 * Track interpersonal commitments: "I'll send you X by Friday"
 * Distinct from GTD tasks — these are promises to other people.
 * Inspired by Minutes crates/core/src/graph.rs commitments table
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./logger.ts";

const logger = log.child("commitments");

const STALE_AFTER_DAYS = 7; // Open commitment with no follow-up

export interface Commitment {
  id: string;
  content: string;
  person_name: string;
  assignee: string;
  status: "open" | "done" | "overdue" | "cancelled";
  due_date: string | null;
  source_conversation_id: string | null;
  source_channel: string | null;
  stale_reason: string | null;
  created_at: string;
}

/**
 * Create a new commitment.
 */
export async function createCommitment(
  supabase: SupabaseClient,
  opts: {
    content: string;
    personName: string;
    assignee?: string;
    dueDate?: string;
    sourceConversationId?: string;
    sourceChannel?: string;
  }
): Promise<Commitment | null> {
  const { data, error } = await supabase
    .from("commitments")
    .insert({
      content: opts.content,
      person_name: opts.personName,
      assignee: opts.assignee ?? "dave",
      due_date: opts.dueDate ?? null,
      source_conversation_id: opts.sourceConversationId ?? null,
      source_channel: opts.sourceChannel ?? null,
    })
    .select()
    .single();

  if (error) {
    logger.error("Failed to create commitment", error);
    return null;
  }

  logger.info("Commitment created", { content: opts.content, person: opts.personName });
  return data as Commitment;
}

/**
 * Complete a commitment.
 */
export async function completeCommitment(supabase: SupabaseClient, id: string): Promise<void> {
  await supabase
    .from("commitments")
    .update({
      status: "done",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
}

/**
 * Get open commitments, optionally filtered.
 */
export async function getOpenCommitments(
  supabase: SupabaseClient,
  opts?: { personName?: string; assignee?: string; includeOverdue?: boolean }
): Promise<Commitment[]> {
  let query = supabase
    .from("commitments")
    .select("*")
    .in("status", opts?.includeOverdue ? ["open", "overdue"] : ["open"])
    .order("due_date", { ascending: true, nullsFirst: false });

  if (opts?.personName) query = query.eq("person_name", opts.personName);
  if (opts?.assignee) query = query.eq("assignee", opts.assignee);

  const { data } = await query;
  return (data ?? []) as Commitment[];
}

/**
 * Detect overdue and stale commitments.
 */
export async function detectOverdueCommitments(supabase: SupabaseClient): Promise<Commitment[]> {
  const now = new Date().toISOString();
  const staleThreshold = new Date(Date.now() - STALE_AFTER_DAYS * 24 * 60 * 60_000).toISOString();

  // Mark overdue (past due date)
  await supabase
    .from("commitments")
    .update({ status: "overdue", stale_reason: "Due date has passed", updated_at: now })
    .eq("status", "open")
    .not("due_date", "is", null)
    .lt("due_date", now);

  // Mark stale (no due date but old)
  await supabase
    .from("commitments")
    .update({ stale_reason: `No update for ${STALE_AFTER_DAYS}+ days`, updated_at: now })
    .eq("status", "open")
    .is("due_date", null)
    .lt("created_at", staleThreshold);

  // Fetch all overdue + stale
  const { data } = await supabase
    .from("commitments")
    .select("*")
    .in("status", ["open", "overdue"])
    .not("stale_reason", "is", null)
    .order("created_at", { ascending: true });

  return (data ?? []) as Commitment[];
}

/**
 * Get commitment summary for a person (for meeting prep).
 */
export async function getCommitmentSummary(
  supabase: SupabaseClient,
  personName: string
): Promise<{ open: number; overdue: number; total: number; items: Commitment[] }> {
  const { data } = await supabase
    .from("commitments")
    .select("*")
    .eq("person_name", personName)
    .order("created_at", { ascending: false });

  const items = (data ?? []) as Commitment[];
  return {
    open: items.filter(c => c.status === "open").length,
    overdue: items.filter(c => c.status === "overdue").length,
    total: items.length,
    items,
  };
}

// Export for testing
export { STALE_AFTER_DAYS };
