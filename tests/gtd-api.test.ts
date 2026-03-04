/**
 * ELLIE-514 — API layer tests: GTD pure functions.
 *
 * Tests validateTags() — the context tag validation used when
 * capturing inbox items and updating todos. Tags starting with @ must
 * match /^@[a-z][a-z0-9-]*$/ (lowercase, dashes only, no spaces/uppercase).
 */

import { describe, test, expect, mock } from "bun:test";

// ── Mock logger ───────────────────────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { validateTags } from "../src/api/gtd.ts";

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
