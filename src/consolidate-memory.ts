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

// ELLIE-1037: Batch window scoping — only process messages within this window
const BATCH_WINDOW_DAYS = parseInt(process.env.UMS_BATCH_WINDOW_DAYS || "7", 10);

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

async function run() {
  logger.info("Starting scheduled consolidation...");
  await consolidateNow(supabase);
  logger.info("Scheduled consolidation complete.");
}

run().catch((err) => {
  logger.error("Fatal error", err);
  process.exit(1);
});
