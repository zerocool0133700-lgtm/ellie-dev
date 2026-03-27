/**
 * Skill Metadata — ELLIE-1078
 * Lightweight skill metadata for prompt injection (100 tokens vs 5000).
 * Full content loaded on demand when skill is invoked.
 * Inspired by gitagent's progressive disclosure pattern.
 */

import { log } from "../logger.ts";
import { estimateTokens } from "../relay-utils.ts";

const logger = log.child("skills:metadata");

export interface SkillMetadata {
  name: string;
  description: string;
  triggers: string[];
  alwaysOn: boolean;
  tokens: number; // Full content token count (for budget planning)
}

export interface SkillDisclosureResult {
  metadataOnly: SkillMetadata[]; // Just name + description (injected into prompt)
  fullContent: string[];          // Skills loaded fully (always-on + invoked)
  tokensSaved: number;           // Tokens saved by not loading full content
}

/**
 * Extract metadata from a parsed SKILL.md frontmatter.
 * Note: frontmatter uses `always` (not `always_on`) per types.ts SkillFrontmatter.
 */
export function extractMetadata(frontmatter: Record<string, any>, fullContent: string): SkillMetadata {
  return {
    name: frontmatter.name || "unknown",
    description: (frontmatter.description || "").slice(0, 200),
    triggers: Array.isArray(frontmatter.triggers) ? frontmatter.triggers : [],
    alwaysOn: frontmatter.always === true,
    tokens: estimateTokens(fullContent),
  };
}

/**
 * Format metadata-only skills as a compact prompt section.
 * ~100 tokens total for 15 skills instead of ~15000.
 */
export function formatMetadataSection(skills: SkillMetadata[]): string {
  if (skills.length === 0) return "";

  const lines = ["Available skills (say the trigger phrase to activate):"];
  for (const skill of skills) {
    const triggers = skill.triggers.length > 0
      ? ` (triggers: ${skill.triggers.slice(0, 3).join(", ")})`
      : "";
    lines.push(`- **${skill.name}**: ${skill.description}${triggers}`);
  }
  return lines.join("\n");
}

/**
 * Decide which skills get full content vs metadata-only.
 * Rules:
 *   - always-on skills -> full content
 *   - Skills matching the current message intent -> full content
 *   - Everything else -> metadata only
 */
export function classifySkills(
  skills: Array<{ metadata: SkillMetadata; fullContent: string }>,
  opts?: {
    message?: string;
    invokedSkillNames?: string[];
    alwaysFullNames?: string[];
  }
): SkillDisclosureResult {
  const metadataOnly: SkillMetadata[] = [];
  const fullContent: string[] = [];
  let tokensSaved = 0;

  const invokedSet = new Set(opts?.invokedSkillNames ?? []);
  const alwaysFullSet = new Set(opts?.alwaysFullNames ?? []);
  const messageLower = opts?.message?.toLowerCase() ?? "";

  for (const skill of skills) {
    const { metadata } = skill;

    // Always-on skills get full content
    if (metadata.alwaysOn) {
      fullContent.push(skill.fullContent);
      continue;
    }

    // Explicitly invoked skills get full content
    if (invokedSet.has(metadata.name)) {
      fullContent.push(skill.fullContent);
      continue;
    }

    // Skills in the always-full list
    if (alwaysFullSet.has(metadata.name)) {
      fullContent.push(skill.fullContent);
      continue;
    }

    // Check if message triggers this skill
    const triggered = metadata.triggers.some(t =>
      messageLower.includes(t.toLowerCase())
    );
    if (triggered) {
      fullContent.push(skill.fullContent);
      continue;
    }

    // Everything else -> metadata only
    metadataOnly.push(metadata);
    tokensSaved += metadata.tokens;
  }

  if (metadataOnly.length > 0) {
    logger.debug("Progressive disclosure", {
      full: fullContent.length,
      metadataOnly: metadataOnly.length,
      tokensSaved,
    });
  }

  return { metadataOnly, fullContent, tokensSaved };
}
