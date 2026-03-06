/**
 * Tests for Role Files — ELLIE-611
 *
 * Validates that all 8 role files in config/roles/ are correctly formatted,
 * parseable by the role schema (ELLIE-605), loadable by the role loader
 * (ELLIE-606), and compatible with agent identity bindings (ELLIE-607)
 * and growth metrics collector (ELLIE-609).
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

import {
  parseRole,
  validateRole,
  validateRoleFile,
  getSection,
  hasAllRequiredSections,
  getMissingSections,
  REQUIRED_ROLE_SECTIONS,
  KNOWN_ROLES,
  type RoleSchema,
} from "../src/role-schema";

import {
  loadRoles,
  listRoles,
  listRoleConfigs,
  getRole,
  hasRole,
  roleCount,
  _resetRoleLoaderForTesting,
} from "../src/role-loader";

import { DEFAULT_BINDINGS } from "../src/agent-identity-binding";

// ── Constants ────────────────────────────────────────────────────────────────

const ROLES_DIR = join(import.meta.dir, "..", "config", "roles");

/** All expected role files based on DEFAULT_BINDINGS. */
const EXPECTED_ROLES = DEFAULT_BINDINGS.map(b => b.role);

/** All role files on disk. */
let roleFiles: string[] = [];
let parsedRoles: Map<string, RoleSchema> = new Map();

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(() => {
  roleFiles = readdirSync(ROLES_DIR).filter(f => f.endsWith(".md"));

  for (const file of roleFiles) {
    const raw = readFileSync(join(ROLES_DIR, file), "utf-8");
    const schema = parseRole(raw);
    if (schema) {
      parsedRoles.set(schema.frontmatter.role, schema);
    }
  }
});

// ── File existence ───────────────────────────────────────────────────────────

describe("role file existence", () => {
  it("has a .md file for every role in DEFAULT_BINDINGS", () => {
    const roleNamesOnDisk = [...parsedRoles.keys()];
    for (const expected of EXPECTED_ROLES) {
      expect(roleNamesOnDisk).toContain(expected);
    }
  });

  it("has exactly 8 role files", () => {
    expect(roleFiles.length).toBe(8);
  });

  it("every file on disk is parseable", () => {
    for (const file of roleFiles) {
      const raw = readFileSync(join(ROLES_DIR, file), "utf-8");
      const schema = parseRole(raw);
      expect(schema).not.toBeNull();
    }
  });
});

// ── Schema validation per role ───────────────────────────────────────────────

describe("schema validation", () => {
  it("all roles pass validateRole", () => {
    for (const [role, schema] of parsedRoles) {
      const result = validateRole(schema);
      expect(result.valid).toBe(true);
      if (!result.valid) {
        console.error(`${role} validation errors:`, result.errors);
      }
    }
  });

  it("all roles pass validateRoleFile", () => {
    for (const file of roleFiles) {
      const raw = readFileSync(join(ROLES_DIR, file), "utf-8");
      const { schema, validation } = validateRoleFile(raw);
      expect(schema).not.toBeNull();
      expect(validation.valid).toBe(true);
    }
  });

  it("all roles have all required sections", () => {
    for (const [role, schema] of parsedRoles) {
      expect(hasAllRequiredSections(schema)).toBe(true);
      expect(getMissingSections(schema)).toEqual([]);
    }
  });

  it("all roles have a non-empty purpose", () => {
    for (const [role, schema] of parsedRoles) {
      expect(schema.frontmatter.purpose.length).toBeGreaterThan(0);
    }
  });

  it("all role names are in KNOWN_ROLES", () => {
    for (const [role] of parsedRoles) {
      expect((KNOWN_ROLES as readonly string[]).includes(role)).toBe(true);
    }
  });
});

// ── Required sections content ────────────────────────────────────────────────

describe("required section content", () => {
  for (const sectionName of REQUIRED_ROLE_SECTIONS) {
    it(`every role has non-empty "${sectionName}" section`, () => {
      for (const [role, schema] of parsedRoles) {
        const section = getSection(schema, sectionName);
        expect(section).not.toBeNull();
        expect(section!.content.trim().length).toBeGreaterThan(0);
      }
    });
  }

  it("Capabilities sections contain bullet points", () => {
    for (const [role, schema] of parsedRoles) {
      const section = getSection(schema, "Capabilities");
      expect(section!.content).toContain("- ");
    }
  });

  it("Anti-Patterns sections contain bullet points", () => {
    for (const [role, schema] of parsedRoles) {
      const section = getSection(schema, "Anti-Patterns");
      expect(section!.content).toContain("- Never");
    }
  });

  it("Tool Categories sections contain bullet points", () => {
    for (const [role, schema] of parsedRoles) {
      const section = getSection(schema, "Tool Categories");
      expect(section!.content).toContain("- **");
    }
  });
});

// ── Role loader integration ──────────────────────────────────────────────────

describe("role loader integration", () => {
  beforeAll(() => {
    _resetRoleLoaderForTesting();
    loadRoles(ROLES_DIR);
  });

  it("loads all 8 roles", () => {
    expect(roleCount()).toBe(8);
  });

  it("all roles accessible by name", () => {
    for (const expected of EXPECTED_ROLES) {
      expect(hasRole(expected)).toBe(true);
      const config = getRole(expected);
      expect(config).not.toBeNull();
      expect(config!.role).toBe(expected);
    }
  });

  it("all loaded roles have valid validation results", () => {
    for (const config of listRoleConfigs()) {
      expect(config.validation.valid).toBe(true);
    }
  });

  it("role names from loader match parsed roles", () => {
    const loaderRoles = listRoles().sort();
    const parsedRoleNames = [...parsedRoles.keys()].sort();
    expect(loaderRoles).toEqual(parsedRoleNames);
  });

  it("case-insensitive lookup works", () => {
    expect(getRole("Dev")).not.toBeNull();
    expect(getRole("GENERAL")).not.toBeNull();
    expect(getRole("Researcher")).not.toBeNull();
  });
});

// ── Agent identity binding compatibility ─────────────────────────────────────

describe("agent identity binding compatibility", () => {
  it("every DEFAULT_BINDING role has a loaded role file", () => {
    _resetRoleLoaderForTesting();
    loadRoles(ROLES_DIR);

    for (const binding of DEFAULT_BINDINGS) {
      expect(hasRole(binding.role)).toBe(true);
    }
  });

  it("binding role names match file frontmatter role names exactly", () => {
    for (const binding of DEFAULT_BINDINGS) {
      const config = getRole(binding.role);
      expect(config).not.toBeNull();
      expect(config!.role).toBe(binding.role);
    }
  });
});

// ── Individual role checks ───────────────────────────────────────────────────

describe("individual role: dev", () => {
  it("has correct frontmatter", () => {
    const schema = parsedRoles.get("dev")!;
    expect(schema.frontmatter.role).toBe("dev");
    expect(schema.frontmatter.purpose).toContain("code");
  });

  it("capabilities include implementation and testing", () => {
    const section = getSection(parsedRoles.get("dev")!, "Capabilities");
    expect(section!.content).toContain("feature");
    expect(section!.content).toContain("test");
  });
});

describe("individual role: general", () => {
  it("has correct frontmatter", () => {
    const schema = parsedRoles.get("general")!;
    expect(schema.frontmatter.role).toBe("general");
    expect(schema.frontmatter.purpose).toContain("coordinate");
  });

  it("capabilities include routing and conversation", () => {
    const section = getSection(parsedRoles.get("general")!, "Capabilities");
    expect(section!.content.toLowerCase()).toContain("route");
    expect(section!.content.toLowerCase()).toContain("conversation");
  });
});

describe("individual role: researcher", () => {
  it("has correct frontmatter", () => {
    const schema = parsedRoles.get("researcher")!;
    expect(schema.frontmatter.role).toBe("researcher");
    expect(schema.frontmatter.purpose).toContain("information");
  });

  it("capabilities include research and synthesis", () => {
    const section = getSection(parsedRoles.get("researcher")!, "Capabilities");
    expect(section!.content.toLowerCase()).toContain("research");
    expect(section!.content.toLowerCase()).toContain("synth");
  });
});

describe("individual role: strategy", () => {
  it("has correct frontmatter", () => {
    const schema = parsedRoles.get("strategy")!;
    expect(schema.frontmatter.role).toBe("strategy");
    expect(schema.frontmatter.purpose.toLowerCase()).toContain("plan");
  });

  it("capabilities include planning and prioritization", () => {
    const section = getSection(parsedRoles.get("strategy")!, "Capabilities");
    expect(section!.content.toLowerCase()).toContain("plan");
    expect(section!.content.toLowerCase()).toContain("prioriti");
  });

  it("anti-patterns include not implementing code", () => {
    const section = getSection(parsedRoles.get("strategy")!, "Anti-Patterns");
    expect(section!.content.toLowerCase()).toContain("implement");
  });
});

describe("individual role: content", () => {
  it("has correct frontmatter", () => {
    const schema = parsedRoles.get("content")!;
    expect(schema.frontmatter.role).toBe("content");
    expect(schema.frontmatter.purpose).toContain("content");
  });

  it("capabilities include writing and editing", () => {
    const section = getSection(parsedRoles.get("content")!, "Capabilities");
    expect(section!.content.toLowerCase()).toContain("writ");
    expect(section!.content.toLowerCase()).toContain("edit");
  });
});

describe("individual role: finance", () => {
  it("has correct frontmatter", () => {
    const schema = parsedRoles.get("finance")!;
    expect(schema.frontmatter.role).toBe("finance");
    expect(schema.frontmatter.purpose).toContain("financial");
  });

  it("capabilities include tracking and analysis", () => {
    const section = getSection(parsedRoles.get("finance")!, "Capabilities");
    expect(section!.content.toLowerCase()).toContain("track");
    expect(section!.content.toLowerCase()).toContain("analy");
  });
});

describe("individual role: critic", () => {
  it("has correct frontmatter", () => {
    const schema = parsedRoles.get("critic")!;
    expect(schema.frontmatter.role).toBe("critic");
    expect(schema.frontmatter.purpose.toLowerCase()).toContain("review");
  });

  it("capabilities include code review and pattern detection", () => {
    const section = getSection(parsedRoles.get("critic")!, "Capabilities");
    expect(section!.content.toLowerCase()).toContain("review");
    expect(section!.content.toLowerCase()).toContain("pattern");
  });

  it("communication contract includes severity levels", () => {
    const section = getSection(parsedRoles.get("critic")!, "Communication Contract");
    expect(section!.content.toLowerCase()).toContain("severity");
  });
});

describe("individual role: ops", () => {
  it("has correct frontmatter", () => {
    const schema = parsedRoles.get("ops")!;
    expect(schema.frontmatter.role).toBe("ops");
    expect(schema.frontmatter.purpose).toContain("infrastructure");
  });

  it("capabilities include monitoring and incident response", () => {
    const section = getSection(parsedRoles.get("ops")!, "Capabilities");
    expect(section!.content.toLowerCase()).toContain("monitor");
    expect(section!.content.toLowerCase()).toContain("incident");
  });

  it("communication contract includes severity levels", () => {
    const section = getSection(parsedRoles.get("ops")!, "Communication Contract");
    expect(section!.content.toLowerCase()).toContain("severity");
  });
});

// ── Cross-role consistency ───────────────────────────────────────────────────

describe("cross-role consistency", () => {
  it("no two roles share the same purpose string", () => {
    const purposes = [...parsedRoles.values()].map(s => s.frontmatter.purpose);
    const unique = new Set(purposes);
    expect(unique.size).toBe(purposes.length);
  });

  it("all roles reference Forest bridge in context or tools", () => {
    for (const [role, schema] of parsedRoles) {
      const context = getSection(schema, "Context Requirements")!.content.toLowerCase();
      const tools = getSection(schema, "Tool Categories")!.content.toLowerCase();
      const combined = context + tools;
      expect(combined).toContain("forest");
    }
  });

  it("no role file exceeds 80 lines", () => {
    for (const file of roleFiles) {
      const raw = readFileSync(join(ROLES_DIR, file), "utf-8");
      const lineCount = raw.split("\n").length;
      expect(lineCount).toBeLessThanOrEqual(80);
    }
  });

  it("every role has at least 4 capabilities", () => {
    for (const [role, schema] of parsedRoles) {
      const section = getSection(schema, "Capabilities")!;
      const bulletCount = (section.content.match(/^- /gm) || []).length;
      expect(bulletCount).toBeGreaterThanOrEqual(4);
    }
  });

  it("every role has at least 3 anti-patterns", () => {
    for (const [role, schema] of parsedRoles) {
      const section = getSection(schema, "Anti-Patterns")!;
      const bulletCount = (section.content.match(/^- Never/gm) || []).length;
      expect(bulletCount).toBeGreaterThanOrEqual(3);
    }
  });
});
