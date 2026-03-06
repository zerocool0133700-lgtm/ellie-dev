/**
 * Tests for Role Schema — ELLIE-605
 *
 * Covers: parsing, validation, section extraction, queries,
 * and conformance of the dev.md role file.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  parseRole,
  parseSections,
  validateRole,
  validateRoleFile,
  getSection,
  listSectionHeadings,
  hasAllRequiredSections,
  getMissingSections,
  REQUIRED_ROLE_SECTIONS,
  KNOWN_ROLES,
  type RoleSchema,
} from "../src/role-schema";

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_DEV_ROLE = `---
role: dev
purpose: "Build, fix, and maintain code"
---

# Dev Role

## Capabilities

- Implement features
- Fix bugs
- Write tests

## Context Requirements

- Work item from Plane
- Codebase access

## Tool Categories

- File operations
- Execution
- Version control

## Communication Contract

Show code diffs, not prose.

## Anti-Patterns

Never refactor outside ticket scope.
`;

const MINIMAL_ROLE = `---
role: researcher
purpose: "Investigate topics and produce findings"
---

## Capabilities

Research and analysis.

## Context Requirements

Topic and scope.

## Tool Categories

Web search, document reading.

## Communication Contract

Structured summaries.

## Anti-Patterns

Never present speculation as fact.
`;

// ── parseRole ────────────────────────────────────────────────────────────────

describe("parseRole", () => {
  it("parses valid role with all frontmatter fields", () => {
    const result = parseRole(VALID_DEV_ROLE);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.role).toBe("dev");
    expect(result!.frontmatter.purpose).toBe("Build, fix, and maintain code");
  });

  it("parses minimal role", () => {
    const result = parseRole(MINIMAL_ROLE);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.role).toBe("researcher");
    expect(result!.frontmatter.purpose).toBe("Investigate topics and produce findings");
  });

  it("returns null for file without frontmatter", () => {
    expect(parseRole("# Just a heading\n\nContent.")).toBeNull();
  });

  it("returns null for frontmatter without role", () => {
    const raw = `---
purpose: "some purpose"
---

## Capabilities

Content.
`;
    expect(parseRole(raw)).toBeNull();
  });

  it("returns null for empty role", () => {
    const raw = `---
role: ""
purpose: "some purpose"
---

## Capabilities

Content.
`;
    expect(parseRole(raw)).toBeNull();
  });

  it("handles missing purpose gracefully (empty string)", () => {
    const raw = `---
role: grader
---

## Capabilities

Grade work.

## Context Requirements

Submission to grade.

## Tool Categories

Analysis tools.

## Communication Contract

Grading rubric.

## Anti-Patterns

Never grade without criteria.
`;
    const result = parseRole(raw);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.role).toBe("grader");
    expect(result!.frontmatter.purpose).toBe("");
  });

  it("extracts body without frontmatter", () => {
    const result = parseRole(VALID_DEV_ROLE);
    expect(result).not.toBeNull();
    expect(result!.body).not.toContain("---");
    expect(result!.body).toContain("# Dev Role");
  });
});

// ── parseSections ────────────────────────────────────────────────────────────

describe("parseSections", () => {
  it("extracts H2 sections from markdown", () => {
    const body = `# Title

## Section One

Content one.

## Section Two

Content two.
`;
    const sections = parseSections(body);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe("Section One");
    expect(sections[1].heading).toBe("Section Two");
  });

  it("handles empty body", () => {
    expect(parseSections("")).toEqual([]);
  });

  it("handles body with no H2 headings", () => {
    expect(parseSections("# Only H1\n\nSome text.")).toEqual([]);
  });

  it("handles section with no content", () => {
    const body = `## Empty

## Has Content

Text.
`;
    const sections = parseSections(body);
    expect(sections).toHaveLength(2);
    expect(sections[0].content).toBe("");
    expect(sections[1].content).toContain("Text");
  });
});

// ── validateRole ─────────────────────────────────────────────────────────────

describe("validateRole", () => {
  it("valid role passes validation", () => {
    const schema = parseRole(VALID_DEV_ROLE)!;
    const result = validateRole(schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("minimal valid role passes", () => {
    const schema = parseRole(MINIMAL_ROLE)!;
    const result = validateRole(schema);
    expect(result.valid).toBe(true);
  });

  it("fails when purpose is empty", () => {
    const raw = `---
role: grader
---

## Capabilities

Content.

## Context Requirements

Content.

## Tool Categories

Content.

## Communication Contract

Content.

## Anti-Patterns

Content.
`;
    const schema = parseRole(raw)!;
    const result = validateRole(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "frontmatter.purpose")).toBe(true);
  });

  it("fails when required section is missing", () => {
    const raw = `---
role: dev
purpose: "Build code"
---

## Capabilities

Content.

## Context Requirements

Content.

## Tool Categories

Content.

## Communication Contract

Content.
`;
    // Missing Anti-Patterns
    const schema = parseRole(raw)!;
    const result = validateRole(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes("Anti-Patterns"))).toBe(true);
  });

  it("fails when required section is empty", () => {
    const raw = `---
role: dev
purpose: "Build code"
---

## Capabilities

## Context Requirements

Content.

## Tool Categories

Content.

## Communication Contract

Content.

## Anti-Patterns

Content.
`;
    const schema = parseRole(raw)!;
    const result = validateRole(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e =>
      e.field.includes("Capabilities") && e.message.includes("empty"),
    )).toBe(true);
  });

  it("fails when multiple sections are missing", () => {
    const raw = `---
role: dev
purpose: "Build code"
---

## Capabilities

Content.
`;
    const schema = parseRole(raw)!;
    const result = validateRole(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(4); // Missing 4 of 5 required
  });

  it("section matching is case-insensitive", () => {
    const raw = `---
role: dev
purpose: "Build code"
---

## capabilities

Content.

## CONTEXT REQUIREMENTS

Content.

## tool categories

Content.

## communication contract

Content.

## anti-patterns

Content.
`;
    const schema = parseRole(raw)!;
    const result = validateRole(schema);
    expect(result.valid).toBe(true);
  });
});

// ── validateRoleFile ─────────────────────────────────────────────────────────

describe("validateRoleFile", () => {
  it("returns parsed schema and validation for valid file", () => {
    const result = validateRoleFile(VALID_DEV_ROLE);
    expect(result.schema).not.toBeNull();
    expect(result.validation.valid).toBe(true);
  });

  it("returns null schema for unparseable file", () => {
    const result = validateRoleFile("Just plain text.");
    expect(result.schema).toBeNull();
    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors[0].field).toBe("file");
  });

  it("returns schema but invalid for file with missing sections", () => {
    const raw = `---
role: dev
purpose: "Build code"
---

## Capabilities

Content.
`;
    const result = validateRoleFile(raw);
    expect(result.schema).not.toBeNull();
    expect(result.validation.valid).toBe(false);
  });
});

// ── getSection ───────────────────────────────────────────────────────────────

describe("getSection", () => {
  it("finds section by exact heading", () => {
    const schema = parseRole(VALID_DEV_ROLE)!;
    const section = getSection(schema, "Capabilities");
    expect(section).not.toBeNull();
    expect(section!.content).toContain("Implement features");
  });

  it("finds section case-insensitively", () => {
    const schema = parseRole(VALID_DEV_ROLE)!;
    expect(getSection(schema, "capabilities")).not.toBeNull();
    expect(getSection(schema, "CAPABILITIES")).not.toBeNull();
  });

  it("returns null for non-existent section", () => {
    const schema = parseRole(VALID_DEV_ROLE)!;
    expect(getSection(schema, "Nonexistent")).toBeNull();
  });
});

// ── listSectionHeadings ──────────────────────────────────────────────────────

describe("listSectionHeadings", () => {
  it("lists all section headings", () => {
    const schema = parseRole(VALID_DEV_ROLE)!;
    const headings = listSectionHeadings(schema);
    expect(headings).toContain("Capabilities");
    expect(headings).toContain("Context Requirements");
    expect(headings).toContain("Tool Categories");
    expect(headings).toContain("Communication Contract");
    expect(headings).toContain("Anti-Patterns");
  });
});

// ── hasAllRequiredSections / getMissingSections ───────────────────────────────

describe("hasAllRequiredSections", () => {
  it("returns true when all present", () => {
    const schema = parseRole(VALID_DEV_ROLE)!;
    expect(hasAllRequiredSections(schema)).toBe(true);
  });

  it("returns false when missing", () => {
    const raw = `---
role: dev
purpose: "Build code"
---

## Capabilities

Content.
`;
    const schema = parseRole(raw)!;
    expect(hasAllRequiredSections(schema)).toBe(false);
  });
});

describe("getMissingSections", () => {
  it("returns empty when all present", () => {
    const schema = parseRole(VALID_DEV_ROLE)!;
    expect(getMissingSections(schema)).toEqual([]);
  });

  it("returns missing section names", () => {
    const raw = `---
role: dev
purpose: "Build code"
---

## Capabilities

Content.

## Anti-Patterns

Content.
`;
    const schema = parseRole(raw)!;
    const missing = getMissingSections(schema);
    expect(missing).toContain("Context Requirements");
    expect(missing).toContain("Tool Categories");
    expect(missing).toContain("Communication Contract");
    expect(missing).not.toContain("Capabilities");
    expect(missing).not.toContain("Anti-Patterns");
  });
});

// ── REQUIRED_ROLE_SECTIONS constant ──────────────────────────────────────────

describe("REQUIRED_ROLE_SECTIONS", () => {
  it("has exactly 5 required sections", () => {
    expect(REQUIRED_ROLE_SECTIONS).toHaveLength(5);
  });

  it("contains the specified sections", () => {
    expect(REQUIRED_ROLE_SECTIONS).toContain("Capabilities");
    expect(REQUIRED_ROLE_SECTIONS).toContain("Context Requirements");
    expect(REQUIRED_ROLE_SECTIONS).toContain("Tool Categories");
    expect(REQUIRED_ROLE_SECTIONS).toContain("Communication Contract");
    expect(REQUIRED_ROLE_SECTIONS).toContain("Anti-Patterns");
  });
});

// ── KNOWN_ROLES constant ────────────────────────────────────────────────────

describe("KNOWN_ROLES", () => {
  it("includes dev", () => {
    expect(KNOWN_ROLES).toContain("dev");
  });

  it("includes researcher", () => {
    expect(KNOWN_ROLES).toContain("researcher");
  });
});

// ── dev.md conformance ───────────────────────────────────────────────────────

describe("dev.md conformance", () => {
  it("dev.md parses as a valid role", () => {
    const devPath = join(__dirname, "../config/roles/dev.md");
    let raw: string;
    try {
      raw = readFileSync(devPath, "utf-8");
    } catch {
      console.log("dev.md not found, skipping conformance test");
      return;
    }

    const schema = parseRole(raw);
    expect(schema).not.toBeNull();
    expect(schema!.frontmatter.role).toBe("dev");
    expect(schema!.frontmatter.purpose).toBeTruthy();
  });

  it("dev.md passes full validation", () => {
    const devPath = join(__dirname, "../config/roles/dev.md");
    let raw: string;
    try {
      raw = readFileSync(devPath, "utf-8");
    } catch {
      return;
    }

    const { schema, validation } = validateRoleFile(raw);
    expect(schema).not.toBeNull();
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it("dev.md has all required sections", () => {
    const devPath = join(__dirname, "../config/roles/dev.md");
    let raw: string;
    try {
      raw = readFileSync(devPath, "utf-8");
    } catch {
      return;
    }

    const schema = parseRole(raw)!;
    expect(hasAllRequiredSections(schema)).toBe(true);
    expect(getMissingSections(schema)).toEqual([]);
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles extra unknown frontmatter fields", () => {
    const raw = `---
role: dev
purpose: "Build code"
extra_field: "ignored"
---

## Capabilities

Content.

## Context Requirements

Content.

## Tool Categories

Content.

## Communication Contract

Content.

## Anti-Patterns

Content.
`;
    const result = parseRole(raw);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.role).toBe("dev");
    expect(validateRole(result!).valid).toBe(true);
  });

  it("handles extra non-required sections", () => {
    const raw = `---
role: dev
purpose: "Build code"
---

## Capabilities

Content.

## Bonus Section

Extra stuff.

## Context Requirements

Content.

## Tool Categories

Content.

## Communication Contract

Content.

## Anti-Patterns

Content.
`;
    const result = parseRole(raw);
    expect(result).not.toBeNull();
    expect(result!.sections).toHaveLength(6);
    expect(validateRole(result!).valid).toBe(true);
  });

  it("handles windows-style line endings", () => {
    const raw = "---\r\nrole: dev\r\npurpose: \"Build code\"\r\n---\r\n\r\n## Capabilities\r\n\r\nContent.\r\n\r\n## Context Requirements\r\n\r\nContent.\r\n\r\n## Tool Categories\r\n\r\nContent.\r\n\r\n## Communication Contract\r\n\r\nContent.\r\n\r\n## Anti-Patterns\r\n\r\nContent.\r\n";
    const result = parseRole(raw);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.role).toBe("dev");
  });
});
