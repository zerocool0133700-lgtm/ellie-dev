/**
 * ELLIE-512 — Correction Detector tests
 *
 * Covers:
 * - detectAndCaptureCorrection early exits (null anthropic, short messages, no pattern match)
 * - Haiku call triggered only when correction pattern fires
 * - Forest write called when LLM returns is_correction=true
 * - Forest write NOT called when LLM returns is_correction=false
 * - invalidateRelatedSources: ticket-related tags → freshnessTracker.invalidate("work-item")
 * - invalidateRelatedSources: queue-related tags → freshnessTracker.invalidate("queue")
 * - invalidateRelatedSources: calendar-related tags → freshnessTracker.invalidate("calendar")
 * - invalidateRelatedSources: no specific tags → invalidates structured-context
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mocks (must be declared before import) ────────────────────

const mockInvalidate = mock();
const mockWriteMemory = mock(() => Promise.resolve({ id: "mem-123" }));
const mockTrackDecisionAccuracy = mock(() =>
  Promise.resolve({ linkedMemoryId: null, rootCause: "unknown" })
);
const mockLogAgentPostmortem = mock(() => Promise.resolve());

mock.module("../src/logger.ts", () => ({
  log: {
    child: () => ({
      info: mock(),
      warn: mock(),
      error: mock(),
    }),
  },
}));

mock.module("../src/data-quality.ts", () => ({
  trackDecisionAccuracy: mockTrackDecisionAccuracy,
  logAgentPostmortem: mockLogAgentPostmortem,
}));

mock.module("../src/context-freshness.ts", () => ({
  freshnessTracker: {
    invalidate: mockInvalidate,
    recordFetch: mock(),
    clear: mock(),
    logModeConfig: mock(),
    logAllFreshness: mock(),
  },
}));

mock.module("../../ellie-forest/src/shared-memory", () => ({
  writeMemory: mockWriteMemory,
}));

// ── Import after mocks ────────────────────────────────────────

import { detectAndCaptureCorrection } from "../src/correction-detector.ts";

// ── Helpers ───────────────────────────────────────────────────

const LONG_ASSISTANT = "I believe the capital of France is Berlin, based on my understanding of European geography.";
const LONG_USER_CORRECTION = "actually, that's not right — it's Paris, not Berlin.";

function makeMockAnthropic(responseJson: object) {
  return {
    messages: {
      create: mock(() =>
        Promise.resolve({
          content: [{ type: "text", text: JSON.stringify(responseJson) }],
        })
      ),
    },
  } as any;
}

const IS_CORRECTION_RESULT = {
  is_correction: true,
  ground_truth: "The capital of France is Paris.",
  what_was_wrong: "Said Berlin instead of Paris",
  scope_path: "2",
  tags: ["geography", "europe"],
};

const NOT_CORRECTION_RESULT = {
  is_correction: false,
  ground_truth: "",
  what_was_wrong: "",
  scope_path: "2",
  tags: [],
};

// ── Early exit tests ──────────────────────────────────────────

describe("detectAndCaptureCorrection — early exits", () => {
  beforeEach(() => {
    mockInvalidate.mockReset();
    mockWriteMemory.mockReset();
    mockWriteMemory.mockImplementation(() => Promise.resolve({ id: "mem-123" }));
    mockTrackDecisionAccuracy.mockReset();
    mockTrackDecisionAccuracy.mockImplementation(() =>
      Promise.resolve({ linkedMemoryId: null, rootCause: "unknown" })
    );
  });

  test("no-op when anthropic is null", async () => {
    await detectAndCaptureCorrection(
      LONG_USER_CORRECTION, LONG_ASSISTANT, null, "ellie-chat", null
    );
    expect(mockInvalidate).not.toHaveBeenCalled();
    expect(mockWriteMemory).not.toHaveBeenCalled();
  });

  test("no-op when userMessage is too short (< 10 chars)", async () => {
    const anthropic = makeMockAnthropic(IS_CORRECTION_RESULT);
    await detectAndCaptureCorrection(
      "no.", LONG_ASSISTANT, anthropic, "ellie-chat", null
    );
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  test("no-op when previousAssistantMessage is too short (< 20 chars)", async () => {
    const anthropic = makeMockAnthropic(IS_CORRECTION_RESULT);
    await detectAndCaptureCorrection(
      LONG_USER_CORRECTION, "Too short.", anthropic, "ellie-chat", null
    );
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });
});

// ── Pattern matching tests ────────────────────────────────────

describe("detectAndCaptureCorrection — correction pattern pre-filter", () => {
  test.each([
    // messages that SHOULD trigger the Haiku call
    ["actually, that's not right", true],
    ["no, that's wrong and incorrect", true],
    ["that's not what I said", true],
    ["you're mistaken about this", true],
    ["wait, I said X not Y", true],
    ["correction: the value is 42", true],
    ["I didn't say to delete it", true],
    ["I never asked for that", true],
    ["the correct answer is Paris", true],
    ["it's not Berlin, it's Paris", true],
    // messages that should NOT trigger Haiku
    ["thanks for the help!", false],
    ["can you explain this further?", false],
    ["tell me more about that topic", false],
    ["great work on the analysis", false],
  ])('"%s" → LLM called=%s', async (userMsg, expectsCall) => {
    // Pad to meet length requirement
    const msg = userMsg.length < 10 ? userMsg.padEnd(12, ".") : userMsg;
    const anthropic = makeMockAnthropic(NOT_CORRECTION_RESULT);

    await detectAndCaptureCorrection(msg, LONG_ASSISTANT, anthropic, "ellie-chat", null);

    if (expectsCall) {
      expect(anthropic.messages.create).toHaveBeenCalled();
    } else {
      expect(anthropic.messages.create).not.toHaveBeenCalled();
    }
  });
});

// ── LLM result handling ───────────────────────────────────────

describe("detectAndCaptureCorrection — LLM result handling", () => {
  beforeEach(() => {
    mockWriteMemory.mockReset();
    mockWriteMemory.mockImplementation(() => Promise.resolve({ id: "mem-123" }));
    mockInvalidate.mockReset();
    mockTrackDecisionAccuracy.mockReset();
    mockTrackDecisionAccuracy.mockImplementation(() =>
      Promise.resolve({ linkedMemoryId: null, rootCause: "unknown" })
    );
  });

  test("writes to Forest when LLM returns is_correction=true", async () => {
    const anthropic = makeMockAnthropic(IS_CORRECTION_RESULT);
    await detectAndCaptureCorrection(
      LONG_USER_CORRECTION, LONG_ASSISTANT, anthropic, "ellie-chat", "conv-1"
    );
    expect(mockWriteMemory).toHaveBeenCalledTimes(1);
    const call = mockWriteMemory.mock.calls[0][0] as any;
    expect(call.content).toBe("The capital of France is Paris.");
    expect(call.confidence).toBe(1.0);
    expect(call.type).toBe("fact");
  });

  test("does NOT write to Forest when LLM returns is_correction=false", async () => {
    const anthropic = makeMockAnthropic(NOT_CORRECTION_RESULT);
    await detectAndCaptureCorrection(
      LONG_USER_CORRECTION, LONG_ASSISTANT, anthropic, "ellie-chat", null
    );
    expect(mockWriteMemory).not.toHaveBeenCalled();
  });

  test("no-op when LLM returns no ground_truth (empty string)", async () => {
    const anthropic = makeMockAnthropic({
      ...IS_CORRECTION_RESULT,
      ground_truth: "",
    });
    await detectAndCaptureCorrection(
      LONG_USER_CORRECTION, LONG_ASSISTANT, anthropic, "ellie-chat", null
    );
    expect(mockWriteMemory).not.toHaveBeenCalled();
  });

  test("Forest write includes channel tag in metadata", async () => {
    const anthropic = makeMockAnthropic(IS_CORRECTION_RESULT);
    await detectAndCaptureCorrection(
      LONG_USER_CORRECTION, LONG_ASSISTANT, anthropic, "ellie-chat", "conv-abc"
    );
    const call = mockWriteMemory.mock.calls[0][0] as any;
    expect(call.metadata.channel).toBe("ellie-chat");
    expect(call.metadata.conversation_id).toBe("conv-abc");
  });
});

// ── invalidateRelatedSources ──────────────────────────────────

describe("detectAndCaptureCorrection — context invalidation", () => {
  beforeEach(() => {
    mockInvalidate.mockReset();
    mockWriteMemory.mockImplementation(() => Promise.resolve({ id: "mem-99" }));
    mockTrackDecisionAccuracy.mockImplementation(() =>
      Promise.resolve({ linkedMemoryId: null, rootCause: "unknown" })
    );
  });

  test("ticket-related tags → invalidates work-item + structured-context", async () => {
    const anthropic = makeMockAnthropic({
      ...IS_CORRECTION_RESULT,
      tags: ["ticket", "ELLIE-512"],
    });
    await detectAndCaptureCorrection(
      LONG_USER_CORRECTION, LONG_ASSISTANT, anthropic, "ellie-chat", null
    );
    const invalidated = mockInvalidate.mock.calls.map((c) => c[0]);
    expect(invalidated).toContain("work-item");
    expect(invalidated).toContain("structured-context");
  });

  test("queue-related tags → invalidates queue", async () => {
    const anthropic = makeMockAnthropic({
      ...IS_CORRECTION_RESULT,
      tags: ["queue", "workflow"],
    });
    await detectAndCaptureCorrection(
      LONG_USER_CORRECTION, LONG_ASSISTANT, anthropic, "ellie-chat", null
    );
    const invalidated = mockInvalidate.mock.calls.map((c) => c[0]);
    expect(invalidated).toContain("queue");
  });

  test("calendar-related tags → invalidates calendar", async () => {
    const anthropic = makeMockAnthropic({
      ...IS_CORRECTION_RESULT,
      tags: ["calendar", "meeting"],
    });
    await detectAndCaptureCorrection(
      LONG_USER_CORRECTION, LONG_ASSISTANT, anthropic, "ellie-chat", null
    );
    const invalidated = mockInvalidate.mock.calls.map((c) => c[0]);
    expect(invalidated).toContain("calendar");
  });

  test("forest/memory tags → invalidates forest-awareness + agent-memory", async () => {
    const anthropic = makeMockAnthropic({
      ...IS_CORRECTION_RESULT,
      tags: ["memory", "forest"],
    });
    await detectAndCaptureCorrection(
      LONG_USER_CORRECTION, LONG_ASSISTANT, anthropic, "ellie-chat", null
    );
    const invalidated = mockInvalidate.mock.calls.map((c) => c[0]);
    expect(invalidated).toContain("forest-awareness");
    expect(invalidated).toContain("agent-memory");
  });

  test("unrelated tags → falls back to structured-context invalidation", async () => {
    const anthropic = makeMockAnthropic({
      ...IS_CORRECTION_RESULT,
      tags: ["geography", "europe"],
    });
    await detectAndCaptureCorrection(
      LONG_USER_CORRECTION, LONG_ASSISTANT, anthropic, "ellie-chat", null
    );
    const invalidated = mockInvalidate.mock.calls.map((c) => c[0]);
    expect(invalidated).toContain("structured-context");
  });

  test("ticket pattern in ground_truth → invalidates work-item", async () => {
    const anthropic = makeMockAnthropic({
      ...IS_CORRECTION_RESULT,
      ground_truth: "ELLIE-512 is about test coverage.",
      tags: [],
    });
    await detectAndCaptureCorrection(
      LONG_USER_CORRECTION, LONG_ASSISTANT, anthropic, "ellie-chat", null
    );
    const invalidated = mockInvalidate.mock.calls.map((c) => c[0]);
    expect(invalidated).toContain("work-item");
  });
});
