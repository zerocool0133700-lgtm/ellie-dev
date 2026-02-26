/**
 * Correction Detector — ELLIE-250
 *
 * Detects when a user message is correcting a previous AI response.
 * Extracts the ground truth and writes it to the Forest as a high-confidence fact.
 *
 * Runs as a lightweight post-message hook (same pattern as runPostMessageAssessment).
 * Uses Haiku for fast, cheap classification.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { log } from "./logger.ts";

const logger = log.child("correction-detector");

// ── Correction patterns (fast pre-filter) ────────────────────

const CORRECTION_PATTERNS = [
  /^no[,.]?\s/i,
  /that'?s\s+(wrong|incorrect|not right|not true)/i,
  /actually[,.]?\s/i,
  /you('re|\s+are)\s+(wrong|mistaken|incorrect|confused)/i,
  /I\s+(said|meant|told you)/i,
  /not\s+\w+[,.]?\s+(it'?s|it\s+is|that'?s|that\s+is)/i,
  /correction:/i,
  /wrong[,.]\s/i,
  /I\s+didn'?t\s+(say|mean)/i,
  /that'?s not what I/i,
  /^wait[,.]?\s/i,
  /the\s+(correct|right|actual)\s+(answer|one|thing|name|date)/i,
  /it'?s\s+not\s+\w+[,.]?\s+it'?s/i,
  /I\s+never\s+(said|asked|wanted)/i,
];

/** Quick regex check — returns true if the message *might* be a correction. */
function mightBeCorrection(userMessage: string): boolean {
  return CORRECTION_PATTERNS.some(p => p.test(userMessage));
}

// ── Haiku classification ─────────────────────────────────────

interface CorrectionResult {
  is_correction: boolean;
  ground_truth: string;
  what_was_wrong: string;
  scope_path: string;
  tags: string[];
}

async function classifyCorrection(
  userMessage: string,
  previousAssistantMessage: string,
  anthropic: Anthropic,
): Promise<CorrectionResult | null> {
  const prompt = `You are a correction detector. Determine if the user message is correcting a factual claim in the assistant's previous response.

## Previous assistant message
${previousAssistantMessage.substring(0, 2000)}

## User message
${userMessage.substring(0, 1000)}

## Instructions

Is the user correcting a specific factual claim? Only flag EXPLICIT corrections where the user clearly states something the assistant said was wrong and provides the correct information.

Do NOT flag:
- Clarifications or additions ("also, X is true")
- Disagreements on opinion/approach
- Requests to redo or change something
- Simple "no" without providing what's correct

Return ONLY valid JSON:
{
  "is_correction": true/false,
  "ground_truth": "The correct fact as stated by the user (standalone, future-readable)",
  "what_was_wrong": "What the assistant got wrong (brief)",
  "scope_path": "2/1 for ellie-dev, 2/2 for ellie-forest, 2/3 for ellie-home, 2 for general/all",
  "tags": ["relevant", "topic", "tags"]
}

If not a correction, return: { "is_correction": false, "ground_truth": "", "what_was_wrong": "", "scope_path": "2", "tags": [] }`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]) as CorrectionResult;
  } catch (err) {
    logger.error("Correction classification failed", err);
    return null;
  }
}

// ── Forest write ─────────────────────────────────────────────

async function writeCorrectionToForest(
  result: CorrectionResult,
  conversationId: string | null,
  channel: string,
): Promise<string | null> {
  try {
    const { writeMemory } = await import("../../ellie-forest/src/shared-memory");

    const memory = await writeMemory({
      content: result.ground_truth,
      type: "fact",
      scope_path: result.scope_path,
      confidence: 1.0,
      tags: [
        ...result.tags,
        "correction:ground_truth",
        "source:user_correction",
        ...(channel ? [`channel:${channel}`] : []),
      ],
      metadata: {
        source: "correction_detector",
        what_was_wrong: result.what_was_wrong,
        conversation_id: conversationId,
        channel,
        work_item_id: "ELLIE-250",
      },
      category: "general",
    });

    logger.info("Correction captured", {
      memory_id: memory.id,
      ground_truth: result.ground_truth.substring(0, 80),
      what_was_wrong: result.what_was_wrong.substring(0, 80),
    });

    return memory.id;
  } catch (err) {
    logger.error("Failed to write correction to Forest", err);
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Check if a user message is correcting the previous assistant response.
 * If so, extract the ground truth and write it to the Forest.
 *
 * Designed to run fire-and-forget after saving the user message.
 * Uses a fast regex pre-filter + Haiku classification.
 */
export async function detectAndCaptureCorrection(
  userMessage: string,
  previousAssistantMessage: string,
  anthropic: Anthropic | null,
  channel: string,
  conversationId: string | null,
): Promise<void> {
  // Skip if no anthropic client or messages are too short
  if (!anthropic) return;
  if (userMessage.length < 10 || previousAssistantMessage.length < 20) return;

  // Fast regex pre-filter — skip Haiku call for most messages
  if (!mightBeCorrection(userMessage)) return;

  const result = await classifyCorrection(userMessage, previousAssistantMessage, anthropic);
  if (!result?.is_correction || !result.ground_truth) return;

  console.log(`[correction] Detected: "${result.what_was_wrong}" → "${result.ground_truth}"`);
  await writeCorrectionToForest(result, conversationId, channel);
}
