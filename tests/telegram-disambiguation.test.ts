import { describe, test, expect } from 'bun:test'
import { formatQuestionMessage } from '../src/telegram-question-format'

describe('formatQuestionMessage', () => {
  test('includes agent name and question ID', () => {
    const msg = formatQuestionMessage({
      agentName: 'james',
      questionId: 'q-7f3a2b1c',
      question: 'Should we use JWT or session cookies?',
      whatINeed: 'Pick one — this decides the session store.',
      decisionUnlocked: 'Session store implementation',
    })
    expect(msg).toContain('james asks (q-7f3a)')
    expect(msg).toContain('Should we use JWT or session cookies?')
    expect(msg).toContain('What I need:')
    expect(msg).toContain('Pick one')
    expect(msg).toContain('Unlocks:')
  })

  test('includes choices when provided', () => {
    const msg = formatQuestionMessage({
      agentName: 'kate',
      questionId: 'q-aabbccdd',
      question: 'Which approach?',
      whatINeed: 'Choose one',
      decisionUnlocked: 'Will proceed',
      choices: ['Option A', 'Option B'],
    })
    expect(msg).toContain('1. Option A')
    expect(msg).toContain('2. Option B')
  })

  test('displays short ID (first 4 hex chars)', () => {
    const msg = formatQuestionMessage({
      agentName: 'alan',
      questionId: 'q-deadbeef',
      question: 'Test?',
      whatINeed: 'Answer',
      decisionUnlocked: 'Next step',
    })
    expect(msg).toContain('q-dead')
    expect(msg).not.toContain('q-deadbeef')
  })
})

import { disambiguateAnswer, stripRoutingPrefix } from '../src/telegram-question-format'

interface MockQuestion {
  questionId: string
  agentName: string
  question: string
  choices?: string[]
}

describe('disambiguateAnswer', () => {
  const q1: MockQuestion = {
    questionId: 'q-7f3a2b1c',
    agentName: 'james',
    question: 'JWT or session cookies?',
    choices: ['JWT', 'Session cookies'],
  }
  const q2: MockQuestion = {
    questionId: 'q-aabbccdd',
    agentName: 'kate',
    question: 'Use materialized view?',
    choices: ['Yes', 'No'],
  }

  test('single pending question routes directly', () => {
    expect(disambiguateAnswer('use JWT', [q1])).toBe(q1)
  })

  test('agent name prefix routes correctly', () => {
    expect(disambiguateAnswer('james: use JWT', [q1, q2])).toBe(q1)
  })

  test('agent name prefix is case-insensitive', () => {
    expect(disambiguateAnswer('James: use JWT', [q1, q2])).toBe(q1)
  })

  test('choice matching routes to correct question', () => {
    expect(disambiguateAnswer('JWT', [q1, q2])).toBe(q1)
  })

  test('choice matching is case-insensitive', () => {
    expect(disambiguateAnswer('jwt', [q1, q2])).toBe(q1)
  })

  test('explicit question ID routes by ID', () => {
    expect(disambiguateAnswer('q-aabb yes', [q1, q2])).toBe(q2)
  })

  test('ambiguous answer returns "ambiguous"', () => {
    expect(disambiguateAnswer('sounds good', [q1, q2])).toBe('ambiguous')
  })

  test('no pending questions returns "ambiguous"', () => {
    expect(disambiguateAnswer('hello', [])).toBe('ambiguous')
  })
})

describe('stripRoutingPrefix', () => {
  test('strips agent name prefix', () => {
    expect(stripRoutingPrefix('james: use JWT', 'james')).toBe('use JWT')
  })

  test('strips question ID prefix', () => {
    expect(stripRoutingPrefix('q-7f3a use JWT', 'james')).toBe('use JWT')
  })

  test('leaves plain answers unchanged', () => {
    expect(stripRoutingPrefix('use JWT', 'james')).toBe('use JWT')
  })
})
