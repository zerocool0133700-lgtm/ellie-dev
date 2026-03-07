/**
 * ELLIE-338 — Cognitive load detector tests
 *
 * Tests for:
 *  - detectStateChecks: repeated status/state questions
 *  - detectLengthVariance: message length coefficient of variation
 *  - detectTopicSwitching: topic change frequency
 *  - detectWorkItemLoad: open work item scoring
 *  - detectMessageFrequency: messages per hour
 *  - assessCognitiveLoad: aggregate scoring
 *  - formatLoadHint: prompt hint generation
 *  - classifyTopic: topic classification helper
 */

import { describe, it, expect } from "bun:test";
import {
  detectStateChecks,
  detectLengthVariance,
  detectTopicSwitching,
  detectWorkItemLoad,
  detectMessageFrequency,
  assessCognitiveLoad,
  formatLoadHint,
  classifyTopic,
  type MessageSnapshot,
  type WorkItemCount,
  type CognitiveLoadResult,
} from "../src/api/cognitive-load.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

function msg(content: string, role: "user" | "assistant" = "user", minutesAgo: number = 0): MessageSnapshot {
  const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return { content, timestamp: ts, role };
}

function userMsgs(contents: string[], minutesApart: number = 2): MessageSnapshot[] {
  return contents.map((c, i) => msg(c, "user", (contents.length - i) * minutesApart));
}

// ── detectStateChecks ──────────────────────────────────────────────────────

describe("detectStateChecks", () => {
  it("returns not triggered for empty messages", () => {
    const result = detectStateChecks([]);
    expect(result.triggered).toBe(false);
    expect(result.value).toBe(0);
  });

  it("returns not triggered for normal messages", () => {
    const messages = userMsgs([
      "Can you refactor this function?",
      "Add a test for the login module",
      "Deploy to staging please",
    ]);
    const result = detectStateChecks(messages);
    expect(result.triggered).toBe(false);
  });

  it("triggers on 3+ state-check questions", () => {
    const messages = userMsgs([
      "What's the status of the deploy?",
      "Where are we with the refactor?",
      "What was I working on?",
    ]);
    const result = detectStateChecks(messages);
    expect(result.triggered).toBe(true);
    expect(result.value).toBe(3);
    expect(result.detail).toContain("3 state-check questions");
  });

  it("ignores assistant messages", () => {
    const messages = [
      msg("What's the status?", "user", 5),
      msg("The status is good", "assistant", 4),
      msg("Where are we?", "user", 3),
      msg("We are on track", "assistant", 2),
    ];
    const result = detectStateChecks(messages);
    expect(result.triggered).toBe(false);
    expect(result.value).toBe(2);
  });

  it("detects various state-check phrasings", () => {
    const messages = userMsgs([
      "What's the plan?",
      "I'm lost, can you remind me what we're doing?",
      "too much going on",
      "What should I focus on?",
    ]);
    const result = detectStateChecks(messages);
    expect(result.triggered).toBe(true);
    expect(result.value).toBe(4);
  });

  it("detects 'I am overwhelmed'", () => {
    const messages = userMsgs(["I'm overwhelmed with all these tickets"]);
    const result = detectStateChecks(messages);
    expect(result.value).toBe(1);
  });
});

// ── detectLengthVariance ───────────────────────────────────────────────────

describe("detectLengthVariance", () => {
  it("returns not triggered for too few messages", () => {
    const messages = userMsgs(["hello", "world"]);
    const result = detectLengthVariance(messages);
    expect(result.triggered).toBe(false);
  });

  it("returns not triggered for uniform length messages", () => {
    const messages = userMsgs([
      "Fix the login bug now",
      "Add the test please",
      "Deploy it to stage",
      "Check the log files",
    ]);
    const result = detectLengthVariance(messages);
    expect(result.triggered).toBe(false);
  });

  it("triggers on highly variable message lengths", () => {
    const messages = userMsgs([
      "ok",
      "This is a very long message about all the things I need to get done today including deploying the new feature, fixing the login bug, updating the dashboard theme, and reviewing the PR from yesterday. There is so much to do and I'm not sure where to start. Can you help me figure out what's most important?",
      "yes",
      "Actually wait, I also need to handle the customer support tickets that came in overnight and there are at least five of them that seem urgent plus the server monitoring alerts from last night",
      "k",
    ]);
    const result = detectLengthVariance(messages);
    expect(result.triggered).toBe(true);
    expect(result.value).toBeGreaterThanOrEqual(1.2);
  });

  it("reports coefficient of variation in detail", () => {
    const messages = userMsgs([
      "y",
      "This is a much longer message that explains something in great detail with lots of context and explanation",
      "n",
      "Another very long detailed message explaining the full background and history of the situation at hand",
      "ok",
    ]);
    const result = detectLengthVariance(messages);
    if (result.triggered) {
      expect(result.detail).toContain("CV=");
    }
  });
});

// ── detectTopicSwitching ───────────────────────────────────────────────────

describe("detectTopicSwitching", () => {
  it("returns not triggered for too few messages", () => {
    const result = detectTopicSwitching(userMsgs(["hello", "world"]));
    expect(result.triggered).toBe(false);
  });

  it("returns not triggered for same-topic messages", () => {
    const messages = userMsgs([
      "Fix the bug in the test function",
      "Refactor the error handling code",
      "Deploy the commit to production",
      "Add a test for the merge logic",
    ]);
    const result = detectTopicSwitching(messages);
    expect(result.triggered).toBe(false);
  });

  it("triggers on rapid topic switching", () => {
    const messages = userMsgs([
      "Fix the deploy error in the function",
      "What's the budget for this quarter?",
      "Restart the nginx server service",
      "Update the dashboard component layout",
      "Check the subscription payment cost",
      "How is the sprint backlog looking?",
      "The CSS theme needs updating",
      "Deploy the commit now",
      "What was the invoice total?",
    ]);
    const result = detectTopicSwitching(messages);
    expect(result.triggered).toBe(true);
    expect(result.value).toBeGreaterThanOrEqual(4);
  });

  it("does not count switches from/to unknown topics", () => {
    const messages = userMsgs([
      "Fix the deploy error",
      "hello there",        // unknown
      "What's the budget?",
    ]);
    const result = detectTopicSwitching(messages);
    // "code" -> "unknown" -> "finance" = only 1 switch (code->finance skipped because unknown in between)
    expect(result.triggered).toBe(false);
  });
});

// ── detectWorkItemLoad ─────────────────────────────────────────────────────

describe("detectWorkItemLoad", () => {
  it("returns not triggered for low counts", () => {
    const counts: WorkItemCount = { open: 5, inProgress: 1, highPriority: 0 };
    const result = detectWorkItemLoad(counts);
    expect(result.triggered).toBe(false);
  });

  it("triggers on high open item count", () => {
    const counts: WorkItemCount = { open: 15, inProgress: 3, highPriority: 2 };
    const result = detectWorkItemLoad(counts);
    expect(result.triggered).toBe(true);
    expect(result.detail).toContain("15 open");
  });

  it("weighs in-progress items more heavily", () => {
    const lowOpen: WorkItemCount = { open: 5, inProgress: 8, highPriority: 0 };
    const result = detectWorkItemLoad(lowOpen);
    // score = 5 + 8*2 + 0 = 21, threshold 20
    expect(result.triggered).toBe(true);
  });

  it("returns not triggered for zero items", () => {
    const counts: WorkItemCount = { open: 0, inProgress: 0, highPriority: 0 };
    const result = detectWorkItemLoad(counts);
    expect(result.triggered).toBe(false);
    expect(result.value).toBe(0);
  });
});

// ── detectMessageFrequency ─────────────────────────────────────────────────

describe("detectMessageFrequency", () => {
  it("returns not triggered for single message", () => {
    const result = detectMessageFrequency([msg("hello", "user", 0)]);
    expect(result.triggered).toBe(false);
  });

  it("returns not triggered for normal pace", () => {
    // 5 messages over 60 minutes = 5/hour
    const messages = userMsgs(["a", "b", "c", "d", "e"], 12);
    const result = detectMessageFrequency(messages);
    expect(result.triggered).toBe(false);
  });

  it("triggers on rapid-fire messaging", () => {
    // 20 messages in 30 minutes = 40/hour
    const messages: MessageSnapshot[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(msg(`message ${i}`, "user", i * 1.5));
    }
    const result = detectMessageFrequency(messages);
    expect(result.triggered).toBe(true);
    expect(result.detail).toContain("messages/hour");
  });

  it("ignores assistant messages in frequency calculation", () => {
    // 2 user messages over 120 minutes = 1/hour (well under 15 threshold)
    const messages = [
      msg("a", "user", 120),
      msg("response", "assistant", 90),
      msg("b", "user", 0),
      msg("response", "assistant", 0),
    ];
    const result = detectMessageFrequency(messages);
    expect(result.triggered).toBe(false);
  });
});

// ── classifyTopic ──────────────────────────────────────────────────────────

describe("classifyTopic", () => {
  it("classifies code-related messages", () => {
    expect(classifyTopic("Fix the bug in the test function")).toBe("code");
  });

  it("classifies ops-related messages", () => {
    expect(classifyTopic("Restart the nginx server")).toBe("ops");
  });

  it("classifies finance-related messages", () => {
    expect(classifyTopic("What's the budget and subscription cost?")).toBe("finance");
  });

  it("classifies planning-related messages", () => {
    expect(classifyTopic("Check the sprint backlog and ticket priority")).toBe("planning");
  });

  it("classifies design-related messages", () => {
    expect(classifyTopic("Update the dashboard component layout")).toBe("design");
  });

  it("returns unknown for unclassifiable messages", () => {
    expect(classifyTopic("hello there")).toBe("unknown");
  });
});

// ── assessCognitiveLoad ────────────────────────────────────────────────────

describe("assessCognitiveLoad", () => {
  it("returns low for calm session", () => {
    const messages = userMsgs([
      "Fix the login bug",
      "Add a test for that",
      "Looks good, deploy it",
    ], 10);
    const items: WorkItemCount = { open: 3, inProgress: 1, highPriority: 0 };
    const result = assessCognitiveLoad(messages, items);
    expect(result.level).toBe("low");
    expect(result.score).toBeLessThan(0.3);
    expect(result.suggestion).toBeUndefined();
  });

  it("returns moderate or higher when some signals trigger", () => {
    const messages = userMsgs([
      "What's the status of everything?",
      "Where are we with the deploy?",
      "What was I working on?",
      "Can you remind me what's next?",
    ], 5);
    const items: WorkItemCount = { open: 5, inProgress: 1, highPriority: 0 };
    const result = assessCognitiveLoad(messages, items);
    expect(["moderate", "high", "overloaded"]).toContain(result.level);
    expect(result.suggestion).toBeDefined();
  });

  it("returns high or overloaded when multiple signals trigger", () => {
    // State checks + high work item count + rapid messaging
    const messages: MessageSnapshot[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(msg(
        i % 3 === 0 ? "What's the status?" : `message ${i} about stuff`,
        "user",
        i * 1.5,
      ));
    }
    const items: WorkItemCount = { open: 20, inProgress: 5, highPriority: 4 };
    const result = assessCognitiveLoad(messages, items);
    expect(["high", "overloaded"]).toContain(result.level);
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  it("includes all 5 signals in result", () => {
    const messages = userMsgs(["hello"], 5);
    const items: WorkItemCount = { open: 0, inProgress: 0, highPriority: 0 };
    const result = assessCognitiveLoad(messages, items);
    expect(result.signals).toHaveLength(5);
    const signalNames = result.signals.map((s) => s.signal);
    expect(signalNames).toContain("state_checks");
    expect(signalNames).toContain("length_variance");
    expect(signalNames).toContain("topic_switching");
    expect(signalNames).toContain("work_item_load");
    expect(signalNames).toContain("message_frequency");
  });

  it("has a detectedAt timestamp", () => {
    const result = assessCognitiveLoad([], { open: 0, inProgress: 0, highPriority: 0 });
    expect(result.detectedAt).toBeDefined();
    expect(new Date(result.detectedAt).getTime()).toBeGreaterThan(0);
  });
});

// ── formatLoadHint ─────────────────────────────────────────────────────────

describe("formatLoadHint", () => {
  it("returns empty string for low load", () => {
    const result: CognitiveLoadResult = {
      level: "low",
      score: 0.1,
      signals: [],
      detectedAt: new Date().toISOString(),
    };
    expect(formatLoadHint(result)).toBe("");
  });

  it("includes load level for moderate load", () => {
    const result: CognitiveLoadResult = {
      level: "moderate",
      score: 0.35,
      signals: [
        { signal: "state_checks", value: 2, threshold: 3, triggered: false },
      ],
      detectedAt: new Date().toISOString(),
    };
    const hint = formatLoadHint(result);
    expect(hint).toContain("moderate");
    expect(hint).toContain("Guidance for your response");
  });

  it("includes triggered signal details for high load", () => {
    const result: CognitiveLoadResult = {
      level: "high",
      score: 0.6,
      signals: [
        { signal: "state_checks", value: 4, threshold: 3, triggered: true, detail: "4 state-check questions in last 10 messages" },
        { signal: "work_item_load", value: 25, threshold: 20, triggered: true, detail: "15 open + 3 in-progress + 2 high-priority items" },
      ],
      detectedAt: new Date().toISOString(),
    };
    const hint = formatLoadHint(result);
    expect(hint).toContain("4 state-check questions");
    expect(hint).toContain("15 open");
    expect(hint).toContain("summarize where things stand");
  });

  it("includes proactive offering guidance for overloaded", () => {
    const result: CognitiveLoadResult = {
      level: "overloaded",
      score: 0.9,
      signals: [
        { signal: "state_checks", value: 5, threshold: 3, triggered: true, detail: "5 state-check questions" },
        { signal: "topic_switching", value: 6, threshold: 4, triggered: true, detail: "6 topic switches" },
        { signal: "work_item_load", value: 30, threshold: 20, triggered: true, detail: "20 open items" },
      ],
      detectedAt: new Date().toISOString(),
    };
    const hint = formatLoadHint(result);
    expect(hint).toContain("overloaded");
    expect(hint).toContain("prioritize or break things down");
    expect(hint).toContain("Want me to triage these");
  });

  it("never uses diagnostic framing", () => {
    const result: CognitiveLoadResult = {
      level: "high",
      score: 0.6,
      signals: [
        { signal: "state_checks", value: 4, threshold: 3, triggered: true, detail: "detail" },
      ],
      detectedAt: new Date().toISOString(),
    };
    const hint = formatLoadHint(result);
    expect(hint).toContain("Never tell the user");
    expect(hint).not.toContain("your cognitive load is high");
  });

  it("includes suggestion text for high load", () => {
    const result: CognitiveLoadResult = {
      level: "high",
      score: 0.6,
      signals: [],
      suggestion: "Want me to summarize where everything stands?",
      detectedAt: new Date().toISOString(),
    };
    const hint = formatLoadHint(result);
    expect(hint).toContain("high");
  });
});
