/**
 * GTD Orchestration CRUD Library — ELLIE-1151
 *
 * Pure CRUD operations for orchestration trees in the GTD system.
 * Parent items represent orchestration requests, children represent
 * dispatched agent tasks, and grandchildren represent questions for Dave.
 *
 * All functions use the Supabase client from getRelayDeps().
 */

import { getRelayDeps, broadcastDispatchEvent } from "./relay-state.ts";
import { log } from "./logger.ts";
import type { TodoRow } from "./api/gtd-types.ts";

const logger = log.child("gtd-orchestration");

// ── Types ─────────────────────────────────────────────────────

export interface DispatchTree {
  id: string;
  content: string;
  status: string;
  created_by: string | null;
  assigned_to: string | null;
  assigned_agent: string | null;
  urgency: string | null;
  created_at: string;
  elapsed_ms: number;
  dispatch_envelope_id: string | null;
  metadata: Record<string, unknown>;
  children: DispatchTree[];
}

const TERMINAL_STATUSES = ["done", "cancelled"];

// ── Helpers ───────────────────────────────────────────────────

function getSupabase() {
  const { supabase } = getRelayDeps();
  if (!supabase) throw new Error("Supabase client not available");
  return supabase;
}

function toDispatchTree(row: TodoRow): DispatchTree {
  return {
    id: row.id,
    content: row.content,
    status: row.status,
    created_by: row.created_by,
    assigned_to: row.assigned_to,
    assigned_agent: row.assigned_agent,
    urgency: row.urgency,
    created_at: row.created_at,
    elapsed_ms: Date.now() - new Date(row.created_at).getTime(),
    dispatch_envelope_id: row.dispatch_envelope_id,
    metadata: row.metadata ?? {},
    children: [],
  };
}

// ── Create operations ─────────────────────────────────────────

export async function createOrchestrationParent(opts: {
  content: string;
  createdBy: string;
  sourceRef?: string;
}): Promise<TodoRow> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("todos")
    .insert({
      content: opts.content,
      status: "open",
      assigned_to: "ellie",
      is_orchestration: true,
      created_by: opts.createdBy,
      source_ref: opts.sourceRef ?? null,
    })
    .select("*")
    .single();

  if (error) {
    logger.error("Failed to create orchestration parent", error);
    throw error;
  }

  logger.info("Created orchestration parent", { id: data.id, created_by: opts.createdBy });
  return data as TodoRow;
}

export async function createDispatchChild(opts: {
  parentId: string;
  content: string;
  assignedAgent: string;
  assignedTo: string;
  createdBy: string;
  dispatchEnvelopeId?: string;
}): Promise<TodoRow> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("todos")
    .insert({
      parent_id: opts.parentId,
      content: opts.content,
      assigned_agent: opts.assignedAgent,
      assigned_to: opts.assignedTo,
      is_orchestration: true,
      status: "open",
      created_by: opts.createdBy,
      dispatch_envelope_id: opts.dispatchEnvelopeId ?? null,
    })
    .select("*")
    .single();

  if (error) {
    logger.error("Failed to create dispatch child", error);
    throw error;
  }

  logger.info("Created dispatch child", {
    id: data.id,
    parent_id: opts.parentId,
    assigned_agent: opts.assignedAgent,
  });
  broadcastDispatchEvent({ type: "dispatch_update" });
  return data as TodoRow;
}

export async function createQuestionItem(opts: {
  parentId: string;
  content: string;
  createdBy: string;
  urgency?: "blocking" | "normal" | "low";
}): Promise<TodoRow> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("todos")
    .insert({
      parent_id: opts.parentId,
      content: opts.content,
      assigned_to: "dave",
      is_orchestration: true,
      status: "open",
      created_by: opts.createdBy,
      urgency: opts.urgency ?? "blocking",
    })
    .select("*")
    .single();

  if (error) {
    logger.error("Failed to create question item", error);
    throw error;
  }

  logger.info("Created question item", {
    id: data.id,
    parent_id: opts.parentId,
    urgency: opts.urgency ?? "blocking",
  });
  return data as TodoRow;
}

// ── Read operations ───────────────────────────────────────────

export async function getActiveOrchestrationTrees(): Promise<DispatchTree[]> {
  const supabase = getSupabase();

  // Fetch all orchestration items that are not terminal,
  // or whose parent/child might still be active
  const { data, error } = await supabase
    .from("todos")
    .select("*")
    .eq("is_orchestration", true)
    .order("created_at", { ascending: false });

  if (error) {
    logger.error("Failed to fetch orchestration items", error);
    throw error;
  }

  const rows = (data ?? []) as TodoRow[];

  // Index by id and group by parent
  const byId = new Map<string, TodoRow>();
  const childrenOf = new Map<string, TodoRow[]>();

  for (const row of rows) {
    byId.set(row.id, row);
    if (row.parent_id) {
      const siblings = childrenOf.get(row.parent_id) ?? [];
      siblings.push(row);
      childrenOf.set(row.parent_id, siblings);
    }
  }

  // Build trees starting from root items (parent_id IS NULL)
  const roots = rows.filter((r) => !r.parent_id);
  const trees: DispatchTree[] = [];

  for (const root of roots) {
    const tree = buildTree(root, childrenOf);

    // Include tree if root or any descendant is non-terminal
    if (hasNonTerminal(tree)) {
      trees.push(tree);
    }
  }

  // Sort: blocking first, then by created_at DESC
  trees.sort((a, b) => {
    const aBlocking = a.urgency === "blocking" || a.children.some((c) => c.urgency === "blocking");
    const bBlocking = b.urgency === "blocking" || b.children.some((c) => c.urgency === "blocking");
    if (aBlocking && !bBlocking) return -1;
    if (!aBlocking && bBlocking) return 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return trees;
}

function buildTree(row: TodoRow, childrenOf: Map<string, TodoRow[]>): DispatchTree {
  const node = toDispatchTree(row);
  const kids = childrenOf.get(row.id) ?? [];
  for (const kid of kids) {
    node.children.push(buildTree(kid, childrenOf));
  }
  // Sort children: blocking first, then created_at DESC
  node.children.sort((a, b) => {
    if (a.urgency === "blocking" && b.urgency !== "blocking") return -1;
    if (a.urgency !== "blocking" && b.urgency === "blocking") return 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
  return node;
}

function hasNonTerminal(tree: DispatchTree): boolean {
  if (!TERMINAL_STATUSES.includes(tree.status)) return true;
  return tree.children.some((c) => hasNonTerminal(c));
}

// ── Update operations ─────────────────────────────────────────

export async function updateItemStatus(
  id: string,
  status: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const supabase = getSupabase();

  // Build update payload
  const update: Record<string, unknown> = { status };
  if (status === "done") update.completed_at = new Date().toISOString();

  if (metadata) {
    // Merge metadata with existing — fetch current first
    const { data: current } = await supabase
      .from("todos")
      .select("metadata, parent_id")
      .eq("id", id)
      .single();

    const existing = (current?.metadata as Record<string, unknown>) ?? {};
    update.metadata = { ...existing, ...metadata };

    const { error } = await supabase.from("todos").update(update).eq("id", id);
    if (error) {
      logger.error("Failed to update item status", { id, status }, error);
      throw error;
    }

    // Check parent completion if item has a parent
    if (current?.parent_id) {
      await checkParentCompletion(current.parent_id);
    }
  } else {
    // No metadata merge needed — simpler path
    const { data: current } = await supabase
      .from("todos")
      .select("parent_id")
      .eq("id", id)
      .single();

    const { error } = await supabase.from("todos").update(update).eq("id", id);
    if (error) {
      logger.error("Failed to update item status", { id, status }, error);
      throw error;
    }

    if (current?.parent_id) {
      await checkParentCompletion(current.parent_id);
    }
  }

  logger.info("Updated item status", { id, status });
  broadcastDispatchEvent({ type: "dispatch_update" });
}

export async function checkParentCompletion(parentId: string): Promise<void> {
  const supabase = getSupabase();

  // Fetch all children of this parent in a single query
  const { data: children, error } = await supabase
    .from("todos")
    .select("id, status")
    .eq("parent_id", parentId);

  if (error) {
    logger.error("Failed to check parent completion", { parentId }, error);
    throw error;
  }

  if (!children || children.length === 0) return;

  // Check if all children are in terminal states
  const allTerminal = children.every((c) =>
    TERMINAL_STATUSES.includes(c.status) || c.status === "failed" || c.status === "timed_out",
  );

  if (!allTerminal) return;

  // Determine parent status based on children
  const allDone = children.every((c) => c.status === "done" || c.status === "cancelled");
  const anyFailed = children.some((c) => c.status === "failed" || c.status === "timed_out");

  let parentStatus: string;
  if (allDone) {
    parentStatus = "done";
  } else if (anyFailed) {
    parentStatus = "waiting_for";
  } else {
    // All cancelled
    parentStatus = "cancelled";
  }

  const update: Record<string, unknown> = { status: parentStatus };
  if (parentStatus === "done") update.completed_at = new Date().toISOString();

  const { error: updateError } = await supabase
    .from("todos")
    .update(update)
    .eq("id", parentId);

  if (updateError) {
    logger.error("Failed to update parent status", { parentId, parentStatus }, updateError);
    throw updateError;
  }

  logger.info("Parent auto-completed", { parentId, status: parentStatus });
}

// ── Cancel ────────────────────────────────────────────────────

export async function cancelItem(id: string): Promise<void> {
  const supabase = getSupabase();

  // Fetch the item to get parent_id before updating
  const { data: item } = await supabase
    .from("todos")
    .select("parent_id")
    .eq("id", id)
    .single();

  // Cancel the item itself
  const { error } = await supabase
    .from("todos")
    .update({ status: "cancelled" })
    .eq("id", id);

  if (error) {
    logger.error("Failed to cancel item", { id }, error);
    throw error;
  }

  // Cascade: cancel all open children
  const { error: childError } = await supabase
    .from("todos")
    .update({ status: "cancelled" })
    .eq("parent_id", id)
    .in("status", ["open", "inbox", "waiting_for"]);

  if (childError) {
    logger.error("Failed to cascade cancel to children", { id }, childError);
    throw childError;
  }

  // Check parent completion if this item has a parent
  if (item?.parent_id) {
    await checkParentCompletion(item.parent_id);
  }

  logger.info("Cancelled item and children", { id });
  broadcastDispatchEvent({ type: "dispatch_update" });
}

// ── Answer question ───────────────────────────────────────────

export async function answerQuestion(
  questionId: string,
  answerText: string,
): Promise<string | null> {
  const supabase = getSupabase();

  // Fetch the question to get its parent_id and existing metadata
  const { data: question, error: fetchError } = await supabase
    .from("todos")
    .select("parent_id, metadata")
    .eq("id", questionId)
    .single();

  if (fetchError) {
    logger.error("Failed to fetch question", { questionId }, fetchError);
    throw fetchError;
  }

  const existingMeta = (question?.metadata as Record<string, unknown>) ?? {};

  // Mark question as done with answer in metadata
  const { error } = await supabase
    .from("todos")
    .update({
      status: "done",
      completed_at: new Date().toISOString(),
      metadata: { ...existingMeta, answer: answerText },
    })
    .eq("id", questionId);

  if (error) {
    logger.error("Failed to answer question", { questionId }, error);
    throw error;
  }

  // Check parent completion
  if (question?.parent_id) {
    await checkParentCompletion(question.parent_id);
  }

  logger.info("Answered question", { questionId, parent_id: question?.parent_id });
  broadcastDispatchEvent({ type: "dispatch_update" });
  return question?.parent_id ?? null;
}

// ── Badge count ───────────────────────────────────────────────

export async function getOrchestrationBadgeCount(): Promise<number> {
  const supabase = getSupabase();

  const { count, error } = await supabase
    .from("todos")
    .select("id", { count: "exact", head: true })
    .eq("is_orchestration", true)
    .eq("assigned_to", "dave")
    .eq("status", "open");

  if (error) {
    logger.error("Failed to get badge count", error);
    throw error;
  }

  return count ?? 0;
}

// ── Orphan & timeout detection ────────────────────────────────

export async function findOrphanedParents(maxAgeMs: number): Promise<TodoRow[]> {
  const supabase = getSupabase();

  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

  const { data, error } = await supabase
    .from("todos")
    .select("*")
    .eq("is_orchestration", true)
    .is("parent_id", null)
    .eq("status", "open")
    .lt("created_at", cutoff);

  if (error) {
    logger.error("Failed to find orphaned parents", error);
    throw error;
  }

  return (data ?? []) as TodoRow[];
}

export async function timeoutStaleChildren(
  parentId: string,
  maxAgeMs: number,
): Promise<number> {
  const supabase = getSupabase();

  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

  const { data, error } = await supabase
    .from("todos")
    .update({ status: "timed_out" })
    .eq("parent_id", parentId)
    .eq("status", "open")
    .lt("created_at", cutoff)
    .select("id");

  if (error) {
    logger.error("Failed to timeout stale children", { parentId }, error);
    throw error;
  }

  const count = data?.length ?? 0;
  if (count > 0) {
    logger.info("Timed out stale children", { parentId, count });
    await checkParentCompletion(parentId);
  }

  return count;
}
