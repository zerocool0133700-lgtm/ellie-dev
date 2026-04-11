#!/usr/bin/env bun
/**
 * Apply agent_tool_usage migration directly
 */

import { createClient } from "@supabase/supabase-js";
import { readFile } from "fs/promises";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey);

const migrationSQL = await readFile(
  "/home/ellie/ellie-dev/migrations/supabase/20260322_agent_tool_usage.sql",
  "utf-8"
);

console.log("Applying agent_tool_usage migration...");

const { data, error } = await supabase.rpc("execute_sql", {
  sql: migrationSQL,
});

if (error) {
  console.error("Migration failed:", error);
  process.exit(1);
}

console.log("Migration applied successfully!");
console.log(data);
