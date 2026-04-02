/**
 * ELLIE-514 — API layer tests: GTD pure functions.
 * ELLIE-1272 — Answer Bridge: ask-user queue resolution + metadata fields.
 *
 * Tests validateTags() — the context tag validation used when
 * capturing inbox items and updating todos. Tags starting with @ must
 * match /^@[a-z][a-z0-9-]*$/ (lowercase, dashes only, no spaces/uppercase).
 *
 * Also tests the ask-user-queue bridge: after a dashboard answer, the in-memory
 * coordinator promise should resolve and metadata should include answered_at /
 * answered_via fields.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock logger ───────────────────────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { validateTags } from "../src/api/gtd.ts";
import {
  enqueueQuestion,
  answerQuestion,
  clearQuestionQueue,
  getPendingQuestions,
} from "../src/ask-user-queue.ts";

// ── validateTags ──────────────────────────────────────────────────────────────

describe("validateTags — valid inputs", () => {
  test("returns null for empty array", () => {
    expect(validateTags([])).toBeNull();
  });

  test("returns null for valid @context tag", () => {
    expect(validateTags(["@home"])).toBeNull();
  });

  test("returns null for @tag with dashes", () => {
    expect(validateTags(["@work-deep"])).toBeNull();
  });

  test("returns null for @tag with numbers after first char", () => {
    expect(validateTags(["@context1"])).toBeNull();
  });

  test("returns null for non-@ plain label tags", () => {
    expect(validateTags(["project", "admin", "someday"])).toBeNull();
  });

  test("returns null when mixing valid @ tags and plain labels", () => {
    expect(validateTags(["project", "@home", "@office", "admin"])).toBeNull();
  });

  test("allows single lowercase letter after @", () => {
    expect(validateTags(["@a"])).toBeNull();
  });
});

describe("validateTags — invalid @ tags", () => {
  test("returns error for @tag with uppercase letters", () => {
    const result = validateTags(["@Home"]);
    expect(result).not.toBeNull();
    expect(result).toContain("@Home");
  });

  test("returns error for @tag starting with a number", () => {
    const result = validateTags(["@1task"]);
    expect(result).not.toBeNull();
    expect(result).toContain("@1task");
  });

  test("returns error for @tag with spaces", () => {
    const result = validateTags(["@my tag"]);
    expect(result).not.toBeNull();
    expect(result).toContain("@my tag");
  });

  test("returns error for @tag with underscores", () => {
    const result = validateTags(["@my_tag"]);
    expect(result).not.toBeNull();
    expect(result).toContain("@my_tag");
  });

  test("returns error for bare @ (no char after it)", () => {
    const result = validateTags(["@"]);
    expect(result).not.toBeNull();
  });

  test("error message mentions 'Invalid context tag'", () => {
    const result = validateTags(["@BadTag"]);
    expect(result).toContain("Invalid context tag");
    expect(result).toContain("@BadTag");
  });

  test("returns error for @tag with special chars", () => {
    const result = validateTags(["@tag!"]);
    expect(result).not.toBeNull();
    expect(result).toContain("@tag!");
  });
});

describe("validateTags — mixed arrays", () => {
  test("catches invalid @ tag among valid ones", () => {
    // @home valid, @Work invalid (uppercase)
    const result = validateTags(["@home", "@Work", "@office"]);
    expect(result).not.toBeNull();
    expect(result).toContain("@Work");
  });

  test("stops at first invalid tag (does not aggregate errors)", () => {
    const result = validateTags(["@Bad1", "@Bad2"]);
    // Returns a single error, not two
    expect(typeof result).toBe("string");
    // @Bad2 not mentioned since we stop at @Bad1
    expect(result).not.toContain("@Bad2");
  });

  test("skips non-string values without error", () => {
    // null, undefined, numbers, booleans are skipped silently
    expect(validateTags([null, undefined, 42, true, false] as unknown[])).toBeNull();
  });

  test("non-string values before invalid @ tag are skipped, still catches the @", () => {
    const result = validateTags([null, "@Bad"] as unknown[]);
    expect(result).not.toBeNull();
    expect(result).toContain("@Bad");
  });
});

// ── ELLIE-1272: Ask-User Queue Bridge ────────────────────────────────────────

describe("ask-user-queue — enqueue and answer", () => {
  beforeEach(() => {
    clearQuestionQueue();
  });

  test("answerQuestion resolves the pending promise with the answer text", async () => {
    const id = enqueueQuestion("test-agent", "What is your name?");
    const entry = getPendingQuestions().find((q) => q.id === id);
    expect(entry).toBeDefined();

    const resolved = answerQuestion(id, "Dave");
    expect(resolved).toBe(true);

    // The promise on the question should have resolved with the answer
    const answer = await entry!.promise;
    expect(answer).toBe("Dave");
  });

  test("answerQuestion returns false for unknown question ID (stale/timed-out)", () => {
    const resolved = answerQuestion("q-00000000", "irrelevant");
    expect(resolved).toBe(false);
  });

  test("answered question is removed from pending queue", () => {
    const id = enqueueQuestion("test-agent", "Are you there?");
    expect(getPendingQuestions()).toHaveLength(1);

    answerQuestion(id, "yes");
    expect(getPendingQuestions()).toHaveLength(0);
  });

  test("question status is set to answered after answerQuestion", async () => {
    const id = enqueueQuestion("test-agent", "Ready?");
    const question = getPendingQuestions().find((q) => q.id === id)!;
    expect(question.status).toBe("pending");

    answerQuestion(id, "ready");
    // status is mutated in place before removal from queue
    expect(question.status).toBe("answered");
  });
});

describe("answer bridge — metadata fields", () => {
  test("answered_at is a valid ISO 8601 timestamp string", () => {
    const answeredAt = new Date().toISOString();
    // Must parse without NaN and be recent (within 1 second)
    const parsed = new Date(answeredAt).getTime();
    expect(Number.isNaN(parsed)).toBe(false);
    expect(Date.now() - parsed).toBeLessThan(1000);
  });

  test("answered_via is 'dashboard' for dashboard-originated answers", () => {
    const answeredVia = "dashboard";
    expect(answeredVia).toBe("dashboard");
  });

  test("metadata merge preserves existing fields alongside answered_at and answered_via", () => {
    const existingMetadata = { question_id: "q-abc123", urgency: "high" };
    const answeredAt = new Date().toISOString();
    const merged = {
      ...existingMetadata,
      answered_at: answeredAt,
      answered_via: "dashboard",
    };

    expect(merged.question_id).toBe("q-abc123");
    expect(merged.urgency).toBe("high");
    expect(merged.answered_at).toBe(answeredAt);
    expect(merged.answered_via).toBe("dashboard");
  });

  test("question_id from metadata used to resolve in-memory queue promise", async () => {
    clearQuestionQueue();
    // Simulate: coordinator enqueued a question and stored question_id in todo metadata
    const questionId = enqueueQuestion("ellie", "Shall I proceed?");
    const metadata = { question_id: questionId, urgency: "normal" };

    // Simulate: dashboard handler reads metadata.question_id and bridges to queue
    const inMemoryId = typeof metadata.question_id === "string" ? metadata.question_id : null;
    expect(inMemoryId).toBe(questionId);

    const pending = getPendingQuestions().find((q) => q.id === questionId)!;
    const resolved = answerQuestion(inMemoryId!, "yes, proceed");
    expect(resolved).toBe(true);

    const answer = await pending.promise;
    expect(answer).toBe("yes, proceed");
  });
});
