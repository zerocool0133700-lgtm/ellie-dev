/**
 * Memory Module API — ELLIE-323
 *
 * Endpoints:
 *   GET    /api/memory/facts                — list facts (filtered by type, category, confidence, tags)
 *   POST   /api/memory/facts                — create fact manually
 *   PUT    /api/memory/facts/:id            — update fact
 *   DELETE /api/memory/facts/:id            — archive fact (soft delete)
 *   GET    /api/memory/goals                — list goals (active, completed, overdue)
 *   POST   /api/memory/goals/:id/complete   — mark goal complete
 *   GET    /api/memory/conflicts            — unresolved conflicts
 *   POST   /api/memory/conflicts/:id/resolve — resolve a conflict
 *   GET    /api/memory/search               — semantic search across facts
 *   GET    /api/memory/tags                 — all tags with counts
 *   GET    /api/memory/module-stats         — live module stats from consumer
 *   GET    /api/memory/health              — memory health report (Phase 2)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiRequest, ApiResponse } from "./types.ts";

// ── Facts: List ───────────────────────────────────────────────

export async function listFacts(
  req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  const limit = Math.min(Number(req.query?.limit) || 50, 200);
  const offset = Number(req.query?.offset) || 0;
  const type = req.query?.type;       // comma-separated: fact,preference,decision
  const category = req.query?.category;
  const status = req.query?.status || "active";
  const minConfidence = req.query?.min_confidence ? Number(req.query.min_confidence) : undefined;
  const tag = req.query?.tag;
  const sort = req.query?.sort || "created_at";
  const order = req.query?.order === "asc" ? true : false;

  try {
    let query = supabase
      .from("conversation_facts")
      .select("*", { count: "exact" })
      .eq("status", status);

    if (type) {
      const types = type.split(",").map(t => t.trim());
      query = query.in("type", types);
    }
    if (category) {
      query = query.eq("category", category);
    }
    if (minConfidence !== undefined) {
      query = query.gte("confidence", minConfidence);
    }
    if (tag) {
      query = query.contains("tags", [tag]);
    }

    const validSorts: Record<string, string> = {
      created_at: "created_at",
      updated_at: "updated_at",
      confidence: "confidence",
    };
    const sortCol = validSorts[sort] || "created_at";

    query = query
      .order(sortCol, { ascending: order })
      .range(offset, offset + limit - 1);

    const { data, count, error } = await query;
    if (error) throw error;

    res.json({ success: true, facts: data, total: count ?? 0, limit, offset });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "List facts failed" });
  }
}

// ── Facts: Create ─────────────────────────────────────────────

export async function createFact(
  req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  const { content, type, category, confidence, tags, deadline } = req.body || {};

  if (!content || typeof content !== "string" || content.length < 2) {
    res.status(400).json({ error: "Content must be at least 2 characters" });
    return;
  }

  const validTypes = ["fact", "preference", "goal", "decision", "constraint", "contact"];
  if (type && !validTypes.includes(type as string)) {
    res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(", ")}` });
    return;
  }

  try {
    const row: Record<string, unknown> = {
      content,
      type: type || "fact",
      category: category || "other",
      confidence: Math.min(Math.max(Number(confidence) || 1.0, 0), 1),
      extraction_method: "manual",
      tags: Array.isArray(tags) ? tags : [],
    };

    if (deadline) {
      try { row.deadline = new Date(deadline as string).toISOString(); } catch { /* skip */ }
    }

    const { data, error } = await supabase
      .from("conversation_facts")
      .insert(row)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, fact: data });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Create fact failed" });
  }
}

// ── Facts: Update ─────────────────────────────────────────────

export async function updateFact(
  req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  const id = req.params?.id;
  if (!id) { res.status(400).json({ error: "Fact ID required" }); return; }

  const { content, type, category, confidence, tags } = req.body || {};

  const update: Record<string, unknown> = {};
  if (content !== undefined) update.content = content;
  if (type !== undefined) update.type = type;
  if (category !== undefined) update.category = category;
  if (confidence !== undefined) update.confidence = Math.min(Math.max(Number(confidence), 0), 1);
  if (tags !== undefined) update.tags = tags;

  if (Object.keys(update).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  try {
    const { data, error } = await supabase
      .from("conversation_facts")
      .update(update)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    if (!data) { res.status(404).json({ error: "Fact not found" }); return; }

    res.json({ success: true, fact: data });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Update fact failed" });
  }
}

// ── Facts: Delete (archive) ───────────────────────────────────

export async function deleteFact(
  req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  const id = req.params?.id;
  if (!id) { res.status(400).json({ error: "Fact ID required" }); return; }

  try {
    const { error } = await supabase
      .from("conversation_facts")
      .update({ status: "archived", archived_at: new Date().toISOString() })
      .eq("id", id);

    if (error) throw error;

    res.json({ success: true, archived: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Delete fact failed" });
  }
}

// ── Goals: List ───────────────────────────────────────────────

export async function listGoals(
  req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  const statusFilter = req.query?.status || "active"; // active, completed, overdue, all

  try {
    let query = supabase
      .from("conversation_facts")
      .select("*");

    if (statusFilter === "active") {
      query = query.in("type", ["goal"]).eq("status", "active");
    } else if (statusFilter === "completed") {
      query = query.eq("type", "completed_goal");
    } else if (statusFilter === "overdue") {
      query = query
        .eq("type", "goal")
        .eq("status", "active")
        .not("deadline", "is", null)
        .lte("deadline", new Date().toISOString());
    } else {
      // all
      query = query.in("type", ["goal", "completed_goal"]);
    }

    query = query.order("created_at", { ascending: false });

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, goals: data, count: data?.length ?? 0, status: statusFilter });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "List goals failed" });
  }
}

// ── Goals: Complete ───────────────────────────────────────────

export async function completeGoal(
  req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  const id = req.params?.id;
  if (!id) { res.status(400).json({ error: "Goal ID required" }); return; }

  try {
    // Verify it's actually an active goal
    const { data: existing, error: fetchErr } = await supabase
      .from("conversation_facts")
      .select("id, type, status")
      .eq("id", id)
      .single();

    if (fetchErr || !existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    if (existing.type !== "goal" || existing.status !== "active") {
      res.status(400).json({ error: "Can only complete active goals" });
      return;
    }

    const { data, error } = await supabase
      .from("conversation_facts")
      .update({
        type: "completed_goal",
        status: "archived",
        completed_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, goal: data });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Complete goal failed" });
  }
}

// ── Conflicts: List ───────────────────────────────────────────

export async function listConflicts(
  req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  const statusFilter = req.query?.status || "open";

  try {
    const { data, error } = await supabase
      .from("memory_conflicts")
      .select(`
        *,
        fact_a:conversation_facts!memory_conflicts_fact_a_id_fkey(id, content, type, confidence, created_at),
        fact_b:conversation_facts!memory_conflicts_fact_b_id_fkey(id, content, type, confidence, created_at)
      `)
      .eq("status", statusFilter)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({ success: true, conflicts: data, count: data?.length ?? 0 });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "List conflicts failed" });
  }
}

// ── Conflicts: Resolve ────────────────────────────────────────

export async function resolveConflict(
  req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  const id = req.params?.id;
  if (!id) { res.status(400).json({ error: "Conflict ID required" }); return; }

  const { keep, merged_content } = req.body || {};

  if (!keep || !["a", "b", "merge", "both"].includes(keep as string)) {
    res.status(400).json({ error: "keep must be 'a', 'b', 'merge', or 'both'" });
    return;
  }
  if (keep === "merge" && !merged_content) {
    res.status(400).json({ error: "merged_content required for merge resolution" });
    return;
  }

  try {
    // Get the conflict with fact references
    const { data: conflict, error: fetchErr } = await supabase
      .from("memory_conflicts")
      .select("*")
      .eq("id", id)
      .eq("status", "open")
      .single();

    if (fetchErr || !conflict) {
      res.status(404).json({ error: "Open conflict not found" });
      return;
    }

    const resolution = keep === "a" ? "keep_a" : keep === "b" ? "keep_b"
      : keep === "merge" ? "merge" : "keep_both";

    // Update conflict record
    await supabase
      .from("memory_conflicts")
      .update({
        status: "resolved",
        resolution,
        resolved_content: merged_content as string || null,
        resolved_by: "user",
        resolved_at: new Date().toISOString(),
      })
      .eq("id", id);

    // Apply resolution to facts
    if (keep === "a") {
      await supabase.from("conversation_facts")
        .update({ status: "superseded", superseded_by: conflict.fact_a_id })
        .eq("id", conflict.fact_b_id);
    } else if (keep === "b") {
      await supabase.from("conversation_facts")
        .update({ status: "superseded", superseded_by: conflict.fact_b_id })
        .eq("id", conflict.fact_a_id);
    } else if (keep === "merge") {
      // Update fact A with merged content, supersede fact B
      await supabase.from("conversation_facts")
        .update({ content: merged_content as string })
        .eq("id", conflict.fact_a_id);
      await supabase.from("conversation_facts")
        .update({ status: "superseded", superseded_by: conflict.fact_a_id })
        .eq("id", conflict.fact_b_id);
    }
    // keep_both: no fact changes needed

    res.json({ success: true, resolution, conflict_id: id });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Resolve conflict failed" });
  }
}

// ── Search ────────────────────────────────────────────────────

export async function searchFacts(
  req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  const q = req.query?.q;
  if (!q || q.length < 2) {
    res.status(400).json({ error: "Query must be at least 2 characters" });
    return;
  }

  const limit = Math.min(Number(req.query?.limit) || 20, 100);
  const type = req.query?.type;

  try {
    // Text search via ILIKE (embedding search would be better but requires Edge Function)
    let query = supabase
      .from("conversation_facts")
      .select("*")
      .eq("status", "active")
      .ilike("content", `%${q}%`)
      .order("confidence", { ascending: false })
      .limit(limit);

    if (type) {
      query = query.eq("type", type);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, results: data, count: data?.length ?? 0, query: q });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Search failed" });
  }
}

// ── Tags ──────────────────────────────────────────────────────

export async function listTags(
  _req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  try {
    // Supabase doesn't support unnest directly, so fetch all tags and aggregate
    const { data, error } = await supabase
      .from("conversation_facts")
      .select("tags")
      .eq("status", "active")
      .not("tags", "eq", "{}");

    if (error) throw error;

    const tagCounts: Record<string, number> = {};
    for (const row of data || []) {
      for (const tag of row.tags || []) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }

    const tags = Object.entries(tagCounts)
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);

    res.json({ success: true, tags, count: tags.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Tags failed" });
  }
}

// ── Module Stats ──────────────────────────────────────────────

export async function getModuleStats(
  _req: ApiRequest, res: ApiResponse,
): Promise<void> {
  try {
    const { getMemoryStats } = await import("../ums/consumers/memory.ts");
    const stats = getMemoryStats();
    res.json({ success: true, ...stats });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Module stats failed" });
  }
}

// ── Health (Phase 2) ──────────────────────────────────────────

export async function getHealth(
  _req: ApiRequest, res: ApiResponse,
): Promise<void> {
  try {
    const { getMemoryHealth } = await import("../ums/consumers/memory.ts");
    const health = getMemoryHealth();

    // Compute overall health grade
    let grade: "good" | "fair" | "poor" = "good";
    const issues: string[] = [];

    if (health.conflictRate > 0.1) { grade = "poor"; issues.push("High conflict rate"); }
    else if (health.conflictRate > 0.05) { grade = "fair"; issues.push("Moderate conflict rate"); }

    if (health.avgConfidence < 0.5) { grade = "poor"; issues.push("Low average confidence"); }
    else if (health.avgConfidence < 0.7) { if (grade !== "poor") grade = "fair"; issues.push("Below-average confidence"); }

    if (health.tagCoverage < 0.3) { if (grade !== "poor") grade = "fair"; issues.push("Low tag coverage"); }

    if (health.forestSyncRate < 0.5) { if (grade !== "poor") grade = "fair"; issues.push("Forest sync behind"); }

    if (health.staleFacts > 10) { if (grade !== "poor") grade = "fair"; issues.push(`${health.staleFacts} stale facts`); }

    res.json({ success: true, grade, issues, ...health });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Health check failed" });
  }
}
