#!/usr/bin/env bun
/**
 * Backfill agent attribution on historical memory records
 *
 * Problem: 671 out of 870 memories have NULL source_agent
 * Solution: Infer from conversation.agent where conversation_id exists
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  console.log('🔍 Analyzing memory attribution gaps...\n');

  // Get stats before using aggregation
  const { data: allMemories } = await supabase
    .from('memory')
    .select('source_agent');

  const beforeStats = allMemories?.reduce((acc, m) => {
    const agent = m.source_agent || 'NULL';
    acc[agent] = (acc[agent] || 0) + 1;
    return acc;
  }, {} as Record<string, number>) || {};

  console.log('📊 Before backfill:');
  console.table(Object.entries(beforeStats).map(([agent, count]) => ({ agent, count })));

  // Find memories with NULL source_agent but valid conversation_id
  const { data: orphanedMemories, error } = await supabase
    .from('memory')
    .select('id, conversation_id')
    .is('source_agent', null)
    .not('conversation_id', 'is', null);

  if (error) {
    console.error('❌ Failed to fetch orphaned memories:', error);
    return;
  }

  console.log(`\n✅ Found ${orphanedMemories?.length || 0} memories with conversation_id but no agent attribution\n`);

  if (!orphanedMemories || orphanedMemories.length === 0) {
    console.log('✨ Nothing to backfill!');
    return;
  }

  // Group by conversation_id to minimize queries
  const conversationIds = [...new Set(orphanedMemories.map(m => m.conversation_id))];

  console.log(`🔗 Loading agent data for ${conversationIds.length} conversations...\n`);

  // Fetch conversation agents
  const { data: conversations } = await supabase
    .from('conversations')
    .select('id, agent')
    .in('id', conversationIds);

  if (!conversations) {
    console.error('❌ Failed to fetch conversations');
    return;
  }

  // Build lookup map
  const conversationAgentMap = new Map(
    conversations.map(c => [c.id, c.agent])
  );

  // Update memories in batches
  let updated = 0;
  let skipped = 0;

  for (const memory of orphanedMemories) {
    const agent = conversationAgentMap.get(memory.conversation_id);

    if (!agent) {
      skipped++;
      continue;
    }

    const { error: updateError } = await supabase
      .from('memory')
      .update({ source_agent: agent })
      .eq('id', memory.id);

    if (updateError) {
      console.error(`❌ Failed to update ${memory.id}:`, updateError.message);
    } else {
      updated++;
      if (updated % 50 === 0) {
        process.stdout.write(`✓ ${updated}/${orphanedMemories.length}\r`);
      }
    }
  }

  console.log(`\n✅ Updated ${updated} memories`);
  console.log(`⚠️  Skipped ${skipped} (no conversation agent found)\n`);

  // Get stats after
  const { data: allMemoriesAfter } = await supabase
    .from('memory')
    .select('source_agent');

  const afterStats = allMemoriesAfter?.reduce((acc, m) => {
    const agent = m.source_agent || 'NULL';
    acc[agent] = (acc[agent] || 0) + 1;
    return acc;
  }, {} as Record<string, number>) || {};

  console.log('📊 After backfill:');
  console.table(Object.entries(afterStats).map(([agent, count]) => ({ agent, count })));

  console.log('\n✨ Done!');
}

main().catch(console.error);
