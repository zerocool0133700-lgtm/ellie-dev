/**
 * Elasticsearch Module
 *
 * Provides full-text search with domain filtering to augment
 * Supabase's vector-based semantic search.
 *
 * Uses raw fetch() instead of the @elastic/elasticsearch client
 * because the official client has compatibility issues with Bun's
 * HTTP implementation. The ES REST API is simple enough that
 * fetch() works perfectly.
 *
 * ES is optional — if unavailable, functions return empty results
 * and log warnings. The bot never breaks because ES is down.
 */

import { log } from "./logger.ts";

const logger = log.child("es");

const ES_URL = process.env.ELASTICSEARCH_URL || "";

let esAvailable = true;

/**
 * Check if ES is reachable. Disables for 60s on failure.
 */
async function checkHealth(): Promise<boolean> {
  if (!ES_URL) return false;
  if (!esAvailable) return false;

  try {
    const res = await fetch(`${ES_URL}/_cluster/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    logger.warn("Elasticsearch unreachable, disabling for 60s");
    esAvailable = false;
    setTimeout(() => {
      esAvailable = true;
    }, 60_000);
    return false;
  }
}

/**
 * Send a request to Elasticsearch.
 */
async function esRequest(
  method: string,
  path: string,
  body?: object
): Promise<unknown> {
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
// DOMAIN CLASSIFICATION
// ============================================================

const DOMAIN_RULES: [string, RegExp][] = [
  [
    "architecture",
    /\b(server|deploy|docker|elastic|supabase|database|infra|vps|systemd|nginx|cloudflare|tunnel|port|cluster)\b/i,
  ],
  [
    "technology",
    /\b(typescript|javascript|bun|node|api|sdk|framework|library|cli|mcp|nuxt|vue|react|twilio|groq|anthropic|openai|elevenlabs)\b/i,
  ],
  [
    "processing",
    /\b(pipeline|consolidat|embed|sync|cron|batch|process|workflow|automat|timer|webhook|queue)\b/i,
  ],
  [
    "personal",
    /\b(dave|prefer|schedule|timezone|dinner|pick.?up|dyslexia|hobby|game)\b/i,
  ],
  [
    "projects",
    /\b(eve online|pi production|miro|plane|kanban|ellie.?home|telegram.?relay)\b/i,
  ],
  [
    "business",
    /\b(client|revenue|cost|business|work|meeting|deadline|invoice|customer)\b/i,
  ],
];

/**
 * Classify content into a domain using keyword matching.
 */
export function classifyDomain(content: string): string {
  for (const [domain, regex] of DOMAIN_RULES) {
    if (regex.test(content)) return domain;
  }
  return "general";
}

// ============================================================
// INDEXING
// ============================================================

/**
 * Index a message document. Fire-and-forget from relay.
 */
export async function indexMessage(doc: {
  id: string;
  content: string;
  role: string;
  channel: string;
  created_at: string;
  conversation_id?: string;
  summarized?: boolean;
  source_agent?: string;
}): Promise<void> {
  if (!(await checkHealth())) return;

  try {
    await esRequest("PUT", `/ellie-messages/_doc/${doc.id}`, {
      ...doc,
      domain: classifyDomain(doc.content),
    });
  } catch (err) {
    logger.error("Failed to index message", err);
  }
}

/**
 * Index a memory entry (fact, action_item, summary, goal).
 */
export async function indexMemory(doc: {
  id: string;
  content: string;
  type: string;
  domain?: string;
  created_at: string;
  conversation_id?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!(await checkHealth())) return;

  try {
    await esRequest("PUT", `/ellie-memory/_doc/${doc.id}`, {
      ...doc,
      domain: doc.domain || classifyDomain(doc.content),
    });
  } catch (err) {
    logger.error("Failed to index memory", err);
  }
}

/**
 * Index a conversation record.
 */
export async function indexConversation(doc: {
  id: string;
  summary: string;
  channel: string;
  started_at: string;
  ended_at: string;
  message_count: number;
}): Promise<void> {
  if (!(await checkHealth())) return;

  try {
    await esRequest("PUT", `/ellie-conversations/_doc/${doc.id}`, {
      ...doc,
      domain: doc.summary ? classifyDomain(doc.summary) : "general",
    });
  } catch (err) {
    logger.error("Failed to index conversation", err);
  }
}

// ============================================================
// BULK INDEXING (for backfill)
// ============================================================

/**
 * Bulk index documents. Used by sync script.
 */
export async function bulkIndex(
  operations: Array<{ index: string; id: string; doc: object }>
): Promise<{ errors: number; indexed: number }> {
  if (!ES_URL) return { errors: 0, indexed: 0 };

  // Build NDJSON body
  const lines: string[] = [];
  for (const op of operations) {
    lines.push(JSON.stringify({ index: { _index: op.index, _id: op.id } }));
    lines.push(JSON.stringify(op.doc));
  }
  const ndjson = lines.join("\n") + "\n";

  const res = await fetch(`${ES_URL}/_bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/x-ndjson" },
    body: ndjson,
    signal: AbortSignal.timeout(30_000),
  });

  const result = await res.json();
  const errorCount = result.items?.filter((i: Record<string, Record<string, unknown>>) => i.index?.error).length || 0;

  return { errors: errorCount, indexed: operations.length - errorCount };
}

// ============================================================
// SEARCH
// ============================================================

/**
 * Search across all Ellie indices with optional domain filtering.
 * Returns a formatted string ready for injection into prompts,
 * or empty string if nothing found / ES unavailable.
 */
export async function searchElastic(
  query: string,
  options?: {
    domains?: string[];
    types?: string[];
    channel?: string;
    sourceAgent?: string;
    excludeConversationId?: string;
    limit?: number;
    recencyBoost?: boolean;
  }
): Promise<string> {
  if (!(await checkHealth())) return "";
  if (query.trim().length < 10) return ""; // Short messages don't need search context

  const { domains, types, channel, sourceAgent, excludeConversationId, limit = 5, recencyBoost = true } = options || {};

  try {
    const filters: object[] = [];
    if (domains?.length) {
      filters.push({ terms: { domain: domains } });
    }
    if (types?.length) {
      filters.push({ terms: { type: types } });
    }
    if (channel) {
      filters.push({ term: { channel } });
    }
    if (sourceAgent) {
      filters.push({ term: { source_agent: sourceAgent } });
    }
    // ELLIE-202: Exclude current conversation from search (it's already loaded in full)
    if (excludeConversationId) {
      filters.push({ bool: { must_not: { term: { conversation_id: excludeConversationId } } } });
    }

    let queryBody: Record<string, unknown> = {
      bool: {
        must: [
          {
            multi_match: {
              query,
              fields: ["content^2", "summary"],
              type: "best_fields",
              fuzziness: "AUTO",
            },
          },
        ],
        filter: filters,
      },
    };

    // Boost recent results with function_score decay
    if (recencyBoost) {
      queryBody = {
        function_score: {
          query: queryBody,
          functions: [
            {
              gauss: {
                created_at: {
                  origin: "now",
                  scale: "3d",
                  decay: 0.5,
                },
              },
            },
          ],
          boost_mode: "multiply",
          score_mode: "multiply",
        },
      };
    }

    const result = await esRequest(
      "POST",
      "/ellie-messages,ellie-memory,ellie-conversations/_search",
      { query: queryBody, size: limit, min_score: 2.0 }
    ) as { hits?: { hits?: Array<{ _source: Record<string, string>; _index: string; _score?: number }> } };

    const hits = result.hits?.hits;
    if (!hits || hits.length === 0) return "";

    const lines = hits.map((hit: { _source: Record<string, string>; _index: string; _score?: number }) => {
      const src = hit._source;
      const index = hit._index;
      const score = hit._score?.toFixed(1) || "?";

      if (index === "ellie-conversations") {
        return `[conversation, ${src.channel}, ${src.domain}, score:${score}] ${src.summary}`;
      }
      if (index === "ellie-memory") {
        return `[${src.type}, ${src.domain}, score:${score}] ${src.content}`;
      }
      return `[${src.role}, ${src.channel}, ${src.domain}, score:${score}] ${src.content}`;
    });

    return "ELASTICSEARCH RESULTS:\n" + lines.join("\n");
  } catch (err) {
    logger.error("Search error", err);
    return "";
  }
}
