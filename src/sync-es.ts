/**
 * Supabase → Elasticsearch Backfill
 *
 * One-time (or re-runnable) script to populate ES with existing data.
 * Uses Supabase UUIDs as ES document IDs, so re-running upserts safely.
 *
 * Usage: bun run src/sync-es.ts
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { classifyDomain, bulkIndex } from "./elasticsearch.ts";
import { log } from "./logger.ts";

const logger = log.child("sync-es");

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

const ES_URL = process.env.ELASTICSEARCH_URL || "http://localhost:9200";
const BATCH_SIZE = 500;

async function syncMessages() {
  console.log("[sync] Syncing messages...");
  let count = 0;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("messages")
      .select("id, role, content, channel, created_at, conversation_id, summarized")
      .order("created_at", { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) {
      logger.error("Messages fetch error", error);
      break;
    }
    if (!data || data.length === 0) break;

    const ops = data.map((msg) => ({
      index: "ellie-messages",
      id: msg.id,
      doc: {
        id: msg.id,
        content: msg.content,
        role: msg.role,
        channel: msg.channel,
        domain: classifyDomain(msg.content),
        created_at: msg.created_at,
        conversation_id: msg.conversation_id,
        summarized: msg.summarized,
      },
    }));

    const result = await bulkIndex(ops);
    if (result.errors > 0) {
      logger.error("Message indexing errors", { count: result.errors });
    }

    count += data.length;
    offset += BATCH_SIZE;
    process.stdout.write(`\r[sync] Messages: ${count}`);

    if (data.length < BATCH_SIZE) break;
  }
  console.log(`\n[sync] Messages done: ${count}`);
}

async function syncMemory() {
  console.log("[sync] Syncing memory...");
  let count = 0;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("memory")
      .select("id, type, content, created_at, updated_at, priority, conversation_id, metadata")
      .order("created_at", { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) {
      logger.error("Memory fetch error", error);
      break;
    }
    if (!data || data.length === 0) break;

    const ops = data.map((mem) => ({
      index: "ellie-memory",
      id: mem.id,
      doc: {
        id: mem.id,
        content: mem.content,
        type: mem.type,
        domain: classifyDomain(mem.content),
        created_at: mem.created_at,
        updated_at: mem.updated_at,
        priority: mem.priority,
        conversation_id: mem.conversation_id,
        metadata: mem.metadata,
      },
    }));

    const result = await bulkIndex(ops);
    if (result.errors > 0) {
      logger.error("Memory indexing errors", { count: result.errors });
    }

    count += data.length;
    offset += BATCH_SIZE;
    process.stdout.write(`\r[sync] Memory: ${count}`);

    if (data.length < BATCH_SIZE) break;
  }
  console.log(`\n[sync] Memory done: ${count}`);
}

async function syncConversations() {
  console.log("[sync] Syncing conversations...");
  let count = 0;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("conversations")
      .select("id, channel, summary, started_at, ended_at, message_count")
      .order("started_at", { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) {
      logger.error("Conversations fetch error", error);
      break;
    }
    if (!data || data.length === 0) break;

    const ops = data.map((convo) => ({
      index: "ellie-conversations",
      id: convo.id,
      doc: {
        id: convo.id,
        summary: convo.summary || "",
        channel: convo.channel,
        domain: convo.summary ? classifyDomain(convo.summary) : "general",
        started_at: convo.started_at,
        ended_at: convo.ended_at,
        message_count: convo.message_count,
      },
    }));

    const result = await bulkIndex(ops);
    if (result.errors > 0) {
      logger.error("Conversation indexing errors", { count: result.errors });
    }

    count += data.length;
    offset += BATCH_SIZE;
    process.stdout.write(`\r[sync] Conversations: ${count}`);

    if (data.length < BATCH_SIZE) break;
  }
  console.log(`\n[sync] Conversations done: ${count}`);
}

async function run() {
  // Verify ES is reachable
  try {
    const res = await fetch(`${ES_URL}/_cluster/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log("[sync] Elasticsearch connected\n");
  } catch {
    logger.error("Cannot reach Elasticsearch");
    process.exit(1);
  }

  await syncMessages();
  await syncMemory();
  await syncConversations();

  // Refresh indices
  await fetch(`${ES_URL}/ellie-messages,ellie-memory,ellie-conversations/_refresh`, {
    method: "POST",
  });

  // Print counts
  const [msgs, mems, convos] = await Promise.all([
    fetch(`${ES_URL}/ellie-messages/_count`).then((r) => r.json()),
    fetch(`${ES_URL}/ellie-memory/_count`).then((r) => r.json()),
    fetch(`${ES_URL}/ellie-conversations/_count`).then((r) => r.json()),
  ]);

  console.log(`\n[sync] Final counts:`);
  console.log(`  ellie-messages:      ${msgs.count}`);
  console.log(`  ellie-memory:        ${mems.count}`);
  console.log(`  ellie-conversations: ${convos.count}`);
  console.log("[sync] Done.");
}

run().catch((err) => {
  logger.error("Fatal error", err);
  process.exit(1);
});
