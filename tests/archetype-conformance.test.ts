/**
 * Archetype Conformance Tests — ELLIE-617
 *
 * Validates that all 13 real archetype files in config/archetypes/:
 *   1. Parse successfully via parseArchetype()
 *   2. Have proper YAML frontmatter with species + cognitive_style
 *   3. Pass validateArchetype() with zero validation errors
 *   4. Use prefix-based section matching correctly
 *
 * Also tests identity-startup validation integration.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join, basename } from "path";

import {
  parseArchetype,
  validateArchetype,
  REQUIRED_SECTIONS,
  SECTION_ALIASES,
  MESSAGE_TYPES,
} from "../src/archetype-schema.ts";

import {
  loadArchetypes,
  listArchetypeConfigs,
  archetypeCount,
  _resetLoaderForTesting,
} from "../src/archetype-loader.ts";

import {
  initIdentitySystem,
} from "../src/identity-startup.ts";

const ARCHETYPES_DIR = "config/archetypes";

// Expected species mapping for all 13 files
const EXPECTED_SPECIES: Record<string, string> = {
  "ant.md": "ant",
  "chipmunk.md": "chipmunk",
  "content.md": "ant",
  "critic.md": "bee",
  "deer.md": "deer",
  "dev.md": "ant",
  "finance.md": "ant",
  "general.md": "squirrel",
  "ops.md": "bee",
  "owl.md": "owl",
  "research.md": "squirrel",
  "road-runner.md": "road-runner",
  "strategy.md": "squirrel",
};

// ── Per-file conformance ────────────────────────────────────────────────────

describe("archetype file conformance", () => {
  const files = readdirSync(ARCHETYPES_DIR).filter(f => f.endsWith(".md"));

  test("all 13 archetype files exist", () => {
    expect(files.length).toBe(13);
    for (const expected of Object.keys(EXPECTED_SPECIES)) {
      expect(files).toContain(expected);
    }
  });

  for (const file of files) {
    describe(file, () => {
      const raw = readFileSync(join(ARCHETYPES_DIR, file), "utf-8");
      const speciesHint = basename(file, ".md");
      const schema = parseArchetype(raw, speciesHint);

      test("parses successfully", () => {
        expect(schema).not.toBeNull();
      });

      test("has correct species", () => {
        expect(schema!.frontmatter.species).toBe(EXPECTED_SPECIES[file]);
      });

      test("has non-empty cognitive_style", () => {
        expect(schema!.frontmatter.cognitive_style.length).toBeGreaterThan(0);
      });

      test("has species in YAML frontmatter", () => {
        // Verify the raw file actually contains species: in frontmatter
        const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
        expect(fmMatch).not.toBeNull();
        expect(fmMatch![1]).toContain("species:");
      });

      test("has cognitive_style in YAML frontmatter", () => {
        const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
        expect(fmMatch![1]).toContain("cognitive_style:");
      });

      test("passes validation with zero errors", () => {
        const result = validateArchetype(schema!);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      test("has all required sections", () => {
        const headings = schema!.sections.map(s => s.heading.toLowerCase());
        for (const required of REQUIRED_SECTIONS) {
          const reqLower = required.toLowerCase();
          const aliases = SECTION_ALIASES[reqLower] || [];
          const allPatterns = [reqLower, ...aliases];
          const found = headings.some(h =>
            allPatterns.some(p => h.startsWith(p))
          );
          expect(found).toBe(true);
        }
      });
    });
  }
});

// ── Loader integration ──────────────────────────────────────────────────────

describe("archetype loader — all files", () => {
  beforeEach(() => _resetLoaderForTesting());
  afterEach(() => _resetLoaderForTesting());

  test("loads all 13 archetypes with zero failures", () => {
    const result = loadArchetypes(ARCHETYPES_DIR);
    expect(result.loaded).toBe(13);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  test("every loaded archetype passes validation", () => {
    loadArchetypes(ARCHETYPES_DIR);
    const configs = listArchetypeConfigs();
    // Cache is keyed by species — multiple files with same species (e.g. ant)
    // overwrite each other. 7 unique species across 13 files.
    expect(configs.length).toBe(7);

    for (const config of configs) {
      expect(config.validation.valid).toBe(true);
      expect(config.validation.errors).toHaveLength(0);
    }
  });

  test("archetypeCount matches unique species count", () => {
    loadArchetypes(ARCHETYPES_DIR);
    const uniqueSpecies = new Set(Object.values(EXPECTED_SPECIES));
    expect(archetypeCount()).toBe(uniqueSpecies.size);
  });
});

// ── Startup validation integration ──────────────────────────────────────────

describe("identity startup — archetype validation", () => {
  beforeEach(() => _resetLoaderForTesting());
  afterEach(() => _resetLoaderForTesting());

  test("startup reports zero archetype validation warnings", () => {
    const result = initIdentitySystem({
      archetypesDir: ARCHETYPES_DIR,
      skipWatchers: true,
    });
    expect(result.archetypes.loaded).toBe(13);
    expect(result.archetypes.failed).toBe(0);
    expect(result.archetypeValidationWarnings).toHaveLength(0);
  });
});

// ── Prefix matching ────────────────────────────────────────────────────────

describe("prefix-based section matching", () => {
  test("road-runner.md 'Communication Contracts' matches 'Communication'", () => {
    const raw = readFileSync(join(ARCHETYPES_DIR, "road-runner.md"), "utf-8");
    const schema = parseArchetype(raw, "road-runner")!;
    const headings = schema.sections.map(s => s.heading);
    expect(headings.some(h => h.startsWith("Communication"))).toBe(true);
    expect(validateArchetype(schema).valid).toBe(true);
  });

  test("strategy.md 'Anti-Patterns (What Strategy Never Does)' matches 'Anti-Patterns'", () => {
    const raw = readFileSync(join(ARCHETYPES_DIR, "strategy.md"), "utf-8");
    const schema = parseArchetype(raw, "strategy")!;
    const headings = schema.sections.map(s => s.heading);
    expect(headings.some(h => h.startsWith("Anti-Patterns"))).toBe(true);
    expect(validateArchetype(schema).valid).toBe(true);
  });
});

// ── Creature file conformance (dual-layer validation) ────────────────────────

const CREATURES_DIR = "creatures";

const EXPECTED_CREATURES: Record<string, { species: string; role?: string }> = {
  "general.md": { species: "squirrel" },
  "kate.md": { species: "squirrel" },
  "james.md": { species: "ant", role: "dev" },
  "amy.md": { species: "ant", role: "content" },
  "jason.md": { species: "ant", role: "ops" },
  "brian.md": { species: "owl", role: "critic" },
  "alan.md": { species: "bird", role: "strategy" },
};

describe("creature file conformance (strict: false)", () => {
  const files = readdirSync(CREATURES_DIR).filter(f => f.endsWith(".md"));

  test("all 7 creature files exist", () => {
    expect(files.length).toBe(7);
    for (const expected of Object.keys(EXPECTED_CREATURES)) {
      expect(files).toContain(expected);
    }
  });

  for (const file of files) {
    describe(file, () => {
      const raw = readFileSync(join(CREATURES_DIR, file), "utf-8");
      const speciesHint = basename(file, ".md");
      const schema = parseArchetype(raw, speciesHint);

      test("parses successfully", () => {
        expect(schema).not.toBeNull();
      });

      test("has correct species", () => {
        expect(schema!.frontmatter.species).toBe(EXPECTED_CREATURES[file].species);
      });

      test("has non-empty cognitive_style", () => {
        expect(schema!.frontmatter.cognitive_style.length).toBeGreaterThan(0);
      });

      test("has produces and consumes arrays", () => {
        expect(schema!.frontmatter.produces).toBeDefined();
        expect(Array.isArray(schema!.frontmatter.produces)).toBe(true);
        expect(schema!.frontmatter.produces!.length).toBeGreaterThan(0);

        expect(schema!.frontmatter.consumes).toBeDefined();
        expect(Array.isArray(schema!.frontmatter.consumes)).toBe(true);
        expect(schema!.frontmatter.consumes!.length).toBeGreaterThan(0);
      });

      test("produces domain-specific types (not protocol types)", () => {
        // Creature types should be domain-specific, NOT the generic protocol types
        const protocolTypes = new Set<string>(MESSAGE_TYPES);
        const hasDomainType = schema!.frontmatter.produces!.some(t => !protocolTypes.has(t));
        expect(hasDomainType).toBe(true);
      });

      test("passes validation with strict: false (domain types accepted)", () => {
        const result = validateArchetype(schema!, { strict: false });
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      test("has required sections", () => {
        const headings = schema!.sections.map(s => s.heading.toLowerCase());
        for (const required of REQUIRED_SECTIONS) {
          const reqLower = required.toLowerCase();
          const aliases = SECTION_ALIASES[reqLower] || [];
          const allPatterns = [reqLower, ...aliases];
          const found = headings.some(h =>
            allPatterns.some(p => h.startsWith(p))
          );
          expect(found).toBe(true);
        }
      });
    });
  }
});

describe("dual-layer validation — strict vs non-strict", () => {
  test("strict: true rejects domain-specific types", () => {
    const raw = readFileSync(join(CREATURES_DIR, "james.md"), "utf-8");
    const schema = parseArchetype(raw, "james")!;
    const result = validateArchetype(schema, { strict: true });
    // James produces domain types like code_implementation — strict should reject
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "frontmatter.produces")).toBe(true);
  });

  test("strict: false accepts domain-specific types", () => {
    const raw = readFileSync(join(CREATURES_DIR, "james.md"), "utf-8");
    const schema = parseArchetype(raw, "james")!;
    const result = validateArchetype(schema, { strict: false });
    expect(result.valid).toBe(true);
  });

  test("strict: true accepts protocol types (archetypes)", () => {
    const raw = readFileSync(join(ARCHETYPES_DIR, "dev.md"), "utf-8");
    const schema = parseArchetype(raw, "dev")!;
    const result = validateArchetype(schema, { strict: true });
    expect(result.valid).toBe(true);
  });

  test("default (no options) is strict", () => {
    const raw = readFileSync(join(CREATURES_DIR, "james.md"), "utf-8");
    const schema = parseArchetype(raw, "james")!;
    const result = validateArchetype(schema);
    // Default = strict, so domain types should be rejected
    expect(result.valid).toBe(false);
  });
});
