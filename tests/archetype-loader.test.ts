/**
 * Tests for Archetype Loader — ELLIE-604
 *
 * Covers: loading from directory, single file loading, queries,
 * cache management, hot-reload via inject/remove, malformed file handling.
 *
 * Uses a temp directory with test .md files to avoid depending on
 * the actual config/archetypes/ directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  loadArchetypes,
  loadSingleFile,
  reloadArchetype,
  reloadFromPath,
  removeByPath,
  getArchetype,
  listArchetypes,
  listArchetypeConfigs,
  archetypeCount,
  hasArchetype,
  startWatcher,
  stopWatcher,
  isWatching,
  _resetLoaderForTesting,
  _injectArchetypeForTesting,
  type ArchetypeConfig,
} from "../src/archetype-loader";

import { type ArchetypeSchema } from "../src/archetype-schema";

// ── Test fixtures ────────────────────────────────────────────────────────────

const VALID_ANT = `---
species: ant
cognitive_style: "depth-first, single-threaded, methodical"
token_budget: 100000
---

## Cognitive Style

Stay on task until completion. Don't context-switch.

## Communication Contracts

Show code, not descriptions.

## Anti-Patterns

No scope creep.

## Growth Metrics

- Task completion rate
`;

const VALID_OWL = `---
species: owl
cognitive_style: "breadth-first, multi-threaded, exploratory"
---

## Cognitive Style

Explore broadly before committing.

## Communication Contracts

Synthesize findings into summaries.

## Anti-Patterns

Never tunnel-vision.

## Growth Metrics

- Research coverage
`;

const MALFORMED_NO_SPECIES = `---
cognitive_style: "some style"
---

## Cognitive Style

Content.
`;

const MALFORMED_NO_FRONTMATTER = `# Just a heading

Some content without frontmatter.
`;

// ── Setup ────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  _resetLoaderForTesting();
  tempDir = mkdtempSync(join(tmpdir(), "archetype-test-"));
});

afterEach(() => {
  _resetLoaderForTesting();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

// ── loadArchetypes ───────────────────────────────────────────────────────────

describe("loadArchetypes", () => {
  it("loads valid archetype files from directory", () => {
    writeFileSync(join(tempDir, "ant.md"), VALID_ANT);
    writeFileSync(join(tempDir, "owl.md"), VALID_OWL);

    const result = loadArchetypes(tempDir);
    expect(result.loaded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("counts malformed files as failed", () => {
    writeFileSync(join(tempDir, "ant.md"), VALID_ANT);
    writeFileSync(join(tempDir, "bad.md"), MALFORMED_NO_FRONTMATTER);

    const result = loadArchetypes(tempDir);
    expect(result.loaded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe("bad.md");
  });

  it("loads legacy files without species: by inferring from filename", () => {
    writeFileSync(join(tempDir, "ant.md"), MALFORMED_NO_SPECIES);

    const result = loadArchetypes(tempDir);
    expect(result.loaded).toBe(1);
    expect(result.failed).toBe(0);
    expect(listArchetypes()).toContain("ant");
  });

  it("handles non-existent directory gracefully", () => {
    const result = loadArchetypes("/nonexistent/path");
    expect(result.loaded).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("skips non-.md files", () => {
    writeFileSync(join(tempDir, "ant.md"), VALID_ANT);
    writeFileSync(join(tempDir, "readme.txt"), "Not an archetype");
    writeFileSync(join(tempDir, "config.json"), "{}");

    const result = loadArchetypes(tempDir);
    expect(result.loaded).toBe(1);
  });

  it("handles empty directory", () => {
    const result = loadArchetypes(tempDir);
    expect(result.loaded).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("handles file without frontmatter", () => {
    writeFileSync(join(tempDir, "plain.md"), MALFORMED_NO_FRONTMATTER);

    const result = loadArchetypes(tempDir);
    expect(result.loaded).toBe(0);
    expect(result.failed).toBe(1);
  });
});

// ── loadSingleFile ───────────────────────────────────────────────────────────

describe("loadSingleFile", () => {
  it("loads and caches a valid archetype file", () => {
    const filePath = join(tempDir, "ant.md");
    writeFileSync(filePath, VALID_ANT);

    const config = loadSingleFile(filePath);
    expect(config).not.toBeNull();
    expect(config!.species).toBe("ant");
    expect(config!.schema.frontmatter.cognitive_style).toBe("depth-first, single-threaded, methodical");
    expect(config!.schema.frontmatter.token_budget).toBe(100000);
    expect(config!.filePath).toBe(filePath);
    expect(config!.loadedAt).toBeTruthy();

    // Verify it's in the cache
    expect(getArchetype("ant")).not.toBeNull();
  });

  it("returns null for non-existent file", () => {
    const config = loadSingleFile("/nonexistent/file.md");
    expect(config).toBeNull();
  });

  it("returns null for file with no frontmatter", () => {
    const filePath = join(tempDir, "bad.md");
    writeFileSync(filePath, MALFORMED_NO_FRONTMATTER);

    const config = loadSingleFile(filePath);
    expect(config).toBeNull();
  });

  it("loads file without species: using filename as hint", () => {
    const filePath = join(tempDir, "ant.md");
    writeFileSync(filePath, MALFORMED_NO_SPECIES);

    const config = loadSingleFile(filePath);
    expect(config).not.toBeNull();
    expect(config!.species).toBe("ant");
  });

  it("includes validation results", () => {
    const filePath = join(tempDir, "ant.md");
    writeFileSync(filePath, VALID_ANT);

    const config = loadSingleFile(filePath);
    expect(config).not.toBeNull();
    expect(config!.validation.valid).toBe(true);
    expect(config!.validation.errors).toEqual([]);
  });

  it("loads file with validation errors (missing sections)", () => {
    const raw = `---
species: incomplete
cognitive_style: "partial"
---

## Cognitive Style

Content only in one section.
`;
    const filePath = join(tempDir, "incomplete.md");
    writeFileSync(filePath, raw);

    const config = loadSingleFile(filePath);
    expect(config).not.toBeNull();
    expect(config!.species).toBe("incomplete");
    expect(config!.validation.valid).toBe(false);
    expect(config!.validation.errors.length).toBeGreaterThan(0);
  });
});

// ── getArchetype ─────────────────────────────────────────────────────────────

describe("getArchetype", () => {
  it("returns null for unknown species", () => {
    expect(getArchetype("unknown")).toBeNull();
  });

  it("is case-insensitive", () => {
    writeFileSync(join(tempDir, "ant.md"), VALID_ANT);
    loadArchetypes(tempDir);

    expect(getArchetype("ant")).not.toBeNull();
    expect(getArchetype("ANT")).not.toBeNull();
    expect(getArchetype("Ant")).not.toBeNull();
  });

  it("returns the full config", () => {
    writeFileSync(join(tempDir, "ant.md"), VALID_ANT);
    loadArchetypes(tempDir);

    const config = getArchetype("ant");
    expect(config).not.toBeNull();
    expect(config!.species).toBe("ant");
    expect(config!.schema.sections.length).toBeGreaterThan(0);
  });
});

// ── listArchetypes ───────────────────────────────────────────────────────────

describe("listArchetypes", () => {
  it("returns empty array when nothing loaded", () => {
    expect(listArchetypes()).toEqual([]);
  });

  it("returns all loaded species names", () => {
    writeFileSync(join(tempDir, "ant.md"), VALID_ANT);
    writeFileSync(join(tempDir, "owl.md"), VALID_OWL);
    loadArchetypes(tempDir);

    const species = listArchetypes();
    expect(species).toHaveLength(2);
    expect(species).toContain("ant");
    expect(species).toContain("owl");
  });
});

// ── listArchetypeConfigs ─────────────────────────────────────────────────────

describe("listArchetypeConfigs", () => {
  it("returns full config objects", () => {
    writeFileSync(join(tempDir, "ant.md"), VALID_ANT);
    loadArchetypes(tempDir);

    const configs = listArchetypeConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0].species).toBe("ant");
    expect(configs[0].schema).toBeDefined();
  });
});

// ── archetypeCount / hasArchetype ────────────────────────────────────────────

describe("archetypeCount", () => {
  it("returns 0 when empty", () => {
    expect(archetypeCount()).toBe(0);
  });

  it("returns correct count", () => {
    writeFileSync(join(tempDir, "ant.md"), VALID_ANT);
    writeFileSync(join(tempDir, "owl.md"), VALID_OWL);
    loadArchetypes(tempDir);

    expect(archetypeCount()).toBe(2);
  });
});

describe("hasArchetype", () => {
  it("returns false for unknown", () => {
    expect(hasArchetype("ant")).toBe(false);
  });

  it("returns true for loaded", () => {
    writeFileSync(join(tempDir, "ant.md"), VALID_ANT);
    loadArchetypes(tempDir);

    expect(hasArchetype("ant")).toBe(true);
    expect(hasArchetype("ANT")).toBe(true);
  });
});

// ── reloadArchetype ──────────────────────────────────────────────────────────

describe("reloadArchetype", () => {
  it("reloads an existing archetype", () => {
    const filePath = join(tempDir, "ant.md");
    writeFileSync(filePath, VALID_ANT);
    loadArchetypes(tempDir);

    const original = getArchetype("ant")!;
    const originalLoadedAt = original.loadedAt;

    // Modify the file
    const updated = VALID_ANT.replace("depth-first", "breadth-first");
    writeFileSync(filePath, updated);

    const reloaded = reloadArchetype("ant");
    expect(reloaded).not.toBeNull();
    expect(reloaded!.schema.frontmatter.cognitive_style).toContain("breadth-first");
  });

  it("returns null for unknown species", () => {
    const result = reloadArchetype("unknown");
    expect(result).toBeNull();
  });
});

// ── reloadFromPath ───────────────────────────────────────────────────────────

describe("reloadFromPath", () => {
  it("loads a new file by path", () => {
    const filePath = join(tempDir, "owl.md");
    writeFileSync(filePath, VALID_OWL);

    const config = reloadFromPath(filePath);
    expect(config).not.toBeNull();
    expect(config!.species).toBe("owl");
    expect(getArchetype("owl")).not.toBeNull();
  });

  it("replaces existing entry when file changes", () => {
    const filePath = join(tempDir, "ant.md");
    writeFileSync(filePath, VALID_ANT);
    loadArchetypes(tempDir);

    expect(getArchetype("ant")).not.toBeNull();

    const updated = VALID_ANT.replace("depth-first", "updated-style");
    writeFileSync(filePath, updated);

    const config = reloadFromPath(filePath);
    expect(config).not.toBeNull();
    expect(config!.schema.frontmatter.cognitive_style).toContain("updated-style");
  });

  it("returns null for unparseable file", () => {
    const filePath = join(tempDir, "bad.md");
    writeFileSync(filePath, MALFORMED_NO_FRONTMATTER);

    const config = reloadFromPath(filePath);
    expect(config).toBeNull();
  });
});

// ── removeByPath ─────────────────────────────────────────────────────────────

describe("removeByPath", () => {
  it("removes an archetype by file path", () => {
    const filePath = join(tempDir, "ant.md");
    writeFileSync(filePath, VALID_ANT);
    loadArchetypes(tempDir);

    expect(hasArchetype("ant")).toBe(true);

    const removed = removeByPath(filePath);
    expect(removed).toBe("ant");
    expect(hasArchetype("ant")).toBe(false);
  });

  it("returns null for unknown path", () => {
    const removed = removeByPath("/unknown/path.md");
    expect(removed).toBeNull();
  });
});

// ── _injectArchetypeForTesting ───────────────────────────────────────────────

describe("_injectArchetypeForTesting", () => {
  it("injects archetype into cache for testing", () => {
    const config: ArchetypeConfig = {
      species: "test-species",
      schema: {
        frontmatter: {
          species: "test-species",
          cognitive_style: "test style",
        },
        sections: [
          { heading: "Working Pattern", content: "Test" },
          { heading: "Communication Style", content: "Test" },
          { heading: "Anti-Patterns", content: "Test" },
          { heading: "Growth Metrics", content: "Test" },
        ],
        body: "test body",
      },
      validation: { valid: true, errors: [] },
      filePath: "/test/path.md",
      loadedAt: new Date().toISOString(),
    };

    _injectArchetypeForTesting(config);
    expect(getArchetype("test-species")).not.toBeNull();
    expect(getArchetype("test-species")!.species).toBe("test-species");
  });
});

// ── Watcher ──────────────────────────────────────────────────────────────────

describe("watcher", () => {
  it("starts and stops without error", () => {
    expect(isWatching()).toBe(false);

    const started = startWatcher(tempDir);
    expect(started).toBe(true);
    expect(isWatching()).toBe(true);

    stopWatcher();
    expect(isWatching()).toBe(false);
  });

  it("returns false for non-existent directory", () => {
    const started = startWatcher("/nonexistent/path");
    expect(started).toBe(false);
  });

  it("returns false if already watching", () => {
    startWatcher(tempDir);
    const second = startWatcher(tempDir);
    expect(second).toBe(false);
    stopWatcher();
  });

  it("stopWatcher is safe to call when not watching", () => {
    expect(isWatching()).toBe(false);
    stopWatcher(); // Should not throw
    expect(isWatching()).toBe(false);
  });
});

// ── Full scenarios ───────────────────────────────────────────────────────────

describe("full scenarios", () => {
  it("load all → query → reload → remove", () => {
    writeFileSync(join(tempDir, "ant.md"), VALID_ANT);
    writeFileSync(join(tempDir, "owl.md"), VALID_OWL);

    // Load all
    const loadResult = loadArchetypes(tempDir);
    expect(loadResult.loaded).toBe(2);
    expect(archetypeCount()).toBe(2);

    // Query
    const ant = getArchetype("ant");
    expect(ant).not.toBeNull();
    expect(ant!.schema.frontmatter.species).toBe("ant");

    const owl = getArchetype("owl");
    expect(owl).not.toBeNull();

    // Reload with changes
    const updatedAnt = VALID_ANT.replace("depth-first", "revised-style");
    writeFileSync(join(tempDir, "ant.md"), updatedAnt);

    const reloaded = reloadArchetype("ant");
    expect(reloaded).not.toBeNull();
    expect(reloaded!.schema.frontmatter.cognitive_style).toContain("revised-style");

    // Remove
    const removed = removeByPath(join(tempDir, "owl.md"));
    expect(removed).toBe("owl");
    expect(archetypeCount()).toBe(1);
    expect(hasArchetype("owl")).toBe(false);
    expect(hasArchetype("ant")).toBe(true);
  });

  it("mixed valid and invalid files", () => {
    writeFileSync(join(tempDir, "ant.md"), VALID_ANT);
    writeFileSync(join(tempDir, "bad1.md"), MALFORMED_NO_SPECIES); // loads with filename hint "bad1"
    writeFileSync(join(tempDir, "bad2.md"), MALFORMED_NO_FRONTMATTER); // truly unparseable
    writeFileSync(join(tempDir, "owl.md"), VALID_OWL);

    const result = loadArchetypes(tempDir);
    expect(result.loaded).toBe(3); // ant, owl, bad1 (inferred species)
    expect(result.failed).toBe(1); // bad2 (no frontmatter)
    expect(archetypeCount()).toBe(3);

    expect(listArchetypes()).toContain("ant");
    expect(listArchetypes()).toContain("owl");
    expect(listArchetypes()).toContain("bad1");
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("loading same directory twice overwrites cache", () => {
    writeFileSync(join(tempDir, "ant.md"), VALID_ANT);

    loadArchetypes(tempDir);
    expect(archetypeCount()).toBe(1);

    loadArchetypes(tempDir);
    expect(archetypeCount()).toBe(1); // Still 1, not duplicated
  });

  it("species name from frontmatter takes precedence over filename", () => {
    // File named "custom.md" but species is "ant" in frontmatter
    writeFileSync(join(tempDir, "custom.md"), VALID_ANT);

    loadArchetypes(tempDir);
    expect(hasArchetype("ant")).toBe(true);
    expect(hasArchetype("custom")).toBe(false);
  });

  it("watcher callback fires on reloadFromPath", () => {
    const events: Array<{ event: string; species: string }> = [];

    const filePath = join(tempDir, "ant.md");
    writeFileSync(filePath, VALID_ANT);

    // Start watcher with callback
    startWatcher(tempDir, (event, species) => {
      events.push({ event, species });
    });

    // Reload triggers callback
    reloadFromPath(filePath);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("loaded");
    expect(events[0].species).toBe("ant");

    stopWatcher();
  });

  it("watcher callback fires on removeByPath", () => {
    const events: Array<{ event: string; species: string }> = [];

    const filePath = join(tempDir, "ant.md");
    writeFileSync(filePath, VALID_ANT);
    loadArchetypes(tempDir);

    startWatcher(tempDir, (event, species) => {
      events.push({ event, species });
    });

    removeByPath(filePath);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("removed");
    expect(events[0].species).toBe("ant");

    stopWatcher();
  });
});
