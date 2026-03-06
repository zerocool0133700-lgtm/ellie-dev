/**
 * Role Loader — ELLIE-606
 *
 * Reads and parses role markdown files from config/roles/,
 * returns typed RoleConfig objects. Supports hot-reload via
 * file system watcher.
 *
 * Depends on role-schema.ts (ELLIE-605) for parsing and validation.
 *
 * Same pattern as archetype-loader.ts (ELLIE-604).
 */

import { readFileSync, readdirSync, existsSync, watch, type FSWatcher } from "fs";
import { join, basename, extname } from "path";

import {
  parseRole,
  validateRole,
  type RoleSchema,
  type RoleValidationResult,
} from "./role-schema";

// ── Types ────────────────────────────────────────────────────────────────────

/** A loaded role with schema, validation status, and file path. */
export interface RoleConfig {
  role: string;
  schema: RoleSchema;
  validation: RoleValidationResult;
  filePath: string;
  loadedAt: string;
}

/** Result of loading all roles from a directory. */
export interface RoleLoadResult {
  loaded: number;
  failed: number;
  errors: Array<{ file: string; reason: string }>;
}

/** Callback for watcher events. */
export type RoleWatcherCallback = (event: "loaded" | "removed" | "error", role: string) => void;

// ── Configuration ────────────────────────────────────────────────────────────

export const DEFAULT_ROLES_DIR = "config/roles";

// ── Storage ──────────────────────────────────────────────────────────────────

const _cache = new Map<string, RoleConfig>();
let _watcher: FSWatcher | null = null;
let _watcherCallback: RoleWatcherCallback | null = null;

// ── Loading ──────────────────────────────────────────────────────────────────

/**
 * Load all role .md files from a directory.
 */
export function loadRoles(dir: string = DEFAULT_ROLES_DIR): RoleLoadResult {
  const result: RoleLoadResult = { loaded: 0, failed: 0, errors: [] };

  if (!existsSync(dir)) return result;

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => extname(f) === ".md");
  } catch {
    return result;
  }

  for (const file of files) {
    const config = loadSingleFile(join(dir, file));
    if (config) {
      result.loaded++;
    } else {
      result.failed++;
      result.errors.push({ file, reason: "Failed to parse role file" });
    }
  }

  return result;
}

/**
 * Load a single role file into the cache.
 */
export function loadSingleFile(filePath: string): RoleConfig | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const schema = parseRole(raw);
  if (!schema) return null;

  const validation = validateRole(schema);

  const config: RoleConfig = {
    role: schema.frontmatter.role,
    schema,
    validation,
    filePath,
    loadedAt: new Date().toISOString(),
  };

  _cache.set(config.role.toLowerCase(), config);
  return config;
}

/**
 * Reload a single role by name.
 */
export function reloadRole(role: string): RoleConfig | null {
  const existing = _cache.get(role.toLowerCase());
  if (!existing) return null;
  return loadSingleFile(existing.filePath);
}

/**
 * Reload a role from a specific file path.
 */
export function reloadFromPath(filePath: string): RoleConfig | null {
  for (const [key, config] of _cache) {
    if (config.filePath === filePath) {
      _cache.delete(key);
      break;
    }
  }

  const config = loadSingleFile(filePath);

  if (config && _watcherCallback) {
    _watcherCallback("loaded", config.role);
  }

  return config;
}

/**
 * Remove a role from the cache by file path.
 */
export function removeByPath(filePath: string): string | null {
  for (const [key, config] of _cache) {
    if (config.filePath === filePath) {
      _cache.delete(key);
      if (_watcherCallback) {
        _watcherCallback("removed", config.role);
      }
      return config.role;
    }
  }
  return null;
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Get a loaded role by name. Case-insensitive.
 */
export function getRole(role: string): RoleConfig | null {
  return _cache.get(role.toLowerCase()) ?? null;
}

/**
 * List all loaded role names.
 */
export function listRoles(): string[] {
  return [..._cache.values()].map(c => c.role);
}

/**
 * List all loaded role configs.
 */
export function listRoleConfigs(): RoleConfig[] {
  return [..._cache.values()];
}

/**
 * Get the count of loaded roles.
 */
export function roleCount(): number {
  return _cache.size;
}

/**
 * Check if a role is loaded.
 */
export function hasRole(role: string): boolean {
  return _cache.has(role.toLowerCase());
}

// ── File Watcher ─────────────────────────────────────────────────────────────

/**
 * Start watching the roles directory for changes.
 */
export function startWatcher(
  dir: string = DEFAULT_ROLES_DIR,
  callback?: RoleWatcherCallback,
): boolean {
  if (_watcher) return false;
  if (!existsSync(dir)) return false;

  _watcherCallback = callback ?? null;

  try {
    _watcher = watch(dir, (eventType, filename) => {
      if (!filename || extname(filename) !== ".md") return;

      const filePath = join(dir, filename);

      if (existsSync(filePath)) {
        const config = reloadFromPath(filePath);
        if (!config && _watcherCallback) {
          _watcherCallback("error", basename(filename, ".md"));
        }
      } else {
        removeByPath(filePath);
      }
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop watching for file changes.
 */
export function stopWatcher(): void {
  if (_watcher) {
    _watcher.close();
    _watcher = null;
  }
  _watcherCallback = null;
}

/**
 * Check if the watcher is active.
 */
export function isWatching(): boolean {
  return _watcher !== null;
}

// ── Testing ──────────────────────────────────────────────────────────────────

/** Reset all state — for testing only. */
export function _resetRoleLoaderForTesting(): void {
  _cache.clear();
  stopWatcher();
}

/** Inject a role config directly — for testing only. */
export function _injectRoleForTesting(config: RoleConfig): void {
  _cache.set(config.role.toLowerCase(), config);
}
