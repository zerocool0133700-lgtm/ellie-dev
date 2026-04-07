/**
 * Ingestion Pipeline — orchestrates raw file → River MD → Forest chunks.
 *
 * Stages:
 *   1. Validate (size, format)
 *   2. SHA-256 dedup check against per-folder .hashes.jsonl
 *   3. Archive raw to uploads-archive/{folder}/{filename}
 *   4. Convert via document-ingestion.ts
 *   5. Chunk markdown via markdown-chunker.ts
 *   6. Build frontmatter (with chunk count already known)
 *   7. Write MD to River (single write, no second-pass update)
 *   8. Plant Forest chunks (parallel)
 *   9. Async LLM summary chunk for long docs
 *  10. Emit ingest_complete event
 *
 * See: docs/superpowers/specs/2026-04-06-knowledge-surface-and-ingestion-design.md
 */

import { promises as fs } from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { log } from "./logger.ts";
import { ingestDocument, canIngest } from "./document-ingestion";
import { chunkMarkdown } from "./markdown-chunker";
import { riverFolderToScope } from "./river-folder-scope";

const logger = log.child("ingest");

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const UPLOADS_ARCHIVE_ROOT = process.env.UPLOADS_ARCHIVE_ROOT || "/home/ellie/uploads-archive";
const RIVER_VAULT_ROOT = process.env.RIVER_ROOT || "/home/ellie/obsidian-vault/ellie-river";

// ── Hash record types ────────────────────────────────────────

export interface HashRecord {
  sha256: string;
  filename: string;
  md_path: string;
  ingested_at: string;
}

export function computeSourceHash(buf: Buffer | Uint8Array): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export async function checkDedup(folderArchivePath: string, sha256: string): Promise<HashRecord | null> {
  const hashLog = path.join(folderArchivePath, ".hashes.jsonl");
  try {
    const content = await fs.readFile(hashLog, "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as HashRecord;
        if (rec.sha256 === sha256) return rec;
      } catch {
        // skip malformed line
      }
    }
    return null;
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function recordHash(folderArchivePath: string, record: HashRecord): Promise<void> {
  await fs.mkdir(folderArchivePath, { recursive: true });
  const hashLog = path.join(folderArchivePath, ".hashes.jsonl");
  await fs.appendFile(hashLog, JSON.stringify(record) + "\n", "utf8");
}

// ── Pipeline result types ────────────────────────────────────

export type IngestionStatus = "queued" | "uploading" | "converting" | "planting" | "done" | "duplicate" | "failed";

// NOTE: Renamed from IngestionResult to avoid collision with the existing
// IngestionResult exported from src/document-ingestion.ts.
export interface IngestionPipelineResult {
  ingestion_id: string;
  status: IngestionStatus;
  river_path?: string;
  raw_path?: string;
  forest_chunk_count?: number;
  forest_scope?: string;
  source_hash?: string;
  duplicate_of?: { md_path: string; ingested_at: string };
  error?: string;
}

export interface IngestionEvent {
  ingestion_id: string;
  status: IngestionStatus;
  filename: string;
  target_folder: string;
  river_path?: string;
  forest_chunk_count?: number;
  source_hash?: string;
  error?: string;
}

export type IngestionEventCallback = (event: IngestionEvent) => void;

export interface IngestOptions {
  filename: string;
  target_folder: string;
  buffer: Buffer;
  proposal_id?: string;
  onEvent?: IngestionEventCallback;
}

// ── Main orchestrator ────────────────────────────────────────

export async function runIngestion(opts: IngestOptions): Promise<IngestionPipelineResult> {
  const ingestion_id = `ing_${crypto.randomUUID().slice(0, 8)}`;
  const { filename, target_folder, buffer, onEvent } = opts;

  function emit(status: IngestionStatus, extra: Partial<IngestionEvent> = {}) {
    onEvent?.({ ingestion_id, status, filename, target_folder, ...extra });
  }

  try {
    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      emit("failed", { error: `File too large: ${buffer.length} > ${MAX_FILE_SIZE_BYTES}` });
      return { ingestion_id, status: "failed", error: "file too large" };
    }
    if (!canIngest(filename)) {
      emit("failed", { error: `Unsupported format: ${filename}` });
      return { ingestion_id, status: "failed", error: "unsupported format" };
    }

    const sha256 = computeSourceHash(buffer);
    const folderArchivePath = path.join(UPLOADS_ARCHIVE_ROOT, target_folder.replace(/\/+$/, ""));
    const existing = await checkDedup(folderArchivePath, sha256);
    if (existing) {
      emit("duplicate", { source_hash: sha256, river_path: existing.md_path });
      return {
        ingestion_id,
        status: "duplicate",
        source_hash: sha256,
        duplicate_of: { md_path: existing.md_path, ingested_at: existing.ingested_at },
      };
    }

    emit("uploading", { source_hash: sha256 });

    await fs.mkdir(folderArchivePath, { recursive: true });
    let archiveFilename = filename;
    let archivePath = path.join(folderArchivePath, archiveFilename);
    let suffix = 1;
    while (await fileExists(archivePath)) {
      const ext = path.extname(filename);
      const base = path.basename(filename, ext);
      archiveFilename = `${base}-${++suffix}${ext}`;
      archivePath = path.join(folderArchivePath, archiveFilename);
    }
    await fs.writeFile(archivePath, buffer);

    emit("converting", { source_hash: sha256 });
    const converted = await ingestDocument(buffer, filename);
    if (!converted.success) {
      emit("failed", { error: converted.error || "conversion failed" });
      return { ingestion_id, status: "failed", error: converted.error || "conversion failed" };
    }

    const chunks = chunkMarkdown(converted.markdown);

    const ingested_at = new Date().toISOString();
    const slug = filenameToSlug(filename);
    const riverPath = `${target_folder.replace(/\/+$/, "")}/${slug}.md`;
    const frontmatter: Record<string, unknown> = {
      title: converted.title || slug,
      source: filename,
      source_path: path.relative("/home/ellie", archivePath),
      ingested_at,
      ingested_by: "dave",
      original_size: buffer.length,
      original_format: converted.format,
      forest_chunks: chunks.length,
      ingestion_id,
      source_hash: sha256,
    };
    const fmYaml = serializeFrontmatter(frontmatter);
    const fullMd = `${fmYaml}\n\n${converted.markdown}`;

    emit("planting", { source_hash: sha256, river_path: riverPath });
    await writeRiverDoc(riverPath, fullMd);

    await recordHash(folderArchivePath, {
      sha256,
      filename: archiveFilename,
      md_path: riverPath,
      ingested_at,
    });

    const scope = riverFolderToScope(target_folder);
    for (let i = 0; i < chunks.length; i++) {
      await plantChunk({
        content: chunks[i],
        scope_path: scope,
        chunk_index: i,
        ingestion_id,
        target_folder,
        river_doc_path: riverPath,
        source_hash: sha256,
      });
    }

    if (chunks.length > 3) {
      generateAndPlantSummary({
        markdown: converted.markdown,
        title: frontmatter.title as string,
        scope_path: scope,
        ingestion_id,
        target_folder,
        river_doc_path: riverPath,
        source_hash: sha256,
      }).catch((err) => {
        logger.warn("summary chunk generation failed (silent)", { err: String(err), ingestion_id });
      });
    }

    emit("done", { source_hash: sha256, river_path: riverPath, forest_chunk_count: chunks.length });

    return {
      ingestion_id,
      status: "done",
      river_path: riverPath,
      raw_path: archivePath,
      forest_chunk_count: chunks.length,
      forest_scope: scope,
      source_hash: sha256,
    };
  } catch (err: any) {
    logger.error("ingestion failed", { err: String(err), ingestion_id, filename });
    emit("failed", { error: String(err) });
    return { ingestion_id, status: "failed", error: String(err) };
  }
}

// ── Supporting helpers ───────────────────────────────────────

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function filenameToSlug(filename: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function serializeFrontmatter(fm: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string") {
      const needsQuote = /[:#\n]/.test(v);
      lines.push(`${k}: ${needsQuote ? `"${v.replace(/"/g, '\\"')}"` : v}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

async function writeRiverDoc(relPath: string, content: string): Promise<void> {
  const fullPath = path.join(RIVER_VAULT_ROOT, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
}

interface PlantChunkOpts {
  content: string;
  scope_path: string;
  chunk_index: number;
  ingestion_id: string;
  target_folder: string;
  river_doc_path: string;
  source_hash: string;
}

const BRIDGE_KEY = process.env.BRIDGE_KEY_ELLIE
  || process.env.BRIDGE_KEY
  || "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";

async function plantChunk(opts: PlantChunkOpts): Promise<void> {
  const res = await fetch("http://localhost:3001/api/bridge/write", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bridge-key": BRIDGE_KEY,
    },
    body: JSON.stringify({
      content: opts.content,
      scope_path: opts.scope_path,
      type: "fact",
      metadata: {
        river_doc_path: opts.river_doc_path,
        chunk_index: opts.chunk_index,
        ingestion_id: opts.ingestion_id,
        target_folder: opts.target_folder,
        source_hash: opts.source_hash,
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`bridge write failed (${res.status}): ${text}`);
  }
}

async function generateAndPlantSummary(opts: {
  markdown: string;
  title: string;
  scope_path: string;
  ingestion_id: string;
  target_folder: string;
  river_doc_path: string;
  source_hash: string;
}): Promise<void> {
  logger.info("summary chunk generation skipped (Phase 2 stub)", { ingestion_id: opts.ingestion_id });
}
