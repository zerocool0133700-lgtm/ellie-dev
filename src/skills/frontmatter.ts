/**
 * Frontmatter Parser — ELLIE-217
 *
 * Extracts YAML frontmatter from SKILL.md files.
 * Format: --- YAML --- followed by markdown body.
 */

import type { SkillFrontmatter } from "./types.ts";

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

export function parseFrontmatter(raw: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} | null {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return null;

  const yamlBlock = match[1];
  const body = match[2].trim();

  try {
    const fm = parseSimpleYaml(yamlBlock);
    if (!fm.name || !fm.description) return null;
    return { frontmatter: fm as SkillFrontmatter, body };
  } catch {
    return null;
  }
}

/**
 * Lightweight YAML parser for skill frontmatter.
 * Handles: scalars, arrays (inline [...] and block - items), nested objects.
 * No external dependency needed for this limited subset.
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and comments
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
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
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

    // No value — check for block array or nested object on next lines
    if (!rawValue || rawValue === "") {
      const items: string[] = [];
      const nested: Record<string, unknown> = {};
      let isArray = false;
      let isNested = false;
      i++;

      while (i < lines.length) {
        const nextLine = lines[i];
        const nextTrimmed = nextLine.trim();

        if (!nextTrimmed || nextTrimmed.startsWith("#")) {
          i++;
          continue;
        }

        // Block array item: "  - value"
        if (nextTrimmed.startsWith("- ")) {
          isArray = true;
          items.push(nextTrimmed.substring(2).trim().replace(/^["']|["']$/g, ""));
          i++;
          continue;
        }

        // Nested key-value (indented)
        const indent = nextLine.length - nextLine.trimStart().length;
        if (indent > 0 && nextTrimmed.includes(":")) {
          isNested = true;
          const nColonIdx = nextTrimmed.indexOf(":");
          const nKey = nextTrimmed.substring(0, nColonIdx).trim();
          const nVal = nextTrimmed.substring(nColonIdx + 1).trim();
          if (nVal.startsWith("[") && nVal.endsWith("]")) {
            nested[nKey] = nVal
              .slice(1, -1)
              .split(",")
              .map((s) => s.trim().replace(/^["']|["']$/g, ""))
              .filter(Boolean);
          } else {
            nested[nKey] = parseScalar(nVal);
          }
          i++;
          continue;
        }

        // Back to top-level
        break;
      }

      if (isArray) {
        result[key] = items;
      } else if (isNested) {
        result[key] = nested;
      }
      continue;
    }

    i++;
  }

  return result;
}

function parseScalar(val: string): string | number | boolean {
  // Remove quotes
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  if (val === "true") return true;
  if (val === "false") return false;
  const num = Number(val);
  if (!isNaN(num) && val !== "") return num;
  return val;
}
