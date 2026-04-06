#!/usr/bin/env bun
/**
 * Compare BERT vs Rule-based Empathy Detection
 *
 * Runs both detectors on recent user messages and shows differences.
 */

import { detectEmpathyNeeds } from '../src/empathy-detector.ts';
import { detectEmpathyNeedsBert } from '../src/empathy-detector-bert.ts';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function main() {
  const limit = parseInt(process.argv[2]) || 20;

  console.log(`\n📊 Comparing BERT vs Rule-based Empathy Detection\n`);
  console.log(`Fetching last ${limit} user messages...\n`);

  // Fetch recent user messages
  const { data: messages, error } = await supabase
    .from('messages')
    .select('id, content, created_at')
    .eq('role', 'user')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !messages) {
    console.error('Failed to fetch messages:', error);
    process.exit(1);
  }

  console.log(`Found ${messages.length} messages\n`);
  console.log('═'.repeat(120));

  // Process each message
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const msgPreview = msg.content.length > 80
      ? msg.content.slice(0, 80) + '...'
      : msg.content;

    console.log(`\n${i + 1}. ${msgPreview}`);
    console.log(`   ${new Date(msg.created_at).toLocaleString()}`);
    console.log('─'.repeat(120));

    // Run both detectors
    const ruleResult = detectEmpathyNeeds(msg.content);
    const bertResult = await detectEmpathyNeedsBert(msg.content);

    // Compare results
    const scoreDiff = Math.abs(bertResult.empathy_score - ruleResult.empathy_score);
    const tierMatch = bertResult.tier === ruleResult.tier;

    // Display comparison
    console.log(`   Rule-based: ${ruleResult.tier.padEnd(8)} (score: ${ruleResult.empathy_score.toFixed(3)})`);
    console.log(`   BERT:       ${bertResult.tier.padEnd(8)} (score: ${bertResult.empathy_score.toFixed(3)}) [${bertResult.bert_signals.model_used}]`);

    if (!tierMatch) {
      console.log(`   ⚠️  TIER MISMATCH — diff: ${scoreDiff.toFixed(3)}`);
    } else if (scoreDiff > 0.2) {
      console.log(`   ℹ️  Same tier, but score differs by ${scoreDiff.toFixed(3)}`);
    } else {
      console.log(`   ✓ Agreement (diff: ${scoreDiff.toFixed(3)})`);
    }

    // Show key differences
    if (bertResult.bert_signals.model_used === 'bert') {
      const bertNeg = bertResult.bert_signals.negative_emotion_total;
      console.log(`   BERT negative sentiment: ${(bertNeg * 100).toFixed(0)}%`);
    }

    if (ruleResult.detected_emotions.length > 0) {
      console.log(`   Emotions detected: ${ruleResult.detected_emotions.join(', ')}`);
    }

    // Show signal breakdown for significant differences
    if (scoreDiff > 0.2) {
      console.log(`   Signal breakdown:`);
      console.log(`     Emotional language: ${(ruleResult.signals.emotional_language_density * 100).toFixed(0)}%`);
      console.log(`     Vulnerability cues: ${ruleResult.signals.vulnerability_cues_present ? 'YES' : 'NO'}`);
      console.log(`     Help-seeking vagueness: ${(ruleResult.signals.help_seeking_vagueness * 100).toFixed(0)}%`);
      console.log(`     Repeated emotions: ${(ruleResult.signals.repeated_emotions * 100).toFixed(0)}%`);
      console.log(`     Narrative detail: ${(ruleResult.signals.narrative_detail_ratio * 100).toFixed(0)}%`);
      console.log(`     Rhetorical questions: ${(ruleResult.signals.rhetorical_questions * 100).toFixed(0)}%`);
    }
  }

  console.log('\n' + '═'.repeat(120));

  // Summary statistics
  const totalMessages = messages.length;
  let tierMatches = 0;
  let scoreDiffsSum = 0;
  let bertHigher = 0;
  let ruleHigher = 0;

  for (const msg of messages) {
    const ruleResult = detectEmpathyNeeds(msg.content);
    const bertResult = await detectEmpathyNeedsBert(msg.content);

    if (bertResult.tier === ruleResult.tier) tierMatches++;

    const diff = bertResult.empathy_score - ruleResult.empathy_score;
    scoreDiffsSum += Math.abs(diff);

    if (diff > 0.05) bertHigher++;
    else if (diff < -0.05) ruleHigher++;
  }

  console.log(`\n📈 Summary:`);
  console.log(`   Tier agreement: ${tierMatches}/${totalMessages} (${((tierMatches / totalMessages) * 100).toFixed(1)}%)`);
  console.log(`   Avg score difference: ${(scoreDiffsSum / totalMessages).toFixed(3)}`);
  console.log(`   BERT scored higher: ${bertHigher} messages`);
  console.log(`   Rule-based scored higher: ${ruleHigher} messages`);
  console.log('');
}

main();
