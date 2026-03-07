/**
 * Tests for Archetype Schema — ELLIE-603
 *
 * Covers: parsing, validation, section extraction, queries,
 * and conformance of the existing ant.md archetype file.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  parseArchetype,
  parseSections,
  validateArchetype,
  validateArchetypeFile,
  getSection,
  listSectionHeadings,
  hasAllRequiredSections,
  getMissingSections,
  REQUIRED_SECTIONS,
  KNOWN_SPECIES,
  type ArchetypeSchema,
  type ArchetypeFrontmatter,
} from "../src/archetype-schema";

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_ARCHETYPE = `---
species: ant
cognitive_style: "depth-first, single-threaded, methodical"
token_budget: 100000
allowed_skills: [github, plane, memory]
---

# Ant Archetype

## Cognitive Style

Stay on task until completion. Don't context-switch.

## Communication Contracts

Show code, not descriptions. Diff-first responses.

## Anti-Patterns

No scope creep. No speculation without evidence.

## Growth Metrics

- Task completion rate
- Investigation depth
- Scope discipline
`;

const MINIMAL_ARCHETYPE = `---
species: owl
cognitive_style: "breadth-first, multi-threaded, exploratory"
---

## Cognitive Style

Explore broadly before committing.

## Communication Contracts

Synthesize findings into summaries.

## Anti-Patterns

Never tunnel-vision on a single approach.
`;

// ── parseArchetype ───────────────────────────────────────────────────────────

describe("parseArchetype", () => {
  it("parses valid archetype with all frontmatter fields", () => {
    const result = parseArchetype(VALID_ARCHETYPE);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.species).toBe("ant");
    expect(result!.frontmatter.cognitive_style).toBe("depth-first, single-threaded, methodical");
    expect(result!.frontmatter.token_budget).toBe(100000);
    expect(result!.frontmatter.allowed_skills).toEqual(["github", "plane", "memory"]);
  });

  it("parses minimal archetype (species + cognitive_style only)", () => {
    const result = parseArchetype(MINIMAL_ARCHETYPE);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.species).toBe("owl");
    expect(result!.frontmatter.cognitive_style).toBe("breadth-first, multi-threaded, exploratory");
    expect(result!.frontmatter.token_budget).toBeUndefined();
    expect(result!.frontmatter.allowed_skills).toBeUndefined();
  });

  it("returns null for file without frontmatter", () => {
    const result = parseArchetype("# Just a heading\n\nSome content.");
    expect(result).toBeNull();
  });

  it("returns null for frontmatter without species", () => {
    const raw = `---
cognitive_style: "some style"
---

## Cognitive Style

Content here.
`;
    const result = parseArchetype(raw);
    expect(result).toBeNull();
  });

  it("returns null for empty species", () => {
    const raw = `---
species: ""
cognitive_style: "some style"
---

## Cognitive Style

Content here.
`;
    const result = parseArchetype(raw);
    expect(result).toBeNull();
  });

  it("handles missing cognitive_style gracefully (empty string)", () => {
    const raw = `---
species: bee
---

## Cognitive Style

Parallel task execution.

## Communication Contracts

Status updates per task.

## Anti-Patterns

Never block on a single task.

## Growth Metrics

- Throughput
`;
    const result = parseArchetype(raw);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.species).toBe("bee");
    expect(result!.frontmatter.cognitive_style).toBe("");
  });

  it("extracts body without frontmatter", () => {
    const result = parseArchetype(VALID_ARCHETYPE);
    expect(result).not.toBeNull();
    expect(result!.body).not.toContain("---");
    expect(result!.body).toContain("# Ant Archetype");
  });

  it("parses section_priorities from frontmatter", () => {
    const raw = `---
species: ant
cognitive_style: "methodical"
section_priorities:
  archetype: 1
  work-item: 2
---

## Cognitive Style

Content.

## Communication Contracts

Content.

## Anti-Patterns

Content.

## Growth Metrics

Content.
`;
    const result = parseArchetype(raw);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.section_priorities).toEqual({
      archetype: 1,
      "work-item": 2,
    });
  });
});

// ── parseSections ────────────────────────────────────────────────────────────

describe("parseSections", () => {
  it("extracts H2 sections from markdown", () => {
    const body = `# Title

Some intro text.

## Section One

Content for section one.

## Section Two

Content for section two.
More content.
`;
    const sections = parseSections(body);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe("Section One");
    expect(sections[0].content).toContain("Content for section one");
    expect(sections[1].heading).toBe("Section Two");
    expect(sections[1].content).toContain("More content");
  });

  it("handles empty body", () => {
    const sections = parseSections("");
    expect(sections).toEqual([]);
  });

  it("handles body with no H2 headings", () => {
    const sections = parseSections("# Only H1\n\nSome text.\n\n### H3 heading");
    expect(sections).toEqual([]);
  });

  it("handles section with no content", () => {
    const body = `## Empty Section

## Has Content

Some text here.
`;
    const sections = parseSections(body);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe("Empty Section");
    expect(sections[0].content).toBe("");
    expect(sections[1].heading).toBe("Has Content");
    expect(sections[1].content).toContain("Some text");
  });

  it("preserves section content formatting", () => {
    const body = `## Code Section

\`\`\`typescript
const x = 1;
\`\`\`

- List item 1
- List item 2
`;
    const sections = parseSections(body);
    expect(sections).toHaveLength(1);
    expect(sections[0].content).toContain("```typescript");
    expect(sections[0].content).toContain("const x = 1");
    expect(sections[0].content).toContain("- List item 1");
  });
});

// ── validateArchetype ────────────────────────────────────────────────────────

describe("validateArchetype", () => {
  it("valid archetype passes validation", () => {
    const schema = parseArchetype(VALID_ARCHETYPE)!;
    const result = validateArchetype(schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("minimal valid archetype passes", () => {
    const schema = parseArchetype(MINIMAL_ARCHETYPE)!;
    const result = validateArchetype(schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails when cognitive_style is empty", () => {
    const raw = `---
species: bee
---

## Cognitive Style

Content.

## Communication Contracts

Content.

## Anti-Patterns

Content.

## Growth Metrics

Content.
`;
    const schema = parseArchetype(raw)!;
    const result = validateArchetype(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "frontmatter.cognitive_style")).toBe(true);
  });

  it("fails when required section is missing", () => {
    const raw = `---
species: ant
cognitive_style: "methodical"
---

## Cognitive Style

Content.

## Anti-Patterns

Content.
`;
    // Missing "Communication"
    const schema = parseArchetype(raw)!;
    const result = validateArchetype(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes("Communication"))).toBe(true);
  });

  it("fails when required section is empty", () => {
    const raw = `---
species: ant
cognitive_style: "methodical"
---

## Cognitive Style

Content.

## Communication Contracts

## Anti-Patterns

Content.

## Growth Metrics

Content.
`;
    const schema = parseArchetype(raw)!;
    const result = validateArchetype(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e =>
      e.field.includes("Communication Contracts") && e.message.includes("empty"),
    )).toBe(true);
  });

  it("fails when multiple sections are missing", () => {
    const raw = `---
species: ant
cognitive_style: "methodical"
---

## Cognitive Style

Content.
`;
    const schema = parseArchetype(raw)!;
    const result = validateArchetype(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(2); // Missing Communication, Anti-Patterns
  });

  it("validates token_budget must be positive", () => {
    const schema: ArchetypeSchema = {
      frontmatter: {
        species: "ant",
        cognitive_style: "methodical",
        token_budget: -100,
      },
      sections: [
        { heading: "Cognitive Style", content: "Content" },
        { heading: "Communication Contracts", content: "Content" },
        { heading: "Anti-Patterns", content: "Content" },
      ],
      body: "",
    };
    const result = validateArchetype(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "frontmatter.token_budget")).toBe(true);
  });

  it("section matching is case-insensitive", () => {
    const raw = `---
species: ant
cognitive_style: "methodical"
---

## cognitive style

Content.

## COMMUNICATION CONTRACTS

Content.

## anti-patterns

Content.

## growth metrics

Content.
`;
    const schema = parseArchetype(raw)!;
    const result = validateArchetype(schema);
    expect(result.valid).toBe(true);
  });
});

// ── validateArchetypeFile ────────────────────────────────────────────────────

describe("validateArchetypeFile", () => {
  it("returns parsed schema and validation for valid file", () => {
    const result = validateArchetypeFile(VALID_ARCHETYPE);
    expect(result.schema).not.toBeNull();
    expect(result.validation.valid).toBe(true);
  });

  it("returns null schema and error for unparseable file", () => {
    const result = validateArchetypeFile("Just plain text, no frontmatter.");
    expect(result.schema).toBeNull();
    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors[0].field).toBe("file");
  });

  it("returns schema but invalid for file with missing sections", () => {
    const raw = `---
species: ant
cognitive_style: "methodical"
---

## Cognitive Style

Content.
`;
    const result = validateArchetypeFile(raw);
    expect(result.schema).not.toBeNull();
    expect(result.validation.valid).toBe(false);
  });
});

// ── getSection ───────────────────────────────────────────────────────────────

describe("getSection", () => {
  it("finds section by exact heading", () => {
    const schema = parseArchetype(VALID_ARCHETYPE)!;
    const section = getSection(schema, "Cognitive Style");
    expect(section).not.toBeNull();
    expect(section!.content).toContain("Stay on task");
  });

  it("finds section case-insensitively", () => {
    const schema = parseArchetype(VALID_ARCHETYPE)!;
    const section = getSection(schema, "cognitive style");
    expect(section).not.toBeNull();
  });

  it("returns null for non-existent section", () => {
    const schema = parseArchetype(VALID_ARCHETYPE)!;
    const section = getSection(schema, "Nonexistent Section");
    expect(section).toBeNull();
  });
});

// ── listSectionHeadings ──────────────────────────────────────────────────────

describe("listSectionHeadings", () => {
  it("lists all section headings", () => {
    const schema = parseArchetype(VALID_ARCHETYPE)!;
    const headings = listSectionHeadings(schema);
    expect(headings).toContain("Cognitive Style");
    expect(headings).toContain("Communication Contracts");
    expect(headings).toContain("Anti-Patterns");
    expect(headings).toContain("Growth Metrics"); // extra section, not required but present
  });
});

// ── hasAllRequiredSections / getMissingSections ───────────────────────────────

describe("hasAllRequiredSections", () => {
  it("returns true when all required sections present", () => {
    const schema = parseArchetype(VALID_ARCHETYPE)!;
    expect(hasAllRequiredSections(schema)).toBe(true);
  });

  it("returns false when sections missing", () => {
    const raw = `---
species: ant
cognitive_style: "methodical"
---

## Cognitive Style

Content.
`;
    const schema = parseArchetype(raw)!;
    expect(hasAllRequiredSections(schema)).toBe(false);
  });
});

describe("getMissingSections", () => {
  it("returns empty array when all present", () => {
    const schema = parseArchetype(VALID_ARCHETYPE)!;
    expect(getMissingSections(schema)).toEqual([]);
  });

  it("returns missing section names", () => {
    const raw = `---
species: ant
cognitive_style: "methodical"
---

## Cognitive Style

Content.

## Anti-Patterns

Content.
`;
    const schema = parseArchetype(raw)!;
    const missing = getMissingSections(schema);
    expect(missing).toContain("Communication");
    expect(missing).not.toContain("Cognitive Style");
    expect(missing).not.toContain("Anti-Patterns");
  });
});

// ── REQUIRED_SECTIONS constant ───────────────────────────────────────────────

describe("REQUIRED_SECTIONS", () => {
  it("has exactly 3 required sections", () => {
    expect(REQUIRED_SECTIONS).toHaveLength(3);
  });

  it("contains the specified sections", () => {
    expect(REQUIRED_SECTIONS).toContain("Cognitive Style");
    expect(REQUIRED_SECTIONS).toContain("Communication");
    expect(REQUIRED_SECTIONS).toContain("Anti-Patterns");
  });
});

// ── Ant archetype conformance ────────────────────────────────────────────────

describe("ant.md conformance", () => {
  it("ant.md parses and validates cleanly", () => {
    const antPath = join(__dirname, "../config/archetypes/ant.md");
    let raw: string;
    try {
      raw = readFileSync(antPath, "utf-8");
    } catch {
      console.log("ant.md not found, skipping conformance test");
      return;
    }

    // ELLIE-617: ant.md now has species + cognitive_style in frontmatter
    const schema = parseArchetype(raw);
    expect(schema).not.toBeNull();
    expect(schema!.frontmatter.species).toBe("ant");
    expect(schema!.frontmatter.cognitive_style).not.toBe("");
    const validation = validateArchetype(schema!);
    expect(validation.valid).toBe(true);
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles frontmatter with extra unknown fields", () => {
    const raw = `---
species: ant
cognitive_style: "methodical"
unknown_field: "should be ignored"
another: 42
---

## Cognitive Style

Content.

## Communication Contracts

Content.

## Anti-Patterns

Content.

## Growth Metrics

Content.
`;
    const result = parseArchetype(raw);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.species).toBe("ant");
    const validation = validateArchetype(result!);
    expect(validation.valid).toBe(true);
  });

  it("handles extra non-required sections", () => {
    const raw = `---
species: ant
cognitive_style: "methodical"
---

## Cognitive Style

Content.

## Communication Contracts

Content.

## Bonus Section

Extra content that's fine.

## Anti-Patterns

Content.

## Growth Metrics

Content.
`;
    const result = parseArchetype(raw);
    expect(result).not.toBeNull();
    expect(result!.sections).toHaveLength(5);
    const validation = validateArchetype(result!);
    expect(validation.valid).toBe(true);
  });

  it("handles section headings with special characters", () => {
    const raw = `---
species: ant
cognitive_style: "methodical"
---

## Cognitive Style

Content.

## Communication Contracts

Content.

## Anti-Patterns (What Ant Never Does)

Content about anti-patterns.

## Growth Metrics

Content.
`;
    const result = parseArchetype(raw);
    expect(result).not.toBeNull();
    // "Anti-Patterns (What Ant Never Does)" matches "Anti-Patterns" via prefix matching
    const headings = listSectionHeadings(result!);
    expect(headings).toContain("Anti-Patterns (What Ant Never Does)");
    // ELLIE-617: prefix matching means this validates as having all required sections
    const validation = validateArchetype(result!);
    expect(validation.valid).toBe(true);
  });

  it("handles windows-style line endings", () => {
    const raw = "---\r\nspecies: ant\r\ncognitive_style: \"methodical\"\r\n---\r\n\r\n## Cognitive Style\r\n\r\nContent.\r\n\r\n## Communication Contracts\r\n\r\nContent.\r\n\r\n## Anti-Patterns\r\n\r\nContent.\r\n\r\n## Growth Metrics\r\n\r\nContent.\r\n";
    const result = parseArchetype(raw);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.species).toBe("ant");
  });
});
