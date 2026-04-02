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
