/**
 * ELLIE-512 — ellie-chat-handler sub-behavior tests
 *
 * Tests the pure utility helpers extracted from ellie-chat-handler.ts into
 * ellie-chat-utils.ts. No mocking required — zero external dependencies.
 *
 * Covers:
 * - extractCommandBarScope: command bar detection, scope parsing, text stripping
 * - extractWorkItemId: Plane-style work item IDs from message text
 * - classifyRoute: specialist vs general routing, single vs multi-step detection
 */

import { describe, test, expect } from "bun:test";
import {
  extractCommandBarScope,
  extractWorkItemId,
  classifyRoute,
  COMMAND_BAR_CHANNEL_ID,
} from "../src/ellie-chat-utils.ts";

// ── extractCommandBarScope ────────────────────────────────────────────────────

describe("extractCommandBarScope — non-command-bar channel", () => {
  test("returns null scope and original text for a regular channel", () => {
    const result = extractCommandBarScope("Hello world", "some-other-channel-id");
    expect(result.scopePath).toBeNull();
    expect(result.strippedText).toBe("Hello world");
  });

  test("returns null scope when channelId is undefined", () => {
    const result = extractCommandBarScope("Hello world", undefined);
    expect(result.scopePath).toBeNull();
    expect(result.strippedText).toBe("Hello world");
  });

  test("does NOT strip [scope:...] prefix when not in command bar channel", () => {
    const text = "[scope: 2/1] search for something";
    const result = extractCommandBarScope(text, "different-channel");
    expect(result.scopePath).toBeNull();
    expect(result.strippedText).toBe(text); // unchanged
  });
});

describe("extractCommandBarScope — command bar channel", () => {
  test("returns null scope when no [scope:] prefix present", () => {
    const result = extractCommandBarScope("search for memories", COMMAND_BAR_CHANNEL_ID);
    expect(result.scopePath).toBeNull();
    expect(result.strippedText).toBe("search for memories");
  });

  test("extracts scope path and strips prefix", () => {
    const result = extractCommandBarScope("[scope: 2/1] find tickets", COMMAND_BAR_CHANNEL_ID);
    expect(result.scopePath).toBe("2/1");
    expect(result.strippedText).toBe("find tickets");
  });

  test("handles scope with spaces around colon", () => {
    const result = extractCommandBarScope("[scope:  2/2  ] show memories", COMMAND_BAR_CHANNEL_ID);
    expect(result.scopePath).toBe("2/2");
    expect(result.strippedText).toBe("show memories");
  });

  test("handles nested scope path (e.g. 2/1/3)", () => {
    const result = extractCommandBarScope("[scope: 2/1/3] write a fact", COMMAND_BAR_CHANNEL_ID);
    expect(result.scopePath).toBe("2/1/3");
    expect(result.strippedText).toBe("write a fact");
  });

  test("strips trailing whitespace after scope prefix", () => {
    const result = extractCommandBarScope("[scope: 2]   do something", COMMAND_BAR_CHANNEL_ID);
    expect(result.scopePath).toBe("2");
    expect(result.strippedText).toBe("do something");
  });

  test("returns null when [scope:] prefix is not at the start", () => {
    const result = extractCommandBarScope("write [scope: 2] here", COMMAND_BAR_CHANNEL_ID);
    expect(result.scopePath).toBeNull();
    expect(result.strippedText).toBe("write [scope: 2] here"); // unchanged
  });

  test("COMMAND_BAR_CHANNEL_ID constant matches expected UUID", () => {
    expect(COMMAND_BAR_CHANNEL_ID).toBe("a0000000-0000-0000-0000-000000000100");
  });
});

// ── extractWorkItemId ─────────────────────────────────────────────────────────

describe("extractWorkItemId — match cases", () => {
  test("extracts ELLIE-style identifier", () => {
    expect(extractWorkItemId("please work on ELLIE-512")).toBe("ELLIE-512");
  });

  test("extracts identifier from the beginning of text", () => {
    expect(extractWorkItemId("ELLIE-100 is the active ticket")).toBe("ELLIE-100");
  });

  test("extracts first identifier when multiple are present", () => {
    expect(extractWorkItemId("ELLIE-100 and ELLIE-200 both matter")).toBe("ELLIE-100");
  });

  test("extracts EVE-style identifier", () => {
    expect(extractWorkItemId("see EVE-3 for context")).toBe("EVE-3");
  });

  test("extracts single-letter project identifiers", () => {
    expect(extractWorkItemId("P-99 is the blocker")).toBe("P-99");
  });

  test("extracts identifier embedded in a sentence", () => {
    expect(extractWorkItemId("I need help with ELLIE-512, can you review it?")).toBe("ELLIE-512");
  });
});

describe("extractWorkItemId — no-match cases", () => {
  test("returns null for plain text", () => {
    expect(extractWorkItemId("hello, how are you?")).toBeNull();
  });

  test("returns null for lowercase identifier", () => {
    expect(extractWorkItemId("ellie-512 is lowercase")).toBeNull();
  });

  test("returns null for partial match (letters-only, no digits)", () => {
    expect(extractWorkItemId("ELLIE- is incomplete")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(extractWorkItemId("")).toBeNull();
  });

  test("XELLIE-512 matches as identifier XELLIE-512 (it is a valid word boundary)", () => {
    // The regex matches word boundaries, so XELLIE-512 as a token is valid.
    // This confirms the regex doesn't require the identifier prefix to be 'ELLIE'.
    expect(extractWorkItemId("XELLIE-512")).toBe("XELLIE-512");
  });
});

// ── classifyRoute ─────────────────────────────────────────────────────────────

describe("classifyRoute — specialist detection", () => {
  test("'general' agent → isSpecialist=false", () => {
    const { isSpecialist } = classifyRoute("general", "single", 0);
    expect(isSpecialist).toBe(false);
  });

  test("non-general agent → isSpecialist=true", () => {
    const { isSpecialist } = classifyRoute("dev-ant", "single", 0);
    expect(isSpecialist).toBe(true);
  });

  test("'road-runner' agent → isSpecialist=true", () => {
    const { isSpecialist } = classifyRoute("road-runner", "single", 0);
    expect(isSpecialist).toBe(true);
  });

  test("'research' agent → isSpecialist=true", () => {
    const { isSpecialist } = classifyRoute("research", "pipeline", 2);
    expect(isSpecialist).toBe(true);
  });
});

describe("classifyRoute — multi-step detection", () => {
  test("execution_mode='single' → isMultiStep=false even with skills", () => {
    const { isMultiStep } = classifyRoute("dev-ant", "single", 3);
    expect(isMultiStep).toBe(false);
  });

  test("execution_mode='pipeline' with skills → isMultiStep=true", () => {
    const { isMultiStep } = classifyRoute("dev-ant", "pipeline", 2);
    expect(isMultiStep).toBe(true);
  });

  test("execution_mode='fan-out' with skills → isMultiStep=true", () => {
    const { isMultiStep } = classifyRoute("general", "fan-out", 3);
    expect(isMultiStep).toBe(true);
  });

  test("execution_mode='critic-loop' with skills → isMultiStep=true", () => {
    const { isMultiStep } = classifyRoute("general", "critic-loop", 2);
    expect(isMultiStep).toBe(true);
  });

  test("execution_mode='pipeline' with 0 skills → isMultiStep=false", () => {
    const { isMultiStep } = classifyRoute("dev-ant", "pipeline", 0);
    expect(isMultiStep).toBe(false);
  });

  test("execution_mode=undefined → isMultiStep=false", () => {
    const { isMultiStep } = classifyRoute("general", undefined, 0);
    expect(isMultiStep).toBe(false);
  });

  test("execution_mode=undefined with skills → isMultiStep=true (not 'single')", () => {
    // undefined !== "single" is true, so multi-step if skills present
    const { isMultiStep } = classifyRoute("general", undefined, 2);
    expect(isMultiStep).toBe(true);
  });
});

describe("classifyRoute — combined cases", () => {
  test("specialist single-step: isSpecialist=true, isMultiStep=false", () => {
    const result = classifyRoute("dev-ant", "single", 0);
    expect(result.isSpecialist).toBe(true);
    expect(result.isMultiStep).toBe(false);
  });

  test("general multi-step: isSpecialist=false, isMultiStep=true", () => {
    const result = classifyRoute("general", "pipeline", 3);
    expect(result.isSpecialist).toBe(false);
    expect(result.isMultiStep).toBe(true);
  });

  test("specialist multi-step: isSpecialist=true, isMultiStep=true", () => {
    const result = classifyRoute("research", "fan-out", 4);
    expect(result.isSpecialist).toBe(true);
    expect(result.isMultiStep).toBe(true);
  });

  test("general single-step: isSpecialist=false, isMultiStep=false", () => {
    const result = classifyRoute("general", "single", 0);
    expect(result.isSpecialist).toBe(false);
    expect(result.isMultiStep).toBe(false);
  });
});
