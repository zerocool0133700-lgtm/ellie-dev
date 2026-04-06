/**
 * Tests for routing observability — ELLIE-1452
 *
 * Covers:
 *   - extractRoutingReasoning: pulls text from content blocks before a tool call
 *   - emitRoutingDecision: stores decisions in memory, broadcasts to WebSocket
 *   - recordRoutingFeedback: stores feedback, journals it, writes to Forest
 *   - handleRoutingFeedback / handleGetRoutingDecisions / handleGetRoutingFeedback: HTTP handlers
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  extractRoutingReasoning,
  emitRoutingDecision,
  recordRoutingFeedback,
  getRecentRoutingDecisions,
  getRoutingFeedback,
  handleGetRoutingDecisions,
  handleGetRoutingFeedback,
  handleRoutingFeedback,
  _clearDecisionsForTesting,
  _clearFeedbackForTesting,
} from "../src/routing-observability.ts";

// ── extractRoutingReasoning ──────────────────────────────────────────────────

describe("extractRoutingReasoning", () => {
  it("extracts text before the target tool_use block", () => {
    const blocks = [
      { type: "text", text: "Thinking about this request..." },
      { type: "text", text: "I'll dispatch to James for this dev task." },
      { type: "tool_use", id: "tu_abc", name: "dispatch_agent", input: {} },
    ];
    const reasoning = extractRoutingReasoning(blocks, "tu_abc");
    expect(reasoning).toContain("Thinking about this request...");
    expect(reasoning).toContain("dispatch to James");
  });

  it("stops at the matching tool_use ID", () => {
    const blocks = [
      { type: "text", text: "First dispatch reasoning." },
      { type: "tool_use", id: "tu_first", name: "dispatch_agent", input: {} },
      { type: "text", text: "Second dispatch reasoning." },
      { type: "tool_use", id: "tu_second", name: "dispatch_agent", input: {} },
    ];
    const first = extractRoutingReasoning(blocks, "tu_first");
    expect(first).toContain("First dispatch reasoning.");
    expect(first).not.toContain("Second dispatch reasoning.");
  });

  it("returns empty string when no text blocks exist", () => {
    const blocks = [
      { type: "tool_use", id: "tu_abc", name: "dispatch_agent", input: {} },
    ];
    expect(extractRoutingReasoning(blocks, "tu_abc")).toBe("");
  });

  it("caps reasoning at 500 chars", () => {
    const longText = "A".repeat(600);
    const blocks = [
      { type: "text", text: longText },
      { type: "tool_use", id: "tu_abc", name: "dispatch_agent", input: {} },
    ];
    const reasoning = extractRoutingReasoning(blocks, "tu_abc");
    expect(reasoning.length).toBeLessThanOrEqual(503); // 500 + "..."
    expect(reasoning).toEndWith("...");
  });
});

// ── emitRoutingDecision ──────────────────────────────────────────────────────

describe("emitRoutingDecision", () => {
  beforeEach(() => {
    _clearDecisionsForTesting();
  });

  it("stores decision in recent decisions list", () => {
    emitRoutingDecision({
      envelopeId: "dsp_test_001",
      agentChosen: "james",
      task: "Fix the bug in relay.ts",
      reasoning: "This is a dev task that requires code changes.",
      agentsAvailable: ["james", "kate", "brian", "ellie"],
      workItemId: "ELLIE-1452",
      timestamp: Date.now(),
    });

    const decisions = getRecentRoutingDecisions();
    expect(decisions.length).toBe(1);
    expect(decisions[0].agentChosen).toBe("james");
    expect(decisions[0].envelopeId).toBe("dsp_test_001");
  });

  it("caps at 50 recent decisions", () => {
    for (let i = 0; i < 55; i++) {
      emitRoutingDecision({
        envelopeId: `dsp_test_${i}`,
        agentChosen: "james",
        task: `Task ${i}`,
        reasoning: "",
        agentsAvailable: ["james"],
        timestamp: Date.now(),
      });
    }
    expect(getRecentRoutingDecisions().length).toBe(50);
    // First 5 should have been evicted
    expect(getRecentRoutingDecisions()[0].envelopeId).toBe("dsp_test_5");
  });
});

// ── recordRoutingFeedback ────────────────────────────────────────────────────

describe("recordRoutingFeedback", () => {
  beforeEach(() => {
    _clearFeedbackForTesting();
  });

  it("stores feedback in the log", () => {
    recordRoutingFeedback({
      envelopeId: "dsp_test_001",
      originalAgent: "james",
      suggestedAgent: "kate",
      comment: "This was a research question, not a dev task",
      timestamp: Date.now(),
    });

    const feedback = getRoutingFeedback();
    expect(feedback.length).toBe(1);
    expect(feedback[0].originalAgent).toBe("james");
    expect(feedback[0].suggestedAgent).toBe("kate");
  });

  it("caps at 100 feedback entries", () => {
    for (let i = 0; i < 105; i++) {
      recordRoutingFeedback({
        envelopeId: `dsp_test_${i}`,
        originalAgent: "james",
        timestamp: Date.now(),
      });
    }
    expect(getRoutingFeedback().length).toBe(100);
  });
});

// ── HTTP handlers ────────────────────────────────────────────────────────────

describe("handleGetRoutingDecisions", () => {
  beforeEach(() => {
    _clearDecisionsForTesting();
  });

  it("returns empty list when no decisions", () => {
    const result = handleGetRoutingDecisions();
    expect(result.status).toBe(200);
    expect((result.body as any).decisions).toEqual([]);
    expect((result.body as any).count).toBe(0);
  });

  it("returns recent decisions in reverse order", () => {
    emitRoutingDecision({
      envelopeId: "dsp_1",
      agentChosen: "james",
      task: "first",
      reasoning: "",
      agentsAvailable: [],
      timestamp: 1000,
    });
    emitRoutingDecision({
      envelopeId: "dsp_2",
      agentChosen: "kate",
      task: "second",
      reasoning: "",
      agentsAvailable: [],
      timestamp: 2000,
    });

    const result = handleGetRoutingDecisions();
    const decisions = (result.body as any).decisions;
    expect(decisions.length).toBe(2);
    // Most recent first
    expect(decisions[0].envelopeId).toBe("dsp_2");
    expect(decisions[1].envelopeId).toBe("dsp_1");
  });
});

describe("handleRoutingFeedback", () => {
  beforeEach(() => {
    _clearFeedbackForTesting();
  });

  it("returns 400 when required fields are missing", async () => {
    const result = await handleRoutingFeedback({
      json: () => Promise.resolve({ comment: "bad" }),
    });
    expect(result.status).toBe(400);
  });

  it("records valid feedback and returns 200", async () => {
    const result = await handleRoutingFeedback({
      json: () => Promise.resolve({
        envelope_id: "dsp_test",
        original_agent: "james",
        suggested_agent: "kate",
        comment: "Should have been research",
      }),
    });
    expect(result.status).toBe(200);
    expect(getRoutingFeedback().length).toBe(1);
  });
});

describe("handleGetRoutingFeedback", () => {
  beforeEach(() => {
    _clearFeedbackForTesting();
  });

  it("returns empty list when no feedback", () => {
    const result = handleGetRoutingFeedback();
    expect(result.status).toBe(200);
    expect((result.body as any).feedback).toEqual([]);
  });
});
