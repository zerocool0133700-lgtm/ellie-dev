/**
 * Memory Consolidation Job (Batch)
 *
 * Runs on a schedule (systemd timer, every 4 hours).
 * Safety net for any messages the inline consolidation missed.
 *
 * Uses the same shared consolidation logic as the relay.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { log } from "./logger.ts";
import { consolidateNow } from "./consolidate-inline.ts";

const logger = log.child("consolidate-memory");

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

async function run() {
  console.log("[batch] Starting scheduled consolidation...");
  await consolidateNow(supabase);
  console.log("[batch] Scheduled consolidation complete.");
}

run().catch((err) => {
  logger.error("Fatal error", err);
  process.exit(1);
});
