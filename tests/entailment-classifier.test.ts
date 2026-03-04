/**
 * ELLIE-512 — Entailment Classifier tests
 *
 * Covers:
 * - classifyEntailment when no LLM initialised → default contradiction
 * - initEntailmentClassifier + classifyEntailment → valid labels parsed
 * - Invalid label from LLM → falls back to "contradicts"
 * - JSON parse error → error fallback result
 * - Markdown-fenced JSON (```json...```) → stripped and parsed correctly
 * - Confidence and reasoning fields extracted
 */

import { describe, test, expect, mock } from "bun:test";

// ── Mocks ─────────────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: {
    child: () => ({
      info: mock(),
      warn: mock(),
      error: mock(),
    }),
  },
}));

// ── Imports after mocks ───────────────────────────────────────

import {
  classifyEntailment,
  initEntailmentClassifier,
  type EntailmentLabel,
  type EntailmentResult,
} from "../src/entailment-classifier.ts";

// ── Helpers ───────────────────────────────────────────────────

function makeAnthropic(responseText: string) {
  return {
    messages: {
      create: mock(() =>
        Promise.resolve({
          content: [{ type: "text", text: responseText }],
        })
      ),
    },
  } as any;
}

// ── No-LLM path ───────────────────────────────────────────────

describe("classifyEntailment — no LLM initialised", () => {
  // Note: entailment-classifier module keeps _anthropic in module scope.
  // Tests in this describe run before initEntailmentClassifier is called,
  // so _anthropic is null → default result is returned.

  test("returns contradicts label with confidence 0.5 when no LLM", async () => {
    // Reset to no-LLM state by importing fresh — module is already loaded
    // without init in this test file context.
    // We re-export and test at module level before calling init.
    const result = await classifyEntailment("A is true", "A is false");
    expect(result.label).toBe("contradicts");
    expect(result.confidence).toBe(0.5);
    expect(result.reasoning).toContain("No LLM available");
  });
});

// ── LLM path ─────────────────────────────────────────────────

describe("classifyEntailment — with LLM (mock Anthropic)", () => {
  test("entails label parsed correctly", async () => {
    const anthropic = makeAnthropic(
      JSON.stringify({ label: "entails", confidence: 0.95, reasoning: "Both say Paris is the capital." })
    );
    initEntailmentClassifier(anthropic);

    const result = await classifyEntailment(
      "Paris is the capital of France.",
      "The French capital is Paris.",
    );
    expect(result.label).toBe("entails");
    expect(result.confidence).toBeCloseTo(0.95, 5);
    expect(result.reasoning).toBe("Both say Paris is the capital.");
  });

  test("contradicts label parsed correctly", async () => {
    const anthropic = makeAnthropic(
      JSON.stringify({ label: "contradicts", confidence: 0.9, reasoning: "Different capitals claimed." })
    );
    initEntailmentClassifier(anthropic);

    const result = await classifyEntailment(
      "Berlin is the capital of France.",
      "Paris is the capital of France.",
    );
    expect(result.label).toBe("contradicts");
    expect(result.confidence).toBeCloseTo(0.9, 5);
  });

  test("neutral label parsed correctly", async () => {
    const anthropic = makeAnthropic(
      JSON.stringify({ label: "neutral", confidence: 0.7, reasoning: "Unrelated geographic facts." })
    );
    initEntailmentClassifier(anthropic);

    const result = await classifyEntailment(
      "Paris is in France.",
      "Berlin has many museums.",
    );
    expect(result.label).toBe("neutral");
    expect(result.confidence).toBeCloseTo(0.7, 5);
  });

  test("invalid label from LLM → defaults to 'contradicts'", async () => {
    const anthropic = makeAnthropic(
      JSON.stringify({ label: "unknown_label", confidence: 0.6, reasoning: "Weird response." })
    );
    initEntailmentClassifier(anthropic);

    const result = await classifyEntailment("A", "B");
    expect(result.label).toBe("contradicts");
  });

  test("malformed JSON → returns error fallback", async () => {
    const anthropic = makeAnthropic("this is not json at all {{{");
    initEntailmentClassifier(anthropic);

    const result = await classifyEntailment("A", "B");
    expect(result.label).toBe("contradicts");
    expect(result.confidence).toBe(0.5);
    expect(result.reasoning).toContain("error");
  });

  test("markdown-fenced JSON (```json) → strips fences and parses", async () => {
    const fenced = "```json\n{\"label\":\"entails\",\"confidence\":0.85,\"reasoning\":\"Same claim.\"}\n```";
    const anthropic = makeAnthropic(fenced);
    initEntailmentClassifier(anthropic);

    const result = await classifyEntailment("X is true", "X is true");
    expect(result.label).toBe("entails");
    expect(result.confidence).toBeCloseTo(0.85, 5);
    expect(result.reasoning).toBe("Same claim.");
  });

  test("missing confidence in LLM response → defaults to 0.5", async () => {
    const anthropic = makeAnthropic(
      JSON.stringify({ label: "neutral", reasoning: "Independent claims." })
    );
    initEntailmentClassifier(anthropic);

    const result = await classifyEntailment("A", "B");
    expect(result.label).toBe("neutral");
    expect(result.confidence).toBe(0.5);
  });

  test("missing reasoning in LLM response → empty string", async () => {
    const anthropic = makeAnthropic(
      JSON.stringify({ label: "entails", confidence: 0.9 })
    );
    initEntailmentClassifier(anthropic);

    const result = await classifyEntailment("A is true", "A is correct");
    expect(result.label).toBe("entails");
    expect(result.reasoning).toBe("");
  });

  test("LLM API error → returns error fallback", async () => {
    const anthropic = {
      messages: {
        create: mock(() => Promise.reject(new Error("API connection refused"))),
      },
    } as any;
    initEntailmentClassifier(anthropic);

    const result = await classifyEntailment("A", "B");
    expect(result.label).toBe("contradicts");
    expect(result.confidence).toBe(0.5);
    expect(result.reasoning).toContain("error");
  });
});

// ── Type-level checks ─────────────────────────────────────────

describe("EntailmentLabel type coverage", () => {
  test("all three labels are valid assignments", () => {
    const labels: EntailmentLabel[] = ["entails", "contradicts", "neutral"];
    expect(labels).toHaveLength(3);
  });

  test("EntailmentResult shape is correct", () => {
    const r: EntailmentResult = {
      label: "neutral",
      confidence: 0.75,
      reasoning: "Different claims.",
    };
    expect(r.label).toBe("neutral");
    expect(r.confidence).toBe(0.75);
    expect(r.reasoning).toBe("Different claims.");
  });
});
