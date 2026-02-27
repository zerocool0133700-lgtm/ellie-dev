/**
 * Offline Config Cache — ELLIE-230
 *
 * Persists Supabase-sourced configuration to disk so the relay can start
 * with warm caches even when Supabase is unreachable.
 *
 * Cache files live in .cache/ (gitignored). Each key maps to a JSON file.
 * On successful Supabase fetch, data is written to disk in the background.
 * On startup or cache miss, disk cache is loaded as fallback.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { log } from "./logger.ts";

const logger = log.child("config-cache");

const CACHE_DIR = join(process.cwd(), ".cache");

/** Ensure the cache directory exists. */
async function ensureCacheDir(): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
  } catch {}
}

/**
 * Write data to disk cache. Fire-and-forget — never blocks the caller.
 */
export function writeToDisk<T>(key: string, data: T): void {
  const path = join(CACHE_DIR, `${key}.json`);
  ensureCacheDir()
    .then(() => writeFile(path, JSON.stringify(data), "utf-8"))
    .catch((err) => logger.warn(`Disk cache write failed: ${key}`, err));
}

/**
 * Read data from disk cache. Returns null if missing or corrupt.
 */
export async function readFromDisk<T>(key: string): Promise<T | null> {
  const path = join(CACHE_DIR, `${key}.json`);
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
