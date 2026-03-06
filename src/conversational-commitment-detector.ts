/**
 * Conversational Commitment Detector — ELLIE-592
 *
 * Scans agent response text for implicit commitment language and
 * auto-creates commitment records in the ledger.
 *
 * Layer 2 of the commitment tracking system — catches softer promises
 * that aren't formal specialist dispatches.
 *
 * Two layers:
 *  - Pure: pattern matching + extraction (zero deps, testable)
 *  - Effectful: creates ledger entries (uses commitment-ledger)
 */

import { createCommitment } from "./commitment-ledger.ts";
import { log } from "./logger.ts";

const logger = log.child("conversational-commitment-detector");

// ── Configuration ────────────────────────────────────────────────────────────

let _enabled = true;

/** Enable or disable conversational commitment detection. */
export function setConversationalDetectionEnabled(enabled: boolean): void {
  _enabled = enabled;
}

/** Check if detection is enabled. */
export function isConversationalDetectionEnabled(): boolean {
  return _enabled;
}

// ── Pure: Commitment patterns ────────────────────────────────────────────────

export interface DetectedCommitment {
  phrase: string;
  description: string;
}

/**
 * Patterns that indicate a definite commitment.
 * Each pattern has a regex and a label describing the commitment type.
 * Order matters — first match wins per sentence.
 */
const COMMITMENT_PATTERNS: { pattern: RegExp; label: string }[] = [
  // Follow-up promises (must come before general "I'll + verb" to avoid false matches)
  { pattern: /\bI'll\s+get\s+back\s+to\s+you\b/i, label: "follow-up" },
  { pattern: /\bI'll\s+follow\s+up\b/i, label: "follow-up" },
  { pattern: /\bI'll\s+circle\s+back\b/i, label: "follow-up" },
  { pattern: /\bI'll\s+report\s+back\b/i, label: "follow-up" },
  { pattern: /\bI'll\s+let\s+you\s+know\b/i, label: "follow-up" },

  // Direct future promises
  { pattern: /\bI'll\s+(?:check|look into|investigate|research|find|get|send|create|set up|update|fix|handle|take care of|work on|prepare|draft|write|build|review|analyze)\b/i, label: "promised action" },
  { pattern: /\bI\s+will\s+(?:check|look into|investigate|research|find|get|send|create|set up|update|fix|handle|take care of|work on|prepare|draft|write|build|review|analyze)\b/i, label: "promised action" },
  { pattern: /\blet me\s+(?:check|look into|investigate|research|find|get|send|create|set up|update|fix|handle|take care of|work on|prepare|draft|write|build|review|analyze)\b/i, label: "immediate action" },

  // Dispatch / delegation language
  { pattern: /\bdispatching\s+(?:now|this|that|to)\b/i, label: "dispatch" },
  { pattern: /\bsending\s+(?:this|that)\s+to\b/i, label: "delegation" },
  { pattern: /\brouting\s+(?:this|that)\s+to\b/i, label: "delegation" },
  { pattern: /\bpassing\s+(?:this|that)\s+to\b/i, label: "delegation" },
];

/**
 * Patterns that indicate rhetorical or conditional language — NOT a commitment.
 * If any of these match the same sentence, the commitment is suppressed.
 */
const SUPPRESSION_PATTERNS: RegExp[] = [
  /\bI\s+could\b/i,
  /\bI\s+might\b/i,
  /\bI\s+would\b/i,
  /\bif\s+you\s+(?:want|need|like)\b/i,
  /\bwould\s+you\s+like\s+me\s+to\b/i,
  /\bdo\s+you\s+want\s+me\s+to\b/i,
  /\bshould\s+I\b/i,
  /\bI\s+can\b/i,
  /\bI\s+(?:could|can)\s+also\b/i,
];

/**
 * Split text into sentences for per-sentence analysis.
 */
export function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * Detect commitment language in a single sentence.
 * Returns the detected commitment or null if none found or suppressed.
 */
export function detectInSentence(sentence: string): DetectedCommitment | null {
  // Check suppression patterns first
  for (const suppression of SUPPRESSION_PATTERNS) {
    if (suppression.test(sentence)) return null;
  }

  // Check commitment patterns
  for (const { pattern, label } of COMMITMENT_PATTERNS) {
    const match = sentence.match(pattern);
    if (match) {
      return {
        phrase: match[0],
        description: `${label}: "${sentence.slice(0, 150)}"`,
      };
    }
  }

  return null;
}

/**
 * Scan agent response text and return all detected commitments.
 * Pure function — no side effects.
 */
export function detectCommitments(text: string): DetectedCommitment[] {
  const sentences = splitIntoSentences(text);
  const results: DetectedCommitment[] = [];

  for (const sentence of sentences) {
    const detected = detectInSentence(sentence);
    if (detected) results.push(detected);
  }

  return results;
}

// ── Effectful: Create ledger entries ─────────────────────────────────────────

/**
 * Scan agent response text, detect commitments, and create ledger entries.
 * Returns the number of commitments created.
 *
 * No-op if detection is disabled.
 */
export function detectAndLogCommitments(
  text: string,
  sessionId: string,
  turn: number,
): number {
  if (!_enabled) return 0;

  const detected = detectCommitments(text);
  if (detected.length === 0) return 0;

  for (const d of detected) {
    createCommitment({
      sessionId,
      description: d.description,
      source: "conversational",
      turnCreated: turn,
    });
  }

  logger.info("Conversational commitments detected", {
    sessionId,
    count: detected.length,
    phrases: detected.map(d => d.phrase),
  });

  return detected.length;
}
