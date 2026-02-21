/**
 * ES Forest — Search API & Aggregations (ELLIE-111)
 *
 * Multi-index search across forest data, aggregation queries for
 * ELLIE-100 (Memory Graph), and completion suggester for autocomplete.
 *
 * All functions are wrapped with the circuit breaker for graceful
 * degradation when ES is unavailable.
 */

import "dotenv/config";
import { withBreaker } from "./circuit-breaker.ts";

const ES_URL = process.env.ELASTICSEARCH_URL || "";

// ============================================================
// ES REQUEST HELPER
// ============================================================

async function esRequest(method: string, path: string, body?: object): Promise<any> {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${ES_URL}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ES ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

// ============================================================
// TYPES
// ============================================================

export interface ForestSearchResult {
  id: string;
  index: string;
  score: number;
  type: "event" | "commit" | "creature" | "tree";
  highlight?: Record<string, string[]>;
  source: Record<string, any>;
}

export interface ForestSearchOptions {
  indices?: ("events" | "commits" | "creatures" | "trees")[];
  limit?: number;
  filters?: {
    treeId?: string;
    entityName?: string;
    state?: string;
    treeType?: string;
    kind?: string;
    dateFrom?: string;
    dateTo?: string;
  };
  recencyBoost?: boolean;
}

export interface ForestMetrics {
  creaturesByEntity: Record<string, number>;
  eventsByKind: Record<string, number>;
  treesByType: Record<string, number>;
  creaturesByState: Record<string, number>;
  failureRate: number;
  totalEvents: number;
  totalCreatures: number;
  totalTrees: number;
}

export interface ForestMetricsOptions {
  timeRange?: { from: string; to: string };
  entityNames?: string[];
  treeIds?: string[];
}

// ============================================================
// INDEX NAME MAPPING
// ============================================================

const INDEX_MAP: Record<string, string> = {
  events: "ellie-forest-events",
  commits: "ellie-forest-commits",
  creatures: "ellie-forest-creatures",
  trees: "ellie-forest-trees",
};

function resolveIndices(selected?: string[]): string {
  if (!selected?.length) return Object.values(INDEX_MAP).join(",");
  return selected.map((s) => INDEX_MAP[s] || s).join(",");
}

// ============================================================
// SEARCH API
// ============================================================

/**
 * Multi-index search across forest data.
 * Returns structured results with highlights.
 */
export async function searchForest(
  query: string,
  options?: ForestSearchOptions
): Promise<ForestSearchResult[]> {
  if (!ES_URL) return [];

  const { indices, limit = 20, filters, recencyBoost = true } = options || {};
  const indexStr = resolveIndices(indices);

  // Build filters
  const filterClauses: object[] = [];
  if (filters?.treeId) filterClauses.push({ term: { tree_id: filters.treeId } });
  if (filters?.entityName) filterClauses.push({ term: { entity_name: filters.entityName } });
  if (filters?.state) filterClauses.push({ term: { state: filters.state } });
  if (filters?.treeType) filterClauses.push({ term: { tree_type: filters.treeType } });
  if (filters?.kind) filterClauses.push({ term: { kind: filters.kind } });
  if (filters?.dateFrom || filters?.dateTo) {
    const range: Record<string, string> = {};
    if (filters.dateFrom) range.gte = filters.dateFrom;
    if (filters.dateTo) range.lte = filters.dateTo;
    filterClauses.push({ range: { created_at: range } });
  }

  // Build query
  let queryBody: any = {
    bool: {
      must: [
        {
          multi_match: {
            query,
            fields: [
              "summary^3",
              "message^3",
              "intent^2",
              "title^2",
              "description",
              "content_summary",
              "error",
            ],
            type: "best_fields",
            fuzziness: "AUTO",
          },
        },
      ],
      filter: filterClauses,
    },
  };

  // Boost recent results
  if (recencyBoost) {
    queryBody = {
      function_score: {
        query: queryBody,
        functions: [
          {
            gauss: {
              created_at: { origin: "now", scale: "7d", decay: 0.5 },
            },
          },
        ],
        boost_mode: "multiply",
      },
    };
  }

  const result = await esRequest("POST", `/${indexStr}/_search`, {
    query: queryBody,
    size: limit,
    highlight: {
      fields: {
        summary: { number_of_fragments: 2 },
        message: { number_of_fragments: 2 },
        intent: { number_of_fragments: 1 },
        title: { number_of_fragments: 1 },
        description: { number_of_fragments: 2 },
      },
    },
  });

  const hits = result.hits?.hits || [];
  return hits.map((hit: any) => {
    const idx = hit._index as string;
    let type: ForestSearchResult["type"] = "event";
    if (idx.includes("commits")) type = "commit";
    else if (idx.includes("creatures")) type = "creature";
    else if (idx.includes("trees")) type = "tree";

    return {
      id: hit._id,
      index: idx,
      score: hit._score,
      type,
      highlight: hit.highlight,
      source: hit._source,
    };
  });
}

/**
 * Search with circuit breaker — returns formatted string or degradation message.
 */
export async function searchForestSafe(
  query: string,
  options?: ForestSearchOptions
): Promise<string> {
  return withBreaker(
    async () => {
      const results = await searchForest(query, options);
      if (results.length === 0) return "";

      const lines = results.map((r) => {
        const hl = r.highlight
          ? Object.values(r.highlight).flat().join(" ... ")
          : "";
        const preview = hl || r.source.summary || r.source.message || r.source.title || r.source.intent || "";
        return `[${r.type}, ${r.source.tree_type || "?"}, score:${r.score.toFixed(2)}] ${preview}`;
      });

      return "FOREST SEARCH RESULTS:\n" + lines.join("\n");
    },
    "" // empty string fallback — caller won't show anything
  );
}

// ============================================================
// AGGREGATION API (for ELLIE-100 Memory Graph)
// ============================================================

/**
 * Get forest-wide metrics for dashboards and the memory graph visualization.
 */
export async function getForestMetrics(
  options?: ForestMetricsOptions
): Promise<ForestMetrics> {
  if (!ES_URL) {
    return {
      creaturesByEntity: {}, eventsByKind: {}, treesByType: {},
      creaturesByState: {}, failureRate: 0,
      totalEvents: 0, totalCreatures: 0, totalTrees: 0,
    };
  }

  const timeFilter = options?.timeRange
    ? { range: { created_at: { gte: options.timeRange.from, lte: options.timeRange.to } } }
    : null;

  const entityFilter = options?.entityNames?.length
    ? { terms: { entity_name: options.entityNames } }
    : null;

  const treeFilter = options?.treeIds?.length
    ? { terms: { tree_id: options.treeIds } }
    : null;

  const filters = [timeFilter, entityFilter, treeFilter].filter(Boolean);
  const filterClause = filters.length > 0 ? { bool: { filter: filters } } : { match_all: {} };

  // Run three aggregation queries in parallel
  const [creatureAggs, eventAggs, treeAggs] = await Promise.all([
    // Creatures: by entity, by state, failure rate
    esRequest("POST", "/ellie-forest-creatures/_search", {
      size: 0,
      query: filterClause,
      aggs: {
        by_entity: { terms: { field: "entity_name", size: 50 } },
        by_state: { terms: { field: "state", size: 10 } },
        failed: { filter: { term: { state: "failed" } } },
      },
    }),
    // Events: by kind
    esRequest("POST", "/ellie-forest-events/_search", {
      size: 0,
      query: filterClause,
      aggs: {
        by_kind: { terms: { field: "kind", size: 50 } },
      },
    }),
    // Trees: by type
    esRequest("POST", "/ellie-forest-trees/_search", {
      size: 0,
      query: filterClause,
      aggs: {
        by_type: { terms: { field: "type", size: 20 } },
      },
    }),
  ]);

  // Parse buckets into maps
  const toBucketMap = (agg: any): Record<string, number> => {
    const map: Record<string, number> = {};
    for (const bucket of agg?.buckets || []) {
      map[bucket.key] = bucket.doc_count;
    }
    return map;
  };

  const totalCreatures = creatureAggs.hits?.total?.value || 0;
  const failedCreatures = creatureAggs.aggregations?.failed?.doc_count || 0;

  return {
    creaturesByEntity: toBucketMap(creatureAggs.aggregations?.by_entity),
    creaturesByState: toBucketMap(creatureAggs.aggregations?.by_state),
    eventsByKind: toBucketMap(eventAggs.aggregations?.by_kind),
    treesByType: toBucketMap(treeAggs.aggregations?.by_type),
    failureRate: totalCreatures > 0 ? failedCreatures / totalCreatures : 0,
    totalEvents: eventAggs.hits?.total?.value || 0,
    totalCreatures,
    totalTrees: treeAggs.hits?.total?.value || 0,
  };
}

/**
 * Get metrics with circuit breaker fallback.
 */
export async function getForestMetricsSafe(
  options?: ForestMetricsOptions
): Promise<ForestMetrics> {
  return withBreaker(
    () => getForestMetrics(options),
    {
      creaturesByEntity: {}, eventsByKind: {}, treesByType: {},
      creaturesByState: {}, failureRate: 0,
      totalEvents: 0, totalCreatures: 0, totalTrees: 0,
    }
  );
}

// ============================================================
// COMPLETION SUGGESTER
// ============================================================

/**
 * Autocomplete tree names using the completion suggester.
 */
export async function suggestTreeNames(prefix: string): Promise<string[]> {
  if (!ES_URL || !prefix) return [];

  const result = await esRequest("POST", "/ellie-forest-trees/_search", {
    suggest: {
      tree_suggest: {
        prefix,
        completion: {
          field: "tree_name_suggest",
          size: 10,
          skip_duplicates: true,
        },
      },
    },
  });

  const options = result.suggest?.tree_suggest?.[0]?.options || [];
  return options.map((o: any) => o.text);
}

/**
 * Suggest tree names with circuit breaker fallback.
 */
export async function suggestTreeNamesSafe(prefix: string): Promise<string[]> {
  return withBreaker(
    () => suggestTreeNames(prefix),
    []
  );
}
