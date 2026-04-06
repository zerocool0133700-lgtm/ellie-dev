#!/usr/bin/env bun

/**
 * VADER Sentiment Analysis Test Script
 *
 * Analyzes recent user messages from Supabase and flags strong negative sentiment.
 * Threshold: compound score < -0.5 indicates strong negative sentiment.
 */

import { createClient } from '@supabase/supabase-js'
// @ts-ignore - vaderSentiment doesn't have TypeScript types
import vader from 'vader-sentiment'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

interface Message {
  id: string
  content: string
  role: 'user' | 'assistant'
  created_at: string
  conversation_id: string
}

interface SentimentResult {
  messageId: string
  content: string
  timestamp: string
  conversationId: string
  scores: {
    negative: number
    neutral: number
    positive: number
    compound: number
  }
  flagged: boolean
}

async function analyzeRecentMessages(limit: number = 50) {
  console.log(`\n📊 Analyzing last ${limit} user messages...\n`)

  // Fetch recent user messages
  const { data: messages, error } = await supabase
    .from('messages')
    .select('id, content, role, created_at, conversation_id')
    .eq('role', 'user')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('Error fetching messages:', error)
    process.exit(1)
  }

  if (!messages || messages.length === 0) {
    console.log('No messages found.')
    return
  }

  const results: SentimentResult[] = []
  const flaggedMessages: SentimentResult[] = []

  for (const message of messages as Message[]) {
    // Skip empty or very short messages
    if (!message.content || message.content.trim().length < 3) {
      continue
    }

    // Run VADER sentiment analysis
    const scores = vader.SentimentIntensityAnalyzer.polarity_scores(message.content)

    const result: SentimentResult = {
      messageId: message.id,
      content: message.content.substring(0, 100), // Truncate for display
      timestamp: message.created_at,
      conversationId: message.conversation_id,
      scores: {
        negative: scores.neg,
        neutral: scores.neu,
        positive: scores.pos,
        compound: scores.compound
      },
      flagged: scores.compound < -0.5
    }

    results.push(result)

    if (result.flagged) {
      flaggedMessages.push(result)
    }
  }

  // Display summary
  console.log(`✅ Analyzed ${results.length} messages\n`)
  console.log(`🚩 Flagged ${flaggedMessages.length} messages with strong negative sentiment (compound < -0.5)\n`)

  // Display flagged messages
  if (flaggedMessages.length > 0) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('🚨 FLAGGED MESSAGES (Strong Negative Sentiment)')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

    for (const msg of flaggedMessages) {
      console.log(`📅 ${new Date(msg.timestamp).toLocaleString()}`)
      console.log(`💬 "${msg.content}${msg.content.length >= 100 ? '...' : ''}"`)
      console.log(`📊 Scores:`)
      console.log(`   • Compound: ${msg.scores.compound.toFixed(3)} (FLAGGED)`)
      console.log(`   • Negative: ${msg.scores.negative.toFixed(3)}`)
      console.log(`   • Neutral:  ${msg.scores.neutral.toFixed(3)}`)
      console.log(`   • Positive: ${msg.scores.positive.toFixed(3)}`)
      console.log(`🔗 Conversation ID: ${msg.conversationId}`)
      console.log('')
    }
  } else {
    console.log('✨ No strongly negative messages detected in this sample.\n')
  }

  // Display distribution stats
  const avgCompound = results.reduce((sum, r) => sum + r.scores.compound, 0) / results.length
  const minCompound = Math.min(...results.map(r => r.scores.compound))
  const maxCompound = Math.max(...results.map(r => r.scores.compound))

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('📈 SENTIMENT DISTRIBUTION')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
  console.log(`Average compound score: ${avgCompound.toFixed(3)}`)
  console.log(`Range: ${minCompound.toFixed(3)} to ${maxCompound.toFixed(3)}`)
  console.log(`Flag rate: ${((flaggedMessages.length / results.length) * 100).toFixed(1)}%\n`)

  // Categorize by sentiment
  const positive = results.filter(r => r.scores.compound >= 0.5).length
  const neutral = results.filter(r => r.scores.compound > -0.5 && r.scores.compound < 0.5).length
  const negative = results.filter(r => r.scores.compound <= -0.5).length

  console.log('Sentiment breakdown:')
  console.log(`  😊 Positive (≥ 0.5):  ${positive} (${((positive / results.length) * 100).toFixed(1)}%)`)
  console.log(`  😐 Neutral:            ${neutral} (${((neutral / results.length) * 100).toFixed(1)}%)`)
  console.log(`  😟 Negative (≤ -0.5):  ${negative} (${((negative / results.length) * 100).toFixed(1)}%)`)
  console.log('')
}

// Run the analysis
const messageLimit = process.argv[2] ? parseInt(process.argv[2]) : 50

analyzeRecentMessages(messageLimit)
  .then(() => {
    console.log('✅ Analysis complete\n')
    process.exit(0)
  })
  .catch(err => {
    console.error('❌ Error:', err)
    process.exit(1)
  })
