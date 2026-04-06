#!/usr/bin/env bun
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);

const { data: allTasks } = await supabase
  .from('todos')
  .select('id, content, status, assigned_agent, assigned_to, completed_at, updated_at')
  .or('assigned_agent.eq.general,assigned_agent.is.null')
  .order('updated_at', { ascending: false })
  .limit(30);

console.log('=== Tasks assigned to general ===');
const generalTasks = (allTasks || []).filter(t => t.assigned_agent === 'general');
for (const task of generalTasks) {
  console.log(`[${task.status}] ${task.content.substring(0, 80)}`);
  console.log(`   ID: ${task.id}, completed_at: ${task.completed_at || 'null'}\n`);
}

console.log('\n=== Tasks unassigned ===');
const unassignedTasks = (allTasks || []).filter(t => !t.assigned_agent);
for (const task of unassignedTasks) {
  console.log(`[${task.status}] ${task.content.substring(0, 80)}`);
  console.log(`   ID: ${task.id}\n`);
}
