/**
 * ELLIE-1103 — Reproduce text.length crash in skill snapshot
 *
 * getSkillSnapshot passes skill.body (which doesn't exist on SkillEntry)
 * to extractMetadata → estimateTokens, causing a crash on undefined.length.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock() }) },
}));

// Mock eligibility to pass all skills through
mock.module("../src/skills/eligibility.ts", () => ({
  filterEligibleSkills: (skills: any[]) => skills,
}));

// Mock loader to return a controlled skill entry
const fakeSkill = {
  name: "test-skill",
  description: "A test skill",
  instructions: "Do the thing",  // SkillEntry uses "instructions", not "body"
  frontmatter: {
    name: "test-skill",
    description: "A test skill",
    always: true,
    triggers: [],
  },
  sourceDir: "/tmp/skills/test-skill",
  sourcePriority: 1,
};

mock.module("../src/skills/loader.ts", () => ({
  loadSkillEntries: () => [fakeSkill],
}));

// ── Import under test (after mocks) ─────────────────────────────────────────

import { getSkillSnapshot, bumpSnapshotVersion } from "../src/skills/snapshot.ts";

describe("ELLIE-1103: skill snapshot text.length crash", () => {
  beforeEach(() => {
    bumpSnapshotVersion(); // force rebuild each test
  });

  test("getSkillSnapshot does not crash on skill entries", async () => {
    // This should not throw — but before the fix, it crashes with:
    // "undefined is not an object (evaluating text.length)"
    // because snapshot.ts passes skill.body (undefined) instead of skill.instructions
    const result = await getSkillSnapshot(["test-skill"], "hello");
    expect(result.prompt).toContain("test-skill");
  });

  test("extractMetadata receives actual skill content, not undefined", async () => {
    const result = await getSkillSnapshot(["test-skill"], "hello");
    // The prompt should contain the skill instructions content
    expect(result.prompt).toContain("Do the thing");
    expect(result.totalChars).toBeGreaterThan(0);
  });
});
