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
