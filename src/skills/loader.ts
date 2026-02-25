/**
 * Skill Loader — ELLIE-217
 *
 * Discovers and loads SKILL.md files from multiple directories
 * with precedence-based deduplication.
 */

import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { parseFrontmatter } from "./frontmatter.ts";
import { SKILL_LIMITS, type SkillEntry } from "./types.ts";

// Scan order (lower number = higher priority, wins dedup)
const SEARCH_DIRS = [
  { path: () => join(process.cwd(), "skills"), priority: 1, label: "workspace" },
  { path: () => join(homedir(), ".ellie", "skills"), priority: 2, label: "personal" },
  { path: () => join(import.meta.dir, "../../skills"), priority: 3, label: "bundled" },
];

/**
 * Load all skill entries from configured directories.
 * First-found wins (highest priority directory takes precedence).
 */
export async function loadSkillEntries(): Promise<SkillEntry[]> {
  const seen = new Map<string, SkillEntry>();

  for (const dir of SEARCH_DIRS) {
    const dirPath = dir.path();
    const entries = await scanSkillDir(dirPath, dir.priority);
    for (const entry of entries) {
      // First-found wins — don't override higher-priority entries
      if (!seen.has(entry.name)) {
        seen.set(entry.name, entry);
      }
    }
  }

  const skills = [...seen.values()];
  console.log(`[skills] Loaded ${skills.length} skills from ${SEARCH_DIRS.length} locations`);
  return skills;
}

/**
 * Scan a single directory for skill subdirectories containing SKILL.md.
 */
async function scanSkillDir(dirPath: string, priority: number): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];

  try {
    const items = await readdir(dirPath, { withFileTypes: true });

    for (const item of items) {
      if (!item.isDirectory()) continue;

      const skillMdPath = join(dirPath, item.name, "SKILL.md");
      try {
        const fileStat = await stat(skillMdPath);

        // Size limit check
        if (fileStat.size > SKILL_LIMITS.maxSkillFileBytes) {
          console.warn(`[skills] Skipping ${item.name}: SKILL.md exceeds ${SKILL_LIMITS.maxSkillFileBytes / 1000}KB`);
          continue;
        }

        const raw = await readFile(skillMdPath, "utf-8");
        const parsed = parseFrontmatter(raw);
        if (!parsed) {
          console.warn(`[skills] Skipping ${item.name}: invalid frontmatter`);
          continue;
        }

        entries.push({
          name: parsed.frontmatter.name,
          description: parsed.frontmatter.description,
          instructions: parsed.body,
          frontmatter: parsed.frontmatter,
          sourceDir: join(dirPath, item.name),
          sourcePriority: priority,
        });
      } catch {
        // No SKILL.md in this subdirectory — skip silently
      }
    }
  } catch {
    // Directory doesn't exist — skip silently
  }

  return entries;
}
