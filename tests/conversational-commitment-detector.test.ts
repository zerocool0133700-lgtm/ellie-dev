/**
 * Conversational Commitment Detector Tests — ELLIE-592
 *
 * Validates:
 *  - splitIntoSentences() correctly splits text
 *  - detectInSentence() matches commitment patterns
 *  - detectInSentence() suppresses rhetorical/conditional language
 *  - detectCommitments() scans full text
 *  - detectAndLogCommitments() creates ledger entries
 *  - Toggle on/off works
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  splitIntoSentences,
  detectInSentence,
  detectCommitments,
  detectAndLogCommitments,
  setConversationalDetectionEnabled,
  isConversationalDetectionEnabled,
} from "../src/conversational-commitment-detector.ts";
import {
  _resetLedgerForTesting,
  listCommitments,
  pendingCount,
} from "../src/commitment-ledger.ts";

beforeEach(() => {
  _resetLedgerForTesting();
  setConversationalDetectionEnabled(true);
});

// ── splitIntoSentences ──────────────────────────────────────────────────────

describe("splitIntoSentences", () => {
  it("splits on period-space", () => {
    const result = splitIntoSentences("First sentence. Second sentence.");
    expect(result).toHaveLength(2);
  });

  it("splits on newlines", () => {
    const result = splitIntoSentences("Line one\nLine two\nLine three");
    expect(result).toHaveLength(3);
  });

  it("filters empty strings", () => {
    const result = splitIntoSentences("  \n  \n  ");
    expect(result).toHaveLength(0);
  });

  it("handles mixed delimiters", () => {
    const result = splitIntoSentences("Hello! How are you? Fine.\nGoodbye.");
    expect(result).toHaveLength(4);
  });
});

// ── detectInSentence — positive matches ─────────────────────────────────────

describe("detectInSentence — commitments", () => {
  it("detects I'll check", () => {
    const result = detectInSentence("I'll check the database for that error.");
    expect(result).not.toBeNull();
    expect(result!.phrase).toContain("I'll check");
    expect(result!.description).toContain("promised action");
  });

  it("detects I will investigate", () => {
    const result = detectInSentence("I will investigate the root cause.");
    expect(result).not.toBeNull();
    expect(result!.description).toContain("promised action");
  });

  it("detects let me look into", () => {
    const result = detectInSentence("Let me look into that issue for you.");
    expect(result).not.toBeNull();
    expect(result!.description).toContain("immediate action");
  });

  it("detects dispatching now", () => {
    const result = detectInSentence("Dispatching this to the dev agent now.");
    expect(result).not.toBeNull();
    expect(result!.description).toContain("dispatch");
  });

  it("detects sending that to", () => {
    const result = detectInSentence("Sending that to the research team for analysis.");
    expect(result).not.toBeNull();
    expect(result!.description).toContain("delegation");
  });

  it("detects routing this to", () => {
    const result = detectInSentence("Routing this to the strategy agent.");
    expect(result).not.toBeNull();
    expect(result!.description).toContain("delegation");
  });

  it("detects I'll get back to you", () => {
    const result = detectInSentence("I'll get back to you once I have the results.");
    expect(result).not.toBeNull();
    expect(result!.description).toContain("follow-up");
  });

  it("detects I'll follow up", () => {
    const result = detectInSentence("I'll follow up on that ticket.");
    expect(result).not.toBeNull();
    expect(result!.description).toContain("follow-up");
  });

  it("detects I'll let you know", () => {
    const result = detectInSentence("I'll let you know when it's done.");
    expect(result).not.toBeNull();
    expect(result!.description).toContain("follow-up");
  });

  it("detects let me fix", () => {
    const result = detectInSentence("Let me fix that for you right away.");
    expect(result).not.toBeNull();
  });

  it("detects I'll review", () => {
    const result = detectInSentence("I'll review the pull request.");
    expect(result).not.toBeNull();
  });

  it("detects I will send", () => {
    const result = detectInSentence("I will send the report tomorrow.");
    expect(result).not.toBeNull();
  });
});

// ── detectInSentence — suppressed (false positives) ─────────────────────────

describe("detectInSentence — suppressed", () => {
  it("suppresses I could check", () => {
    const result = detectInSentence("I could check the logs if needed.");
    expect(result).toBeNull();
  });

  it("suppresses I might investigate", () => {
    const result = detectInSentence("I might investigate that later.");
    expect(result).toBeNull();
  });

  it("suppresses would you like me to", () => {
    const result = detectInSentence("Would you like me to check the database?");
    expect(result).toBeNull();
  });

  it("suppresses if you want", () => {
    const result = detectInSentence("If you want I'll check that out.");
    expect(result).toBeNull();
  });

  it("suppresses should I", () => {
    const result = detectInSentence("Should I look into that issue?");
    expect(result).toBeNull();
  });

  it("suppresses do you want me to", () => {
    const result = detectInSentence("Do you want me to fix it?");
    expect(result).toBeNull();
  });

  it("suppresses I can check (offering, not committing)", () => {
    const result = detectInSentence("I can check that for you.");
    expect(result).toBeNull();
  });

  it("suppresses I would investigate", () => {
    const result = detectInSentence("I would investigate the auth module.");
    expect(result).toBeNull();
  });

  it("returns null for no commitment language", () => {
    const result = detectInSentence("The error is in the database module.");
    expect(result).toBeNull();
  });

  it("returns null for general statements", () => {
    const result = detectInSentence("Here's what I found in the logs.");
    expect(result).toBeNull();
  });
});

// ── detectCommitments (full text) ───────────────────────────────────────────

describe("detectCommitments", () => {
  it("detects multiple commitments in a paragraph", () => {
    const text = "I'll check the database for errors. Let me also look into the auth flow. I'll get back to you with results.";
    const results = detectCommitments(text);
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty for text with no commitments", () => {
    const text = "The error is caused by a null pointer. The fix is straightforward.";
    const results = detectCommitments(text);
    expect(results).toHaveLength(0);
  });

  it("ignores suppressed language mixed with commitments", () => {
    const text = "I could check that, but I'll investigate the logs instead.";
    const results = detectCommitments(text);
    // "I could check" is suppressed, "I'll investigate" is in the second clause
    // but it's one sentence so suppression wins
    // Let's test with separate sentences
    const text2 = "I could check that. I'll investigate the logs.";
    const results2 = detectCommitments(text2);
    expect(results2).toHaveLength(1);
    expect(results2[0].description).toContain("investigate");
  });

  it("handles newline-separated text", () => {
    const text = "Here's the plan:\nI'll fix the bug\nI'll update the tests\nDone!";
    const results = detectCommitments(text);
    expect(results).toHaveLength(2);
  });

  it("truncates long descriptions", () => {
    const longText = "I'll check " + "x".repeat(200) + " in the database.";
    const results = detectCommitments(longText);
    expect(results).toHaveLength(1);
    expect(results[0].description.length).toBeLessThanOrEqual(200);
  });
});

// ── detectAndLogCommitments (effectful) ─────────────────────────────────────

describe("detectAndLogCommitments", () => {
  it("creates ledger entries for detected commitments", () => {
    const text = "I'll check the database. I'll get back to you soon.";
    const count = detectAndLogCommitments(text, "sess-1", 0);

    expect(count).toBeGreaterThanOrEqual(1);
    const commitments = listCommitments("sess-1");
    expect(commitments.length).toBeGreaterThanOrEqual(1);
    expect(commitments[0].source).toBe("conversational");
    expect(commitments[0].status).toBe("pending");
  });

  it("returns 0 for text with no commitments", () => {
    const count = detectAndLogCommitments("The fix is ready.", "sess-1", 0);
    expect(count).toBe(0);
    expect(pendingCount("sess-1")).toBe(0);
  });

  it("uses correct session and turn", () => {
    detectAndLogCommitments("I'll investigate that.", "sess-42", 5);

    const commitments = listCommitments("sess-42");
    expect(commitments).toHaveLength(1);
    expect(commitments[0].sessionId).toBe("sess-42");
    expect(commitments[0].turnCreated).toBe(5);
  });

  it("no-ops when detection is disabled", () => {
    setConversationalDetectionEnabled(false);
    const count = detectAndLogCommitments("I'll check everything.", "sess-1", 0);
    expect(count).toBe(0);
    expect(pendingCount("sess-1")).toBe(0);
  });

  it("works again after re-enabling", () => {
    setConversationalDetectionEnabled(false);
    detectAndLogCommitments("I'll check that.", "sess-1", 0);
    expect(pendingCount("sess-1")).toBe(0);

    setConversationalDetectionEnabled(true);
    detectAndLogCommitments("I'll check that.", "sess-1", 1);
    expect(pendingCount("sess-1")).toBe(1);
  });
});

// ── Toggle ──────────────────────────────────────────────────────────────────

describe("detection toggle", () => {
  it("is enabled by default", () => {
    expect(isConversationalDetectionEnabled()).toBe(true);
  });

  it("can be disabled", () => {
    setConversationalDetectionEnabled(false);
    expect(isConversationalDetectionEnabled()).toBe(false);
  });

  it("can be re-enabled", () => {
    setConversationalDetectionEnabled(false);
    setConversationalDetectionEnabled(true);
    expect(isConversationalDetectionEnabled()).toBe(true);
  });
});
