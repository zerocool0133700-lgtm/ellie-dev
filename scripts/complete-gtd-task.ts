#!/usr/bin/env bun
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);

const searchTerm = process.argv[2];
if (!searchTerm) {
  console.error('Usage: bun scripts/complete-gtd-task.ts "search term"');
  process.exit(1);
}

// Find the task
const { data: tasks, error: searchError } = await supabase
  .from('todos')
  .select('id, content, status, completed_at')
  .ilike('content', `%${searchTerm}%`)
  .order('updated_at', { ascending: false });

if (searchError) {
  console.error('Error searching for task:', searchError);
  process.exit(1);
}

if (!tasks || tasks.length === 0) {
  console.log(`No tasks found matching "${searchTerm}"`);
  process.exit(0);
}

console.log(`Found ${tasks.length} task(s) matching "${searchTerm}":\n`);
tasks.forEach((task, i) => {
  console.log(`${i + 1}. [${task.status}] ${task.content.substring(0, 100)}`);
  console.log(`   ID: ${task.id}, completed_at: ${task.completed_at || 'null'}\n`);
});

// If there's exactly one task, or the first one isn't already done, complete it
const taskToComplete = tasks[0];

if (taskToComplete.status === 'done' && taskToComplete.completed_at) {
  console.log(`Task is already marked as done (completed at ${taskToComplete.completed_at})`);
  process.exit(0);
}

console.log(`Marking task ${taskToComplete.id} as done...`);

const { error: updateError } = await supabase
  .from('todos')
  .update({
    status: 'done',
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  })
  .eq('id', taskToComplete.id);

if (updateError) {
  console.error('Error updating task:', updateError);
  process.exit(1);
}

console.log('✓ Task marked as done');
