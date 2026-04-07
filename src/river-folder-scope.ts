/**
 * River folder → Forest scope mapping.
 *
 * Per-folder Forest scopes (2/river-ingest/{slug}) keep semantic search
 * coherent. Each top-level River folder gets its own scope.
 *
 * See: docs/superpowers/specs/2026-04-06-knowledge-surface-and-ingestion-design.md
 */

const SCOPE_ROOT = "2/river-ingest";

export function slugifyFolder(folder: string): string {
  if (!folder) return "";
  return folder
    .replace(/\/+$/, "")
    .toLowerCase()
    .replace(/[\/\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function riverFolderToScope(folder: string): string {
  const slug = slugifyFolder(folder);
  if (!slug) return `${SCOPE_ROOT}/misc`;
  return `${SCOPE_ROOT}/${slug}`;
}

export const RIVER_INGEST_SCOPE_ROOT = SCOPE_ROOT;
