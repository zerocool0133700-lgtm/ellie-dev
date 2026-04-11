/**
 * One-time backfill: Index pre-March Supabase messages into Elasticsearch.
 *
 * ES message indexing started March 14, 2026. This script backfills the
 * 8,000+ messages from before that date.
 *
 * Usage: bun run scripts/backfill-es-messages.ts [--dry-run] [--batch-size=500]
 */

import { createClient } from "@supabase/supabase-js";
import { indexMessage } from "../src/elasticsearch.ts";

const dryRun = process.argv.includes("--dry-run");
const batchArg = process.argv.find(a => a.startsWith("--batch-size="));
const batchSize = batchArg ? parseInt(batchArg.split("=")[1]) : 500;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in environment");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function backfill() {
  // Count messages not yet in ES (before March 14)
  const cutoff = "2026-03-14T00:00:00Z";

  const { count, error: countErr } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .lt("created_at", cutoff);

  if (countErr) {
    console.error("Count failed:", countErr.message);
    process.exit(1);
  }

  console.log(`Found ${count} pre-March messages to backfill`);

  if (dryRun) {
    // Show channel breakdown
    for (const channel of ["ellie-chat", "telegram", "google-chat", "voice"]) {
      const { count: chCount } = await supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .lt("created_at", cutoff)
        .eq("channel", channel);
      console.log(`  ${channel}: ${chCount}`);
    }
    return;
  }

  let indexed = 0;
  let failed = 0;
  let offset = 0;

  while (true) {
    const { data: messages, error } = await supabase
      .from("messages")
      .select("id, content, role, channel, created_at, conversation_id")
      .lt("created_at", cutoff)
      .order("created_at", { ascending: true })
      .range(offset, offset + batchSize - 1);

    if (error) {
      console.error(`Batch at offset ${offset} failed:`, error.message);
      break;
    }

    if (!messages || messages.length === 0) break;

    for (const msg of messages) {
      if (!msg.content || msg.content.length < 5) continue;
      try {
        await indexMessage({
          id: msg.id,
          content: msg.content,
          role: msg.role,
          channel: msg.channel || "unknown",
          created_at: msg.created_at,
          conversation_id: msg.conversation_id,
        });
        indexed++;
      } catch {
        failed++;
      }
    }

    offset += messages.length;
    if (indexed % 500 === 0 || messages.length < batchSize) {
      console.log(`  ... ${indexed} indexed, ${failed} failed (offset: ${offset})`);
    }

    if (messages.length < batchSize) break;
  }

  console.log(`Backfill complete: ${indexed} indexed, ${failed} failed`);
  process.exit(0);
}

backfill().catch(err => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
