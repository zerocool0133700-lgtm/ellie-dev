#!/usr/bin/env bun
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

const messageId = 'cf987e7c-fd99-4f4c-bcde-93e1eedd1359';

async function checkMessageScore() {
  // Fetch the original message to get conversation_id
  const { data: message, error: msgError } = await supabase
    .from('messages')
    .select('id, content, role, created_at, conversation_id')
    .eq('id', messageId)
    .single();

  if (msgError) {
    console.error('Error fetching message:', msgError);
    return;
  }

  console.log('\n📨 ORIGINAL MESSAGE (user):');
  console.log(`Created: ${message.created_at}`);
  console.log(`Content: ${message.content.substring(0, 100)}...`);

  // Find the assistant response that came after this message
  const { data: assistantResponse, error: respError } = await supabase
    .from('messages')
    .select('id, content, role, created_at')
    .eq('conversation_id', message.conversation_id)
    .eq('role', 'assistant')
    .gt('created_at', message.created_at)
    .order('created_at', { ascending: true })
    .limit(1)
    .single();

  if (respError) {
    console.error('\n❌ No assistant response found');
    return;
  }

  console.log('\n💬 MY RESPONSE (assistant):');
  console.log(`Created: ${assistantResponse.created_at}`);
  console.log(`Response ID: ${assistantResponse.id}`);
  console.log(`\n--- FULL RESPONSE ---\n${assistantResponse.content}\n--- END RESPONSE ---`);

  console.log('\n📊 NOTE: We only score USER messages for empathy needs.');
  console.log('To evaluate my response quality, we would manually assess whether it:');
  console.log('  1. Acknowledged the emotional weight appropriately');
  console.log('  2. Validated the experience without minimizing');
  console.log('  3. Connected to the work context (design philosophy)');
  console.log('  4. Offered appropriate next steps without rushing past the emotion');
}

checkMessageScore();
