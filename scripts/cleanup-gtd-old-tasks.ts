#!/usr/bin/env bun

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const cutoffDate = "2026-03-01";

  // First, query what we're about to delete
  console.log("\n📋 Tasks created before March 1, 2026:\n");

  const { data: oldTasks, error: queryError } = await supabase
    .from("todos")
    .select("id, content, created_at, priority, status")
    .lt("created_at", cutoffDate)
    .order("created_at", { ascending: false });

  if (queryError) {
    console.error("Query error:", queryError);
    process.exit(1);
  }

  if (!oldTasks || oldTasks.length === 0) {
    console.log("✅ No old tasks found!");
    return;
  }

  console.log(`Found ${oldTasks.length} old tasks:\n`);
  for (const task of oldTasks) {
    const date = new Date(task.created_at).toLocaleDateString();
    console.log(`  • [${task.priority || 'none'}] ${task.content} (${date})`);
  }

  console.log(`\n📊 Total to delete: ${oldTasks.length} tasks`);

  // Show what we're keeping
  const { data: newTasks, error: newQueryError } = await supabase
    .from("todos")
    .select("id, content, created_at, priority")
    .gte("created_at", cutoffDate)
    .order("created_at", { ascending: false });

  if (newQueryError) {
    console.error("Query error for new tasks:", newQueryError);
  } else if (newTasks && newTasks.length > 0) {
    console.log(`\n✅ Tasks to keep (${newTasks.length} total):\n`);
    for (const task of newTasks) {
      const date = new Date(task.created_at).toLocaleDateString();
      console.log(`  • [${task.priority || 'none'}] ${task.content} (${date})`);
    }
  } else {
    console.log("\n⚠️  No tasks will remain after cleanup!");
  }

  // Delete
  console.log("\n🗑️  Deleting old tasks...\n");

  const { error: deleteError } = await supabase
    .from("todos")
    .delete()
    .lt("created_at", cutoffDate);

  if (deleteError) {
    console.error("Delete error:", deleteError);
    process.exit(1);
  }

  console.log(`✅ Deleted ${oldTasks.length} tasks successfully!`);
}

main();
