/**
 * River Document Pruner — ELLIE-581
 *
 * Defines TTL policy per document type and prunes expired documents
 * by moving them to an archive folder. QMD re-indexes after pruning.
 *
 * Two layers:
 *  - Pure: TTL policy, expiry checks, path builders (zero deps, testable)
 *  - Effectful: fs scan + move + QMD reindex (non-fatal)
 */

import { readdir, rename, mkdir, stat } from "fs/promises";
import { join, dirname } from "path";
import { RIVER_ROOT, qmdReindex } from "./api/bridge-river.ts";
import { log } from "./logger.ts";

const logger = log.child("river-pruner");

// ── TTL Policy ──────────────────────────────────────────────────────────────

/** TTL in days per document type. null = indefinite (never pruned). */
export interface TtlPolicy {
  [docType: string]: number | null;
}

export const DEFAULT_TTL_POLICY: TtlPolicy = {
  "dispatch-journal": 90,
  "post-mortems": 365,
  "work-trails": 180,
  "dashboards": null,   // living document, never pruned
  "tickets": null,       // context cards, indefinite
};

export const ARCHIVE_DIR = ".archive";

// ── Pure: Date extraction ───────────────────────────────────────────────────

/**
 * Extract a date from a filename or path.
 * Matches patterns like:
 *   - 2026-03-05.md (journal)
 *   - ELLIE-567-2026-03-05.md (post-mortem)
 *   - ELLIE-530-2026-03-05.md (work-trail)
 */
export function extractDateFromPath(path: string): string | null {
  const match = path.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/**
 * Check if a document has expired given its date and TTL in days.
 * Returns true if the document is older than ttlDays from referenceDate.
 */
export function isExpired(
  docDate: string,
  ttlDays: number,
  referenceDate?: string,
): boolean {
  const ref = referenceDate ? new Date(referenceDate) : new Date();
  const doc = new Date(docDate);
  const diffMs = ref.getTime() - doc.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays > ttlDays;
}

/**
 * Build the archive path for a document.
 * E.g. "dispatch-journal/2025-06-01.md" → ".archive/dispatch-journal/2025-06-01.md"
 */
export function buildArchivePath(relativePath: string): string {
  return `${ARCHIVE_DIR}/${relativePath}`;
}

// ── Pure: Classify documents ────────────────────────────────────────────────

/**
 * Determine the document type from its relative path.
 * Returns the first path segment (e.g. "dispatch-journal", "post-mortems").
 */
export function getDocType(relativePath: string): string {
  const firstSlash = relativePath.indexOf("/");
  return firstSlash === -1 ? relativePath : relativePath.slice(0, firstSlash);
}

// ── Effectful: Scan and prune ───────────────────────────────────────────────

export interface PruneResult {
  scanned: number;
  archived: number;
  skipped: number;
  errors: number;
  archivedFiles: string[];
}

export interface PruneDeps {
  /** Override RIVER_ROOT for testing. */
  riverRoot?: string;
  /** Override TTL policy. */
  policy?: TtlPolicy;
  /** Override reference date for expiry checks. */
  referenceDate?: string;
  /** If true, don't actually move files — just report what would be pruned. */
  dryRun?: boolean;
}

/**
 * Scan River vault directories and archive expired documents.
 * Non-fatal: catches errors per-file and continues.
 */
export async function pruneRiver(deps: PruneDeps = {}): Promise<PruneResult> {
  const root = deps.riverRoot ?? RIVER_ROOT;
  const policy = deps.policy ?? DEFAULT_TTL_POLICY;
  const result: PruneResult = {
    scanned: 0,
    archived: 0,
    skipped: 0,
    errors: 0,
    archivedFiles: [],
  };

  for (const [docType, ttl] of Object.entries(policy)) {
    if (ttl === null) {
      continue; // Indefinite — skip
    }

    const dirPath = join(root, docType);

    let files: string[];
    try {
      files = await scanDir(dirPath);
    } catch {
      // Directory doesn't exist yet — skip
      continue;
    }

    for (const file of files) {
      result.scanned++;
      const relativePath = `${docType}/${file}`;
      const date = extractDateFromPath(file);

      if (!date) {
        result.skipped++;
        continue;
      }

      if (!isExpired(date, ttl, deps.referenceDate)) {
        result.skipped++;
        continue;
      }

      // Document is expired — archive it
      const srcPath = join(root, relativePath);
      const archivePath = join(root, buildArchivePath(relativePath));

      try {
        if (!deps.dryRun) {
          await mkdir(dirname(archivePath), { recursive: true });
          await rename(srcPath, archivePath);
        }
        result.archived++;
        result.archivedFiles.push(relativePath);
      } catch (err) {
        result.errors++;
        logger.warn("Failed to archive file", {
          file: relativePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Reindex QMD after pruning (only if we actually moved files)
  if (result.archived > 0 && !deps.dryRun) {
    await qmdReindex();
  }

  logger.info("River pruning complete", {
    scanned: result.scanned,
    archived: result.archived,
    skipped: result.skipped,
    errors: result.errors,
    dryRun: deps.dryRun ?? false,
  });

  return result;
}

/**
 * Scan a directory for markdown files, including subdirectories.
 * Returns relative paths from the given directory.
 */
async function scanDir(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === ARCHIVE_DIR) continue; // Skip archive directory

    if (entry.isDirectory()) {
      const subFiles = await scanDir(join(dirPath, entry.name));
      for (const sf of subFiles) {
        files.push(`${entry.name}/${sf}`);
      }
    } else if (entry.name.endsWith(".md")) {
      files.push(entry.name);
    }
  }

  return files;
}
