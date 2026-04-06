import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);

// Get a recent conversation with memories
const { data: convo } = await supabase
  .from('conversations')
  .select('id, summary')
  .order('started_at', { ascending: false })
  .not('summary', 'is', null)
  .limit(1)
  .single();

if (!convo) {
  console.log('No conversation with summary found');
  process.exit(0);
}

console.log(`Conversation: ${convo.id}`);
console.log(`Summary: ${convo.summary?.substring(0, 60)}...\n`);

// Get all memories for this conversation
const { data: memories } = await supabase
  .from('memory')
  .select('id, type, content')
  .eq('conversation_id', convo.id)
  .order('created_at', { ascending: true });

if (!memories || memories.length === 0) {
  console.log('No memories found for this conversation');
  process.exit(0);
}

console.log(`Total memories: ${memories.length}\n`);

// Group by type
const byType: Record<string, number> = {};
for (const m of memories) {
  byType[m.type] = (byType[m.type] || 0) + 1;
}

console.log('Breakdown by type:');
for (const [type, count] of Object.entries(byType)) {
  console.log(`  ${type}: ${count}`);
}

// Show what the UI filter would return
const nonSummary = memories.filter(m => m.type !== 'summary');
console.log(`\nNon-summary memories (what UI shows): ${nonSummary.length}`);

if (nonSummary.length > 0) {
  console.log('\nNon-summary memories:');
  for (const m of nonSummary.slice(0, 3)) {
    console.log(`  [${m.type}] ${m.content.substring(0, 60)}...`);
  }
}
