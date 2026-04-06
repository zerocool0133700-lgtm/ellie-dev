#!/usr/bin/env bun
/**
 * Quick script to check agents' tools_enabled values
 */

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey);

const { data, error } = await supabase
  .from("agents")
  .select("name, type, tools_enabled")
  .eq("status", "active")
  .order("name");

if (error) {
  console.error("Error:", error);
  process.exit(1);
}

console.log(JSON.stringify(data, null, 2));
