/**
 * Skills System — ELLIE-217
 *
 * Public API for the skills subsystem.
 */

export { loadSkillEntries } from "./loader.ts";
export { filterEligibleSkills, isSkillEligible, clearBinCache } from "./eligibility.ts";
export { getSkillSnapshot, rebuildSnapshot, bumpSnapshotVersion } from "./snapshot.ts";
export { getSkillCommands, matchSkillCommand } from "./commands.ts";
export { startSkillWatcher, stopSkillWatcher } from "./watcher.ts";
export type { SkillEntry, SkillFrontmatter, SkillSnapshot, SkillCommand } from "./types.ts";
export { SKILL_LIMITS } from "./types.ts";
