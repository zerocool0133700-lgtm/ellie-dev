/**
 * Entailment Classifier — ELLIE-92
 *
 * Classifies the semantic relationship between two memory statements:
 * - "entails": they agree (corroboration)
 * - "contradicts": they make incompatible claims
 * - "neutral": similar topic but independent claims
 *
 * Uses Haiku for fast, cheap classification (~$0.001/call).
 */

import type Anthropic from "@anthropic-ai/sdk";

export type EntailmentLabel = "entails" | "contradicts" | "neutral";

export interface EntailmentResult {
  label: EntailmentLabel;
  confidence: number;
  reasoning: string;
}

let _anthropic: Anthropic | null = null;

export function initEntailmentClassifier(anthropic: Anthropic): void {
  _anthropic = anthropic;
  console.log("[entailment] Initialized");
}

export async function classifyEntailment(
  memoryA: string,
  memoryB: string,
): Promise<EntailmentResult> {
  if (!_anthropic) {
    return { label: "contradicts", confidence: 0.5, reasoning: "No LLM available — defaulting to contradiction" };
  }

  const prompt = `You are a precise semantic judge. Given two statements from an AI memory system, classify their relationship.

Statement A (new): "${memoryA}"
Statement B (existing): "${memoryB}"

Classify as exactly one of:
- "entails": A and B agree or say the same thing (corroboration)
- "contradicts": A and B make incompatible claims about the same topic
- "neutral": A and B are about similar topics but make independent, non-conflicting claims

Respond with ONLY a JSON object (no markdown fences):
{"label": "entails|contradicts|neutral", "confidence": 0.0-1.0, "reasoning": "one sentence"}`;

  try {
    const response = await _anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");

    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```\s*$/m, "");

    const parsed = JSON.parse(cleaned);
    const validLabels: EntailmentLabel[] = ["entails", "contradicts", "neutral"];
    const label = validLabels.includes(parsed.label) ? parsed.label : "contradicts";

    return {
      label,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      reasoning: parsed.reasoning || "",
    };
  } catch (err) {
    console.error("[entailment] Classification failed:", err);
    return { label: "contradicts", confidence: 0.5, reasoning: "Classification error — defaulting to contradiction" };
  }
}
