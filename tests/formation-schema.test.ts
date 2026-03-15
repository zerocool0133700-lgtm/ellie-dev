/**
 * Formation Schema Tests — ELLIE-673
 *
 * Tests for formation TypeScript types, parsing, validation,
 * SKILL.md template structure, and mock helpers.
 */

import { describe, test, expect } from "bun:test";
import {
  parseFormation,
  parseSections,
  validateFormation,
  validateFormationFile,
  getSection,
  listSectionHeadings,
  hasAllRequiredSections,
  getMissingSections,
  getAgentNames,
  _makeMockFormationFrontmatter,
  _makeMockFormationMarkdown,
  REQUIRED_FORMATION_SECTIONS,
  VALID_PATTERNS,
  VALID_CONFLICT_RESOLUTIONS,
  VALID_SESSION_STATES,
  VALID_MESSAGE_TYPES,
  type FormationSchema,
  type FormationFrontmatter,
  type AgentRole,
  type InteractionProtocol,
  type FormationSession,
  type FormationMessage,
  type FormationSessionState,
  type FormationMessageType,
} from "../src/types/formation.ts";
import { readFileSync } from "fs";
import { join } from "path";

// ── parseFormation ──────────────────────────────────────────────

describe("parseFormation", () => {
  test("parses valid formation markdown", () => {
    const md = _makeMockFormationMarkdown();
    const schema = parseFormation(md);
    expect(schema).not.toBeNull();
    expect(schema!.frontmatter.name).toBe("test-formation");
    expect(schema!.frontmatter.description).toBe("A test formation for unit tests");
    expect(schema!.frontmatter.agents).toHaveLength(2);
    expect(schema!.frontmatter.protocol.pattern).toBe("coordinator");
  });

  test("returns null for missing frontmatter", () => {
    const result = parseFormation("# Just a heading\nSome content");
    expect(result).toBeNull();
  });

  test("returns null for missing name field", () => {
    const md = `---
description: No name here
agents: []
protocol: {"pattern": "free-form", "maxTurns": 0, "requiresApproval": false}
---

## Objective

Test
`;
    expect(parseFormation(md)).toBeNull();
  });

  test("parses agent roles correctly", () => {
    const md = _makeMockFormationMarkdown({
      agents: [
        { agent: "dev", role: "lead", responsibility: "Build it", canInitiate: true },
        { agent: "research", role: "advisor", responsibility: "Find context", canInitiate: false },
        { agent: "critic", role: "reviewer", responsibility: "Review output" },
      ],
    });
    const schema = parseFormation(md);
    expect(schema!.frontmatter.agents).toHaveLength(3);
    expect(schema!.frontmatter.agents[0].agent).toBe("dev");
    expect(schema!.frontmatter.agents[0].canInitiate).toBe(true);
    expect(schema!.frontmatter.agents[1].canInitiate).toBe(false);
  });

  test("parses protocol fields", () => {
    const md = _makeMockFormationMarkdown({
      protocol: {
        pattern: "round-robin",
        maxTurns: 6,
        requiresApproval: true,
        turnOrder: ["dev", "critic"],
        conflictResolution: "majority-vote",
      },
    });
    const schema = parseFormation(md);
    const p = schema!.frontmatter.protocol;
    expect(p.pattern).toBe("round-robin");
    expect(p.maxTurns).toBe(6);
    expect(p.requiresApproval).toBe(true);
    expect(p.turnOrder).toEqual(["dev", "critic"]);
    expect(p.conflictResolution).toBe("majority-vote");
  });

  test("parses optional fields (triggers, minAgents, timeoutSeconds)", () => {
    const md = _makeMockFormationMarkdown({
      triggers: ["code review", "review this"],
      minAgents: 2,
      timeoutSeconds: 600,
    });
    const schema = parseFormation(md);
    expect(schema!.frontmatter.triggers).toEqual(["code review", "review this"]);
    expect(schema!.frontmatter.minAgents).toBe(2);
    expect(schema!.frontmatter.timeoutSeconds).toBe(600);
  });

  test("defaults to free-form pattern when protocol missing", () => {
    const md = `---
name: minimal
description: Minimal formation
agents: [{"agent": "dev", "role": "lead", "responsibility": "Do work"}]
---

## Objective

Minimal test

## Agent Roles

- dev (lead)

## Interaction Flow

Free-form
`;
    const schema = parseFormation(md);
    expect(schema!.frontmatter.protocol.pattern).toBe("free-form");
    expect(schema!.frontmatter.protocol.requiresApproval).toBe(false);
  });
});

// ── parseSections ───────────────────────────────────────────────

describe("parseSections", () => {
  test("extracts H2 sections", () => {
    const body = `## First

Content one

## Second

Content two
`;
    const sections = parseSections(body);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe("First");
    expect(sections[0].content).toBe("Content one");
    expect(sections[1].heading).toBe("Second");
    expect(sections[1].content).toBe("Content two");
  });

  test("returns empty array for no sections", () => {
    expect(parseSections("Just plain text")).toHaveLength(0);
  });

  test("ignores H1 and H3 headings", () => {
    const body = `# H1

## H2 Section

Content

### H3 Inside

More content
`;
    const sections = parseSections(body);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("H2 Section");
    expect(sections[0].content).toContain("### H3 Inside");
  });
});

// ── validateFormation ───────────────────────────────────────────

describe("validateFormation", () => {
  test("valid formation passes", () => {
    const md = _makeMockFormationMarkdown();
    const schema = parseFormation(md)!;
    const result = validateFormation(schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("empty name fails", () => {
    const md = _makeMockFormationMarkdown();
    const schema = parseFormation(md)!;
    schema.frontmatter.name = "";
    const result = validateFormation(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "frontmatter.name")).toBe(true);
  });

  test("empty description fails", () => {
    const md = _makeMockFormationMarkdown();
    const schema = parseFormation(md)!;
    schema.frontmatter.description = "";
    const result = validateFormation(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "frontmatter.description")).toBe(true);
  });

  test("no agents fails", () => {
    const md = _makeMockFormationMarkdown();
    const schema = parseFormation(md)!;
    schema.frontmatter.agents = [];
    const result = validateFormation(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "frontmatter.agents")).toBe(true);
  });

  test("agent with empty name fails", () => {
    const md = _makeMockFormationMarkdown();
    const schema = parseFormation(md)!;
    schema.frontmatter.agents[0].agent = "";
    const result = validateFormation(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field.includes("agents[0].agent"))).toBe(true);
  });

  test("agent with empty role fails", () => {
    const md = _makeMockFormationMarkdown();
    const schema = parseFormation(md)!;
    schema.frontmatter.agents[0].role = "";
    const result = validateFormation(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field.includes("agents[0].role"))).toBe(true);
  });

  test("agent with empty responsibility fails", () => {
    const md = _makeMockFormationMarkdown();
    const schema = parseFormation(md)!;
    schema.frontmatter.agents[0].responsibility = "";
    const result = validateFormation(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field.includes("agents[0].responsibility"))).toBe(true);
  });

  test("invalid pattern fails", () => {
    const md = _makeMockFormationMarkdown();
    const schema = parseFormation(md)!;
    (schema.frontmatter.protocol as any).pattern = "invalid-pattern";
    const result = validateFormation(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "frontmatter.protocol.pattern")).toBe(true);
  });

  test("coordinator pattern without coordinator fails", () => {
    const md = _makeMockFormationMarkdown();
    const schema = parseFormation(md)!;
    schema.frontmatter.protocol.pattern = "coordinator";
    schema.frontmatter.protocol.coordinator = undefined;
    const result = validateFormation(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "frontmatter.protocol.coordinator")).toBe(true);
  });

  test("coordinator not in agents list fails", () => {
    const md = _makeMockFormationMarkdown();
    const schema = parseFormation(md)!;
    schema.frontmatter.protocol.coordinator = "nonexistent-agent";
    const result = validateFormation(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes("nonexistent-agent"))).toBe(true);
  });

  test("turnOrder with unknown agent fails", () => {
    const md = _makeMockFormationMarkdown();
    const schema = parseFormation(md)!;
    schema.frontmatter.protocol.turnOrder = ["dev", "unknown"];
    const result = validateFormation(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes("unknown"))).toBe(true);
  });

  test("invalid conflictResolution fails", () => {
    const md = _makeMockFormationMarkdown();
    const schema = parseFormation(md)!;
    (schema.frontmatter.protocol as any).conflictResolution = "rock-paper-scissors";
    const result = validateFormation(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "frontmatter.protocol.conflictResolution")).toBe(true);
  });

  test("minAgents < 1 fails", () => {
    const md = _makeMockFormationMarkdown();
    const schema = parseFormation(md)!;
    schema.frontmatter.minAgents = 0;
    const result = validateFormation(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "frontmatter.minAgents")).toBe(true);
  });

  test("timeoutSeconds <= 0 fails", () => {
    const md = _makeMockFormationMarkdown();
    const schema = parseFormation(md)!;
    schema.frontmatter.timeoutSeconds = -1;
    const result = validateFormation(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "frontmatter.timeoutSeconds")).toBe(true);
  });

  test("missing required section fails", () => {
    const md = `---
name: missing-sections
description: Missing required sections
agents: [{"agent": "dev", "role": "lead", "responsibility": "Work"}]
protocol: {"pattern": "free-form", "maxTurns": 0, "requiresApproval": false}
---

## Objective

Has objective only
`;
    const schema = parseFormation(md)!;
    const result = validateFormation(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes("Agent Roles"))).toBe(true);
    expect(result.errors.some(e => e.message.includes("Interaction Flow"))).toBe(true);
  });

  test("empty required section fails", () => {
    const md = `---
name: empty-sections
description: Empty required sections
agents: [{"agent": "dev", "role": "lead", "responsibility": "Work"}]
protocol: {"pattern": "free-form", "maxTurns": 0, "requiresApproval": false}
---

## Objective



## Agent Roles

Agents listed here

## Interaction Flow

Flow described here
`;
    const schema = parseFormation(md)!;
    const result = validateFormation(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes("Objective") && e.message.includes("empty"))).toBe(true);
  });

  test("valid conflictResolution values pass", () => {
    for (const cr of VALID_CONFLICT_RESOLUTIONS) {
      const md = _makeMockFormationMarkdown();
      const schema = parseFormation(md)!;
      schema.frontmatter.protocol.conflictResolution = cr;
      const result = validateFormation(schema);
      // Should not have conflictResolution errors
      expect(result.errors.filter(e => e.field === "frontmatter.protocol.conflictResolution")).toHaveLength(0);
    }
  });
});

// ── validateFormationFile ───────────────────────────────────────

describe("validateFormationFile", () => {
  test("valid file passes", () => {
    const md = _makeMockFormationMarkdown();
    const { schema, validation } = validateFormationFile(md);
    expect(schema).not.toBeNull();
    expect(validation.valid).toBe(true);
  });

  test("unparseable file returns null schema with error", () => {
    const { schema, validation } = validateFormationFile("not valid frontmatter");
    expect(schema).toBeNull();
    expect(validation.valid).toBe(false);
    expect(validation.errors[0].field).toBe("file");
  });
});

// ── Query Functions ─────────────────────────────────────────────

describe("query functions", () => {
  const md = _makeMockFormationMarkdown();
  const schema = parseFormation(md)!;

  test("getSection returns matching section", () => {
    const section = getSection(schema, "Objective");
    expect(section).not.toBeNull();
    expect(section!.content).toContain("Coordinate agents");
  });

  test("getSection is case-insensitive", () => {
    const section = getSection(schema, "objective");
    expect(section).not.toBeNull();
  });

  test("getSection returns null for missing section", () => {
    expect(getSection(schema, "Nonexistent")).toBeNull();
  });

  test("listSectionHeadings returns all headings", () => {
    const headings = listSectionHeadings(schema);
    expect(headings).toContain("Objective");
    expect(headings).toContain("Agent Roles");
    expect(headings).toContain("Interaction Flow");
  });

  test("hasAllRequiredSections returns true for valid formation", () => {
    expect(hasAllRequiredSections(schema)).toBe(true);
  });

  test("getMissingSections returns empty for valid formation", () => {
    expect(getMissingSections(schema)).toHaveLength(0);
  });

  test("getMissingSections identifies missing sections", () => {
    const partial: FormationSchema = {
      frontmatter: schema.frontmatter,
      sections: [{ heading: "Objective", content: "Just this" }],
      body: "## Objective\nJust this",
    };
    const missing = getMissingSections(partial);
    expect(missing).toContain("Agent Roles");
    expect(missing).toContain("Interaction Flow");
  });

  test("getAgentNames returns all agent names", () => {
    const names = getAgentNames(schema);
    expect(names).toContain("dev");
    expect(names).toContain("critic");
  });
});

// ── Constants ───────────────────────────────────────────────────

describe("constants", () => {
  test("REQUIRED_FORMATION_SECTIONS has expected entries", () => {
    expect(REQUIRED_FORMATION_SECTIONS).toContain("Objective");
    expect(REQUIRED_FORMATION_SECTIONS).toContain("Agent Roles");
    expect(REQUIRED_FORMATION_SECTIONS).toContain("Interaction Flow");
  });

  test("VALID_PATTERNS has expected entries", () => {
    expect(VALID_PATTERNS).toContain("round-robin");
    expect(VALID_PATTERNS).toContain("coordinator");
    expect(VALID_PATTERNS).toContain("debate");
    expect(VALID_PATTERNS).toContain("pipeline");
    expect(VALID_PATTERNS).toContain("free-form");
  });

  test("VALID_SESSION_STATES has expected entries", () => {
    expect(VALID_SESSION_STATES).toContain("active");
    expect(VALID_SESSION_STATES).toContain("paused");
    expect(VALID_SESSION_STATES).toContain("completed");
    expect(VALID_SESSION_STATES).toContain("failed");
    expect(VALID_SESSION_STATES).toContain("timed_out");
  });

  test("VALID_MESSAGE_TYPES has expected entries", () => {
    expect(VALID_MESSAGE_TYPES).toContain("proposal");
    expect(VALID_MESSAGE_TYPES).toContain("response");
    expect(VALID_MESSAGE_TYPES).toContain("decision");
    expect(VALID_MESSAGE_TYPES).toContain("escalation");
    expect(VALID_MESSAGE_TYPES).toContain("system");
  });
});

// ── Mock Helpers ────────────────────────────────────────────────

describe("mock helpers", () => {
  test("_makeMockFormationFrontmatter returns valid defaults", () => {
    const fm = _makeMockFormationFrontmatter();
    expect(fm.name).toBe("test-formation");
    expect(fm.agents).toHaveLength(2);
    expect(fm.protocol.pattern).toBe("coordinator");
    expect(fm.protocol.coordinator).toBe("dev");
  });

  test("_makeMockFormationFrontmatter accepts overrides", () => {
    const fm = _makeMockFormationFrontmatter({
      name: "custom",
      timeoutSeconds: 120,
    });
    expect(fm.name).toBe("custom");
    expect(fm.timeoutSeconds).toBe(120);
    // Non-overridden fields remain
    expect(fm.agents).toHaveLength(2);
  });

  test("_makeMockFormationMarkdown produces parseable markdown", () => {
    const md = _makeMockFormationMarkdown();
    const schema = parseFormation(md);
    expect(schema).not.toBeNull();
    expect(schema!.sections.length).toBeGreaterThanOrEqual(3);
  });

  test("_makeMockFormationMarkdown applies overrides", () => {
    const md = _makeMockFormationMarkdown({ name: "override-test" });
    const schema = parseFormation(md);
    expect(schema!.frontmatter.name).toBe("override-test");
  });
});

// ── SKILL.md Template ───────────────────────────────────────────

describe("formation SKILL.md template", () => {
  test("template file exists and is parseable", () => {
    const templatePath = join(import.meta.dir, "../skills/formations/_template/SKILL.md");
    const raw = readFileSync(templatePath, "utf-8");
    expect(raw.length).toBeGreaterThan(0);

    const schema = parseFormation(raw);
    expect(schema).not.toBeNull();
    expect(schema!.frontmatter.name).toBe("formation-name");
  });

  test("template has all required sections", () => {
    const templatePath = join(import.meta.dir, "../skills/formations/_template/SKILL.md");
    const raw = readFileSync(templatePath, "utf-8");
    const schema = parseFormation(raw)!;
    expect(hasAllRequiredSections(schema)).toBe(true);
  });

  test("template has agents defined", () => {
    const templatePath = join(import.meta.dir, "../skills/formations/_template/SKILL.md");
    const raw = readFileSync(templatePath, "utf-8");
    const schema = parseFormation(raw)!;
    expect(schema.frontmatter.agents.length).toBeGreaterThan(0);
  });

  test("template has protocol defined", () => {
    const templatePath = join(import.meta.dir, "../skills/formations/_template/SKILL.md");
    const raw = readFileSync(templatePath, "utf-8");
    const schema = parseFormation(raw)!;
    expect(schema.frontmatter.protocol.pattern).toBe("coordinator");
    expect(schema.frontmatter.protocol.coordinator).toBe("dev");
  });
});

// ── Type Shapes (compile-time + runtime) ────────────────────────

describe("type shapes", () => {
  test("FormationSession has all expected fields", () => {
    const session: FormationSession = {
      id: "test-id",
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: null,
      formation_name: "test",
      state: "active",
      turn_count: 0,
      initiator_agent: "dev",
      channel: "internal",
      work_item_id: null,
      protocol: { pattern: "free-form", maxTurns: 0, requiresApproval: false },
      participating_agents: ["dev", "critic"],
      metadata: {},
      checked_out_by: null,
      checked_out_at: null,
      status: "pending",
    };
    expect(session.id).toBe("test-id");
    expect(session.state).toBe("active");
    expect(session.participating_agents).toHaveLength(2);
    expect(session.checked_out_by).toBeNull();
    expect(session.status).toBe("pending");
  });

  test("FormationMessage has all expected fields", () => {
    const msg: FormationMessage = {
      id: "msg-id",
      created_at: new Date(),
      session_id: "session-id",
      from_agent: "dev",
      to_agent: "critic",
      content: "Here is my proposal",
      turn_number: 1,
      message_type: "proposal",
      metadata: {},
    };
    expect(msg.from_agent).toBe("dev");
    expect(msg.message_type).toBe("proposal");
  });

  test("all session states are valid", () => {
    const states: FormationSessionState[] = ["active", "paused", "completed", "failed", "timed_out"];
    for (const state of states) {
      expect(VALID_SESSION_STATES).toContain(state);
    }
  });

  test("all message types are valid", () => {
    const types: FormationMessageType[] = ["proposal", "response", "decision", "escalation", "system"];
    for (const t of types) {
      expect(VALID_MESSAGE_TYPES).toContain(t);
    }
  });
});

// ── Migration SQL ───────────────────────────────────────────────

describe("migration SQL", () => {
  test("migration file exists", () => {
    const migrationPath = join(import.meta.dir, "../migrations/supabase/20260312_formation_tables.sql");
    const sql = readFileSync(migrationPath, "utf-8");
    expect(sql.length).toBeGreaterThan(0);
  });

  test("migration creates formation_sessions table", () => {
    const migrationPath = join(import.meta.dir, "../migrations/supabase/20260312_formation_tables.sql");
    const sql = readFileSync(migrationPath, "utf-8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS formation_sessions");
  });

  test("migration creates formation_messages table", () => {
    const migrationPath = join(import.meta.dir, "../migrations/supabase/20260312_formation_tables.sql");
    const sql = readFileSync(migrationPath, "utf-8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS formation_messages");
  });

  test("migration has indexes on session_id, from_agent, created_at", () => {
    const migrationPath = join(import.meta.dir, "../migrations/supabase/20260312_formation_tables.sql");
    const sql = readFileSync(migrationPath, "utf-8");
    expect(sql).toContain("idx_formation_messages_session_id");
    expect(sql).toContain("idx_formation_messages_from_agent");
    expect(sql).toContain("idx_formation_messages_created_at");
  });

  test("migration has RLS enabled", () => {
    const migrationPath = join(import.meta.dir, "../migrations/supabase/20260312_formation_tables.sql");
    const sql = readFileSync(migrationPath, "utf-8");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
  });

  test("migration has foreign key from messages to sessions", () => {
    const migrationPath = join(import.meta.dir, "../migrations/supabase/20260312_formation_tables.sql");
    const sql = readFileSync(migrationPath, "utf-8");
    expect(sql).toContain("REFERENCES formation_sessions(id)");
  });

  test("migration has state CHECK constraint on sessions", () => {
    const migrationPath = join(import.meta.dir, "../migrations/supabase/20260312_formation_tables.sql");
    const sql = readFileSync(migrationPath, "utf-8");
    expect(sql).toContain("'active', 'paused', 'completed', 'failed', 'timed_out'");
  });

  test("migration has message_type CHECK constraint", () => {
    const migrationPath = join(import.meta.dir, "../migrations/supabase/20260312_formation_tables.sql");
    const sql = readFileSync(migrationPath, "utf-8");
    expect(sql).toContain("'proposal', 'response', 'decision', 'escalation', 'system'");
  });
});

// ── E2E: Parse → Validate → Query ──────────────────────────────

describe("E2E: parse → validate → query", () => {
  test("full lifecycle with coordinator formation", () => {
    const md = _makeMockFormationMarkdown({
      name: "code-review-formation",
      description: "Multi-agent code review",
      agents: [
        { agent: "dev", role: "author", responsibility: "Present code for review" },
        { agent: "critic", role: "reviewer", responsibility: "Review and identify issues" },
        { agent: "strategy", role: "arbiter", responsibility: "Resolve disagreements" },
      ],
      protocol: {
        pattern: "coordinator",
        maxTurns: 8,
        coordinator: "strategy",
        requiresApproval: true,
        conflictResolution: "coordinator-decides",
      },
      triggers: ["review", "code review"],
      minAgents: 2,
      timeoutSeconds: 300,
    });

    // Parse
    const schema = parseFormation(md);
    expect(schema).not.toBeNull();

    // Validate
    const result = validateFormation(schema!);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);

    // Query
    expect(getAgentNames(schema!)).toEqual(["dev", "critic", "strategy"]);
    expect(hasAllRequiredSections(schema!)).toBe(true);
    expect(getSection(schema!, "Objective")).not.toBeNull();

    // Frontmatter details
    expect(schema!.frontmatter.triggers).toContain("review");
    expect(schema!.frontmatter.minAgents).toBe(2);
    expect(schema!.frontmatter.timeoutSeconds).toBe(300);
    expect(schema!.frontmatter.protocol.coordinator).toBe("strategy");
    expect(schema!.frontmatter.protocol.requiresApproval).toBe(true);
  });

  test("full lifecycle with pipeline formation", () => {
    const md = _makeMockFormationMarkdown({
      name: "content-pipeline",
      description: "Sequential content creation pipeline",
      agents: [
        { agent: "research", role: "gatherer", responsibility: "Gather source material" },
        { agent: "content", role: "writer", responsibility: "Draft content" },
        { agent: "critic", role: "editor", responsibility: "Edit and polish" },
      ],
      protocol: {
        pattern: "pipeline",
        maxTurns: 6,
        turnOrder: ["research", "content", "critic"],
        requiresApproval: false,
      },
    });

    const schema = parseFormation(md)!;
    const result = validateFormation(schema);
    expect(result.valid).toBe(true);
    expect(schema.frontmatter.protocol.pattern).toBe("pipeline");
    expect(schema.frontmatter.protocol.turnOrder).toEqual(["research", "content", "critic"]);
  });
});
