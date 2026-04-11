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
import forestSql from "../../../ellie-forest/src/db";

// ── Facts: List (reads from Forest shared_memories) ──────────

export async function listFacts(
  req: ApiRequest, res: ApiResponse, _supabase: SupabaseClient,
): Promise<void> {
  const limit = Math.min(Number(req.query?.limit) || 50, 200);
  const offset = Number(req.query?.offset) || 0;
  const type = req.query?.type;       // comma-separated: fact,preference,decision
  const category = req.query?.category;
  const tag = req.query?.tag;         // single tag to filter by
  const status = req.query?.status || "active";
  const minConfidence = req.query?.min_confidence ? Number(req.query.min_confidence) : undefined;
  const sort = req.query?.sort || "created_at";
  const order = req.query?.order === "asc" ? "ASC" : "DESC";

  try {
    const types = type ? type.split(",").map((t: string) => t.trim()) : null;

    const rows = await forestSql`
      SELECT id, content, type, category, confidence, tags, scope_path,
             cognitive_type, metadata, created_at, updated_at
      FROM shared_memories
      WHERE status = ${status}
        AND archived_at IS NULL
        ${types ? forestSql`AND type::text = ANY(${types})` : forestSql``}
        ${category ? forestSql`AND category::text = ${category}` : forestSql``}
        ${tag ? forestSql`AND tags @> ${forestSql.array([tag])}` : forestSql``}
        ${minConfidence !== undefined ? forestSql`AND confidence >= ${minConfidence}` : forestSql``}
      ORDER BY ${sort === "confidence" ? forestSql`confidence` : sort === "updated_at" ? forestSql`updated_at` : forestSql`created_at`} ${order === "ASC" ? forestSql`ASC` : forestSql`DESC`}
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [{ total }] = await forestSql<{ total: number }[]>`
      SELECT count(*)::int as total FROM shared_memories
      WHERE status = ${status} AND archived_at IS NULL
        ${types ? forestSql`AND type::text = ANY(${types})` : forestSql``}
        ${category ? forestSql`AND category::text = ${category}` : forestSql``}
        ${tag ? forestSql`AND tags @> ${forestSql.array([tag])}` : forestSql``}
        ${minConfidence !== undefined ? forestSql`AND confidence >= ${minConfidence}` : forestSql``}
    `;

    res.json({ success: true, facts: rows, total, limit, offset });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "List facts failed" });
  }
}

// ── Facts: Create ─────────────────────────────────────────────

export async function createFact(
  req: ApiRequest, res: ApiResponse, _supabase: SupabaseClient,
): Promise<void> {
  const { content, type, category, confidence, tags, scope_path } = req.body || {};

  if (!content || typeof content !== "string" || content.length < 2) {
    res.status(400).json({ error: "Content must be at least 2 characters" });
    return;
  }

  const validTypes = ["fact", "preference", "decision", "finding", "hypothesis", "contradiction"];
  if (type && !validTypes.includes(type as string)) {
    res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(", ")}` });
    return;
  }

  try {
    const { writeMemory } = await import("../../../ellie-forest/src/index");
    const result = await writeMemory({
      content,
      type: type || "fact",
      scope_path: scope_path || "2",
      confidence: Math.min(Math.max(Number(confidence) || 0.8, 0), 1),
      category: category || "general",
      tags: Array.isArray(tags) ? tags : [],
    });

    res.json({
      success: true,
      fact: {
        ...result,
        extraction_method: "manual",
      }
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Create fact failed" });
  }
}

// ── Facts: Update ─────────────────────────────────────────────

export async function updateFact(
  req: ApiRequest, res: ApiResponse, _supabase: SupabaseClient,
): Promise<void> {
  const id = req.params?.id;
  if (!id) { res.status(400).json({ error: "Fact ID required" }); return; }

  const { content, type, category, confidence, tags } = req.body || {};

  const updates: string[] = [];
  const values: unknown[] = [];

  if (content !== undefined) { updates.push("content"); values.push(content); }
  if (type !== undefined) { updates.push("type"); values.push(type); }
  if (category !== undefined) { updates.push("category"); values.push(category); }
  if (confidence !== undefined) { updates.push("confidence"); values.push(Math.min(Math.max(Number(confidence), 0), 1)); }
  if (tags !== undefined) { updates.push("tags"); values.push(tags); }

  if (updates.length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  try {
    // Build update object for postgres.js set helper
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (content !== undefined) update.content = content;
    if (confidence !== undefined) update.confidence = Math.min(Math.max(Number(confidence), 0), 1);
    if (tags !== undefined) update.tags = tags;

    const result = await forestSql`
      UPDATE shared_memories SET ${forestSql(update, ...Object.keys(update))}
        ${type !== undefined ? forestSql`, type = ${type}::memory_type` : forestSql``}
        ${category !== undefined ? forestSql`, category = ${category}::memory_category` : forestSql``}
      WHERE id = ${id}
      RETURNING *
    `;

    if (result.length === 0) { res.status(404).json({ error: "Fact not found" }); return; }

    res.json({ success: true, fact: result[0] });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Update fact failed" });
  }
}

// ── Facts: Delete (archive) ───────────────────────────────────

export async function deleteFact(
  req: ApiRequest, res: ApiResponse, _supabase: SupabaseClient,
): Promise<void> {
  const id = req.params?.id;
  if (!id) { res.status(400).json({ error: "Fact ID required" }); return; }

  try {
    await forestSql`
      UPDATE shared_memories
      SET status = 'archived', archived_at = now(), updated_at = now()
      WHERE id = ${id}
    `;

    res.json({ success: true, archived: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Delete fact failed" });
  }
}

// ── Goals: List ───────────────────────────────────────────────

export async function listGoals(
  req: ApiRequest, res: ApiResponse, _supabase: SupabaseClient,
): Promise<void> {
  const statusFilter = req.query?.status || "active"; // active, completed, overdue, all

  try {
    let statusCondition = forestSql``;
    let typeFilter = forestSql``;

    if (statusFilter === "active") {
      typeFilter = forestSql`AND type = 'goal'::memory_type`;
      statusCondition = forestSql`AND status = 'active'`;
    } else if (statusFilter === "completed") {
      typeFilter = forestSql`AND type = 'goal'::memory_type`;
      statusCondition = forestSql`AND status = 'archived'`;
    } else if (statusFilter === "overdue") {
      typeFilter = forestSql`AND type = 'goal'::memory_type`;
      statusCondition = forestSql`AND status = 'active'
        AND goal_deadline IS NOT NULL
        AND goal_deadline <= now()`;
    } else {
      // all — show both active and archived goals
      typeFilter = forestSql`AND type = 'goal'::memory_type`;
    }

    const rows = await forestSql`
      SELECT id, content, type, category, confidence, tags, status,
             goal_deadline as deadline, goal_status, goal_progress,
             created_at, updated_at
      FROM shared_memories
      WHERE archived_at IS NULL
        ${typeFilter}
        ${statusCondition}
      ORDER BY created_at DESC
    `;

    res.json({ success: true, goals: rows, count: rows?.length ?? 0, status: statusFilter });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "List goals failed" });
  }
}

// ── Goals: Complete ───────────────────────────────────────────

export async function completeGoal(
  req: ApiRequest, res: ApiResponse, _supabase: SupabaseClient,
): Promise<void> {
  const id = req.params?.id;
  if (!id) { res.status(400).json({ error: "Goal ID required" }); return; }

  try {
    // Verify it's actually an active goal
    const existing = await forestSql<{ id: string; type: string; status: string }[]>`
      SELECT id, type::text, status
      FROM shared_memories
      WHERE id = ${id}
    `;

    if (!existing || existing.length === 0) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }

    const goal = existing[0];
    if (goal.type !== "goal" || goal.status !== "active") {
      res.status(400).json({ error: "Can only complete active goals" });
      return;
    }

    const [updated] = await forestSql<{ id: string; type: string; status: string }[]>`
      UPDATE shared_memories
      SET status = 'archived',
          goal_status = 'completed',
          updated_at = now()
      WHERE id = ${id}
      RETURNING id, type::text, status, goal_status, goal_deadline, goal_progress,
                content, category, confidence, tags, created_at, updated_at
    `;

    res.json({
      success: true,
      goal: {
        ...updated,
        type: "completed_goal",
        completed_at: new Date().toISOString(),
      }
    });
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
  req: ApiRequest, res: ApiResponse, _supabase: SupabaseClient,
): Promise<void> {
  const q = req.query?.q;
  if (!q || q.length < 2) {
    res.status(400).json({ error: "Query must be at least 2 characters" });
    return;
  }

  const limit = Math.min(Number(req.query?.limit) || 20, 100);
  const type = req.query?.type;

  try {
    const { readMemories } = await import("../../../ellie-forest/src/shared-memory");
    const results = await readMemories({
      query: q,
      match_count: limit,
      match_threshold: 0.3,
    });

    const filtered = type
      ? results.filter(r => r.type === type)
      : results;

    res.json({ success: true, results: filtered, count: filtered.length, query: q });
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
    const { getMemorySearchHealth } = await import("../memory.ts");
    const health = getMemoryHealth();
    const searchHealth = getMemorySearchHealth();

    // Compute overall health grade
    let grade: "good" | "fair" | "poor" = "good";
    const issues: string[] = [];

    // ELLIE-1425: Search outage degrades health grade
    if (!searchHealth.searchAvailable) { grade = "poor"; issues.push("Memory search unavailable — dedup paused"); }
    else if (searchHealth.outageCount > 0) { if (grade !== "poor") grade = "fair"; issues.push(`${searchHealth.outageCount} search outage(s) detected`); }

    if (health.conflictRate > 0.1) { grade = "poor"; issues.push("High conflict rate"); }
    else if (health.conflictRate > 0.05) { grade = "fair"; issues.push("Moderate conflict rate"); }

    if (health.avgConfidence < 0.5) { grade = "poor"; issues.push("Low average confidence"); }
    else if (health.avgConfidence < 0.7) { if (grade !== "poor") grade = "fair"; issues.push("Below-average confidence"); }

    if (health.tagCoverage < 0.3) { if (grade !== "poor") grade = "fair"; issues.push("Low tag coverage"); }

    if (health.forestSyncRate < 0.5) { if (grade !== "poor") grade = "fair"; issues.push("Forest sync behind"); }

    if (health.staleFacts > 10) { if (grade !== "poor") grade = "fair"; issues.push(`${health.staleFacts} stale facts`); }

    res.json({ success: true, grade, issues, search: searchHealth, ...health });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Health check failed" });
  }
}
