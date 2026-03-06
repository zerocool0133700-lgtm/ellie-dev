/**
 * Archetype Schema — ELLIE-603
 *
 * Defines the markdown + YAML frontmatter schema for behavioral archetype files.
 * These files encode an agent's cognitive style, working patterns, and behavioral DNA.
 *
 * File location: config/archetypes/{species}.md
 *
 * Frontmatter (YAML):
 *   species         — archetype name (e.g. ant, owl, bee)
 *   cognitive_style — one-line summary (e.g. "depth-first, single-threaded, methodical")
 *   token_budget    — optional token budget for prompt building
 *   allowed_skills  — optional list of allowed skill names
 *   section_priorities — optional priority map for prompt sections
 *
 * Required markdown sections (H2 headings):
 *   ## Working Pattern       — behavioral rules for task approach
 *   ## Communication Style   — how the agent reports and surfaces info
 *   ## Anti-Patterns         — things this archetype never does
 *   ## Growth Metrics        — measurable indicators of compliance
 *
 * Pure module — parsing and validation only, no side effects.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** Frontmatter fields for an archetype file. */
export interface ArchetypeFrontmatter {
  species: string;
  cognitive_style: string;
  token_budget?: number;
  allowed_skills?: string[];
  section_priorities?: Record<string, number>;
}

/** A parsed markdown section (H2 heading + content). */
export interface ArchetypeSection {
  heading: string;
  content: string;
}

/** Complete parsed archetype — frontmatter + sections + raw body. */
export interface ArchetypeSchema {
  frontmatter: ArchetypeFrontmatter;
  sections: ArchetypeSection[];
  body: string;
}

/** Validation error with field path and message. */
export interface ArchetypeValidationError {
  field: string;
  message: string;
}

/** Result of validating an archetype file. */
export interface ArchetypeValidationResult {
  valid: boolean;
  errors: ArchetypeValidationError[];
}

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Required H2 sections in every archetype file.
 * Matching is flexible — a file heading matches if it starts with (case-insensitive)
 * one of these prefixes or one of its aliases.
 */
export const REQUIRED_SECTIONS = [
  "Cognitive Style",
  "Communication",
  "Anti-Patterns",
] as const;

/**
 * Aliases for required sections. A heading matching any alias
 * also satisfies the corresponding required section.
 */
export const SECTION_ALIASES: Record<string, string[]> = {
  "communication": ["communication contracts", "communication style"],
  "anti-patterns": ["anti-patterns"],
};

/** Valid species names (known archetypes). Extensible — new species can be added. */
export const KNOWN_SPECIES = [
  "ant",
  "owl",
  "bee",
  "chipmunk",
  "deer",
  "road-runner",
  "squirrel",
] as const;

// ── Parsing ──────────────────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;
const H2_RE = /^## (.+)$/gm;

/**
 * Parse an archetype markdown file into its schema components.
 * Returns null if the file has no valid frontmatter.
 *
 * Species can come from:
 *   1. frontmatter `species:` field (ODS format)
 *   2. first H1 heading like "# Ant Creature" → "ant" (legacy format)
 *   3. explicit `speciesHint` parameter (filename-derived)
 */
export function parseArchetype(raw: string, speciesHint?: string): ArchetypeSchema | null {
  const fmMatch = raw.match(FRONTMATTER_RE);
  if (!fmMatch) return null;

  const yamlBlock = fmMatch[1];
  const body = fmMatch[2].trim();

  const fm = parseSimpleYaml(yamlBlock);

  // Resolve species: frontmatter → H1 heading → hint
  let species: string | undefined;
  if (typeof fm.species === "string" && fm.species.trim()) {
    species = fm.species.trim();
  } else {
    // Try extracting from first H1: "# Ant Creature -- ..." → "ant"
    const h1Match = body.match(/^# (\S+)/m);
    if (h1Match) {
      species = h1Match[1].toLowerCase().replace(/[^a-z0-9-]/g, "");
    }
    if (!species && speciesHint) {
      species = speciesHint.toLowerCase();
    }
  }

  if (!species) return null;

  const frontmatter: ArchetypeFrontmatter = {
    species,
    cognitive_style: typeof fm.cognitive_style === "string" ? fm.cognitive_style : "",
  };

  if (typeof fm.token_budget === "number") {
    frontmatter.token_budget = fm.token_budget;
  }

  if (Array.isArray(fm.allowed_skills)) {
    frontmatter.allowed_skills = fm.allowed_skills as string[];
  }

  if (fm.section_priorities && typeof fm.section_priorities === "object" && !Array.isArray(fm.section_priorities)) {
    frontmatter.section_priorities = fm.section_priorities as Record<string, number>;
  }

  const sections = parseSections(body);

  return { frontmatter, sections, body };
}

/**
 * Extract H2 sections from markdown body.
 */
export function parseSections(body: string): ArchetypeSection[] {
  const sections: ArchetypeSection[] = [];
  const lines = body.split("\n");
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
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

  // Push last section
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
 * Validate an archetype schema against requirements.
 * Checks frontmatter fields and required sections.
 */
export function validateArchetype(schema: ArchetypeSchema): ArchetypeValidationResult {
  const errors: ArchetypeValidationError[] = [];

  // Frontmatter validation
  if (!schema.frontmatter.species.trim()) {
    errors.push({ field: "frontmatter.species", message: "species is required" });
  }

  if (!schema.frontmatter.cognitive_style.trim()) {
    errors.push({ field: "frontmatter.cognitive_style", message: "cognitive_style is required" });
  }

  if (schema.frontmatter.token_budget !== undefined && schema.frontmatter.token_budget <= 0) {
    errors.push({ field: "frontmatter.token_budget", message: "token_budget must be positive" });
  }

  // Section validation — uses prefix matching to handle variations
  // e.g. "Anti-Patterns (What Dev Never Does)" matches "Anti-Patterns"
  const headings = schema.sections.map(s => normalizeHeading(s.heading));

  for (const required of REQUIRED_SECTIONS) {
    if (!headingMatchesRequired(headings, required)) {
      errors.push({
        field: `sections.${required}`,
        message: `Required section "## ${required}" is missing`,
      });
    }
  }

  // Check for empty required sections
  for (const section of schema.sections) {
    if (matchesAnyRequired(section.heading)) {
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
 * Returns validation result plus the parsed schema if parsing succeeded.
 */
export function validateArchetypeFile(raw: string): {
  schema: ArchetypeSchema | null;
  validation: ArchetypeValidationResult;
} {
  const schema = parseArchetype(raw);

  if (!schema) {
    return {
      schema: null,
      validation: {
        valid: false,
        errors: [{ field: "file", message: "Could not parse archetype file — missing or invalid frontmatter with species field" }],
      },
    };
  }

  return { schema, validation: validateArchetype(schema) };
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Get a specific section from a parsed archetype by heading.
 * Case-insensitive match.
 */
export function getSection(schema: ArchetypeSchema, heading: string): ArchetypeSection | null {
  const normalized = normalizeHeading(heading);
  return schema.sections.find(s => normalizeHeading(s.heading) === normalized) ?? null;
}

/**
 * List all section headings in an archetype.
 */
export function listSectionHeadings(schema: ArchetypeSchema): string[] {
  return schema.sections.map(s => s.heading);
}

/**
 * Check if an archetype has all required sections.
 */
export function hasAllRequiredSections(schema: ArchetypeSchema): boolean {
  const headings = schema.sections.map(s => normalizeHeading(s.heading));
  return REQUIRED_SECTIONS.every(r => headingMatchesRequired(headings, r));
}

/**
 * Get missing required sections.
 */
export function getMissingSections(schema: ArchetypeSchema): string[] {
  const headings = schema.sections.map(s => normalizeHeading(s.heading));
  return REQUIRED_SECTIONS.filter(r => !headingMatchesRequired(headings, r));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a heading for comparison (lowercase, trimmed). */
function normalizeHeading(heading: string): string {
  return heading.toLowerCase().trim();
}

/**
 * Check if any file heading matches a required section.
 * Uses prefix matching: "anti-patterns (what dev never does)" matches "anti-patterns".
 * Also checks SECTION_ALIASES for alternative names.
 */
function headingMatchesRequired(headings: string[], required: string): boolean {
  const normalizedReq = normalizeHeading(required);
  const aliases = SECTION_ALIASES[normalizedReq] || [];
  const allPatterns = [normalizedReq, ...aliases.map(a => a.toLowerCase())];

  return headings.some(h =>
    allPatterns.some(pattern => h.startsWith(pattern))
  );
}

/**
 * Check if a single heading matches any required section (for empty-check).
 */
function matchesAnyRequired(heading: string): boolean {
  const normalized = normalizeHeading(heading);
  for (const required of REQUIRED_SECTIONS) {
    const normalizedReq = normalizeHeading(required);
    const aliases = SECTION_ALIASES[normalizedReq] || [];
    const allPatterns = [normalizedReq, ...aliases.map(a => a.toLowerCase())];
    if (allPatterns.some(pattern => normalized.startsWith(pattern))) {
      return true;
    }
  }
  return false;
}

/**
 * Minimal YAML parser for frontmatter.
 * Handles scalars, inline arrays, and one level of nesting.
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

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

    // Inline array: [item1, item2]
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const inner = rawValue.slice(1, -1);
      result[key] = inner
        .split(",")
        .map(s => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      i++;
      continue;
    }

    // Value present on same line
    if (rawValue && !rawValue.endsWith(":")) {
      result[key] = parseScalar(rawValue);
      i++;
      continue;
    }

    // No value — check for nested object on next lines
    if (!rawValue || rawValue === "") {
      const nested: Record<string, unknown> = {};
      let isNested = false;
      i++;

      while (i < lines.length) {
        const nextLine = lines[i];
        const nextTrimmed = nextLine.trim();

        if (!nextTrimmed || nextTrimmed.startsWith("#")) {
          i++;
          continue;
        }

        const indent = nextLine.length - nextLine.trimStart().length;
        if (indent > 0 && nextTrimmed.includes(":")) {
          isNested = true;
          const nColonIdx = nextTrimmed.indexOf(":");
          const nKey = nextTrimmed.substring(0, nColonIdx).trim();
          const nVal = nextTrimmed.substring(nColonIdx + 1).trim();
          nested[nKey] = parseScalar(nVal);
          i++;
          continue;
        }

        break;
      }

      if (isNested) {
        result[key] = nested;
      }
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
