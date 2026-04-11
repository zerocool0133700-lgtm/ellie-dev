/**
 * Layer 1: Identity Loader
 *
 * Reads identity .md files from disk, caches them, builds a compact skill registry,
 * and renders the identity block for prompt injection.
 *
 * See spec: docs/superpowers/specs/2026-04-06-layered-prompt-architecture-design.md
 */

import { Glob } from "bun";
import { join } from "path";
import { log } from "../logger.ts";
import type { IdentityBlock, SkillRegistryEntry } from "./types.ts";

const logger = log.child("identity-loader");

// Base directory for the ellie-dev project
const BASE_DIR = join(import.meta.dir, "../..");

// In-memory cache — loaded once per process
let _cache: IdentityBlock | null = null;

// ── YAML frontmatter extraction ────────────────────────────────────────────────

/**
 * Extract a string field from YAML frontmatter block.
 * Supports: `field: value` and `field: "quoted value"`
 */
function extractYamlField(yaml: string, field: string): string {
  const match = yaml.match(new RegExp(`^${field}:\\s*["']?(.+?)["']?\\s*$`, "m"));
  return match ? match[1].trim() : "";
}

/**
 * Extract a YAML array field from frontmatter.
 * Supports inline arrays: `triggers: [a, b, c]`
 */
function extractYamlArray(yaml: string, field: string): string[] {
  const match = yaml.match(new RegExp(`^${field}:\\s*\\[(.+?)\\]`, "m"));
  if (!match) return [];
  return match[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""));
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns the frontmatter string if found, empty string otherwise.
 */
function parseFrontmatter(content: string): string {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : "";
}

// ── Skill registry ─────────────────────────────────────────────────────────────

/**
 * Reads skills SKILL.md files and extracts name/description/triggers
 * from YAML frontmatter. Exported for Layer 3 Channel A.
 */
export async function loadSkillRegistry(): Promise<SkillRegistryEntry[]> {
  const glob = new Glob("skills/*/SKILL.md");
  const entries: SkillRegistryEntry[] = [];

  for await (const file of glob.scan({ cwd: BASE_DIR })) {
    try {
      const fullPath = join(BASE_DIR, file);
      const content = await Bun.file(fullPath).text();
      const frontmatter = parseFrontmatter(content);
      if (!frontmatter) continue;

      const name = extractYamlField(frontmatter, "name");
      const description = extractYamlField(frontmatter, "description");
      const triggers = extractYamlArray(frontmatter, "triggers");

      if (name) {
        entries.push({ name, description, triggers, file });
      }
    } catch (err) {
      logger.warn("Failed to parse SKILL.md", { file, err });
    }
  }

  logger.info("Skill registry loaded", { count: entries.length });
  return entries;
}

/**
 * Produces a compact one-line-per-skill summary string.
 * Pure function — no I/O.
 */
export function buildSkillSummary(entries: SkillRegistryEntry[]): string {
  if (entries.length === 0) return "No skills loaded.";
  const names = entries.map(e => e.name).join(", ");
  return `I have ${entries.length} skills available: ${names}.\nFor details on any skill, I can load the full reference.`;
}

// ── Identity document loader ───────────────────────────────────────────────────

/**
 * Reads the four identity documents from disk and caches the result.
 * Files: config/soul.md, config/identity/identity.md, config/identity/user.md,
 *        config/identity/relationship.md
 */
export async function loadIdentityDocs(): Promise<IdentityBlock> {
  if (_cache) return _cache;

  logger.info("Loading identity documents from disk");

  const [soul, identity, user, relationship, skillEntries] = await Promise.all([
    Bun.file(join(BASE_DIR, "config/soul.md")).text(),
    Bun.file(join(BASE_DIR, "config/identity/identity.md")).text(),
    Bun.file(join(BASE_DIR, "config/identity/user.md")).text(),
    Bun.file(join(BASE_DIR, "config/identity/relationship.md")).text(),
    loadSkillRegistry(),
  ]);

  const skillSummary = buildSkillSummary(skillEntries);

  _cache = { soul, identity, user, relationship, skillSummary };
  logger.info("Identity documents cached");
  return _cache;
}

// ── Renderer ───────────────────────────────────────────────────────────────────

/**
 * Extract just the Core Identity section from soul.md (first ~20 lines up to first ---).
 * The full soul.md is used in the main system prompt — the identity block gets a digest.
 */
function extractSoulDigest(soul: string): string {
  const lines = soul.split("\n");
  const result: string[] = [];
  let started = false;
  for (const line of lines) {
    if (!started && line.startsWith("## Core Identity")) {
      started = true;
      continue; // skip the heading itself
    }
    if (started) {
      if (line.startsWith("## ")) break; // stop at next section heading
      result.push(line);
    }
  }
  return result.join("\n").trim();
}

/**
 * Combines all identity documents and skill summary into a single prompt section
 * under "## IDENTITY". Stays under 4KB.
 */
export async function renderIdentityBlock(): Promise<string> {
  const docs = await loadIdentityDocs();

  // Use a digest of soul to keep the block compact
  const soulDigest = docs.soul.includes("## Core Identity")
    ? extractSoulDigest(docs.soul)
    : docs.soul.split("\n").slice(0, 20).join("\n").trim();

  const sections: string[] = [
    "## IDENTITY",
    "",
    "### Soul",
    soulDigest,
    "",
    "### Who I Am",
    docs.identity.trim(),
    "",
    "### About Dave",
    docs.user.trim(),
    "",
    "### Our Partnership",
    docs.relationship.trim(),
    "",
    "### Skills",
    docs.skillSummary.trim(),
  ];

  return sections.join("\n");
}

// ── Testing helpers ────────────────────────────────────────────────────────────

/** Override the in-memory cache for testing purposes. */
export function _injectIdentityForTesting(block: IdentityBlock): void {
  _cache = block;
}

/** Reset the in-memory cache for testing purposes. */
export function _clearIdentityCacheForTesting(): void {
  _cache = null;
}
