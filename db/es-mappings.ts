/**
 * Elasticsearch Index Setup
 *
 * Creates the three indices for Ellie's memory system:
 *   - ellie-messages: conversation messages
 *   - ellie-memory: facts, action items, summaries
 *   - ellie-conversations: conversation records with summaries
 *
 * Safe to re-run — deletes and recreates indices.
 *
 * Usage: bun run db/es-mappings.ts
 */

import "dotenv/config";

const ES_URL = process.env.ELASTICSEARCH_URL || "http://localhost:9200";

const contentAnalyzer = {
  analysis: {
    analyzer: {
      content_analyzer: {
        type: "custom",
        tokenizer: "standard",
        filter: ["lowercase", "stop", "snowball"],
      },
    },
  },
};

const indices: Record<string, object> = {
  "ellie-messages": {
    settings: {
      number_of_shards: 1,
      number_of_replicas: 0,
      ...contentAnalyzer,
    },
    mappings: {
      properties: {
        id: { type: "keyword" },
        content: { type: "text", analyzer: "content_analyzer" },
        role: { type: "keyword" },
        channel: { type: "keyword" },
        domain: { type: "keyword" },
        created_at: { type: "date" },
        conversation_id: { type: "keyword" },
        summarized: { type: "boolean" },
      },
    },
  },
  "ellie-memory": {
    settings: {
      number_of_shards: 1,
      number_of_replicas: 0,
      ...contentAnalyzer,
    },
    mappings: {
      properties: {
        id: { type: "keyword" },
        content: { type: "text", analyzer: "content_analyzer" },
        type: { type: "keyword" },
        domain: { type: "keyword" },
        created_at: { type: "date" },
        updated_at: { type: "date" },
        priority: { type: "integer" },
        conversation_id: { type: "keyword" },
        metadata: { type: "object", enabled: false },
      },
    },
  },
  "ellie-conversations": {
    settings: {
      number_of_shards: 1,
      number_of_replicas: 0,
    },
    mappings: {
      properties: {
        id: { type: "keyword" },
        summary: { type: "text", analyzer: "standard" },
        channel: { type: "keyword" },
        domain: { type: "keyword" },
        started_at: { type: "date" },
        ended_at: { type: "date" },
        message_count: { type: "integer" },
      },
    },
  },
};

async function setup() {
  console.log(`[es-setup] Connecting to ${ES_URL}...`);

  // Verify ES is reachable
  const health = await fetch(`${ES_URL}/_cluster/health`);
  if (!health.ok) {
    console.error("[es-setup] Cannot reach Elasticsearch");
    process.exit(1);
  }
  console.log("[es-setup] Elasticsearch is healthy\n");

  for (const [name, body] of Object.entries(indices)) {
    // Delete if exists
    const exists = await fetch(`${ES_URL}/${name}`);
    if (exists.ok) {
      console.log(`[es-setup] Deleting existing index: ${name}`);
      await fetch(`${ES_URL}/${name}`, { method: "DELETE" });
    }

    // Create
    const res = await fetch(`${ES_URL}/${name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      console.log(`[es-setup] Created index: ${name}`);
    } else {
      const err = await res.json();
      console.error(`[es-setup] Failed to create ${name}:`, err);
    }
  }

  // Verify
  console.log("\n[es-setup] Indices:");
  const cat = await fetch(`${ES_URL}/_cat/indices?v`);
  console.log(await cat.text());
}

setup().catch((err) => {
  console.error("[es-setup] Fatal:", err);
  process.exit(1);
});
