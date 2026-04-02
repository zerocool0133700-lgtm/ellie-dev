interface QuestionFormatInput {
  agentName: string
  questionId: string
  question: string
  whatINeed: string
  decisionUnlocked: string
  choices?: string[]
}

export function formatQuestionMessage(input: QuestionFormatInput): string {
  const shortId = input.questionId.slice(0, 6)
  const lines: string[] = [
    `${input.agentName} asks (${shortId}):`,
    input.question,
    '',
    `What I need: ${input.whatINeed}`,
    `Unlocks: ${input.decisionUnlocked}`,
  ]

  if (input.choices && input.choices.length > 0) {
    lines.push('')
    input.choices.forEach((c, i) => lines.push(`${i + 1}. ${c}`))
  }

  return lines.join('\n')
}

interface DisambiguationQuestion {
  questionId: string
  agentName: string
  question: string
  choices?: string[]
}

export function disambiguateAnswer(
  answerText: string,
  pendingQuestions: DisambiguationQuestion[],
): DisambiguationQuestion | 'ambiguous' {
  if (pendingQuestions.length === 0) return 'ambiguous'
  if (pendingQuestions.length === 1) return pendingQuestions[0]

  const lower = answerText.toLowerCase().trim()

  // 1. Agent name prefix: "james: use JWT"
  const agentMatch = pendingQuestions.find(q =>
    lower.startsWith(q.agentName.toLowerCase() + ':'),
  )
  if (agentMatch) return agentMatch

  // 2. Choice matching: answer exactly matches a choice
  const choiceMatch = pendingQuestions.find(q =>
    q.choices?.some(c => c.toLowerCase() === lower),
  )
  if (choiceMatch) return choiceMatch

  // 3. Explicit question ID: "q-7f3a use JWT"
  const idMatch = answerText.match(/q-([0-9a-f]{4,8})/i)
  if (idMatch) {
    const match = pendingQuestions.find(q =>
      q.questionId.startsWith(`q-${idMatch[1]}`),
    )
    if (match) return match
  }

  return 'ambiguous'
}

export function stripRoutingPrefix(answerText: string, agentName: string): string {
  const agentPrefix = new RegExp(`^${agentName}:\\s*`, 'i')
  const stripped = answerText.replace(agentPrefix, '')
  if (stripped !== answerText) return stripped.trim()

  const idPrefix = /^q-[0-9a-f]{4,8}\s+/i
  return answerText.replace(idPrefix, '').trim()
}
