import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);

// Get a conversation that should have memories
const { data: convo } = await supabase
  .from('conversations')
  .select('id, summary')
  .order('started_at', { ascending: false })
  .limit(1)
  .eq('status', 'closed')
  .single();

if (!convo) {
  console.log('No closed conversation found');
  process.exit(0);
}

console.log(`Testing conversation: ${convo.id}`);
console.log(`Summary: ${convo.summary?.substring(0, 80)}...\n`);

// Test the same query the UI uses
const { data: memories } = await supabase
  .from('memory')
  .select('id, type, content, created_at')
  .eq('conversation_id', convo.id)
  .order('created_at', { ascending: true });

console.log(`Memories returned by API: ${memories?.length || 0}`);

if (memories && memories.length > 0) {
  console.log('\nFirst few memories:');
  for (const m of memories.slice(0, 3)) {
    console.log(`  [${m.type}] ${m.content.substring(0, 60)}...`);
  }
}
