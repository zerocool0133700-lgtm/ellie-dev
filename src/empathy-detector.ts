/**
 * Empathy Detector — EI Component 1
 *
 * Analyzes user messages to detect empathy needs and calculate empathy score.
 * Maps to response matrix: HIGH (>0.6), MODERATE (0.3-0.6), LOW (<0.3)
 *
 * Part of Emotional Intelligence system (EI detection signals framework)
 */

import vaderSentiment from 'vader-sentiment';

/**
 * Emotional language keywords (mapped from framework doc)
 */
const EMOTION_KEYWORDS = [
  'frustrated', 'frustrating', 'overwhelming', 'overwhelmed', 'stuck',
  'exhausted', 'tired', 'stressed', 'anxious', 'worried', 'scared',
  'angry', 'mad', 'upset', 'sad', 'defeated', 'hopeless', 'disappointed',
  'confused', 'lost', 'helpless', 'struggling', 'failing', 'can\'t handle'
];

/**
 * Vulnerability cue phrases
 */
const VULNERABILITY_CUES = [
  'i don\'t know what to do',
  'i can\'t handle this',
  'i\'m failing',
  'i don\'t know',
  'i\'m lost',
  'i need help',
  'i need support',
  'help me'
];

/**
 * Rhetorical question patterns
 */
const RHETORICAL_PATTERNS = [
  /why does this always happen to me/i,
  /what am i doing wrong/i,
  /why can't i/i,
  /what's wrong with me/i
];

/**
 * Task-focused language (inverse indicator — suggests low empathy need)
 */
const TASK_KEYWORDS = [
  'how do i', 'what\'s the best way', 'can you show me', 'let\'s fix',
  'help me build', 'i need to solve', 'just tell me', 'skip the'
];

export interface EmpathyDetectionResult {
  empathy_score: number;
  tier: 'HIGH' | 'MODERATE' | 'LOW';
  signals: {
    emotional_language_density: number;
    vulnerability_cues_present: boolean;
    help_seeking_vagueness: number;
    repeated_emotions: number;
    narrative_detail_ratio: number;
    rhetorical_questions: number;
  };
  detected_emotions: string[];
  response_guidance: string;
}

/**
 * Detect empathy needs in user message
 */
export function detectEmpathyNeeds(message: string): EmpathyDetectionResult {
  const lowerMessage = message.toLowerCase();
  const words = message.split(/\s+/);
  const wordCount = words.length;

  // 1. Emotional language density (25%) — count total emotion keyword occurrences
  const sentenceCount = message.split(/[.!?]+/).filter(s => s.trim().length > 0).length;

  // Count all occurrences of each emotion keyword
  const emotionCounts: Record<string, number> = {};
  let totalEmotionOccurrences = 0;

  for (const keyword of EMOTION_KEYWORDS) {
    const regex = new RegExp(`\\b${keyword}\\w*\\b`, 'gi'); // Match word boundaries + variants (frustrated, frustrating)
    const matches = lowerMessage.match(regex);
    if (matches) {
      emotionCounts[keyword] = matches.length;
      totalEmotionOccurrences += matches.length;
    }
  }

  const detected_emotions = Object.keys(emotionCounts);
  const emotional_language_density = Math.min(totalEmotionOccurrences / Math.max(sentenceCount, 1), 1);

  // 2. Vulnerability cues (30%) — strong signal, weighted higher
  const vulnerability_cues_present = VULNERABILITY_CUES.some(cue =>
    lowerMessage.includes(cue)
  );

  // 3. Help-seeking vagueness (10%) — inverse specificity
  // High task-focus = low vagueness = low empathy need
  const taskMatches = TASK_KEYWORDS.filter(kw => lowerMessage.includes(kw));
  const taskFocus = taskMatches.length / Math.max(sentenceCount, 1);
  const help_seeking_vagueness = taskMatches.length === 0 ? 0.5 : (1 - Math.min(taskFocus * 2, 1)); // Inverse

  // 4. Repeated emotions (10%) — same emotion mentioned multiple times
  const maxRepeats = Math.max(...Object.values(emotionCounts), 0);
  const repeated_emotions = maxRepeats > 1 ? Math.min((maxRepeats - 1) / 2, 1) : 0; // -1 because 1 occurrence is not a repeat

  // 5. Narrative detail ratio (10%) — feeling words vs fact words
  // Heuristic: multiple emotion words in short message = high emotional content
  const narrative_detail_ratio = totalEmotionOccurrences > 1
    ? Math.min(totalEmotionOccurrences / 3, 1)
    : 0;

  // 6. Rhetorical questions (15%) — strong empathy signal, weighted higher
  const rhetoricalCount = RHETORICAL_PATTERNS.filter(pattern =>
    pattern.test(message)
  ).length;
  const rhetorical_questions = Math.min(rhetoricalCount / 1, 1); // Each rhetorical question maxes this out

  // Calculate weighted empathy score
  const empathy_score = (
    emotional_language_density * 0.25 +
    (vulnerability_cues_present ? 1 : 0) * 0.30 +
    help_seeking_vagueness * 0.10 +
    repeated_emotions * 0.10 +
    narrative_detail_ratio * 0.10 +
    rhetorical_questions * 0.15
  );

  // Determine tier
  let tier: 'HIGH' | 'MODERATE' | 'LOW';
  let response_guidance: string;

  if (empathy_score > 0.6) {
    tier = 'HIGH';
    response_guidance = `HIGH EMPATHY NEED detected (score: ${empathy_score.toFixed(2)}). Response approach:
- Acknowledge emotion first (e.g., "That sounds really frustrating")
- Validate experience (e.g., "It makes sense you'd feel that way")
- Match tone (slower, gentler, patient)
- Ask permission before problem-solving (e.g., "Want to talk through it, or explore solutions?")
- Offer space (e.g., "I'm here — no rush")`;
  } else if (empathy_score >= 0.3) {
    tier = 'MODERATE';
    response_guidance = `MODERATE EMPATHY NEED detected (score: ${empathy_score.toFixed(2)}). Response approach:
- Brief acknowledgment + solution (e.g., "I hear you. Let's see if we can...")
- Balance validation + action
- Neutral tone`;
  } else {
    tier = 'LOW';
    response_guidance = `LOW EMPATHY NEED detected (score: ${empathy_score.toFixed(2)}). Response approach:
- Direct problem-solving
- Efficient, task-focused
- Minimal emotional processing`;
  }

  return {
    empathy_score,
    tier,
    signals: {
      emotional_language_density,
      vulnerability_cues_present,
      help_seeking_vagueness,
      repeated_emotions,
      narrative_detail_ratio,
      rhetorical_questions
    },
    detected_emotions,
    response_guidance
  };
}

/**
 * Extract primary emotion from message (for timeline tracking)
 */
export function extractPrimaryEmotion(message: string): { emotion: string; intensity: number } | null {
  const analysis = vaderSentiment.SentimentIntensityAnalyzer.polarity_scores(message);
  const lowerMessage = message.toLowerCase();

  // Find most prominent emotion keyword
  const emotionMatches = EMOTION_KEYWORDS.filter(kw => lowerMessage.includes(kw));

  if (emotionMatches.length === 0) {
    // Use sentiment as fallback only if compound score is significant
    if (Math.abs(analysis.compound) < 0.5) return null;

    const emotion = analysis.compound > 0 ? 'positive' : 'negative';
    const intensity = Math.abs(analysis.compound);
    return { emotion, intensity };
  }

  // Return first matched emotion with intensity based on VADER compound score
  const emotion = emotionMatches[0];
  const intensity = Math.max(Math.abs(analysis.compound), 0.3); // Minimum intensity for detected keywords

  return { emotion, intensity };
}

/**
 * Format response matrix guidance for prompt injection
 */
export function formatResponseGuidance(result: EmpathyDetectionResult): string {
  return `
## EMPATHY DETECTION RESULT

${result.response_guidance}

**Detected emotions:** ${result.detected_emotions.length > 0 ? result.detected_emotions.join(', ') : 'none'}

**Signal breakdown:**
- Emotional language: ${(result.signals.emotional_language_density * 100).toFixed(0)}%
- Vulnerability cues: ${result.signals.vulnerability_cues_present ? 'YES' : 'NO'}
- Help-seeking vagueness: ${(result.signals.help_seeking_vagueness * 100).toFixed(0)}%
- Repeated emotions: ${(result.signals.repeated_emotions * 100).toFixed(0)}%
- Narrative detail: ${(result.signals.narrative_detail_ratio * 100).toFixed(0)}%
- Rhetorical questions: ${(result.signals.rhetorical_questions * 100).toFixed(0)}%

IMPORTANT: Follow the response approach above. Match your tone and structure to the detected empathy need tier.
`.trim();
}
