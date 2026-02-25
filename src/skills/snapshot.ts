/**
 * Skill Snapshot — ELLIE-217
 *
 * Builds the XML prompt block from eligible skills.
 * Enforces char limits and skill count caps.
 */

import { loadSkillEntries } from "./loader.ts";
import { filterEligibleSkills } from "./eligibility.ts";
import { SKILL_LIMITS, type SkillEntry, type SkillSnapshot } from "./types.ts";

let cachedSnapshot: SkillSnapshot | null = null;
let snapshotVersion = 0;

/**
 * Get the current skills snapshot. Rebuilds if version has changed.
 */
export async function getSkillSnapshot(): Promise<SkillSnapshot> {
  if (cachedSnapshot && cachedSnapshot.version === snapshotVersion) {
    return cachedSnapshot;
  }

  const allSkills = await loadSkillEntries();
  const eligible = await filterEligibleSkills(allSkills);
  const prompt = buildSkillsPrompt(eligible);

  cachedSnapshot = {
    prompt,
    skills: eligible,
    version: snapshotVersion,
    totalChars: prompt.length,
  };

  console.log(
    `[skills] Snapshot built: ${eligible.length}/${allSkills.length} eligible, ${prompt.length} chars`
  );

  return cachedSnapshot;
}

/**
 * Bump the snapshot version (triggers rebuild on next access).
 */
export function bumpSnapshotVersion(): void {
  snapshotVersion = Date.now();
  cachedSnapshot = null;
}

/**
 * Force a fresh rebuild (ignores cache).
 */
export async function rebuildSnapshot(): Promise<SkillSnapshot> {
  bumpSnapshotVersion();
  return getSkillSnapshot();
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
      console.log(`[skills] Char limit reached at ${count} skills (${totalChars} chars)`);
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
