/**
 * Blocker Protocol Tests — ELLIE-619
 *
 * Tests the BlockerProtocol type, getBlockerProtocol() parser,
 * and the ant.md blocker protocol section.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  parseArchetype,
  getBlockerProtocol,
  getSection,
  type BlockerProtocol,
} from "../src/archetype-schema.ts";

// ── getBlockerProtocol parser ───────────────────────────────────────────────

describe("getBlockerProtocol", () => {
  function makeArchetypeWithBlocker(blockerContent: string): ReturnType<typeof parseArchetype> {
    const raw = `---
species: ant
cognitive_style: "depth-first"
---

## Cognitive Style

Think deeply.

## Communication Contracts

Show code.

## Anti-Patterns

Don't drift.

## Blocker Protocol

${blockerContent}
`;
    return parseArchetype(raw);
  }

  test("parses a well-formed blocker protocol", () => {
    const schema = makeArchetypeWithBlocker(`
- **Max wait:** 120s
- **Escalation target:** coordinator
- **Handoff format:**
  - What is blocked
  - What was tried
  - Suggested next step
- **Retry behavior:** none
`);
    expect(schema).not.toBeNull();

    const protocol = getBlockerProtocol(schema!);
    expect(protocol).not.toBeNull();
    expect(protocol!.maxWaitSeconds).toBe(120);
    expect(protocol!.escalationTarget).toBe("coordinator");
    expect(protocol!.handoffFormat).toEqual([
      "What is blocked",
      "What was tried",
      "Suggested next step",
    ]);
    expect(protocol!.retryBehavior).toBe("none");
  });

  test("parses with different wait time", () => {
    const schema = makeArchetypeWithBlocker(`
- **Max wait:** 60s
- **Escalation target:** dave
- **Handoff format:**
  - Description of the blocker
`);
    const protocol = getBlockerProtocol(schema!);
    expect(protocol).not.toBeNull();
    expect(protocol!.maxWaitSeconds).toBe(60);
    expect(protocol!.escalationTarget).toBe("dave");
    expect(protocol!.handoffFormat).toEqual(["Description of the blocker"]);
  });

  test("returns null when no Blocker Protocol section exists", () => {
    const raw = `---
species: ant
cognitive_style: "depth-first"
---

## Cognitive Style

Think deeply.

## Communication Contracts

Show code.

## Anti-Patterns

Don't drift.
`;
    const schema = parseArchetype(raw);
    expect(schema).not.toBeNull();
    expect(getBlockerProtocol(schema!)).toBeNull();
  });

  test("returns null when Blocker Protocol section is empty", () => {
    const schema = makeArchetypeWithBlocker("");
    // Empty section content — parser returns null
    expect(getBlockerProtocol(schema!)).toBeNull();
  });

  test("returns null when max wait is missing", () => {
    const schema = makeArchetypeWithBlocker(`
- **Escalation target:** coordinator
- **Handoff format:**
  - What is blocked
`);
    expect(getBlockerProtocol(schema!)).toBeNull();
  });

  test("returns null when escalation target is missing", () => {
    const schema = makeArchetypeWithBlocker(`
- **Max wait:** 120s
- **Handoff format:**
  - What is blocked
`);
    expect(getBlockerProtocol(schema!)).toBeNull();
  });

  test("retry behavior is optional", () => {
    const schema = makeArchetypeWithBlocker(`
- **Max wait:** 120s
- **Escalation target:** coordinator
- **Handoff format:**
  - What is blocked
`);
    const protocol = getBlockerProtocol(schema!);
    expect(protocol).not.toBeNull();
    expect(protocol!.retryBehavior).toBeUndefined();
  });

  test("handoff format can be empty", () => {
    const schema = makeArchetypeWithBlocker(`
- **Max wait:** 120s
- **Escalation target:** coordinator
- **Handoff format:**
`);
    const protocol = getBlockerProtocol(schema!);
    expect(protocol).not.toBeNull();
    expect(protocol!.handoffFormat).toEqual([]);
  });
});

// ── ant.md blocker protocol ─────────────────────────────────────────────────

describe("ant.md blocker protocol", () => {
  const raw = readFileSync(join("config/archetypes", "ant.md"), "utf-8");
  const schema = parseArchetype(raw, "ant");

  test("ant.md has a Blocker Protocol section", () => {
    expect(schema).not.toBeNull();
    const section = getSection(schema!, "Blocker Protocol");
    expect(section).not.toBeNull();
    expect(section!.content.length).toBeGreaterThan(0);
  });

  test("ant.md blocker protocol parses correctly", () => {
    const protocol = getBlockerProtocol(schema!);
    expect(protocol).not.toBeNull();
    expect(protocol!.maxWaitSeconds).toBe(120);
    expect(protocol!.escalationTarget).toBe("coordinator");
    expect(protocol!.handoffFormat.length).toBeGreaterThanOrEqual(3);
    expect(protocol!.retryBehavior).toBeDefined();
  });

  test("ant.md still passes validation with blocker protocol section", () => {
    // Blocker Protocol is optional — it shouldn't break validation
    const { parseArchetype: _, validateArchetype } = require("../src/archetype-schema.ts");
    const validation = validateArchetype(schema!);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });
});
