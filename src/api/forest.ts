/**
 * Forest Module API — Knowledge browsing, search, scope navigation, timeline
 *
 * ELLIE-322: Phase 1 — API Consolidation + Query Layer
 *
 * Endpoints:
 *   GET    /api/forest/browse              — paginated, filtered memory listing
 *   POST   /api/forest/search              — semantic search with filters
 *   GET    /api/forest/memory/:id          — single memory with full metadata
 *   GET    /api/forest/memory/:id/related  — related memories (pgvector cosine similarity)
 *   GET    /api/forest/scopes              — full scope hierarchy tree
 *   GET    /api/forest/scope/:path/stats   — stats for a scope (counts, types, confidence)
 *   GET    /api/forest/timeline            — chronological memory activity
 *   POST   /api/forest/batch               — batch retrieve memories by IDs
 *   GET    /api/forest/tags                — all tags with counts
 *   GET    /api/forest/contradictions      — unresolved contradictions
 */

import type { ApiRequest, ApiResponse } from "./types.ts";
import {
  readMemories, getMemory, listMemories, getMemoryCount,
  listUnresolvedContradictions,
  getScope, getChildScopes, getFullHierarchy, getBreadcrumb,
  getDescendantScopes,
  sql,
} from "../../../ellie-forest/src/index";

// ── Browse ────────────────────────────────────────────────────

export async function browse(req: ApiRequest, res: ApiResponse): Promise<void> {
  const limit = Math.min(Number(req.query?.limit) || 50, 200);
  const offset = Number(req.query?.offset) || 0;
  const scopePath = req.query?.scope_path;
  const type = req.query?.type;
  const category = req.query?.category;
  const cognitiveType = req.query?.cognitive_type;
  const minConfidence = req.query?.min_confidence ? Number(req.query.min_confidence) : undefined;
  const tag = req.query?.tag;
  const workItem = req.query?.work_item;
  const author = req.query?.author;
  const since = req.query?.since;
  const until = req.query?.until;
  const sort = req.query?.sort || "created_at";
  const order = req.query?.order === "asc" ? "ASC" : "DESC";
  const status = req.query?.status || "active";

  try {
    // Build dynamic query
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    // Status filter
    conditions.push(`status = $${paramIndex++}`);
    params.push(status);

    if (scopePath) {
      conditions.push(`scope_path LIKE $${paramIndex++}`);
      params.push(`${scopePath}%`);
    }
    if (type) {
      conditions.push(`type = $${paramIndex++}`);
      params.push(type);
    }
    if (category) {
      conditions.push(`category = $${paramIndex++}`);
      params.push(category);
    }
    if (cognitiveType) {
      conditions.push(`cognitive_type = $${paramIndex++}`);
      params.push(cognitiveType);
    }
    if (minConfidence !== undefined) {
      conditions.push(`confidence >= $${paramIndex++}`);
      params.push(minConfidence);
    }
    if (tag) {
      conditions.push(`$${paramIndex++} = ANY(tags)`);
      params.push(tag);
    }
    if (workItem) {
      conditions.push(`metadata->>'work_item_id' = $${paramIndex++}`);
      params.push(workItem);
    }
    if (author) {
      conditions.push(`metadata->>'bridge_collaborator' = $${paramIndex++}`);
      params.push(author);
    }
    if (since) {
      conditions.push(`created_at >= $${paramIndex++}`);
      params.push(since);
    }
    if (until) {
      conditions.push(`created_at <= $${paramIndex++}`);
      params.push(until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const validSorts: Record<string, string> = {
      created_at: "created_at",
      updated_at: "updated_at",
      confidence: "confidence",
      weight: "weight",
      access_count: "access_count",
    };
    const sortCol = validSorts[sort] || "created_at";

    // Count + fetch in parallel
    const countQuery = sql.unsafe(
      `SELECT COUNT(*)::int AS total FROM shared_memories ${where}`,
      params as never[],
    );
    const dataQuery = sql.unsafe(
      `SELECT id, content, type, scope, scope_path, confidence, tags, metadata,
              cognitive_type, category, weight, access_count, duration, status,
              source_agent_species, shareable, created_at, updated_at
       FROM shared_memories ${where}
       ORDER BY ${sortCol} ${order}
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset] as never[],
    );

    const [countResult, dataResult] = await Promise.all([countQuery, dataQuery]);
    const total = countResult[0]?.total ?? 0;

    res.json({
      success: true,
      memories: dataResult,
      total,
      limit,
      offset,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Browse failed" });
  }
}

// ── Search ────────────────────────────────────────────────────

export async function search(req: ApiRequest, res: ApiResponse): Promise<void> {
  const { query, scope_path, match_count, match_threshold, category, cognitive_type } = req.body || {};

  if (!query || typeof query !== "string" || query.length < 2) {
    res.status(400).json({ error: "Query must be at least 2 characters" });
    return;
  }

  try {
    const results = await readMemories({
      query,
      scope_path: scope_path || undefined,
      match_count: Math.min(Number(match_count) || 20, 100),
      match_threshold: Number(match_threshold) || 0.5,
      category: category || undefined,
      cognitive_type: cognitive_type || undefined,
      include_global: true,
    });

    res.json({ success: true, results, count: results.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Search failed" });
  }
}

// ── Memory Detail ─────────────────────────────────────────────

export async function getMemoryDetail(req: ApiRequest, res: ApiResponse): Promise<void> {
  const id = req.params?.id;
  if (!id) {
    res.status(400).json({ error: "Memory ID required" });
    return;
  }

  try {
    const memory = await getMemory(id);
    if (!memory) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }

    // Get scope breadcrumb if scope_path exists
    let breadcrumb: { name: string; level: string; path: string }[] = [];
    if (memory.scope_path) {
      try {
        breadcrumb = await getBreadcrumb(memory.scope_path);
      } catch { /* scope may not exist */ }
    }

    res.json({ success: true, memory, breadcrumb });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Detail fetch failed" });
  }
}

// ── Related Memories ──────────────────────────────────────────

export async function getRelatedMemories(req: ApiRequest, res: ApiResponse): Promise<void> {
  const id = req.params?.id;
  if (!id) {
    res.status(400).json({ error: "Memory ID required" });
    return;
  }

  const limit = Math.min(Number(req.query?.limit) || 10, 50);
  const threshold = Number(req.query?.threshold) || 0.7;

  try {
    const memory = await getMemory(id);
    if (!memory) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }

    // Use the memory's content as a semantic search query to find related
    const results = await readMemories({
      query: memory.content,
      match_count: limit + 1, // +1 to exclude self
      match_threshold: threshold,
      include_global: true,
      scope_path: memory.scope_path || undefined,
    });

    // Filter out self
    const related = results.filter(r => r.id !== id).slice(0, limit);

    res.json({ success: true, related, count: related.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Related fetch failed" });
  }
}

// ── Scope Tree ────────────────────────────────────────────────

export async function getScopeTree(_req: ApiRequest, res: ApiResponse): Promise<void> {
  try {
    const scopes = await getFullHierarchy();

    // Build tree structure
    interface ScopeNode {
      path: string;
      name: string;
      level: string;
      description: string | null;
      children: ScopeNode[];
    }

    const nodeMap = new Map<string, ScopeNode>();
    const roots: ScopeNode[] = [];

    for (const scope of scopes) {
      const node: ScopeNode = {
        path: scope.path,
        name: scope.name,
        level: scope.level,
        description: scope.description,
        children: [],
      };
      nodeMap.set(scope.path, node);
    }

    for (const scope of scopes) {
      const parts = scope.path.split("/");
      if (parts.length <= 1) {
        roots.push(nodeMap.get(scope.path)!);
      } else {
        const parentPath = parts.slice(0, -1).join("/");
        const parent = nodeMap.get(parentPath);
        if (parent) {
          parent.children.push(nodeMap.get(scope.path)!);
        } else {
          roots.push(nodeMap.get(scope.path)!);
        }
      }
    }

    res.json({ success: true, tree: roots, total_scopes: scopes.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Scope tree failed" });
  }
}

// ── Scope Stats ───────────────────────────────────────────────

export async function getScopeStats(req: ApiRequest, res: ApiResponse): Promise<void> {
  const path = req.params?.path;
  if (!path) {
    res.status(400).json({ error: "Scope path required" });
    return;
  }

  try {
    const scope = await getScope(path);
    if (!scope) {
      res.status(404).json({ error: "Scope not found" });
      return;
    }

    const children = await getChildScopes(path);
    const breadcrumb = await getBreadcrumb(path);

    // Stats: counts by type, confidence distribution, category breakdown
    const [typeBreakdown, confidenceDist, categoryBreakdown, recentActivity, totalCount] = await Promise.all([
      sql`SELECT type, COUNT(*)::int AS count
          FROM shared_memories
          WHERE scope_path LIKE ${path + "%"} AND status = 'active'
          GROUP BY type ORDER BY count DESC`,

      sql`SELECT
            COUNT(*) FILTER (WHERE confidence >= 0.8)::int AS high,
            COUNT(*) FILTER (WHERE confidence >= 0.5 AND confidence < 0.8)::int AS medium,
            COUNT(*) FILTER (WHERE confidence < 0.5)::int AS low
          FROM shared_memories
          WHERE scope_path LIKE ${path + "%"} AND status = 'active'`,

      sql`SELECT category, COUNT(*)::int AS count
          FROM shared_memories
          WHERE scope_path LIKE ${path + "%"} AND status = 'active'
          GROUP BY category ORDER BY count DESC`,

      sql`SELECT DATE(created_at) AS day, COUNT(*)::int AS count
          FROM shared_memories
          WHERE scope_path LIKE ${path + "%"} AND status = 'active'
            AND created_at >= NOW() - INTERVAL '30 days'
          GROUP BY DATE(created_at)
          ORDER BY day DESC`,

      sql`SELECT COUNT(*)::int AS total
          FROM shared_memories
          WHERE scope_path LIKE ${path + "%"} AND status = 'active'`,
    ]);

    res.json({
      success: true,
      scope: {
        path: scope.path,
        name: scope.name,
        level: scope.level,
        description: scope.description,
      },
      breadcrumb,
      children: children.map(c => ({ path: c.path, name: c.name, level: c.level })),
      stats: {
        total: totalCount[0]?.total ?? 0,
        by_type: typeBreakdown,
        confidence: confidenceDist[0] || { high: 0, medium: 0, low: 0 },
        by_category: categoryBreakdown,
        recent_activity: recentActivity,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Scope stats failed" });
  }
}

// ── Timeline ──────────────────────────────────────────────────

export async function getTimeline(req: ApiRequest, res: ApiResponse): Promise<void> {
  const days = Math.min(Number(req.query?.days) || 30, 90);
  const scopePath = req.query?.scope_path;
  const limit = Math.min(Number(req.query?.limit) || 100, 500);

  try {
    const scopeFilter = scopePath
      ? sql`AND scope_path LIKE ${scopePath + "%"}`
      : sql``;

    const memories = await sql`
      SELECT id, content, type, scope_path, confidence, tags, metadata,
             cognitive_type, category, created_at
      FROM shared_memories
      WHERE status = 'active'
        AND created_at >= NOW() - ${days + " days"}::interval
        ${scopeFilter}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    // Group by day
    const byDay: Record<string, unknown[]> = {};
    for (const m of memories) {
      const day = new Date(m.created_at).toISOString().split("T")[0];
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(m);
    }

    res.json({
      success: true,
      timeline: byDay,
      total: memories.length,
      days,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Timeline failed" });
  }
}

// ── Batch Retrieve ────────────────────────────────────────────

export async function batchRetrieve(req: ApiRequest, res: ApiResponse): Promise<void> {
  const { ids } = req.body || {};

  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "ids array required" });
    return;
  }
  if (ids.length > 100) {
    res.status(400).json({ error: "Maximum 100 IDs per batch" });
    return;
  }

  try {
    const memories = await sql`
      SELECT id, content, type, scope, scope_path, confidence, tags, metadata,
             cognitive_type, category, weight, access_count, duration, status,
             source_agent_species, shareable, created_at, updated_at
      FROM shared_memories
      WHERE id = ANY(${ids})
    `;

    res.json({ success: true, memories, count: memories.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Batch retrieve failed" });
  }
}

// ── Tags ──────────────────────────────────────────────────────

export async function getTags(req: ApiRequest, res: ApiResponse): Promise<void> {
  const scopePath = req.query?.scope_path;

  try {
    const scopeFilter = scopePath
      ? sql`AND scope_path LIKE ${scopePath + "%"}`
      : sql``;

    const tags = await sql`
      SELECT unnest(tags) AS tag, COUNT(*)::int AS count
      FROM shared_memories
      WHERE status = 'active'
        ${scopeFilter}
      GROUP BY tag
      ORDER BY count DESC
      LIMIT 200
    `;

    res.json({ success: true, tags, count: tags.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Tags failed" });
  }
}

// ── Contradictions ────────────────────────────────────────────

export async function getContradictions(_req: ApiRequest, res: ApiResponse): Promise<void> {
  try {
    const contradictions = await listUnresolvedContradictions();
    res.json({ success: true, contradictions, count: contradictions.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Contradictions failed" });
  }
}
