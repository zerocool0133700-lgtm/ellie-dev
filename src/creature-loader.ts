/**
 * Creature Loader — ELLIE-1075
 * Unified loader for creature definitions.
 * Supports both legacy (creatures/*.md) and new directory structure (creatures/{name}/).
 * New structure:
 *   creatures/{name}/
 *     creature.md    — main definition (species, role, boot_requirements)
 *     SOUL.md        — personality + identity (optional, falls back to shared soul)
 *     RULES.md       — hard constraints (optional)
 *     skills/        — creature-specific skills (optional)
 *     memory/        — persistent memory (from ELLIE-1027)
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import { log } from "./logger.ts";
import { parseCreature, type CreatureDef } from "./boot-resolver.ts";

const logger = log.child("creature-loader");

const CREATURES_DIR = join(import.meta.dir, "..", "creatures");

export interface UnifiedCreatureDef extends CreatureDef {
  soulContent?: string;    // Custom soul (from SOUL.md)
  rulesContent?: string;   // Hard constraints (from RULES.md)
  creatureSkills?: string[]; // Creature-specific skill names
  memoryDir?: string;      // Path to memory directory
  isDirectoryBased: boolean; // true = new structure, false = legacy .md
}

/**
 * Load a single creature from either format.
 * Checks directory structure first, falls back to .md file.
 */
export function loadCreature(name: string, dir?: string): UnifiedCreatureDef | null {
  const creaturesDir = dir ?? CREATURES_DIR;
  const normalizedName = name.toLowerCase().replace(/[^a-z0-9-]/g, "");

  // Try new directory structure first
  const creatureDir = join(creaturesDir, normalizedName);
  if (existsSync(creatureDir) && statSync(creatureDir).isDirectory()) {
    return loadFromDirectory(creatureDir, normalizedName);
  }

  // Fall back to legacy .md file
  const mdPath = join(creaturesDir, `${normalizedName}.md`);
  if (existsSync(mdPath)) {
    return loadFromFile(mdPath);
  }

  logger.warn("Creature not found", { name: normalizedName, dir: creaturesDir });
  return null;
}

/**
 * Load from new directory structure: creatures/{name}/
 */
function loadFromDirectory(dir: string, name: string): UnifiedCreatureDef | null {
  // creature.md is required
  const creatureMd = join(dir, "creature.md");
  if (!existsSync(creatureMd)) {
    // Try {name}.md as fallback within directory
    const altPath = join(dir, `${name}.md`);
    if (!existsSync(altPath)) {
      logger.warn("Creature directory missing creature.md", { dir });
      return null;
    }
    return loadFromDirectoryWithFile(dir, altPath);
  }
  return loadFromDirectoryWithFile(dir, creatureMd);
}

function loadFromDirectoryWithFile(dir: string, mainFile: string): UnifiedCreatureDef | null {
  const raw = readFileSync(mainFile, "utf-8");
  const baseDef = parseCreature(raw);
  if (!baseDef) {
    logger.warn("Failed to parse creature definition", { file: mainFile });
    return null;
  }

  const result: UnifiedCreatureDef = {
    ...baseDef,
    isDirectoryBased: true,
  };

  // Load optional SOUL.md
  const soulPath = join(dir, "SOUL.md");
  if (existsSync(soulPath)) {
    result.soulContent = readFileSync(soulPath, "utf-8");
  }

  // Load optional RULES.md
  const rulesPath = join(dir, "RULES.md");
  if (existsSync(rulesPath)) {
    result.rulesContent = readFileSync(rulesPath, "utf-8");
  }

  // Discover creature-specific skills
  const skillsDir = join(dir, "skills");
  if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
    const skillDirs = readdirSync(skillsDir).filter(f => {
      const skillPath = join(skillsDir, f);
      return statSync(skillPath).isDirectory() && existsSync(join(skillPath, "SKILL.md"));
    });
    result.creatureSkills = skillDirs;
  }

  // Memory directory
  const memoryDir = join(dir, "memory");
  if (existsSync(memoryDir) && statSync(memoryDir).isDirectory()) {
    result.memoryDir = memoryDir;
  }

  return result;
}

/**
 * Load from legacy .md file
 */
function loadFromFile(path: string): UnifiedCreatureDef | null {
  const raw = readFileSync(path, "utf-8");
  const baseDef = parseCreature(raw);
  if (!baseDef) return null;
  return { ...baseDef, isDirectoryBased: false };
}

/**
 * Load all creatures (both formats).
 * Directory-based creatures take precedence over legacy .md files.
 */
export function loadAllCreatures(dir?: string): Map<string, UnifiedCreatureDef> {
  const creaturesDir = dir ?? CREATURES_DIR;
  if (!existsSync(creaturesDir)) return new Map();

  const entries = readdirSync(creaturesDir);
  const creatures = new Map<string, UnifiedCreatureDef>();
  // Track which base names we've loaded via directory to avoid duplicates
  const loadedDirNames = new Set<string>();

  // First pass: load directory-based creatures (they take precedence)
  for (const entry of entries) {
    const fullPath = join(creaturesDir, entry);
    if (statSync(fullPath).isDirectory()) {
      const def = loadFromDirectory(fullPath, entry);
      if (def) {
        const key = def.role ?? def.name.toLowerCase();
        creatures.set(key, def);
        loadedDirNames.add(entry);
      }
    }
  }

  // Second pass: load legacy .md files (skip if directory version exists)
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const name = entry.replace(".md", "");
    if (loadedDirNames.has(name)) continue;

    const fullPath = join(creaturesDir, entry);
    if (statSync(fullPath).isFile()) {
      const def = loadFromFile(fullPath);
      if (def) {
        const key = def.role ?? def.name.toLowerCase();
        if (!creatures.has(key)) {
          creatures.set(key, def);
        }
      }
    }
  }

  return creatures;
}

/**
 * Check if a creature uses the new directory format.
 */
export function isDirectoryCreature(name: string, dir?: string): boolean {
  const creaturesDir = dir ?? CREATURES_DIR;
  const creatureDir = join(creaturesDir, name.toLowerCase().replace(/[^a-z0-9-]/g, ""));
  return existsSync(creatureDir) && statSync(creatureDir).isDirectory();
}

// Export for testing
export { CREATURES_DIR };
