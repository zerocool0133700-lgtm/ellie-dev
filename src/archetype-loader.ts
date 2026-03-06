/**
 * Archetype Loader — ELLIE-604
 *
 * Reads and parses archetype markdown files from config/archetypes/,
 * returns typed ArchetypeConfig objects. Supports hot-reload via
 * file system watcher.
 *
 * Depends on archetype-schema.ts (ELLIE-603) for parsing and validation.
 *
 * Usage:
 *   loadArchetypes(dir?)     — scan directory and populate cache
 *   getArchetype(species)    — get loaded config or null
 *   listArchetypes()         — list all loaded species names
 *   reloadArchetype(species) — reload a single file
 *   startWatcher(dir?)       — watch for file changes (hot-reload)
 *   stopWatcher()            — stop the file watcher
 */

import { readFileSync, readdirSync, existsSync, watch, type FSWatcher } from "fs";
import { join, basename, extname } from "path";

import {
  parseArchetype,
  validateArchetype,
  type ArchetypeSchema,
  type ArchetypeValidationResult,
} from "./archetype-schema";

// ── Types ────────────────────────────────────────────────────────────────────

/** A loaded archetype with schema, validation status, and file path. */
export interface ArchetypeConfig {
  species: string;
  schema: ArchetypeSchema;
  validation: ArchetypeValidationResult;
  filePath: string;
  loadedAt: string;
}

/** Result of loading all archetypes from a directory. */
export interface LoadResult {
  loaded: number;
  failed: number;
  errors: Array<{ file: string; reason: string }>;
}

/** Callback for watcher events. */
export type WatcherCallback = (event: "loaded" | "removed" | "error", species: string) => void;

// ── Configuration ────────────────────────────────────────────────────────────

/** Default directory for archetype files. */
export const DEFAULT_ARCHETYPES_DIR = "config/archetypes";

// ── Storage ──────────────────────────────────────────────────────────────────

const _cache = new Map<string, ArchetypeConfig>();
let _watcher: FSWatcher | null = null;
let _watcherCallback: WatcherCallback | null = null;

// ── Loading ──────────────────────────────────────────────────────────────────

/**
 * Load all archetype .md files from a directory.
 * Populates the in-memory cache.
 */
export function loadArchetypes(dir: string = DEFAULT_ARCHETYPES_DIR): LoadResult {
  const result: LoadResult = { loaded: 0, failed: 0, errors: [] };

  if (!existsSync(dir)) {
    return result;
  }

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => extname(f) === ".md");
  } catch {
    return result;
  }

  for (const file of files) {
    const filePath = join(dir, file);
    const loadResult = loadSingleFile(filePath);

    if (loadResult) {
      result.loaded++;
    } else {
      result.failed++;
      result.errors.push({ file, reason: "Failed to parse archetype file" });
    }
  }

  return result;
}

/**
 * Load a single archetype file into the cache.
 * Returns the config or null if parsing fails.
 */
export function loadSingleFile(filePath: string): ArchetypeConfig | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  // Pass filename as species hint for legacy files without species: in frontmatter
  const speciesHint = basename(filePath, ".md");
  const schema = parseArchetype(raw, speciesHint);
  if (!schema) return null;

  const validation = validateArchetype(schema);

  const config: ArchetypeConfig = {
    species: schema.frontmatter.species,
    schema,
    validation,
    filePath,
    loadedAt: new Date().toISOString(),
  };

  _cache.set(config.species.toLowerCase(), config);
  return config;
}

/**
 * Reload a single archetype by species name.
 * Looks up the existing file path from the cache.
 * Returns the updated config or null.
 */
export function reloadArchetype(species: string): ArchetypeConfig | null {
  const existing = _cache.get(species.toLowerCase());
  if (!existing) return null;

  return loadSingleFile(existing.filePath);
}

/**
 * Reload an archetype from a specific file path.
 * Removes old entry if species changed. Notifies watcher callback.
 */
export function reloadFromPath(filePath: string): ArchetypeConfig | null {
  // Remove any existing entry for this file path
  for (const [key, config] of _cache) {
    if (config.filePath === filePath) {
      _cache.delete(key);
      break;
    }
  }

  const config = loadSingleFile(filePath);

  if (config && _watcherCallback) {
    _watcherCallback("loaded", config.species);
  }

  return config;
}

/**
 * Remove an archetype from the cache by file path.
 * Used when a file is deleted.
 */
export function removeByPath(filePath: string): string | null {
  for (const [key, config] of _cache) {
    if (config.filePath === filePath) {
      _cache.delete(key);
      if (_watcherCallback) {
        _watcherCallback("removed", config.species);
      }
      return config.species;
    }
  }
  return null;
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Get a loaded archetype by species name.
 * Case-insensitive lookup.
 */
export function getArchetype(species: string): ArchetypeConfig | null {
  return _cache.get(species.toLowerCase()) ?? null;
}

/**
 * List all loaded species names.
 */
export function listArchetypes(): string[] {
  return [..._cache.values()].map(c => c.species);
}

/**
 * List all loaded archetype configs.
 */
export function listArchetypeConfigs(): ArchetypeConfig[] {
  return [..._cache.values()];
}

/**
 * Get the count of loaded archetypes.
 */
export function archetypeCount(): number {
  return _cache.size;
}

/**
 * Check if a species is loaded.
 */
export function hasArchetype(species: string): boolean {
  return _cache.has(species.toLowerCase());
}

// ── File Watcher ─────────────────────────────────────────────────────────────

/**
 * Start watching the archetypes directory for changes.
 * Reloads or removes archetypes as files change.
 */
export function startWatcher(
  dir: string = DEFAULT_ARCHETYPES_DIR,
  callback?: WatcherCallback,
): boolean {
  if (_watcher) return false; // Already watching
  if (!existsSync(dir)) return false;

  _watcherCallback = callback ?? null;

  try {
    _watcher = watch(dir, (eventType, filename) => {
      if (!filename || extname(filename) !== ".md") return;

      const filePath = join(dir, filename);

      if (existsSync(filePath)) {
        // File added or changed — reload
        const config = reloadFromPath(filePath);
        if (!config && _watcherCallback) {
          _watcherCallback("error", basename(filename, ".md"));
        }
      } else {
        // File deleted — remove from cache
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
export function _resetLoaderForTesting(): void {
  _cache.clear();
  stopWatcher();
}

/** Inject an archetype config directly — for testing only. */
export function _injectArchetypeForTesting(config: ArchetypeConfig): void {
  _cache.set(config.species.toLowerCase(), config);
}
