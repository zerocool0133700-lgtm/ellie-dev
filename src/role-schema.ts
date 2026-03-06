/**
 * Role Schema — ELLIE-605
 *
 * Defines the markdown + YAML frontmatter schema for agent role files.
 * Role files encode an agent's functional capabilities — what it can do,
 * what tools it uses, and how it communicates results.
 *
 * Key distinction:
 *   Archetypes (ELLIE-603) = HOW an agent behaves (behavioral DNA)
 *   Roles (this module)    = WHAT an agent does (functional capabilities)
 *
 * An ant-dev and an ant-grader share the ant archetype but have different roles.
 *
 * File location: config/roles/{role}.md
 *
 * Frontmatter (YAML):
 *   role    — role name (e.g. dev, researcher, grader)
 *   purpose — one-line summary of the role's function
 *
 * Required markdown sections (H2 headings):
 *   ## Capabilities           — list of things this role can do
 *   ## Context Requirements   — what context the role needs to function
 *   ## Tool Categories        — categories of tools the role uses
 *   ## Communication Contract — how the role reports results
 *   ## Anti-Patterns          — things this role never does
 *
 * Pure module — parsing and validation only, no side effects.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** Frontmatter fields for a role file. */
export interface RoleFrontmatter {
  role: string;
  purpose: string;
}

/** A parsed markdown section (H2 heading + content). */
export interface RoleSection {
  heading: string;
  content: string;
}

/** Complete parsed role — frontmatter + sections + raw body. */
export interface RoleSchema {
  frontmatter: RoleFrontmatter;
  sections: RoleSection[];
  body: string;
}

/** Validation error with field path and message. */
export interface RoleValidationError {
  field: string;
  message: string;
}

/** Result of validating a role file. */
export interface RoleValidationResult {
  valid: boolean;
  errors: RoleValidationError[];
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Required H2 sections in every role file. */
export const REQUIRED_ROLE_SECTIONS = [
  "Capabilities",
  "Context Requirements",
  "Tool Categories",
  "Communication Contract",
  "Anti-Patterns",
] as const;

/** Known role names. Extensible — new roles can be added. */
export const KNOWN_ROLES = [
  "dev",
  "researcher",
  "grader",
  "strategy",
  "critic",
  "content",
  "finance",
  "ops",
  "general",
] as const;

// ── Parsing ──────────────────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/**
 * Parse a role markdown file into its schema components.
 * Returns null if the file has no valid frontmatter with role field.
 */
export function parseRole(raw: string): RoleSchema | null {
  const fmMatch = raw.match(FRONTMATTER_RE);
  if (!fmMatch) return null;

  const yamlBlock = fmMatch[1];
  const body = fmMatch[2].trim();

  const fm = parseSimpleYaml(yamlBlock);

  if (typeof fm.role !== "string" || !fm.role.trim()) return null;

  const frontmatter: RoleFrontmatter = {
    role: fm.role as string,
    purpose: typeof fm.purpose === "string" ? fm.purpose : "",
  };

  const sections = parseSections(body);

  return { frontmatter, sections, body };
}

/**
 * Extract H2 sections from markdown body.
 */
export function parseSections(body: string): RoleSection[] {
  const sections: RoleSection[] = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  for (const line of body.split("\n")) {
    const h2Match = line.match(/^## (.+)$/);
    if (h2Match) {
      if (currentHeading !== null) {
        sections.push({
          heading: currentHeading,
          content: currentLines.join("\n").trim(),
        });
      }
      currentHeading = h2Match[1].trim();
      currentLines = [];
    } else if (currentHeading !== null) {
      currentLines.push(line);
    }
  }

  if (currentHeading !== null) {
    sections.push({
      heading: currentHeading,
      content: currentLines.join("\n").trim(),
    });
  }

  return sections;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate a role schema against requirements.
 * Checks frontmatter fields and required sections.
 */
export function validateRole(schema: RoleSchema): RoleValidationResult {
  const errors: RoleValidationError[] = [];

  if (!schema.frontmatter.role.trim()) {
    errors.push({ field: "frontmatter.role", message: "role is required" });
  }

  if (!schema.frontmatter.purpose.trim()) {
    errors.push({ field: "frontmatter.purpose", message: "purpose is required" });
  }

  const headings = new Set(schema.sections.map(s => normalizeHeading(s.heading)));

  for (const required of REQUIRED_ROLE_SECTIONS) {
    if (!headings.has(normalizeHeading(required))) {
      errors.push({
        field: `sections.${required}`,
        message: `Required section "## ${required}" is missing`,
      });
    }
  }

  for (const section of schema.sections) {
    const normalized = normalizeHeading(section.heading);
    if (REQUIRED_ROLE_SECTIONS.some(r => normalizeHeading(r) === normalized)) {
      if (!section.content.trim()) {
        errors.push({
          field: `sections.${section.heading}`,
          message: `Section "## ${section.heading}" is empty`,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate raw markdown string — parse + validate in one step.
 */
export function validateRoleFile(raw: string): {
  schema: RoleSchema | null;
  validation: RoleValidationResult;
} {
  const schema = parseRole(raw);

  if (!schema) {
    return {
      schema: null,
      validation: {
        valid: false,
        errors: [{ field: "file", message: "Could not parse role file — missing or invalid frontmatter with role field" }],
      },
    };
  }

  return { schema, validation: validateRole(schema) };
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Get a specific section from a parsed role by heading.
 * Case-insensitive match.
 */
export function getSection(schema: RoleSchema, heading: string): RoleSection | null {
  const normalized = normalizeHeading(heading);
  return schema.sections.find(s => normalizeHeading(s.heading) === normalized) ?? null;
}

/**
 * List all section headings in a role.
 */
export function listSectionHeadings(schema: RoleSchema): string[] {
  return schema.sections.map(s => s.heading);
}

/**
 * Check if a role has all required sections.
 */
export function hasAllRequiredSections(schema: RoleSchema): boolean {
  const headings = new Set(schema.sections.map(s => normalizeHeading(s.heading)));
  return REQUIRED_ROLE_SECTIONS.every(r => headings.has(normalizeHeading(r)));
}

/**
 * Get missing required sections.
 */
export function getMissingSections(schema: RoleSchema): string[] {
  const headings = new Set(schema.sections.map(s => normalizeHeading(s.heading)));
  return REQUIRED_ROLE_SECTIONS.filter(r => !headings.has(normalizeHeading(r)));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeHeading(heading: string): string {
  return heading.toLowerCase().trim();
}

function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = trimmed.substring(0, colonIdx).trim();
    const rawValue = trimmed.substring(colonIdx + 1).trim();

    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      result[key] = rawValue
        .slice(1, -1)
        .split(",")
        .map(s => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      i++;
      continue;
    }

    if (rawValue) {
      result[key] = parseScalar(rawValue);
      i++;
      continue;
    }

    i++;
  }

  return result;
}

function parseScalar(val: string): string | number | boolean {
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  if (val === "true") return true;
  if (val === "false") return false;
  const num = Number(val);
  if (!isNaN(num) && val !== "") return num;
  return val;
}
