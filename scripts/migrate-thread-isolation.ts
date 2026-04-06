#!/usr/bin/env bun
/**
 * migrate-thread-isolation.ts
 *
 * Backfills the thread_id column on historical ellie-chat messages.
 *
 * Strategy:
 *   1. Find the main (General/coordinated) thread from chat_threads.
 *   2. For messages where thread_id column is NULL but metadata->>'thread_id' exists,
 *      copy the metadata value to the column.
 *   3. For messages still with NULL thread_id, assign them to the main thread.
 *   4. Verify zero NULLs remain.
 *
 * Usage:
 *   bun run scripts/migrate-thread-isolation.ts --dry-run   # counts only, no writes
 *   bun run scripts/migrate-thread-isolation.ts             # apply migration
 */

import fs from "fs";
import { createClient } from "@supabase/supabase-js";

// ── Load .env ─────────────────────────────────────────────────────────────────

const envPath = new URL("../.env", import.meta.url);
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("ERROR: Missing SUPABASE_URL or SUPABASE_ANON_KEY in environment");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── CLI args ──────────────────────────────────────────────────────────────────

const isDryRun = process.argv.includes("--dry-run");
const BATCH_SIZE = 200;

if (isDryRun) {
  console.log("DRY RUN — no writes will be made\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isValidUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// ── Step 1: Find the main thread ──────────────────────────────────────────────

console.log("Step 1: Finding main (coordinated) thread...");

const { data: threads, error: threadErr } = await supabase
  .from("chat_threads")
  .select("id, name, routing_mode")
  .eq("routing_mode", "coordinated")
  .order("created_at", { ascending: true })
  .limit(1);

if (threadErr) {
  console.error("ERROR fetching chat_threads:", threadErr.message);
  process.exit(1);
}

if (!threads || threads.length === 0) {
  console.error("ERROR: No coordinated thread found in chat_threads!");
  process.exit(1);
}

const mainThread = threads[0];
console.log(`  Main thread: ${mainThread.id}  name="${mainThread.name}"  routing=${mainThread.routing_mode}\n`);

// ── Step 2: Count/backfill messages that have metadata thread_id but NULL column ──

console.log("Step 2: Backfill thread_id from metadata->>'thread_id'...");

// Fetch all ellie-chat messages with NULL thread_id column (paginated)
let metaBackfillCount = 0;
let metaSkipCount = 0;
let offset = 0;
let hasMore = true;

while (hasMore) {
  const { data: rows, error: fetchErr } = await supabase
    .from("messages")
    .select("id, metadata")
    .eq("channel", "ellie-chat")
    .is("thread_id", null)
    .range(offset, offset + BATCH_SIZE - 1);

  if (fetchErr) {
    console.error("ERROR fetching messages:", fetchErr.message);
    process.exit(1);
  }

  if (!rows || rows.length === 0) {
    hasMore = false;
    break;
  }

  // Split: those with valid UUID in metadata, those without
  const toUpdateFromMeta: string[] = [];

  for (const row of rows) {
    const metaThreadId = row.metadata?.thread_id as string | undefined;
    if (metaThreadId && isValidUuid(metaThreadId)) {
      toUpdateFromMeta.push(row.id);
    }
  }

  metaBackfillCount += toUpdateFromMeta.length;
  metaSkipCount += rows.length - toUpdateFromMeta.length;

  if (!isDryRun && toUpdateFromMeta.length > 0) {
    // Update each row individually (REST API doesn't support per-row different values)
    // Group by metadata thread_id value for fewer round-trips
    const byThreadId = new Map<string, string[]>();
    for (const row of rows) {
      const metaThreadId = row.metadata?.thread_id as string | undefined;
      if (metaThreadId && isValidUuid(metaThreadId) && toUpdateFromMeta.includes(row.id)) {
        const ids = byThreadId.get(metaThreadId) ?? [];
        ids.push(row.id);
        byThreadId.set(metaThreadId, ids);
      }
    }

    for (const [threadId, ids] of byThreadId) {
      const { error: updateErr } = await supabase
        .from("messages")
        .update({ thread_id: threadId })
        .in("id", ids);

      if (updateErr) {
        console.error(`  ERROR updating batch for thread ${threadId}:`, updateErr.message);
        process.exit(1);
      }
    }
  }

  offset += rows.length;
  if (rows.length < BATCH_SIZE) hasMore = false;
}

console.log(`  Messages with metadata thread_id to backfill: ${metaBackfillCount}`);
console.log(`  Messages with no metadata thread_id (will go to main): ${metaSkipCount}`);
if (!isDryRun) {
  console.log(`  Backfilled ${metaBackfillCount} rows from metadata.\n`);
} else {
  console.log(`  [DRY RUN] Would backfill ${metaBackfillCount} rows from metadata.\n`);
}

// ── Step 3: Assign remaining NULL thread_id messages to main thread ────────────

console.log("Step 3: Assigning remaining NULL thread_id messages to main thread...");

// First count how many remain
const { count: remainingCount, error: countErr } = await supabase
  .from("messages")
  .select("id", { count: "exact", head: true })
  .eq("channel", "ellie-chat")
  .is("thread_id", null);

if (countErr) {
  console.error("ERROR counting remaining messages:", countErr.message);
  process.exit(1);
}

console.log(`  Remaining NULL thread_id messages: ${remainingCount ?? 0}`);

if (!isDryRun && (remainingCount ?? 0) > 0) {
  // Paginated bulk update to main thread
  let assigned = 0;
  let assignOffset = 0;
  let assignMore = true;

  while (assignMore) {
    // Fetch a batch of IDs to update
    const { data: batch, error: batchErr } = await supabase
      .from("messages")
      .select("id")
      .eq("channel", "ellie-chat")
      .is("thread_id", null)
      .limit(BATCH_SIZE);

    if (batchErr) {
      console.error("ERROR fetching batch for main thread assignment:", batchErr.message);
      process.exit(1);
    }

    if (!batch || batch.length === 0) {
      assignMore = false;
      break;
    }

    const ids = batch.map((r) => r.id);
    const { error: assignErr } = await supabase
      .from("messages")
      .update({ thread_id: mainThread.id })
      .in("id", ids);

    if (assignErr) {
      console.error("ERROR assigning messages to main thread:", assignErr.message);
      process.exit(1);
    }

    assigned += ids.length;
    assignOffset += ids.length;

    if (ids.length < BATCH_SIZE) assignMore = false;
  }

  console.log(`  Assigned ${assigned} messages to main thread (${mainThread.id}).\n`);
} else if (isDryRun) {
  console.log(`  [DRY RUN] Would assign ${remainingCount ?? 0} messages to main thread (${mainThread.id}).\n`);
} else {
  console.log(`  Nothing to assign.\n`);
}

// ── Step 4: Verify ────────────────────────────────────────────────────────────

console.log("Step 4: Verifying...");

const { count: nullCount, error: verifyErr } = await supabase
  .from("messages")
  .select("id", { count: "exact", head: true })
  .eq("channel", "ellie-chat")
  .is("thread_id", null);

if (verifyErr) {
  console.error("ERROR during verification:", verifyErr.message);
  process.exit(1);
}

if (isDryRun) {
  console.log(`  [DRY RUN] NULL thread_id count before migration: ${nullCount ?? 0}`);
  console.log(`  [DRY RUN] After migration would expect: 0\n`);
} else {
  console.log(`  NULL thread_id remaining: ${nullCount ?? 0}`);
  if (nullCount === 0) {
    console.log("  All ellie-chat messages now have a thread_id.\n");
  } else {
    console.error(`  WARNING: ${nullCount} messages still have NULL thread_id!`);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log("=== Migration Summary ===");
console.log(`  Main thread:               ${mainThread.id} ("${mainThread.name}")`);
console.log(`  From metadata:             ${metaBackfillCount} messages`);
console.log(`  Assigned to main thread:   ${remainingCount ?? 0} messages`);
console.log(`  Remaining NULLs:           ${isDryRun ? "(not yet applied)" : nullCount ?? 0}`);
if (isDryRun) {
  console.log("\n  Re-run without --dry-run to apply.");
}
