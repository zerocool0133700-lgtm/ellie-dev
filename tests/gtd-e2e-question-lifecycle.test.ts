/**
 * GTD End-to-End Question Lifecycle — ELLIE-1295
 *
 * Integration test validating the full question lifecycle across
 * all Phase 1 and Phase 2 modules:
 *   - gtd-orchestration.ts  — tree creation, question items, answering
 *   - gtd-recovery.ts       — dispatch summary + pending answer formatting
 *   - ask-user-queue.ts     — in-memory question queue
 *   - telegram-question-format.ts — message formatting + disambiguation
 */

import { describe, test, expect, beforeEach, beforeAll, mock } from 'bun:test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ── Mock logger before any src imports ────────────────────────────────────────

mock.module('../src/logger.ts', () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}))

// ── Mock relay-state so Supabase tests use a real client when env vars exist ──

let _testSupabase: SupabaseClient | null = null

mock.module('../src/relay-state.ts', () => ({
  getRelayDeps: () => {
    if (!_testSupabase) throw new Error('Test Supabase not initialized')
    return { supabase: _testSupabase, bot: null, anthropic: null }
  },
  broadcastDispatchEvent: () => {},
}))

// ── Now import the modules under test ─────────────────────────────────────────

import {
  generateQuestionId,
  createOrchestrationParent,
  createDispatchChild,
  createQuestionItem,
  answerQuestion as answerGtdQuestion,
  getActiveOrchestrationTrees,
} from '../src/gtd-orchestration'
import { formatDispatchSummary, formatPendingAnswers } from '../src/gtd-recovery'
import {
  enqueueQuestion,
  answerQuestion as answerQueueQuestion,
  getPendingQuestions,
  clearQuestionQueue,
} from '../src/ask-user-queue'
import { formatQuestionMessage, disambiguateAnswer, stripRoutingPrefix } from '../src/telegram-question-format'

// ── Setup ──────────────────────────────────────────────────────────────────────

let supabaseAvailable = false
const createdIds: string[] = []

beforeAll(() => {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (url && key) {
    _testSupabase = createClient(url, key)
    supabaseAvailable = true
  } else {
    console.warn(
      '[SKIP] SUPABASE_URL/SUPABASE_ANON_KEY not set — GTD tree creation test will be skipped.',
    )
  }
})

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('GTD question lifecycle — end-to-end', () => {
  beforeEach(() => {
    clearQuestionQueue()
  })

  test('question ID generation → formatting → disambiguation round-trip', () => {
    const qId = generateQuestionId()
    expect(qId).toMatch(/^q-[0-9a-f]{8}$/)

    const msg = formatQuestionMessage({
      agentName: 'james',
      questionId: qId,
      question: 'JWT or cookies?',
      whatINeed: 'Pick one',
      decisionUnlocked: 'Auth implementation',
      choices: ['JWT', 'Cookies'],
    })
    expect(msg).toContain('james asks')
    expect(msg).toContain(qId.slice(0, 6))
    expect(msg).toContain('1. JWT')
    expect(msg).toContain('2. Cookies')

    const questions = [{
      questionId: qId,
      agentName: 'james',
      question: 'JWT or cookies?',
      choices: ['JWT', 'Cookies'],
    }]
    const match = disambiguateAnswer('JWT', questions)
    expect(match).not.toBe('ambiguous')
    expect((match as typeof questions[0]).questionId).toBe(qId)
  })

  test('multi-agent disambiguation with agent prefix', () => {
    const q1 = { questionId: 'q-aaaaaaaa', agentName: 'james', question: 'Approach?', choices: ['A', 'B'] }
    const q2 = { questionId: 'q-bbbbbbbb', agentName: 'kate', question: 'Framework?', choices: ['React', 'Vue'] }

    expect(disambiguateAnswer('james: go with A', [q1, q2])).toBe(q1)
    expect(disambiguateAnswer('kate: Vue', [q1, q2])).toBe(q2)
    expect(disambiguateAnswer('React', [q1, q2])).toBe(q2)
    expect(disambiguateAnswer('sounds good', [q1, q2])).toBe('ambiguous')
  })

  test('answer stripping removes routing prefix', () => {
    expect(stripRoutingPrefix('james: use JWT', 'james')).toBe('use JWT')
    expect(stripRoutingPrefix('q-7f3a use JWT', 'james')).toBe('use JWT')
    expect(stripRoutingPrefix('use JWT', 'james')).toBe('use JWT')
  })

  test('ask-user queue enqueue → answer → promise resolution', async () => {
    const queueId = enqueueQuestion('james', 'Which approach?', { options: ['A', 'B'] })
    expect(getPendingQuestions()).toHaveLength(1)

    const answered = answerQueueQuestion(queueId, 'Option A')
    expect(answered).toBe(true)
    expect(getPendingQuestions()).toHaveLength(0)

    expect(answerQueueQuestion(queueId, 'Option B')).toBe(false)
  })

  test('GTD tree creation with structured metadata', async () => {
    if (!supabaseAvailable) {
      console.log('[SKIP] Supabase not available — skipping GTD tree creation test')
      return
    }

    const parent = await createOrchestrationParent({
      content: 'Build auth system',
      createdBy: 'test-e2e',
    })
    expect(parent.id).toBeTruthy()
    createdIds.push(parent.id)

    const child = await createDispatchChild({
      parentId: parent.id,
      content: 'Implement middleware',
      assignedAgent: 'dev',
      assignedTo: 'james',
      createdBy: 'test-e2e',
    })
    expect(child.id).toBeTruthy()
    createdIds.push(child.id)

    const questionId = generateQuestionId()
    const question = await createQuestionItem({
      parentId: child.id,
      content: 'JWT or session cookies?',
      createdBy: 'test-e2e',
      urgency: 'blocking',
      metadata: {
        question_id: questionId,
        what_i_need: 'Pick one',
        decision_unlocked: 'Session store approach',
        answer_format: 'choice',
        choices: ['JWT', 'Session cookies'],
      },
    })
    expect(question.id).toBeTruthy()
    createdIds.push(question.id)

    const answeredParent = await answerGtdQuestion(question.id, 'JWT')
    expect(answeredParent).toBeTruthy()

    const trees = await getActiveOrchestrationTrees()
    expect(trees).toBeInstanceOf(Array)
  })

  test('recovery formatting produces readable summaries', () => {
    const tree = {
      id: 'p1',
      content: 'Build auth system',
      status: 'open',
      item_type: 'agent_dispatch',
      children: [
        {
          id: 'c1',
          content: 'Implement middleware',
          status: 'open',
          item_type: 'agent_dispatch',
          assigned_agent: 'james',
          children: [{
            id: 'gc1',
            content: 'JWT or session cookies?',
            status: 'open',
            item_type: 'agent_question',
            metadata: { question_id: 'q-testtest', what_i_need: 'Pick one' },
            children: [],
          }],
        },
        {
          id: 'c2',
          content: 'Write tests',
          status: 'done',
          item_type: 'agent_dispatch',
          assigned_agent: 'kate',
          children: [],
        },
      ],
    }

    const summary = formatDispatchSummary(tree)
    expect(summary).toContain('james')
    expect(summary).toContain('waiting')
    expect(summary).toContain('kate')
    expect(summary).toContain('completed')

    const pending = formatPendingAnswers(tree)
    expect(pending).toContain('q-testtest')
    expect(pending).toContain('Pick one')
  })
})
