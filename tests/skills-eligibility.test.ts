/**
 * ELLIE-509 — Skills eligibility tests
 *
 * Tests isSkillEligible (pure function) for all check combinations:
 * - always flag, OS matching, required binaries, env vars, credentials
 *
 * No mocking required — isSkillEligible has no async I/O.
 * clearBinCache() is called before bin tests to avoid stale cached results.
 */

import { describe, test, expect, beforeEach } from "bun:test";

// ── Mocks (module init safety) ────────────────────────────────────────────────

import { mock } from "bun:test";

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock() }) },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { isSkillEligible, clearBinCache } from "../src/skills/eligibility.ts";
import type { SkillEntry, SkillFrontmatter } from "../src/skills/types.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSkill(fm: Partial<SkillFrontmatter>): SkillEntry {
  return {
    name: fm.name ?? "test-skill",
    description: fm.description ?? "A test skill",
    instructions: "",
    frontmatter: {
      name: fm.name ?? "test-skill",
      description: fm.description ?? "A test skill",
      ...fm,
    },
    sourceDir: "/tmp/test-skill",
    sourcePriority: 1,
  };
}

/** A bin that is guaranteed to exist on this Linux system. */
const EXISTING_BIN = "sh";
/** A bin that definitely does not exist. */
const MISSING_BIN = "definitely-not-a-binary-ellie509xyz";

beforeEach(() => {
  clearBinCache();
});

// ── always flag ───────────────────────────────────────────────────────────────

describe("isSkillEligible — always flag", () => {
  test("always: true → eligible regardless of OS mismatch", () => {
    const wrongOs = process.platform === "linux" ? "darwin" : "linux";
    const skill = makeSkill({ always: true, os: [wrongOs] });
    expect(isSkillEligible(skill)).toBe(true);
  });

  test("always: true → eligible even with impossible bin requirement", () => {
    const skill = makeSkill({ always: true, requires: { bins: [MISSING_BIN] } });
    expect(isSkillEligible(skill)).toBe(true);
  });

  test("always: true → eligible even with missing env", () => {
    delete process.env.ELLIE_509_NEVER_SET;
    const skill = makeSkill({ always: true, requires: { env: ["ELLIE_509_NEVER_SET"] } });
    expect(isSkillEligible(skill)).toBe(true);
  });

  test("always: false → falls through to normal checks", () => {
    const skill = makeSkill({ always: false });
    // No other restrictions — should be eligible
    expect(isSkillEligible(skill)).toBe(true);
  });
});

// ── OS check ─────────────────────────────────────────────────────────────────

describe("isSkillEligible — OS check", () => {
  test("current platform in OS list → eligible", () => {
    const skill = makeSkill({ os: [process.platform] });
    expect(isSkillEligible(skill)).toBe(true);
  });

  test("wrong OS → not eligible", () => {
    const wrongOs = process.platform === "linux" ? "darwin" : "linux";
    const skill = makeSkill({ os: [wrongOs] });
    expect(isSkillEligible(skill)).toBe(false);
  });

  test("multiple OS options including current → eligible", () => {
    const skill = makeSkill({ os: ["darwin", process.platform, "win32"] });
    expect(isSkillEligible(skill)).toBe(true);
  });

  test("empty OS list → eligible (no OS restriction)", () => {
    const skill = makeSkill({ os: [] });
    expect(isSkillEligible(skill)).toBe(true);
  });

  test("undefined OS → eligible (no restriction)", () => {
    const skill = makeSkill({});
    expect(isSkillEligible(skill)).toBe(true);
  });
});

// ── Required bins ─────────────────────────────────────────────────────────────

describe("isSkillEligible — required binaries", () => {
  test("existing bin on PATH → eligible", () => {
    const skill = makeSkill({ requires: { bins: [EXISTING_BIN] } });
    expect(isSkillEligible(skill)).toBe(true);
  });

  test("non-existent bin → not eligible", () => {
    const skill = makeSkill({ requires: { bins: [MISSING_BIN] } });
    expect(isSkillEligible(skill)).toBe(false);
  });

  test("first bin exists, second missing → not eligible", () => {
    const skill = makeSkill({ requires: { bins: [EXISTING_BIN, MISSING_BIN] } });
    expect(isSkillEligible(skill)).toBe(false);
  });

  test("empty bins array → eligible", () => {
    const skill = makeSkill({ requires: { bins: [] } });
    expect(isSkillEligible(skill)).toBe(true);
  });

  test("undefined requires → eligible", () => {
    const skill = makeSkill({ requires: undefined });
    expect(isSkillEligible(skill)).toBe(true);
  });
});

// ── Required env vars ─────────────────────────────────────────────────────────

describe("isSkillEligible — required env vars", () => {
  const TEST_VAR = "ELLIE_509_TEST_VAR";

  test("env var set → eligible", () => {
    process.env[TEST_VAR] = "hello";
    const skill = makeSkill({ requires: { env: [TEST_VAR] } });
    const result = isSkillEligible(skill);
    delete process.env[TEST_VAR];
    expect(result).toBe(true);
  });

  test("env var not set → not eligible", () => {
    delete process.env[TEST_VAR];
    const skill = makeSkill({ requires: { env: [TEST_VAR] } });
    expect(isSkillEligible(skill)).toBe(false);
  });

  test("env var empty string → not eligible", () => {
    process.env[TEST_VAR] = "";
    const skill = makeSkill({ requires: { env: [TEST_VAR] } });
    const result = isSkillEligible(skill);
    delete process.env[TEST_VAR];
    expect(result).toBe(false);
  });

  test("two required env vars: first set, second missing → not eligible", () => {
    const VAR2 = "ELLIE_509_TEST_VAR2";
    process.env[TEST_VAR] = "set";
    delete process.env[VAR2];
    const skill = makeSkill({ requires: { env: [TEST_VAR, VAR2] } });
    const result = isSkillEligible(skill);
    delete process.env[TEST_VAR];
    expect(result).toBe(false);
  });

  test("empty env array → eligible", () => {
    const skill = makeSkill({ requires: { env: [] } });
    expect(isSkillEligible(skill)).toBe(true);
  });
});

// ── Required credentials ──────────────────────────────────────────────────────

describe("isSkillEligible — required credentials", () => {
  test("required credential present in domain set → eligible", () => {
    const domains = new Set(["github.com", "miro.com"]);
    const skill = makeSkill({ requires: { credentials: ["github.com"] } });
    expect(isSkillEligible(skill, domains)).toBe(true);
  });

  test("required credential missing from domain set → not eligible", () => {
    const domains = new Set(["github.com"]);
    const skill = makeSkill({ requires: { credentials: ["miro.com"] } });
    expect(isSkillEligible(skill, domains)).toBe(false);
  });

  test("multiple credentials: all present → eligible", () => {
    const domains = new Set(["github.com", "miro.com", "slack.com"]);
    const skill = makeSkill({ requires: { credentials: ["github.com", "miro.com"] } });
    expect(isSkillEligible(skill, domains)).toBe(true);
  });

  test("multiple credentials: one missing → not eligible", () => {
    const domains = new Set(["github.com"]);
    const skill = makeSkill({ requires: { credentials: ["github.com", "miro.com"] } });
    expect(isSkillEligible(skill, domains)).toBe(false);
  });

  test("credentials required but no domain set → not eligible (fail closed)", () => {
    const skill = makeSkill({ requires: { credentials: ["github.com"] } });
    expect(isSkillEligible(skill, undefined)).toBe(false);
  });

  test("credentials required but empty domain set → not eligible", () => {
    const skill = makeSkill({ requires: { credentials: ["github.com"] } });
    expect(isSkillEligible(skill, new Set())).toBe(false);
  });

  test("empty credentials array → eligible (no credential restriction)", () => {
    const domains = new Set<string>();
    const skill = makeSkill({ requires: { credentials: [] } });
    expect(isSkillEligible(skill, domains)).toBe(true);
  });
});

// ── Combined checks ───────────────────────────────────────────────────────────

describe("isSkillEligible — combined checks", () => {
  test("OS + bin + env all pass → eligible", () => {
    const TEST_VAR = "ELLIE_509_COMBINED";
    process.env[TEST_VAR] = "yes";
    const skill = makeSkill({
      os: [process.platform],
      requires: { bins: [EXISTING_BIN], env: [TEST_VAR] },
    });
    const result = isSkillEligible(skill);
    delete process.env[TEST_VAR];
    expect(result).toBe(true);
  });

  test("OS passes but env missing → not eligible", () => {
    delete process.env.ELLIE_509_MISSING;
    const skill = makeSkill({
      os: [process.platform],
      requires: { env: ["ELLIE_509_MISSING"] },
    });
    expect(isSkillEligible(skill)).toBe(false);
  });

  test("no restrictions → eligible", () => {
    const skill = makeSkill({});
    expect(isSkillEligible(skill)).toBe(true);
  });
});
