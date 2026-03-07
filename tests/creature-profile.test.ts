/**
 * ELLIE-559 — creature-profile.ts tests
 *
 * Tests YAML frontmatter parsing, profile caching, and section label validation.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  parseCreatureProfile,
  getCreatureProfile,
  setCreatureProfile,
  validateSectionLabels,
  type CreatureProfile,
} from "../src/creature-profile.ts";

// ── parseCreatureProfile ────────────────────────────────────

describe("parseCreatureProfile", () => {
  test("parses frontmatter with section_priorities", () => {
    const raw = `---
token_budget: 100000
section_priorities:
  archetype: 1
  soul: 2
---
Body content here`;
    const { profile, body } = parseCreatureProfile(raw);
    expect(profile).not.toBeNull();
    expect(profile!.section_priorities.archetype).toBe(1);
    expect(profile!.section_priorities.soul).toBe(2);
    expect(profile!.token_budget).toBe(100000);
    expect(body).toBe("Body content here");
  });

  test("parses allowed_skills array", () => {
    const raw = `---
section_priorities:
  archetype: 1
allowed_skills: [github, plane, memory]
---
Body`;
    const { profile } = parseCreatureProfile(raw);
    expect(profile!.allowed_skills).toEqual(["github", "plane", "memory"]);
  });

  test("returns null profile when no frontmatter", () => {
    const { profile, body } = parseCreatureProfile("Just a body.");
    expect(profile).toBeNull();
    expect(body).toBe("Just a body.");
  });

  test("returns null profile when no section_priorities", () => {
    const raw = `---
token_budget: 50000
---
Body`;
    const { profile } = parseCreatureProfile(raw);
    expect(profile).toBeNull();
  });

  test("handles empty frontmatter gracefully", () => {
    const raw = `---
---
Body`;
    const { profile } = parseCreatureProfile(raw);
    expect(profile).toBeNull();
  });

  test("body is trimmed after frontmatter", () => {
    const raw = `---
section_priorities:
  soul: 3
---

  Trimmed body  `;
    const { body } = parseCreatureProfile(raw);
    expect(body).toBe("Trimmed body");
  });

  test("token_budget not set if non-numeric", () => {
    const raw = `---
section_priorities:
  soul: 1
token_budget: "high"
---
Body`;
    const { profile } = parseCreatureProfile(raw);
    expect(profile!.token_budget).toBeUndefined();
  });
});

// ── getCreatureProfile / setCreatureProfile ──────────────────

describe("creature profile cache", () => {
  test("returns null for unknown name", () => {
    expect(getCreatureProfile("nonexistent-xyz")).toBeNull();
  });

  test("returns null for undefined", () => {
    expect(getCreatureProfile(undefined)).toBeNull();
  });

  test("set and get roundtrip", () => {
    const profile: CreatureProfile = {
      section_priorities: { soul: 1, archetype: 2 },
      token_budget: 25000,
    };
    setCreatureProfile("test-agent", profile);
    expect(getCreatureProfile("test-agent")).toEqual(profile);
  });

  test("name is case-insensitive", () => {
    setCreatureProfile("TestAgent", { section_priorities: { soul: 5 } });
    expect(getCreatureProfile("testagent")!.section_priorities.soul).toBe(5);
  });
});

// ── validateSectionLabels ───────────────────────────────────

describe("validateSectionLabels", () => {
  test("valid labels return empty array", () => {
    const profile: CreatureProfile = {
      section_priorities: { soul: 1, archetype: 2, "work-item": 3 },
    };
    expect(validateSectionLabels(profile)).toEqual([]);
  });

  test("unknown labels returned as warnings", () => {
    const profile: CreatureProfile = {
      section_priorities: { soul: 1, "forest-context": 2, "bad-label": 3 },
    };
    const unknown = validateSectionLabels(profile);
    expect(unknown).toContain("forest-context");
    expect(unknown).toContain("bad-label");
    expect(unknown).not.toContain("soul");
  });

  test("empty section_priorities returns empty array", () => {
    expect(validateSectionLabels({ section_priorities: {} })).toEqual([]);
  });
});
