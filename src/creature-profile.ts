/**
 * Creature Profile — ELLIE-367
 *
 * Parses YAML frontmatter from archetype .md files to extract per-creature
 * context section priorities, token budgets, and skill allow-lists.
 *
 * Frontmatter format (flat — parseSimpleYaml only handles 1 level of nesting):
 * ---
 * token_budget: 28000
 * allowed_skills: [github, plane, memory]
 * section_priorities:
 *   archetype: 1
 *   forest-context: 2
 * ---
 */

// ── Types ────────────────────────────────────────────────────

export interface CreatureProfile {
  section_priorities: Record<string, number>;
  token_budget?: number;
  allowed_skills?: string[];
}

// ── Parser ───────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/**
 * Parse creature profile frontmatter from an archetype .md file.
 * Returns the profile (or null if no frontmatter / no section_priorities)
 * and the body markdown without the frontmatter block.
 */
export function parseCreatureProfile(raw: string): { profile: CreatureProfile | null; body: string } {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { profile: null, body: raw };

  const yamlBlock = match[1];
  const body = match[2].trim();

  try {
    const fm = parseSimpleYaml(yamlBlock);

    // section_priorities is required for a valid creature profile
    const priorities = fm.section_priorities;
    if (!priorities || typeof priorities !== "object" || Array.isArray(priorities)) {
      return { profile: null, body };
    }

    const profile: CreatureProfile = {
      section_priorities: priorities as Record<string, number>,
    };

    if (typeof fm.token_budget === "number") {
      profile.token_budget = fm.token_budget;
    }

    if (Array.isArray(fm.allowed_skills)) {
      profile.allowed_skills = fm.allowed_skills as string[];
    }

    return { profile, body };
  } catch {
    return { profile: null, body };
  }
}

// ── Module-level cache ───────────────────────────────────────

const _profileCache: Map<string, CreatureProfile> = new Map();

/** Get a cached creature profile by agent name. */
export function getCreatureProfile(name?: string): CreatureProfile | null {
  if (!name) return null;
  return _profileCache.get(name.toLowerCase().replace(/[^a-z0-9-]/g, "")) ?? null;
}

/** Store a creature profile in the cache. Called from getAgentArchetype(). */
export function setCreatureProfile(name: string, profile: CreatureProfile): void {
  _profileCache.set(name.toLowerCase().replace(/[^a-z0-9-]/g, ""), profile);
}

// ── YAML parser (copied from skills/frontmatter.ts — module-private there) ──

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

        if (nextTrimmed.startsWith("- ")) {
          isArray = true;
          items.push(nextTrimmed.substring(2).trim().replace(/^["']|["']$/g, ""));
          i++;
          continue;
        }

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
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  if (val === "true") return true;
  if (val === "false") return false;
  const num = Number(val);
  if (!isNaN(num) && val !== "") return num;
  return val;
}
