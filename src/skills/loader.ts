/**
 * Skill Loader — ELLIE-217, ELLIE-235
 *
 * Discovers and loads SKILL.md files from multiple directories
 * with precedence-based deduplication.
 *
 * ELLIE-235: Mtime-based caching — only re-reads files whose mtime changed.
 * Avoids full filesystem I/O on every snapshot rebuild.
 */

import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { log } from "../logger.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { SKILL_LIMITS, type SkillEntry } from "./types.ts";

const logger = log.child("skill-loader");

// Scan order (lower number = higher priority, wins dedup)
const SEARCH_DIRS = [
  { path: () => join(process.cwd(), "skills"), priority: 1, label: "workspace" },
  { path: () => join(homedir(), ".ellie", "skills"), priority: 2, label: "personal" },
  { path: () => join(import.meta.dir, "../../skills"), priority: 3, label: "bundled" },
];

// ELLIE-235: Per-file cache keyed by path, stores entry + mtime
interface CachedSkill {
  entry: SkillEntry;
  mtimeMs: number;
}
const fileCache = new Map<string, CachedSkill>();

/**
 * Load all skill entries from configured directories.
 * First-found wins (highest priority directory takes precedence).
 *
 * ELLIE-235: Uses mtime-based caching — only re-reads changed files.
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

/** Clear the file cache (called by watcher on hot-reload). */
export function clearSkillFileCache(): void {
  fileCache.clear();
}

/**
 * Scan a single directory for skill subdirectories containing SKILL.md.
 * ELLIE-235: Checks mtime before re-reading — skips unchanged files.
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
          logger.warn(`Skipping skill: SKILL.md exceeds size limit`, { skill: item.name, limitKB: SKILL_LIMITS.maxSkillFileBytes / 1000 });
          continue;
        }

        // ELLIE-235: Check mtime cache — skip re-reading unchanged files
        const cached = fileCache.get(skillMdPath);
        if (cached && cached.mtimeMs === fileStat.mtimeMs) {
          entries.push(cached.entry);
          continue;
        }

        const raw = await readFile(skillMdPath, "utf-8");
        const parsed = parseFrontmatter(raw);
        if (!parsed) {
          logger.warn("Skipping skill: invalid frontmatter", { skill: item.name });
          fileCache.delete(skillMdPath);
          continue;
        }

        const entry: SkillEntry = {
          name: parsed.frontmatter.name,
          description: parsed.frontmatter.description,
          instructions: parsed.body,
          frontmatter: parsed.frontmatter,
          sourceDir: join(dirPath, item.name),
          sourcePriority: priority,
        };

        fileCache.set(skillMdPath, { entry, mtimeMs: fileStat.mtimeMs });
        entries.push(entry);
      } catch {
        // No SKILL.md in this subdirectory — skip silently
      }
    }
  } catch {
    // Directory doesn't exist — skip silently
  }

  return entries;
}
