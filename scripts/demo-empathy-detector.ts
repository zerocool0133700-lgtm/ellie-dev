/**
 * Empathy Detector Demo — EI MVP Demonstration
 *
 * Shows the empathy detection system analyzing various message types.
 */

import { detectEmpathyNeeds } from "../src/empathy-detector.ts";

console.log("═══════════════════════════════════════════════════════════════");
console.log("  EMPATHY DETECTOR MVP — Demonstration");
console.log("  Component 1 of Emotional Intelligence System");
console.log("═══════════════════════════════════════════════════════════════\n");

const testMessages = [
  {
    label: "HIGH EMPATHY NEED",
    message: "I'm so frustrated and overwhelmed. I don't know what to do. I feel like I'm failing at everything.",
  },
  {
    label: "MODERATE EMPATHY NEED",
    message: "I'm a bit stuck on this problem. Can you help me figure out the best approach?",
  },
  {
    label: "LOW EMPATHY NEED (Task-focused)",
    message: "How do I implement the authentication handler? Show me the code for JWT validation.",
  },
  {
    label: "REPEATED EMOTIONS",
    message: "I'm frustrated with this. It's so frustrating. I keep getting frustrated every time I try.",
  },
  {
    label: "VULNERABILITY CUES",
    message: "I don't know what to do. I can't handle this anymore. I need help.",
  },
  {
    label: "RHETORICAL QUESTIONS",
    message: "Why does this always happen to me? What am I doing wrong?",
  },
];

for (const test of testMessages) {
  console.log(`\n${"─".repeat(70)}`);
  console.log(`TEST: ${test.label}`);
  console.log(`${"─".repeat(70)}`);
  console.log(`MESSAGE: "${test.message}"\n`);

  const result = detectEmpathyNeeds(test.message);

  console.log(`EMPATHY SCORE: ${result.empathy_score.toFixed(3)} → TIER: ${result.tier}`);
  console.log(`\nDETECTED EMOTIONS: ${result.detected_emotions.length > 0 ? result.detected_emotions.join(", ") : "none"}`);

  console.log(`\nSIGNAL BREAKDOWN:`);
  console.log(`  • Emotional language:   ${(result.signals.emotional_language_density * 100).toFixed(0)}%`);
  console.log(`  • Vulnerability cues:   ${result.signals.vulnerability_cues_present ? "YES" : "NO"}`);
  console.log(`  • Help-seeking vague:   ${(result.signals.help_seeking_vagueness * 100).toFixed(0)}%`);
  console.log(`  • Repeated emotions:    ${(result.signals.repeated_emotions * 100).toFixed(0)}%`);
  console.log(`  • Narrative detail:     ${(result.signals.narrative_detail_ratio * 100).toFixed(0)}%`);
  console.log(`  • Rhetorical questions: ${(result.signals.rhetorical_questions * 100).toFixed(0)}%`);

  console.log(`\nRESPONSE GUIDANCE:`);
  const guidanceLines = result.response_guidance.split("\n").slice(0, 3); // First 3 lines
  guidanceLines.forEach(line => console.log(`  ${line}`));
}

console.log(`\n${"═".repeat(70)}`);
console.log("  Demo complete — Empathy Detector MVP is operational!");
console.log(`${"═".repeat(70)}\n`);
