/**
 * Runbook Validator — ELLIE-478
 *
 * Validates runbook documents in the River vault. Checks:
 *  - YAML frontmatter exists with required fields (type, scope_path, tags)
 *  - Document has a title (H1 heading)
 *  - Document has at least one H2 section
 *  - Content is non-trivial (minimum length)
 *
 * Pure module — takes content strings, returns validation results.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface RunbookValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  metadata: {
    title?: string;
    type?: string;
    scopePath?: string;
    tags?: string[];
    sectionCount: number;
    wordCount: number;
  };
}

export interface RunbookFrontmatter {
  type?: string;
  scope_path?: string;
  tags?: string[];
  created?: string;
  updated?: string;
  [key: string]: unknown;
}

// ── Frontmatter Parsing ────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from a markdown document.
 * Returns the parsed fields and the body content after frontmatter.
 */
export function parseFrontmatter(content: string): {
  frontmatter: RunbookFrontmatter | null;
  body: string;
} {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return { frontmatter: null, body: content };

  const fmBlock = fmMatch[1];
  const body = fmMatch[2];

  const frontmatter: RunbookFrontmatter = {};
  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: unknown = line.slice(colonIdx + 1).trim();

    // Parse arrays: [tag1, tag2]
    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim());
    }

    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

// ── Validation ─────────────────────────────────────────────────────────────

const REQUIRED_FRONTMATTER_FIELDS = ["type", "scope_path", "tags"];
const MIN_WORD_COUNT = 50;

/**
 * Validate a runbook document.
 * Returns a validation result with errors, warnings, and metadata.
 */
export function validateRunbook(content: string, filename?: string): RunbookValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const label = filename ? `${filename}: ` : "";

  const { frontmatter, body } = parseFrontmatter(content);

  // Check frontmatter exists
  if (!frontmatter) {
    errors.push(`${label}Missing YAML frontmatter (--- delimiters)`);
  }

  // Check required frontmatter fields
  if (frontmatter) {
    for (const field of REQUIRED_FRONTMATTER_FIELDS) {
      if (!frontmatter[field]) {
        errors.push(`${label}Missing required frontmatter field: ${field}`);
      }
    }

    if (frontmatter.type && frontmatter.type !== "runbook") {
      warnings.push(`${label}Frontmatter type is "${frontmatter.type}", expected "runbook"`);
    }

    if (frontmatter.tags && !Array.isArray(frontmatter.tags)) {
      errors.push(`${label}Frontmatter tags should be an array`);
    }
  }

  // Check title (H1)
  const titleMatch = body.match(/^# (.+)$/m);
  if (!titleMatch) {
    errors.push(`${label}Missing H1 title`);
  }

  // Check sections (H2)
  const sections = body.match(/^## .+$/gm) ?? [];
  if (sections.length === 0) {
    errors.push(`${label}No H2 sections found — runbooks need structured sections`);
  }

  // Check content length
  const words = body
    .replace(/```[\s\S]*?```/g, "") // exclude code blocks
    .replace(/[#|`\-\[\]>]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (words.length < MIN_WORD_COUNT) {
    warnings.push(`${label}Content seems short (${words.length} words, recommend ${MIN_WORD_COUNT}+)`);
  }

  // Check for created/updated dates
  if (frontmatter && !frontmatter.created) {
    warnings.push(`${label}Missing "created" date in frontmatter`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    metadata: {
      title: titleMatch?.[1],
      type: frontmatter?.type as string | undefined,
      scopePath: frontmatter?.scope_path as string | undefined,
      tags: frontmatter?.tags as string[] | undefined,
      sectionCount: sections.length,
      wordCount: words.length,
    },
  };
}

/**
 * Validate multiple runbooks at once.
 * Returns per-file results and an overall valid flag.
 */
export function validateRunbooks(
  runbooks: Array<{ filename: string; content: string }>,
): { valid: boolean; results: Array<{ filename: string } & RunbookValidation> } {
  const results = runbooks.map((rb) => ({
    filename: rb.filename,
    ...validateRunbook(rb.content, rb.filename),
  }));

  return {
    valid: results.every((r) => r.valid),
    results,
  };
}
