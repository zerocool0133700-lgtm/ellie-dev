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

export { UUID_RE };

export const VALID_STATUSES = new Set([
  "inbox", "open", "waiting_for", "someday", "done", "cancelled", "failed", "timed_out",
]);

const TERMINAL_STATUSES = new Set(["done", "cancelled", "failed", "timed_out"]);

// ── Helpers ───────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function generateQuestionId(): string {
  return `q-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function getSupabase() {
  const { supabase } = getRelayDeps();
  if (!supabase) throw new Error("Supabase client not available");
  return supabase;
}

/** Sanitize an array of UUIDs for use in .or() filter strings. */
function sanitizeUuids(ids: string[]): string[] {
  return ids.filter((id) => UUID_RE.test(id));
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
      item_type: "agent_dispatch",
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
      item_type: "agent_dispatch",
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
  metadata?: {
    question_id: string;
    what_i_need: string;
    decision_unlocked: string;
    answer_format?: "text" | "choice" | "approve_deny";
    choices?: string[] | null;
  };
}): Promise<TodoRow> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("todos")
    .insert({
      parent_id: opts.parentId,
      content: opts.content,
      assigned_to: "dave",
      is_orchestration: true,
      item_type: "agent_question",
      status: "open",
      created_by: opts.createdBy,
      urgency: opts.urgency ?? "blocking",
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
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

  // OPTIMIZATION NOTE: These 2-3 sequential queries could be replaced with a single
  // recursive CTE via supabase.rpc() (RPC is available in this project). A function like:
  //   CREATE FUNCTION get_active_orchestration_trees() RETURNS SETOF todos ...
  //   WITH RECURSIVE tree AS (SELECT * FROM todos WHERE is_orchestration AND parent_id IS NULL ...)
  // would fetch the full tree in one round-trip. Left as sequential for now — works correctly,
  // just slower (~3 round-trips vs 1). Filed as future optimization.

  // Step 1: Fetch up to 50 most recent non-terminal parent items
  const terminalList = [...TERMINAL_STATUSES];
  const { data: parents, error: parentError } = await supabase
    .from("todos")
    .select("id")
    .eq("is_orchestration", true)
    .is("parent_id", null)
    .not("status", "in", `(${terminalList.join(",")})`)
    .order("created_at", { ascending: false })
    .limit(50);

  if (parentError) {
    logger.error("Failed to fetch orchestration parents", parentError);
    throw parentError;
  }

  const parentIds = (parents ?? []).map((p) => p.id);
  if (parentIds.length === 0) return [];

  // Step 2: Fetch all descendants of those parents
  // IDs come from our own query (Step 1), not user input — but sanitize anyway for defense-in-depth
  const safeParentIds = sanitizeUuids(parentIds);
  if (safeParentIds.length === 0) return [];

  const { data, error } = await supabase
    .from("todos")
    .select("*")
    .eq("is_orchestration", true)
    .or(`id.in.(${safeParentIds.join(",")}),parent_id.in.(${safeParentIds.join(",")})`)
    .order("created_at", { ascending: false });

  if (error) {
    logger.error("Failed to fetch orchestration items", error);
    throw error;
  }

  let rows = (data ?? []) as TodoRow[];

  // Step 3: Fetch grandchildren (children of children)
  const childIds = rows.filter((r) => r.parent_id && parentIds.includes(r.parent_id)).map((r) => r.id);
  if (childIds.length > 0) {
    const { data: grandchildren, error: gcError } = await supabase
      .from("todos")
      .select("*")
      .eq("is_orchestration", true)
      .in("parent_id", childIds);

    if (gcError) {
      logger.error("Failed to fetch grandchildren", gcError);
      throw gcError;
    }
    if (grandchildren) {
      rows = rows.concat(grandchildren as TodoRow[]);
    }
  }

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
  if (!TERMINAL_STATUSES.has(tree.status)) return true;
  return tree.children.some((c) => hasNonTerminal(c));
}

// ── Update operations ─────────────────────────────────────────

export async function updateItemStatus(
  id: string,
  status: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  // Validate status
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Invalid status "${status}". Must be one of: ${[...VALID_STATUSES].join(", ")}`);
  }

  const supabase = getSupabase();

  // Atomic: update status, merge metadata, and check parent completion in one transaction
  const { data: parentId, error } = await supabase.rpc("update_item_status_atomic", {
    p_item_id: id,
    p_status: status,
    p_metadata: metadata ? metadata : null,
  });

  if (error) {
    logger.error("Failed to update item status", { id, status }, error);
    throw error;
  }

  logger.info("Updated item status", { id, status, parent_id: parentId });
  broadcastDispatchEvent({ type: "dispatch_update" });
}

export async function checkParentCompletion(parentId: string): Promise<void> {
  const supabase = getSupabase();

  // Atomic: lock parent row, check all children, update if all terminal
  // Uses FOR UPDATE on the parent to serialize concurrent child completions
  const { data: newStatus, error } = await supabase.rpc("check_parent_completion_atomic", {
    p_parent_id: parentId,
  });

  if (error) {
    logger.error("Failed to check parent completion", { parentId }, error);
    throw error;
  }

  if (newStatus) {
    logger.info("Parent auto-completed", { parentId, status: newStatus });
  }
}

// ── Cancel ────────────────────────────────────────────────────

export async function cancelItem(id: string): Promise<void> {
  const supabase = getSupabase();

  // Atomic: cancel item + all descendants via recursive CTE + check parent completion
  // All in a single transaction to prevent partial cancellation state
  const { data: cancelledCount, error } = await supabase.rpc("cancel_item_cascade", {
    p_item_id: id,
  });

  if (error) {
    logger.error("Failed to cancel item", { id }, error);
    throw error;
  }

  logger.info("Cancelled item and all descendants", { id, cancelled_count: cancelledCount });
  broadcastDispatchEvent({ type: "dispatch_update" });
}

// ── Answer question ───────────────────────────────────────────

export async function answerQuestion(
  questionId: string,
  answerText: string,
): Promise<string | null> {
  const supabase = getSupabase();

  // Atomic: mark question done with answer, merge metadata, check parent completion
  const { data: parentId, error } = await supabase.rpc("answer_question_atomic", {
    p_question_id: questionId,
    p_answer_text: answerText,
  });

  if (error) {
    logger.error("Failed to answer question", { questionId }, error);
    throw error;
  }

  logger.info("Answered question", { questionId, parent_id: parentId });
  broadcastDispatchEvent({ type: "dispatch_update" });
  return parentId ?? null;
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
