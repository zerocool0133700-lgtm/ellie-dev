/**
 * Deep Classifier tests — ELLIE-92
 *
 * Covers pure functions only (no LLM required):
 * - parseDeepClassification: valid JSON, markdown-fenced JSON, invalid JSON, invalid tier
 * - buildClassificationPrompt: content injection, all four tier descriptions present
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
  parseDeepClassification,
  buildClassificationPrompt,
  initDeepClassifier,
  classifyDeep,
  type DeepTier,
  type DeepClassificationResult,
} from "../src/deep-classifier.ts";

// ── parseDeepClassification ───────────────────────────────────

describe("parseDeepClassification — valid JSON", () => {
  test("foundational tier parsed correctly", () => {
    const json = JSON.stringify({
      tier: "foundational",
      confidence: 0.92,
      emotional_intensity: 0.8,
      reasoning: "Core identity statement about Dave.",
    });
    const result = parseDeepClassification(json);
    expect(result.tier).toBe("foundational");
    expect(result.confidence).toBeCloseTo(0.92, 5);
    expect(result.emotional_intensity).toBeCloseTo(0.8, 5);
    expect(result.reasoning).toBe("Core identity statement about Dave.");
  });

  test("strategic tier parsed correctly", () => {
    const json = JSON.stringify({
      tier: "strategic",
      confidence: 0.85,
      emotional_intensity: 0.3,
      reasoning: "Architectural decision about DB choice.",
    });
    const result = parseDeepClassification(json);
    expect(result.tier).toBe("strategic");
    expect(result.confidence).toBeCloseTo(0.85, 5);
    expect(result.emotional_intensity).toBeCloseTo(0.3, 5);
  });

  test("operational tier parsed correctly", () => {
    const json = JSON.stringify({
      tier: "operational",
      confidence: 0.9,
      emotional_intensity: 0.0,
      reasoning: "Technical config detail.",
    });
    const result = parseDeepClassification(json);
    expect(result.tier).toBe("operational");
    expect(result.confidence).toBeCloseTo(0.9, 5);
  });

  test("ephemeral tier parsed correctly", () => {
    const json = JSON.stringify({
      tier: "ephemeral",
      confidence: 0.75,
      emotional_intensity: 0.1,
      reasoning: "One-time bug report.",
    });
    const result = parseDeepClassification(json);
    expect(result.tier).toBe("ephemeral");
    expect(result.confidence).toBeCloseTo(0.75, 5);
  });
});

describe("parseDeepClassification — markdown-fenced JSON", () => {
  test("```json fence stripped and parsed correctly", () => {
    const fenced = "```json\n{\"tier\":\"foundational\",\"confidence\":0.88,\"emotional_intensity\":0.6,\"reasoning\":\"Identity claim.\"}\n```";
    const result = parseDeepClassification(fenced);
    expect(result.tier).toBe("foundational");
    expect(result.confidence).toBeCloseTo(0.88, 5);
    expect(result.emotional_intensity).toBeCloseTo(0.6, 5);
    expect(result.reasoning).toBe("Identity claim.");
  });

  test("plain ``` fence stripped and parsed correctly", () => {
    const fenced = "```\n{\"tier\":\"ephemeral\",\"confidence\":0.7,\"emotional_intensity\":0.0,\"reasoning\":\"Transient error.\"}\n```";
    const result = parseDeepClassification(fenced);
    expect(result.tier).toBe("ephemeral");
    expect(result.confidence).toBeCloseTo(0.7, 5);
  });
});

describe("parseDeepClassification — failure paths", () => {
  test("invalid JSON → returns operational defaults", () => {
    const result = parseDeepClassification("this is not json {{{");
    expect(result.tier).toBe("operational");
    expect(result.confidence).toBe(0.65);
    expect(result.emotional_intensity).toBe(0);
    expect(result.reasoning).toContain("error");
  });

  test("invalid tier value → falls back to operational", () => {
    const json = JSON.stringify({
      tier: "unknown_tier",
      confidence: 0.9,
      emotional_intensity: 0.5,
      reasoning: "Some reasoning.",
    });
    const result = parseDeepClassification(json);
    expect(result.tier).toBe("operational");
  });

  test("missing confidence → defaults to 0.65", () => {
    const json = JSON.stringify({
      tier: "strategic",
      emotional_intensity: 0.2,
      reasoning: "No confidence provided.",
    });
    const result = parseDeepClassification(json);
    expect(result.tier).toBe("strategic");
    expect(result.confidence).toBe(0.65);
  });

  test("missing emotional_intensity → defaults to 0", () => {
    const json = JSON.stringify({
      tier: "operational",
      confidence: 0.8,
      reasoning: "No emotional intensity provided.",
    });
    const result = parseDeepClassification(json);
    expect(result.emotional_intensity).toBe(0);
  });

  test("missing reasoning → empty string", () => {
    const json = JSON.stringify({
      tier: "operational",
      confidence: 0.8,
      emotional_intensity: 0.1,
    });
    const result = parseDeepClassification(json);
    expect(result.reasoning).toBe("");
  });

  test("empty string → returns operational defaults", () => {
    const result = parseDeepClassification("");
    expect(result.tier).toBe("operational");
    expect(result.confidence).toBe(0.65);
  });
});

// ── buildClassificationPrompt ─────────────────────────────────

describe("buildClassificationPrompt", () => {
  const content = "Dave uses postgres as the primary database";
  const prompt = buildClassificationPrompt(content);

  test("includes the memory content", () => {
    expect(prompt).toContain(content);
  });

  test("includes all four tier names", () => {
    expect(prompt).toContain("foundational");
    expect(prompt).toContain("strategic");
    expect(prompt).toContain("operational");
    expect(prompt).toContain("ephemeral");
  });

  test("includes foundational tier description", () => {
    expect(prompt).toContain("Identity, values, relationships, vision");
  });

  test("includes strategic tier description", () => {
    expect(prompt).toContain("Decisions, preferences, working style");
  });

  test("includes operational tier description", () => {
    expect(prompt).toContain("Technical facts, system behavior, configs");
  });

  test("includes ephemeral tier description", () => {
    expect(prompt).toContain("Bug details, errors, one-time incidents");
  });

  test("instructs to return JSON only", () => {
    expect(prompt).toContain("Return JSON only");
  });

  test("different content produces different prompt", () => {
    const other = buildClassificationPrompt("Wincy is Dave's wife");
    expect(other).toContain("Wincy is Dave's wife");
    expect(other).not.toContain(content);
  });
});

// ── classifyDeep — no LLM path ────────────────────────────────

describe("classifyDeep — no LLM initialised", () => {
  test("returns operational defaults when no LLM", async () => {
    // Module loaded without initDeepClassifier — _anthropic is null
    const result = await classifyDeep("some memory content");
    expect(result.tier).toBe("operational");
    expect(result.confidence).toBe(0.65);
    expect(result.emotional_intensity).toBe(0);
    expect(result.reasoning).toContain("No LLM available");
  });
});

// ── classifyDeep — with mock LLM ─────────────────────────────

describe("classifyDeep — with mock Anthropic", () => {
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

  test("foundational tier returned from LLM response", async () => {
    const anthropic = makeAnthropic(
      JSON.stringify({
        tier: "foundational",
        confidence: 0.95,
        emotional_intensity: 0.9,
        reasoning: "Core identity statement.",
      })
    );
    initDeepClassifier(anthropic);

    const result = await classifyDeep("Dave is building Ellie OS for people with dyslexia.");
    expect(result.tier).toBe("foundational");
    expect(result.confidence).toBeCloseTo(0.95, 5);
    expect(result.emotional_intensity).toBeCloseTo(0.9, 5);
  });

  test("markdown-fenced JSON from LLM → strips fences", async () => {
    const fenced = "```json\n{\"tier\":\"strategic\",\"confidence\":0.8,\"emotional_intensity\":0.3,\"reasoning\":\"Architectural choice.\"}\n```";
    const anthropic = makeAnthropic(fenced);
    initDeepClassifier(anthropic);

    const result = await classifyDeep("Dave prefers Bun over Node for new services.");
    expect(result.tier).toBe("strategic");
    expect(result.confidence).toBeCloseTo(0.8, 5);
  });

  test("LLM API error → returns operational defaults", async () => {
    const anthropic = {
      messages: {
        create: mock(() => Promise.reject(new Error("API error"))),
      },
    } as any;
    initDeepClassifier(anthropic);

    const result = await classifyDeep("some content");
    expect(result.tier).toBe("operational");
    expect(result.confidence).toBe(0.65);
    expect(result.reasoning).toContain("error");
  });
});

// ── Type coverage ─────────────────────────────────────────────

describe("DeepTier type coverage", () => {
  test("all four tiers are valid assignments", () => {
    const tiers: DeepTier[] = ["foundational", "strategic", "operational", "ephemeral"];
    expect(tiers).toHaveLength(4);
  });

  test("DeepClassificationResult shape is correct", () => {
    const r: DeepClassificationResult = {
      tier: "strategic",
      confidence: 0.8,
      emotional_intensity: 0.2,
      reasoning: "Some reasoning.",
    };
    expect(r.tier).toBe("strategic");
    expect(r.confidence).toBe(0.8);
    expect(r.emotional_intensity).toBe(0.2);
    expect(r.reasoning).toBe("Some reasoning.");
  });
});
