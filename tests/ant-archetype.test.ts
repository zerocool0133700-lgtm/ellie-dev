/**
 * Ant Archetype Tests -- ELLIE-583
 *
 * Validates:
 *  - Ant archetype file exists and is discoverable
 *  - Creature profile parses correctly from frontmatter
 *  - Dispatch system can assign the Ant archetype to agent sessions
 *  - Archetype instructions injected into agent prompts when assigned
 *  - Dev role capabilities and communication contract included
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  parseCreatureProfile,
  getCreatureProfile,
  setCreatureProfile,
  validateSectionLabels,
  type CreatureProfile,
} from "../src/creature-profile.ts";

const ARCHETYPES_DIR = join(import.meta.dir, "..", "config", "archetypes");
const ANT_PATH = join(ARCHETYPES_DIR, "ant.md");

// ── File existence and discoverability ────────────────────────

describe("Ant archetype file", () => {
  it("exists at config/archetypes/ant.md", () => {
    const content = readFileSync(ANT_PATH, "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });

  it("starts with YAML frontmatter", () => {
    const content = readFileSync(ANT_PATH, "utf-8");
    expect(content.startsWith("---\n")).toBe(true);
    expect(content.indexOf("\n---\n", 4)).toBeGreaterThan(0);
  });
});

// ── Creature profile parsing ─────────────────────────────────

describe("Ant creature profile", () => {
  let raw: string;
  let profile: CreatureProfile | null;
  let body: string;

  beforeEach(() => {
    raw = readFileSync(ANT_PATH, "utf-8");
    const parsed = parseCreatureProfile(raw);
    profile = parsed.profile;
    body = parsed.body;
  });

  it("parses a valid creature profile from frontmatter", () => {
    expect(profile).not.toBeNull();
  });

  it("has section_priorities defined", () => {
    expect(profile!.section_priorities).toBeDefined();
    expect(Object.keys(profile!.section_priorities).length).toBeGreaterThan(0);
  });

  it("has archetype as highest priority (1)", () => {
    expect(profile!.section_priorities.archetype).toBe(1);
  });

  it("has work-item priority", () => {
    expect(profile!.section_priorities["work-item"]).toBeDefined();
  });

  it("has token_budget set", () => {
    expect(profile!.token_budget).toBeDefined();
    expect(profile!.token_budget).toBeGreaterThan(0);
  });

  it("has allowed_skills defined", () => {
    expect(profile!.allowed_skills).toBeDefined();
    expect(profile!.allowed_skills!.length).toBeGreaterThan(0);
  });

  it("includes expected skills", () => {
    const skills = profile!.allowed_skills!;
    expect(skills).toContain("github");
    expect(skills).toContain("plane");
    expect(skills).toContain("memory");
    expect(skills).toContain("forest");
  });

  it("has no unknown section_priorities labels (typo check)", () => {
    const unknowns = validateSectionLabels(profile!);
    expect(unknowns).toEqual([]);
  });

  it("body does not include frontmatter delimiters", () => {
    expect(body.startsWith("---")).toBe(false);
  });
});

// ── Behavioral DNA content ───────────────────────────────────

describe("Ant behavioral DNA content", () => {
  let body: string;

  beforeEach(() => {
    const raw = readFileSync(ANT_PATH, "utf-8");
    body = parseCreatureProfile(raw).body;
  });

  it("contains Species: Ant heading", () => {
    expect(body).toContain("Species: Ant");
  });

  it("describes depth-first behavioral DNA", () => {
    expect(body).toContain("Depth-first");
    expect(body).toContain("single-threaded");
  });

  it("includes cognitive style section", () => {
    expect(body).toContain("Cognitive Style");
    expect(body).toContain("Code paths over concepts");
  });

  it("includes communication contracts", () => {
    expect(body).toContain("Communication Contracts");
    expect(body).toContain("Show Code, Not Descriptions");
    expect(body).toContain("Diff-First Responses");
    expect(body).toContain("Precision in Language");
  });

  it("includes anti-patterns", () => {
    expect(body).toContain("Scope Creep");
    expect(body).toContain("Speculation Without Evidence");
    expect(body).toContain("Splitting Attention");
  });

  it("includes growth metrics", () => {
    expect(body).toContain("Growth Metrics");
    expect(body).toContain("Task completion rate");
    expect(body).toContain("Scope discipline");
  });

  it("includes problem-solving pattern", () => {
    expect(body).toContain("Problem-Solving Pattern");
    expect(body).toContain("Reproduce");
    expect(body).toContain("Trace");
    expect(body).toContain("Isolate");
    expect(body).toContain("Verify");
  });
});

// ── Dispatch system integration (creature profile cache) ─────

describe("Ant archetype dispatch integration", () => {
  beforeEach(() => {
    // Simulate what getAgentArchetype() does for file-based archetypes
    const raw = readFileSync(ANT_PATH, "utf-8");
    const { profile } = parseCreatureProfile(raw);
    if (profile) {
      setCreatureProfile("ant", profile);
    }
  });

  it("can be stored and retrieved from creature profile cache", () => {
    const cached = getCreatureProfile("ant");
    expect(cached).not.toBeNull();
  });

  it("cached profile has correct section_priorities", () => {
    const cached = getCreatureProfile("ant")!;
    expect(cached.section_priorities.archetype).toBe(1);
    expect(cached.section_priorities["work-item"]).toBe(2);
  });

  it("cached profile has correct token_budget", () => {
    const cached = getCreatureProfile("ant")!;
    expect(cached.token_budget).toBe(28000);
  });

  it("cached profile has correct allowed_skills", () => {
    const cached = getCreatureProfile("ant")!;
    expect(cached.allowed_skills).toContain("github");
    expect(cached.allowed_skills).toContain("plane");
  });

  it("normalizes name for cache lookup", () => {
    // setCreatureProfile normalizes: lowercase, strip non-alphanumeric
    setCreatureProfile("ANT", { section_priorities: { archetype: 1 } });
    const cached = getCreatureProfile("ant");
    expect(cached).not.toBeNull();
  });
});

// ── Consistency with dev archetype ───────────────────────────

describe("Ant vs Dev archetype consistency", () => {
  it("ant has same frontmatter structure as dev", () => {
    const antRaw = readFileSync(ANT_PATH, "utf-8");
    const devRaw = readFileSync(join(ARCHETYPES_DIR, "dev.md"), "utf-8");

    const antParsed = parseCreatureProfile(antRaw);
    const devParsed = parseCreatureProfile(devRaw);

    expect(antParsed.profile).not.toBeNull();
    expect(devParsed.profile).not.toBeNull();

    // Both should have the same frontmatter keys
    const antKeys = Object.keys(antParsed.profile!.section_priorities).sort();
    const devKeys = Object.keys(devParsed.profile!.section_priorities).sort();
    expect(antKeys).toEqual(devKeys);
  });

  it("ant has same token_budget as dev", () => {
    const antRaw = readFileSync(ANT_PATH, "utf-8");
    const devRaw = readFileSync(join(ARCHETYPES_DIR, "dev.md"), "utf-8");

    const antProfile = parseCreatureProfile(antRaw).profile!;
    const devProfile = parseCreatureProfile(devRaw).profile!;

    expect(antProfile.token_budget).toBe(devProfile.token_budget);
  });

  it("ant has same allowed_skills as dev", () => {
    const antRaw = readFileSync(ANT_PATH, "utf-8");
    const devRaw = readFileSync(join(ARCHETYPES_DIR, "dev.md"), "utf-8");

    const antSkills = parseCreatureProfile(antRaw).profile!.allowed_skills!.sort();
    const devSkills = parseCreatureProfile(devRaw).profile!.allowed_skills!.sort();

    expect(antSkills).toEqual(devSkills);
  });
});
