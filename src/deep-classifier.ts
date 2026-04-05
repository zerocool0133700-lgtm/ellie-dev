/**
 * Deep Classifier — ELLIE-92
 *
 * LLM-assisted classifier for ambiguous memories that the fast classifier
 * could not confidently tier. Uses Haiku for cheap, accurate classification.
 *
 * Tiers:
 * - foundational: Identity, values, relationships, vision
 * - strategic:    Decisions, preferences, architectural choices
 * - operational:  Technical facts, configs, system behaviour
 * - ephemeral:    Bugs, errors, one-time incidents, transient state
 */

import type Anthropic from "@anthropic-ai/sdk";
import { log } from "./logger.ts";

const logger = log.child("deep-classifier");

export type DeepTier = "foundational" | "strategic" | "operational" | "ephemeral";

export interface DeepClassificationResult {
  tier: DeepTier;
  confidence: number;
  emotional_intensity: number;
  category: string | null;
  reasoning: string;
}

const VALID_TIERS: DeepTier[] = ["foundational", "strategic", "operational", "ephemeral"];

const DEFAULT_RESULT: DeepClassificationResult = {
  tier: "operational",
  confidence: 0.65,
  emotional_intensity: 0,
  category: null,
  reasoning: "Classification unavailable — defaulting to operational",
};

const VALID_CATEGORIES = [
  "health", "fitness", "relationships", "identity", "financial",
  "learning", "mental_health", "work", "hobbies", "family",
  "spirituality", "general",
];

let _anthropic: Anthropic | null = null;

export function initDeepClassifier(anthropic: Anthropic): void {
  _anthropic = anthropic;
  logger.info("Initialized");
}

export function buildClassificationPrompt(content: string): string {
  return `Classify this memory for a personal AI assistant named Ellie.
Ellie's owner is Dave, a dyslexic enterprise architect building Ellie OS as a personal AI companion and future product for people with learning disabilities.

Memory: "${content}"

Which tier best describes this memory?
- foundational: Identity, values, relationships, vision, who people are, what matters to them
- strategic: Decisions, preferences, working style, architectural choices, the "why" behind things
- operational: Technical facts, system behavior, configs, how things work
- ephemeral: Bug details, errors, one-time incidents, transient state

Also classify the category:
- health, fitness, relationships, identity, financial, learning, mental_health, work, hobbies, family, spirituality, general

Return JSON only: {"tier": "foundational|strategic|operational|ephemeral", "confidence": 0.0-1.0, "emotional_intensity": 0.0-1.0, "category": "one of the above", "reasoning": "one sentence"}`;
}

export function parseDeepClassification(text: string): DeepClassificationResult {
  try {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```\s*$/m, "");

    const parsed = JSON.parse(cleaned);
    const tier: DeepTier = VALID_TIERS.includes(parsed.tier) ? parsed.tier : "operational";

    const category = VALID_CATEGORIES.includes(parsed.category) ? parsed.category : null;

    return {
      tier,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : DEFAULT_RESULT.confidence,
      emotional_intensity: typeof parsed.emotional_intensity === "number" ? parsed.emotional_intensity : 0,
      category,
      reasoning: parsed.reasoning || "",
    };
  } catch {
    return { ...DEFAULT_RESULT, category: null, reasoning: "Parse error — defaulting to operational" };
  }
}

export async function classifyDeep(content: string): Promise<DeepClassificationResult> {
  if (!_anthropic) {
    return { ...DEFAULT_RESULT, reasoning: "No LLM available — defaulting to operational" };
  }

  const prompt = buildClassificationPrompt(content);

  try {
    const response = await _anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { type: string; text: string }) => b.text)
      .join("");

    return parseDeepClassification(text);
  } catch (err) {
    logger.error("Deep classification failed", err);
    return { ...DEFAULT_RESULT, reasoning: "Classification error — defaulting to operational" };
  }
}

export async function processDeepClassificationBatch(opts?: {
  limit?: number;
}): Promise<number> {
  const limit = opts?.limit ?? 50;

  const db = (await import("../../ellie-forest/src/db.ts")).default;

  const rows = await db<{ id: string; content: string; confidence: number }[]>`
    SELECT id, content, confidence
    FROM shared_memories
    WHERE needs_deep_classification = true
      AND status = 'active'
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;

  let count = 0;

  for (const mem of rows) {
    const result = await classifyDeep(mem.content);

    // Override protection: if existing confidence is high, keep the better value
    const finalConfidence =
      mem.confidence > 0.7
        ? Math.max(mem.confidence, result.confidence)
        : result.confidence;

    await db`
      UPDATE shared_memories
      SET
        content_tier               = ${result.tier},
        confidence                 = ${finalConfidence},
        emotional_intensity        = ${result.emotional_intensity},
        needs_deep_classification  = false
        ${result.category ? db`, category = ${result.category}` : db``}
      WHERE id = ${mem.id}
    `;

    count++;
  }

  logger.info(`Deep-classified ${count} memories`);
  return count;
}
