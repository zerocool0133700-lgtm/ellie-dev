#!/usr/bin/env bun
/**
 * Create agent_tool_usage table manually via Supabase SQL query
 */

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const createTableSQL = `
-- Agent Tool Usage Audit Log
CREATE TABLE IF NOT EXISTS agent_tool_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_category TEXT,
  operation TEXT,
  session_id TEXT,
  user_id TEXT,
  channel TEXT,
  success BOOLEAN DEFAULT true,
  error_message TEXT,
  parameters JSONB,
  result_summary TEXT,
  duration_ms INTEGER,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_agent_tool_usage_agent_name ON agent_tool_usage (agent_name);
CREATE INDEX IF NOT EXISTS idx_agent_tool_usage_tool_name ON agent_tool_usage (tool_name);
CREATE INDEX IF NOT EXISTS idx_agent_tool_usage_timestamp ON agent_tool_usage (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_agent_tool_usage_session ON agent_tool_usage (session_id);
CREATE INDEX IF NOT EXISTS idx_agent_tool_usage_agent_tool ON agent_tool_usage (agent_name, tool_name);
`;

console.log("Creating agent_tool_usage table...");

// Split into individual statements
const statements = createTableSQL
  .split(";")
  .map(s => s.trim())
  .filter(s => s.length > 0);

for (const stmt of statements) {
  console.log(`Executing: ${stmt.slice(0, 80)}...`);
  const { error } = await supabase.rpc("exec_sql", { sql_query: stmt });
  if (error) {
    console.error(`Failed: ${error.message}`);
    // Try alternative: use from() with direct query
    try {
      await supabase.from("_sql").select().maybeSingle();
    } catch (e) {
      console.log("Direct SQL execution not available, trying fetch...");
    }
  } else {
    console.log("✓ Success");
  }
}

// Verify table exists
const { data, error } = await supabase
  .from("agent_tool_usage")
  .select("*")
  .limit(1);

if (error) {
  console.error("Table verification failed:", error);
  console.log("\nPlease run this SQL manually in the Supabase SQL Editor:");
  console.log(createTableSQL);
  process.exit(1);
}

console.log("\n✅ agent_tool_usage table created and verified!");
