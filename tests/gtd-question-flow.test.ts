import { describe, test, expect } from 'bun:test'
import { generateQuestionId } from '../src/gtd-orchestration'
import { formatDispatchSummary, formatPendingAnswers } from '../src/gtd-recovery'

describe('end-to-end question flow', () => {
  test('generateQuestionId format', () => {
    const id = generateQuestionId()
    expect(id).toMatch(/^q-[0-9a-f]{8}$/)
  })

  test('structured metadata round-trip', () => {
    const metadata = {
      question_id: generateQuestionId(),
      what_i_need: 'Pick JWT or session cookies',
      decision_unlocked: 'Will implement chosen auth approach',
      answer_format: 'choice' as const,
      choices: ['JWT', 'Session cookies'],
    }
    expect(metadata.question_id).toMatch(/^q-/)
    expect(metadata.what_i_need).toBeTruthy()
    expect(metadata.decision_unlocked).toBeTruthy()
    expect(metadata.answer_format).toBe('choice')
    expect(metadata.choices).toHaveLength(2)
  })

  test('recovery formatting with mock tree', () => {
    const tree = {
      id: 'p1',
      content: 'Test dispatch',
      status: 'open',
      item_type: 'agent_dispatch',
      children: [{
        id: 'c1',
        content: 'Agent task',
        status: 'open',
        item_type: 'agent_dispatch',
        assigned_agent: 'james',
        children: [{
          id: 'gc1',
          content: 'Pick an approach',
          status: 'open',
          item_type: 'agent_question',
          metadata: {
            question_id: 'q-aabbccdd',
            what_i_need: 'Choose A or B',
            decision_unlocked: 'Will proceed with chosen approach',
          },
          children: [],
        }],
      }],
    }

    const summary = formatDispatchSummary(tree)
    expect(summary).toContain('james')
    expect(summary).toContain('waiting')

    const anchors = formatPendingAnswers(tree)
    expect(anchors).toContain('q-aabbccdd')
    expect(anchors).toContain('Choose A or B')
  })

  test('recovery with no pending questions returns empty', () => {
    const tree = {
      id: 'p1',
      content: 'Test dispatch',
      status: 'open',
      item_type: 'agent_dispatch',
      children: [{
        id: 'c1',
        content: 'Done task',
        status: 'done',
        item_type: 'agent_dispatch',
        assigned_agent: 'kate',
        children: [],
      }],
    }

    const anchors = formatPendingAnswers(tree)
    expect(anchors).toBe('')
  })
})
