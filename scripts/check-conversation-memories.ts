import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);

// Get the most recent conversations
const { data: convos } = await supabase
  .from('conversations')
  .select('id, channel, started_at, summary')
  .order('started_at', { ascending: false })
  .limit(10);

if (!convos) {
  console.log('No conversations found');
  process.exit(0);
}

console.log('Recent conversations and their memory counts:\n');
for (const c of convos) {
  const { count } = await supabase
    .from('memory')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', c.id);

  const time = c.started_at.substring(0, 16).replace('T', ' ');
  const summary = c.summary?.substring(0, 60) || 'No summary';
  console.log(`${time} [${c.channel.padEnd(12)}] ${String(count || 0).padStart(3)} memories - ${summary}`);
}
