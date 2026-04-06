#!/usr/bin/env bun
/**
 * Run Message Backfill — one-shot script
 *
 * Reads existing messages from Supabase and writes them to mountain_records
 * in Forest DB. Idempotent — safe to re-run.
 *
 * Usage:
 *   bun run scripts/run-message-backfill.ts [--channel telegram] [--since 2026-01-01] [--limit 500]
 */

import { createClient } from "@supabase/supabase-js";
import {
  runBackfill,
  type SupabaseFetcher,
  type MountainWriter,
  type NormalizedBackfillRecord,
} from "../src/mountain/message-backfill.ts";
import { upsertRecord } from "../src/mountain/records.ts";

// ── Env check ─────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Parse CLI args ────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: { channel?: string; since?: Date; until?: Date; limit?: number } = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--channel":
        opts.channel = args[++i];
        break;
      case "--since":
        opts.since = new Date(args[++i]);
        break;
      case "--until":
        opts.until = new Date(args[++i]);
        break;
      case "--limit":
        opts.limit = parseInt(args[++i], 10);
        break;
    }
  }

  return opts;
}

const cliOpts = parseArgs();

// ── Supabase fetcher ──────────────────────────────────────────

const fetcher: SupabaseFetcher = async ({ channel, since, until, limit, offset }) => {
  let query = supabase
    .from("messages")
    .select("id, created_at, role, content, channel, metadata, conversation_id, user_id", {
      count: "exact",
    })
    .order("created_at", { ascending: true });

  if (channel) query = query.eq("channel", channel);
  if (since) query = query.gte("created_at", since.toISOString());
  if (until) query = query.lt("created_at", until.toISOString());

  // Count-only request
  if (limit === 0) {
    const { count, error } = await query.limit(0);
    if (error) throw new Error(`Supabase count error: ${error.message}`);
    return { data: [], count: count ?? 0 };
  }

  query = query.range(offset, offset + limit - 1);

  const { data, count, error } = await query;
  if (error) throw new Error(`Supabase fetch error: ${error.message}`);

  return { data: data ?? [], count: count ?? 0 };
};

// ── Mountain writer ───────────────────────────────────────────

const writer: MountainWriter = async (record: NormalizedBackfillRecord) => {
  const result = await upsertRecord({
    record_type: record.record_type,
    source_system: record.source_system,
    external_id: record.external_id,
    payload: record.payload,
    summary: record.summary,
    status: record.status,
    source_timestamp: record.source_timestamp,
  });
  return { id: result.id, version: result.version };
};

// ── Run ───────────────────────────────────────────────────────

console.log("Starting message backfill...");
if (cliOpts.channel) console.log(`  Channel filter: ${cliOpts.channel}`);
if (cliOpts.since) console.log(`  Since: ${cliOpts.since.toISOString()}`);
if (cliOpts.until) console.log(`  Until: ${cliOpts.until.toISOString()}`);
if (cliOpts.limit) console.log(`  Limit: ${cliOpts.limit}`);

const result = await runBackfill(fetcher, writer, {
  ...cliOpts,
  pageSize: 100,
  onProgress: (progress) => {
    if (progress.processed % 100 === 0 || progress.percent === 100) {
      console.log(
        `  ${progress.percent}% — ${progress.processed}/${progress.total} (${progress.imported} new, ${progress.skipped} existing)`,
      );
    }
  },
});

console.log("\n=== Backfill Complete ===");
console.log(`  Processed: ${result.processed}`);
console.log(`  Imported:  ${result.imported}`);
console.log(`  Skipped:   ${result.skipped}`);
console.log(`  Errors:    ${result.errors.length}`);
console.log(`  Pages:     ${result.pages}`);
console.log(`  Duration:  ${result.durationMs}ms`);

if (result.errors.length > 0) {
  console.log("\nErrors (first 10):");
  for (const err of result.errors.slice(0, 10)) {
    console.log(`  ${err.messageId}: ${err.error}`);
  }
}

process.exit(result.errors.length > 0 ? 1 : 0);
