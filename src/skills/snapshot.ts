/**
 * Skill Snapshot — ELLIE-217
 *
 * Builds the XML prompt block from eligible skills.
 * Enforces char limits and skill count caps.
 */

import { loadSkillEntries } from "./loader.ts";
import { filterEligibleSkills } from "./eligibility.ts";
import { SKILL_LIMITS, type SkillEntry, type SkillSnapshot } from "./types.ts";
import { log } from "../logger.ts";
import { classifySkills, formatMetadataSection, extractMetadata } from "./metadata.ts";

const logger = log.child("skills");

// ELLIE-367: Per-filter cache keyed by allowed skills list (or "all" for unfiltered)
const snapshotCache: Map<string, SkillSnapshot> = new Map();
let snapshotVersion = 0;

/**
 * Get the current skills snapshot. Rebuilds if version has changed.
 * Optionally filter to only include specific skills (ELLIE-367: creature skill allow-lists).
 */
export async function getSkillSnapshot(allowedSkills?: string[], message?: string): Promise<SkillSnapshot> {
  // ELLIE-430: No declaration = no skills. If allowedSkills is undefined,
  // the agent has no skill list — return empty. Pass explicit array to load skills.
  if (!allowedSkills) {
    const empty: SkillSnapshot = { prompt: "", skills: [], version: snapshotVersion, totalChars: 0 };
    return empty;
  }

  const skillKey = allowedSkills.length > 0 ? allowedSkills.slice().sort().join(",") : "none";
  // ELLIE-1078: Skip cache when message is provided (progressive disclosure depends on message content)
  const cacheKey = message ? null : skillKey;
  if (cacheKey) {
    const cached = snapshotCache.get(cacheKey);
    if (cached && cached.version === snapshotVersion) {
      return cached;
    }
  }

  const allSkills = await loadSkillEntries();
  let eligible = await filterEligibleSkills(allSkills);

  const allowed = new Set(allowedSkills);
  eligible = eligible.filter(s => allowed.has(s.name));

  // ELLIE-1078: Progressive disclosure — only load full content for triggered/always-on skills
  const classifiedInput = eligible.map(skill => ({
    metadata: extractMetadata(skill.frontmatter as Record<string, any>, skill.instructions),
    fullContent: formatSkillBlock(skill),
  }));

  const classified = classifySkills(classifiedInput, { message });

  // Build prompt: full content for active skills + metadata summary for rest
  const fullBlocks = classified.fullContent;
  const metadataSummary = formatMetadataSection(classified.metadataOnly);
  const prompt = fullBlocks.length > 0 || metadataSummary
    ? `<available_skills>\n${fullBlocks.join("\n")}${metadataSummary ? `\n${metadataSummary}` : ""}\n</available_skills>`
    : "";

  const snapshot: SkillSnapshot = {
    prompt,
    skills: eligible,
    version: snapshotVersion,
    totalChars: prompt.length,
  };
  if (cacheKey) snapshotCache.set(cacheKey, snapshot);

  logger.info(
    `Snapshot built (${cacheKey}): ${eligible.length}/${allSkills.length} eligible, ` +
    `${classified.fullContent.length} full + ${classified.metadataOnly.length} metadata-only, ` +
    `${prompt.length} chars (saved ~${classified.tokensSaved} tokens)`
  );

  return snapshot;
}

/**
 * Bump the snapshot version (triggers rebuild on next access).
 */
export function bumpSnapshotVersion(): void {
  snapshotVersion = Date.now();
  snapshotCache.clear();
}

/**
 * Force a cache invalidation. Next getSkillSnapshot() call with any
 * allowedSkills will rebuild from disk.
 */
export function rebuildSnapshot(): void {
  bumpSnapshotVersion();
}

/**
 * Build the XML skills prompt block.
 */
function buildSkillsPrompt(skills: SkillEntry[]): string {
  if (skills.length === 0) return "";

  const blocks: string[] = [];
  let totalChars = 0;
  let count = 0;

  // Sort: always-on first, then by priority
  const sorted = [...skills].sort((a, b) => {
    if (a.frontmatter.always && !b.frontmatter.always) return -1;
    if (!a.frontmatter.always && b.frontmatter.always) return 1;
    return a.sourcePriority - b.sourcePriority;
  });

  for (const skill of sorted) {
    if (count >= SKILL_LIMITS.maxSkillsInPrompt) break;

    const block = formatSkillBlock(skill);

    // Check char limit
    if (totalChars + block.length > SKILL_LIMITS.maxSkillsPromptChars) {
      logger.info(`Char limit reached at ${count} skills (${totalChars} chars)`);
      break;
    }

    blocks.push(block);
    totalChars += block.length;
    count++;
  }

  if (blocks.length === 0) return "";

  return `<available_skills>\n${blocks.join("\n")}\n</available_skills>`;
}

/**
 * Format a single skill as an XML block.
 */
function formatSkillBlock(skill: SkillEntry): string {
  const attrs: string[] = [`name="${skill.name}"`];
  if (skill.frontmatter.agent) attrs.push(`agent="${skill.frontmatter.agent}"`);
  if (skill.frontmatter.mcp) attrs.push(`mcp="${skill.frontmatter.mcp}"`);

  return `<skill ${attrs.join(" ")}>
<description>${skill.description}</description>
<instructions>
${skill.instructions}
</instructions>
</skill>`;
}
