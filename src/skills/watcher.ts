/**
 * Skill Watcher — ELLIE-217
 *
 * Watches skill directories for SKILL.md changes.
 * Debounced rebuild — changes take effect on next prompt build.
 */

import { watch, type FSWatcher } from "fs";
import { homedir } from "os";
import { join } from "path";
import { bumpSnapshotVersion } from "./snapshot.ts";
import { clearBinCache } from "./eligibility.ts";
import { clearSkillFileCache } from "./loader.ts";

const DEBOUNCE_MS = 500;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const watchers: FSWatcher[] = [];

/**
 * Start watching skill directories for changes.
 * Call once at relay startup.
 */
export function startSkillWatcher(): void {
  const dirs = [
    join(process.cwd(), "skills"),
    join(homedir(), ".ellie", "skills"),
    join(import.meta.dir, "../../skills"),
  ];

  for (const dir of dirs) {
    try {
      const watcher = watch(dir, { recursive: true }, (_event, filename) => {
        if (filename && (filename.endsWith("SKILL.md") || filename.endsWith("skill.md"))) {
          scheduleReload(filename);
        }
      });
      watchers.push(watcher);
    } catch {
      // Directory doesn't exist — skip
    }
  }

  if (watchers.length > 0) {
    console.log(`[skills] Watching ${watchers.length} directories for changes`);
  }
}

/**
 * Stop all watchers. Call on shutdown.
 */
export function stopSkillWatcher(): void {
  for (const w of watchers) {
    w.close();
  }
  watchers.length = 0;
}

function scheduleReload(filename: string): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    console.log(`[skills] Reloading after change: ${filename}`);
    clearBinCache();
    clearSkillFileCache();
    bumpSnapshotVersion();
    debounceTimer = null;
  }, DEBOUNCE_MS);
}
