/**
 * Search API — ELLIE-633
 *
 * Unified search endpoint that combines Elasticsearch (keyword) and
 * Supabase vector search (semantic) into a single API.
 *
 * GET /api/search?q=...&mode=hybrid&channel=...&limit=10&dateFrom=...&dateTo=...
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { checkHealth, esRequest } from "../elasticsearch.ts";
import { getConversationById } from "../conversations.ts";
import { log } from "../logger.ts";
import type { ApiRequest, ApiResponse } from "./types.ts";

const logger = log.child("search-api");

export interface SearchResult {
  id: string;
  type: "message" | "memory" | "conversation";
  content: string;
  role?: string;
  channel?: string;
  conversation_id?: string;
  created_at?: string;
  score: number;
  source: "keyword" | "semantic";
}

interface EsHit {
  _id: string;
  _index: string;
  _score?: number;
  _source: Record<string, string>;
}

// ── Keyword search via Elasticsearch ───────────────────────

async function searchKeyword(
  query: string,
  opts: { channel?: string; limit: number; dateFrom?: string; dateTo?: string },
): Promise<SearchResult[]> {
  if (!(await checkHealth())) return [];

  const filters: object[] = [];
  if (opts.channel) {
    filters.push({ term: { channel: opts.channel } });
  }
  if (opts.dateFrom || opts.dateTo) {
    const range: Record<string, string> = {};
    if (opts.dateFrom) range.gte = opts.dateFrom;
    if (opts.dateTo) range.lte = opts.dateTo;
    filters.push({ range: { created_at: range } });
  }

  const queryBody = {
    function_score: {
      query: {
        bool: {
          must: [{
            multi_match: {
              query,
              fields: ["content^2", "summary"],
              type: "best_fields",
              fuzziness: "AUTO",
            },
          }],
          filter: filters,
        },
      },
      functions: [{
        gauss: {
          created_at: { origin: "now", scale: "7d", decay: 0.5 },
        },
      }],
      boost_mode: "multiply",
      score_mode: "multiply",
    },
  };

  try {
    const result = await esRequest(
      "POST",
      "/ellie-messages,ellie-memory,ellie-conversations/_search",
      { query: queryBody, size: opts.limit, min_score: 1.0 },
    ) as { hits?: { hits?: EsHit[] } };

    const hits = result.hits?.hits;
    if (!hits?.length) return [];

    return hits.map((hit) => {
      const src = hit._source;
      const idx = hit._index;
      let type: SearchResult["type"] = "message";
      if (idx === "ellie-conversations") type = "conversation";
      else if (idx === "ellie-memory") type = "memory";

      return {
        id: hit._id,
        type,
        content: src.content || src.summary || "",
        role: src.role,
        channel: src.channel,
        conversation_id: src.conversation_id,
        created_at: src.created_at,
        score: hit._score ?? 0,
        source: "keyword" as const,
      };
    });
  } catch (err) {
    logger.error("Keyword search failed", err);
    return [];
  }
}

// ── Semantic search via Supabase edge function ─────────────

async function searchSemantic(
  supabase: SupabaseClient,
  query: string,
  opts: { limit: number },
): Promise<SearchResult[]> {
  try {
    const [msgResult, memResult] = await Promise.all([
      supabase.functions.invoke("search", {
        body: { query, table: "messages", match_count: opts.limit, match_threshold: 0.65 },
      }),
      supabase.functions.invoke("search", {
        body: { query, table: "memory", match_count: Math.ceil(opts.limit / 2), match_threshold: 0.65 },
      }),
    ]);

    const results: SearchResult[] = [];

    if (msgResult.data?.length) {
      for (const row of msgResult.data) {
        results.push({
          id: row.id,
          type: "message",
          content: row.content || "",
          role: row.role,
          channel: row.channel,
          conversation_id: row.conversation_id,
          created_at: row.created_at,
          score: row.similarity ?? 0,
          source: "semantic",
        });
      }
    }

    if (memResult.data?.length) {
      for (const row of memResult.data) {
        results.push({
          id: row.id,
          type: "memory",
          content: row.content || "",
          created_at: row.created_at,
          score: row.similarity ?? 0,
          source: "semantic",
        });
      }
    }

    return results;
  } catch (err) {
    logger.error("Semantic search failed", err);
    return [];
  }
}

// ── Merge & deduplicate ────────────────────────────────────

export function mergeResults(
  keyword: SearchResult[],
  semantic: SearchResult[],
  limit: number,
): SearchResult[] {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];

  // Normalize scores: keyword ES scores can be 1-20+, semantic are 0-1.
  // Normalize keyword to 0-1 range based on max score.
  const maxKw = keyword.reduce((m, r) => Math.max(m, r.score), 0) || 1;

  const all = [
    ...keyword.map((r) => ({ ...r, _normalizedScore: r.score / maxKw })),
    ...semantic.map((r) => ({ ...r, _normalizedScore: r.score })),
  ];

  // Sort by normalized score descending
  all.sort((a, b) => b._normalizedScore - a._normalizedScore);

  for (const item of all) {
    // Deduplicate by ID or by content substring
    const contentKey = item.content.slice(0, 100).toLowerCase();
    if (seen.has(item.id) || seen.has(contentKey)) continue;
    seen.add(item.id);
    seen.add(contentKey);

    const { _normalizedScore, ...result } = item;
    merged.push(result);
    if (merged.length >= limit) break;
  }

  return merged;
}

// ── API handler ────────────────────────────────────────────

export async function searchEndpoint(
  req: ApiRequest,
  res: ApiResponse,
  supabase: SupabaseClient,
): Promise<void> {
  const q = req.query?.q?.trim();
  if (!q) {
    return res.status(400).json({ error: "Missing required parameter: q" });
  }

  const mode = (req.query?.mode || "hybrid") as "keyword" | "semantic" | "hybrid";
  const channel = req.query?.channel;
  const limit = Math.min(parseInt(req.query?.limit || "15", 10) || 15, 50);
  const dateFrom = req.query?.dateFrom;
  const dateTo = req.query?.dateTo;

  try {
    let keyword: SearchResult[] = [];
    let semantic: SearchResult[] = [];

    if (mode === "keyword" || mode === "hybrid") {
      keyword = await searchKeyword(q, { channel, limit, dateFrom, dateTo });
    }
    if (mode === "semantic" || mode === "hybrid") {
      semantic = await searchSemantic(supabase, q, { limit });
    }

    const results = mode === "hybrid"
      ? mergeResults(keyword, semantic, limit)
      : [...keyword, ...semantic].slice(0, limit);

    return res.json({
      success: true,
      query: q,
      mode,
      count: results.length,
      results,
    });
  } catch (err) {
    logger.error("Search endpoint error", err);
    return res.status(500).json({ error: "Search failed" });
  }
}

// ── Conversation loading endpoint ──────────────────────────

export async function getConversationEndpoint(
  req: ApiRequest,
  res: ApiResponse,
  supabase: SupabaseClient,
): Promise<void> {
  const id = req.params?.id;
  if (!id) {
    return res.status(400).json({ error: "Missing conversation ID" });
  }

  const limit = parseInt(req.query?.limit || "50", 10);
  const offset = parseInt(req.query?.offset || "0", 10);

  try {
    const result = await getConversationById(supabase, id, { limit, offset });
    if (!result) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    return res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    logger.error("Get conversation error", err);
    return res.status(500).json({ error: "Failed to load conversation" });
  }
}
