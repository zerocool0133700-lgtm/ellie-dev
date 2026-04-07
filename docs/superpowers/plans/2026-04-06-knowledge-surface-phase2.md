# Knowledge Surface — Phase 2: River Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply Phase 1's reusable surface panel to the `/knowledge` River tab — restructure the tab into Zone A (navigation) + Zone B (collapsible ingestion drop zone), build the conversion pipeline that turns uploaded files into River markdown plus Forest semantic chunks, and wire Ellie's River agency so she can propose folder structure and the user accepts it visually.

**Architecture:** Three coordinated changes: (1) the River tab UI gets a two-zone layout with the search box as universal command bar, (2) a new ingestion endpoint on the relay (`POST /api/knowledge/ingest`) handles the full pipeline — dedup → archive → convert → River write → Forest chunks → notify, (3) the Ellie panel on River tab gets action handlers for the surface tools and surface-scoped thread auto-creation. By the end of Phase 2, dropping a PDF into River converts it, makes it semantically searchable from any chat, and asking Ellie to "load some quantum papers" walks through proposal → accept → upload → ingest end-to-end.

**Tech Stack:** TypeScript, Bun, Nuxt 4, Vue 3, Tailwind v4, ellie-forest, document-ingestion library

**Spec:** `docs/superpowers/specs/2026-04-06-knowledge-surface-and-ingestion-design.md` (Phase 2A/2B/2C)

**Prerequisite:** Phase 1 (`docs/superpowers/plans/2026-04-06-knowledge-surface-phase1.md`) must be complete. The reusable surface panel pattern, surface action tools, ProposalPreviewCard, and end-to-end wire format must all be in place.

**Repos:**
- `ellie-dev` (the relay) — ingestion endpoint, chunking, scope helper, retrieval extension
- `ellie-home` (the dashboard) — River tab refactor, drop zone, action handlers

---

## File Structure

| File | Repo | Responsibility |
|------|------|----------------|
| Create: `src/api/knowledge.ts` | ellie-dev | `POST /api/knowledge/ingest` and `DELETE /api/knowledge/purge` endpoints |
| Create: `src/ingestion-pipeline.ts` | ellie-dev | Pipeline orchestrator: validate, dedup, archive, convert, River write, Forest chunks, notify |
| Create: `src/markdown-chunker.ts` | ellie-dev | `chunkMarkdown(md, targetTokens)` paragraph-aware chunking with sentence-fallback |
| Create: `src/river-folder-scope.ts` | ellie-dev | `riverFolderToScope(folder)` helper for scope path resolution |
| Modify: `src/prompt-layers/knowledge.ts` | ellie-dev | Layer 3 retrieval enumerates `2/river-ingest/*` for non-surface contexts |
| Modify: `src/http-routes.ts` | ellie-dev | Register the new knowledge routes |
| Modify: `src/api/bridge-river.ts` | ellie-dev | Add `createFolder` operation if not present |
| Create: `tests/markdown-chunker.test.ts` | ellie-dev | Tests for chunking algorithm including edge cases |
| Create: `tests/ingestion-pipeline.test.ts` | ellie-dev | Tests for dedup check + scope resolution |
| Modify: `app/pages/knowledge.vue` | ellie-home | River tab gets two-zone layout, action handlers, surface-scoped thread |
| Create: `app/components/knowledge/RiverNavigationZone.vue` | ellie-home | Zone A: search box, selected folder, contents grid |
| Create: `app/components/knowledge/IngestDropZone.vue` | ellie-home | Zone B: collapsible drop zone, progress display, file picker |

---

### Task 1: chunkMarkdown helper with full test coverage

**Files:**
- Create: `/home/ellie/ellie-dev/src/markdown-chunker.ts`
- Create: `/home/ellie/ellie-dev/tests/markdown-chunker.test.ts`

**Context:** The chunking algorithm splits markdown into ~500-token chunks. It must be paragraph-aware, fall back to sentence splitting for huge paragraphs, and never bleed chunks across paragraph boundaries (the bug Brian's review caught in the spec).

- [ ] **Step 1: Write the failing tests**

Create `/home/ellie/ellie-dev/tests/markdown-chunker.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { chunkMarkdown, estimateTokens } from "../src/markdown-chunker";

describe("estimateTokens", () => {
  test("returns roughly chars/4", () => {
    expect(estimateTokens("hello world")).toBe(Math.ceil(11 / 4));
    expect(estimateTokens("")).toBe(0);
  });
});

describe("chunkMarkdown", () => {
  test("empty input returns empty array", () => {
    expect(chunkMarkdown("")).toEqual([]);
  });

  test("single short paragraph returns one chunk", () => {
    const md = "This is a single short paragraph that fits in one chunk.";
    const chunks = chunkMarkdown(md, 500);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(md);
  });

  test("multiple short paragraphs that fit return one chunk", () => {
    const md = "Para one.\n\nPara two.\n\nPara three.";
    const chunks = chunkMarkdown(md, 500);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("Para one");
    expect(chunks[0]).toContain("Para three");
  });

  test("paragraphs that exceed target split at paragraph boundaries", () => {
    // Each paragraph ~150 tokens (600 chars), target 200
    const p = "x".repeat(600);
    const md = `${p}\n\n${p}\n\n${p}`;
    const chunks = chunkMarkdown(md, 200);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Each chunk should contain whole paragraphs, not split mid-paragraph
    for (const c of chunks) {
      const xCount = (c.match(/x/g) || []).length;
      // Each chunk holds one or more whole copies of the 600-x paragraph
      expect(xCount % 600).toBe(0);
    }
  });

  test("single huge paragraph falls back to sentence splitting", () => {
    // One paragraph with 5 sentences, total ~1000 tokens (4000 chars), target 200 → 1.5x = 300
    const sentence = "x".repeat(800) + ".";
    const md = `${sentence} ${sentence} ${sentence} ${sentence} ${sentence}`;
    const chunks = chunkMarkdown(md, 200);
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("mixed: short + huge + short — sentence-split does not bleed across paragraphs", () => {
    const shortBefore = "Short paragraph before.";
    const huge = "x".repeat(800) + ". " + "y".repeat(800) + "."; // forces sentence split
    const shortAfter = "Short paragraph after.";
    const md = `${shortBefore}\n\n${huge}\n\n${shortAfter}`;
    const chunks = chunkMarkdown(md, 200);

    // The "Short paragraph after." must appear in its own chunk OR
    // a chunk that does NOT contain ANY of the huge paragraph's content.
    const afterChunks = chunks.filter(c => c.includes("Short paragraph after"));
    expect(afterChunks.length).toBeGreaterThan(0);
    for (const c of afterChunks) {
      // The bleed bug would put 'x' or 'y' from the huge paragraph in this chunk
      expect(c.includes("xxxxx")).toBe(false);
      expect(c.includes("yyyyy")).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/markdown-chunker.test.ts`
Expected: FAIL with "Cannot find module './src/markdown-chunker'"

- [ ] **Step 3: Implement the chunker**

Create `/home/ellie/ellie-dev/src/markdown-chunker.ts`:

```typescript
/**
 * Markdown chunker — paragraph-aware splitting with sentence fallback.
 *
 * Splits a markdown document into chunks of ~targetTokens each, never bleeding
 * sentence-split content across paragraph boundaries.
 *
 * See: docs/superpowers/specs/2026-04-06-knowledge-surface-and-ingestion-design.md
 *      "Chunking algorithm (corrected)"
 */

const DEFAULT_TARGET_TOKENS = 500;

export function estimateTokens(s: string): number {
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

function splitSentences(text: string): string[] {
  // Naive sentence splitter — splits on period/question/exclamation followed by whitespace.
  // Good enough for v1; doesn't handle "Mr." / "U.S." abbreviations specially.
  return text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
}

export function chunkMarkdown(md: string, targetTokens: number = DEFAULT_TARGET_TOKENS): string[] {
  if (!md || md.trim().length === 0) return [];

  const paragraphs = md.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);
  const chunks: string[] = [];
  let buffer = "";

  function flush() {
    if (buffer.trim()) {
      chunks.push(buffer.trim());
    }
    buffer = "";
  }

  for (const p of paragraphs) {
    const pTokens = estimateTokens(p);

    // Case 1: paragraph alone exceeds 1.5x target — hard-split it on sentences,
    // WITHIN the paragraph only. Flush current buffer first so sentence chunks
    // don't bleed into the previous paragraph.
    if (pTokens > targetTokens * 1.5) {
      flush();
      const sentences = splitSentences(p);
      let sentBuffer = "";
      for (const s of sentences) {
        const candidate = sentBuffer ? sentBuffer + " " + s : s;
        if (estimateTokens(candidate) > targetTokens && sentBuffer !== "") {
          chunks.push(sentBuffer.trim());
          sentBuffer = s;
        } else {
          sentBuffer = candidate;
        }
      }
      if (sentBuffer.trim()) {
        chunks.push(sentBuffer.trim());
      }
      // After sentence-splitting a huge paragraph, buffer is already empty —
      // do NOT continue accumulating into it from the next paragraph's content
      // until we process the next paragraph in the outer loop normally.
      continue;
    }

    // Case 2: adding this paragraph would exceed target — flush and start fresh
    const candidate = buffer ? buffer + "\n\n" + p : p;
    if (estimateTokens(candidate) > targetTokens && buffer !== "") {
      flush();
      buffer = p;
    } else {
      buffer = candidate;
    }
  }

  flush();
  return chunks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ellie/ellie-dev && bun test tests/markdown-chunker.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/markdown-chunker.ts tests/markdown-chunker.test.ts
git commit -m "[ELLIE-1455] add chunkMarkdown helper with paragraph-aware splitting

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: riverFolderToScope helper

**Files:**
- Create: `/home/ellie/ellie-dev/src/river-folder-scope.ts`

**Context:** Per-folder Forest scopes (`2/river-ingest/{slug}`) keep semantic neighborhoods clean. This helper produces the scope path from a target folder.

- [ ] **Step 1: Write the failing test**

Append to `/home/ellie/ellie-dev/tests/markdown-chunker.test.ts` (keeps tests co-located for now) OR create a new file. Let's create a new file to keep tests focused:

Create `/home/ellie/ellie-dev/tests/river-folder-scope.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { riverFolderToScope, slugifyFolder } from "../src/river-folder-scope";

describe("slugifyFolder", () => {
  test("strips trailing slash", () => {
    expect(slugifyFolder("research/")).toBe("research");
  });

  test("converts path separators to dashes", () => {
    expect(slugifyFolder("research/quantum-computing/")).toBe("research-quantum-computing");
  });

  test("lowercases the result", () => {
    expect(slugifyFolder("Architecture/AI/")).toBe("architecture-ai");
  });

  test("handles deeply nested paths", () => {
    expect(slugifyFolder("a/b/c/d/")).toBe("a-b-c-d");
  });

  test("strips invalid characters", () => {
    expect(slugifyFolder("foo bar/baz!")).toBe("foo-bar-baz");
  });
});

describe("riverFolderToScope", () => {
  test("returns 2/river-ingest/{slug}", () => {
    expect(riverFolderToScope("research/")).toBe("2/river-ingest/research");
    expect(riverFolderToScope("research/quantum-computing/")).toBe("2/river-ingest/research-quantum-computing");
  });

  test("falls back to 'misc' for empty input", () => {
    expect(riverFolderToScope("")).toBe("2/river-ingest/misc");
    expect(riverFolderToScope("/")).toBe("2/river-ingest/misc");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/river-folder-scope.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

Create `/home/ellie/ellie-dev/src/river-folder-scope.ts`:

```typescript
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
  // Strip trailing slash, lowercase, replace path separators and invalid chars with dashes
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ellie/ellie-dev && bun test tests/river-folder-scope.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/river-folder-scope.ts tests/river-folder-scope.test.ts
git commit -m "[ELLIE-1455] add riverFolderToScope helper for per-folder scope paths

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The ingestion pipeline orchestrator

**Files:**
- Create: `/home/ellie/ellie-dev/src/ingestion-pipeline.ts`
- Create: `/home/ellie/ellie-dev/tests/ingestion-pipeline.test.ts`

**Context:** This module orchestrates the full pipeline: validate → dedup check → archive raw → convert → chunk → frontmatter → River write → Forest plant → notify. It does NOT expose an HTTP endpoint (Task 4 does that). It's a pure module that takes a buffer and metadata, returns a result, and emits events via callback.

**Audit corrections (2026-04-06):**
- The pipeline result type is named `IngestionPipelineResult` to avoid collision with the existing `IngestionResult` exported from `src/document-ingestion.ts`.
- `bridgeWrite` is **not** an exported function in `src/api/bridge.ts` — only `bridgeWriteEndpoint(req, res)` exists. The plant step calls `/api/bridge/write` via `fetch("http://localhost:3001/api/bridge/write", …)` using the bridge key from the env, mirroring how `prompt-layers/knowledge.ts` calls `/api/bridge/read`.
- `ensureScopeExists` is removed — `/api/bridge/write` auto-creates the scope on first write, so no separate call is needed.

- [ ] **Step 1: Write the failing test (focused on dedup check + scope resolution)**

Create `/home/ellie/ellie-dev/tests/ingestion-pipeline.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { computeSourceHash, checkDedup, recordHash } from "../src/ingestion-pipeline";

describe("computeSourceHash", () => {
  test("produces stable SHA-256 hex", () => {
    const buf = Buffer.from("hello world");
    const h1 = computeSourceHash(buf);
    const h2 = computeSourceHash(buf);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  test("different content yields different hash", () => {
    const a = computeSourceHash(Buffer.from("hello"));
    const b = computeSourceHash(Buffer.from("world"));
    expect(a).not.toBe(b);
  });
});

describe("checkDedup + recordHash", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ingest-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("checkDedup returns null when no .hashes.jsonl exists", async () => {
    const result = await checkDedup(tmpDir, "abc123");
    expect(result).toBeNull();
  });

  test("recordHash creates .hashes.jsonl and checkDedup finds it", async () => {
    await recordHash(tmpDir, {
      sha256: "abc123",
      filename: "paper.pdf",
      md_path: "research/paper.md",
      ingested_at: "2026-04-06T15:30:00Z",
    });

    const result = await checkDedup(tmpDir, "abc123");
    expect(result).not.toBeNull();
    expect(result?.filename).toBe("paper.pdf");
    expect(result?.md_path).toBe("research/paper.md");
  });

  test("checkDedup with wrong hash returns null", async () => {
    await recordHash(tmpDir, {
      sha256: "abc123",
      filename: "paper.pdf",
      md_path: "research/paper.md",
      ingested_at: "2026-04-06T15:30:00Z",
    });

    const result = await checkDedup(tmpDir, "different-hash");
    expect(result).toBeNull();
  });

  test("multiple records appended without overwriting", async () => {
    await recordHash(tmpDir, { sha256: "h1", filename: "a.pdf", md_path: "a.md", ingested_at: "t1" });
    await recordHash(tmpDir, { sha256: "h2", filename: "b.pdf", md_path: "b.md", ingested_at: "t2" });

    const a = await checkDedup(tmpDir, "h1");
    const b = await checkDedup(tmpDir, "h2");
    expect(a?.filename).toBe("a.pdf");
    expect(b?.filename).toBe("b.pdf");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/ingestion-pipeline.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the dedup helpers and the orchestrator**

Create `/home/ellie/ellie-dev/src/ingestion-pipeline.ts`:

```typescript
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
  target_folder: string; // e.g. "research/quantum/" — relative to River root
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
    // Stage 1: Validate
    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      emit("failed", { error: `File too large: ${buffer.length} > ${MAX_FILE_SIZE_BYTES}` });
      return { ingestion_id, status: "failed", error: "file too large" };
    }
    if (!canIngest(filename)) {
      emit("failed", { error: `Unsupported format: ${filename}` });
      return { ingestion_id, status: "failed", error: "unsupported format" };
    }

    // Stage 2: Dedup check
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

    // Stage 3: Archive raw
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

    // Stage 4: Convert
    emit("converting", { source_hash: sha256 });
    const converted = await ingestDocument(buffer, filename);
    if (!converted.success) {
      emit("failed", { error: converted.error || "conversion failed" });
      return { ingestion_id, status: "failed", error: converted.error || "conversion failed" };
    }

    // Stage 5: Chunk
    const chunks = chunkMarkdown(converted.markdown);

    // Stage 6: Build frontmatter (final form, includes chunk count)
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

    // Stage 7: Write MD to River — single write
    emit("planting", { source_hash: sha256, river_path: riverPath });
    await writeRiverDoc(riverPath, fullMd);

    // Record hash AFTER successful river write so we don't dedup on a failed ingest
    await recordHash(folderArchivePath, {
      sha256,
      filename: archiveFilename,
      md_path: riverPath,
      ingested_at,
    });

    // Stage 8: Plant Forest chunks (scope is auto-created on first /api/bridge/write)
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

    // Stage 9: Async LLM summary for long docs (fire and forget)
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
        logger.warn({ err: String(err), ingestion_id }, "summary chunk generation failed (silent)");
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
    logger.error({ err: String(err), ingestion_id, filename }, "ingestion failed");
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
      // Quote strings that contain special chars
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
  // Trigger async QMD reindex via the existing river bridge helper if available.
  // We do NOT wait for this — eventually consistent.
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
  // bridgeWriteEndpoint is the only export — call it via self-fetch to keep
  // this module pure (no req/res mocking). Mirrors prompt-layers/knowledge.ts
  // calling /api/bridge/read.
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
  // Phase 2 stub: implement LLM summary in a follow-up task once the core pipeline ships.
  // This function exists as a hook so the pipeline structure is correct.
  // For now, log and skip.
  logger.info({ ingestion_id: opts.ingestion_id }, "summary chunk generation skipped (Phase 2 stub)");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ellie/ellie-dev && bun test tests/ingestion-pipeline.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/ingestion-pipeline.ts tests/ingestion-pipeline.test.ts
git commit -m "[ELLIE-1455] add ingestion pipeline orchestrator with dedup + chunk + plant

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: HTTP endpoints for ingest and purge

**Files:**
- Create: `/home/ellie/ellie-dev/src/api/knowledge.ts`
- Modify: `/home/ellie/ellie-dev/src/http-routes.ts`

**Context:** Wire the pipeline to HTTP. `POST /api/knowledge/ingest` accepts a JSON body with the file as base64 (matching the existing `/api/ingest/file` convention from ELLIE-1087), calls `runIngestion`, broadcasts `ingest_*` events to all connected ellie-chat WebSocket clients. `DELETE /api/knowledge/purge` removes a previously-ingested file.

**Audit corrections (2026-04-06):**
- The relay uses raw Node `http` (`req.on("data") / req.on("end")`, `res.writeHead` / `res.end`) — **not** the Fetch API. The handlers must take `(req: IncomingMessage, res: ServerResponse)`, not `(req: Request) => Promise<Response>`. Mirror the existing `/api/ingest/file` block in `http-routes.ts:6942`.
- `broadcastToEllieChatClients` is exported from `src/relay-state.ts` (not a non-existent `ws-delivery`). Verified at `relay-state.ts:129`.
- Auth uses the shared `authenticateBridgeKey(...)` helper from `src/api/bridge.ts:52`, not a local `process.env.BRIDGE_KEY` check. Mirror the wrap-with-mockRes pattern in `http-routes.ts` around line 6997.
- Multipart upload is done as **base64-in-JSON** to match `/api/ingest/file` (no new package, no FormData parser): the body is `{ filename, content, target_folder, proposal_id? }` where `content` is base64.
- `bridgeDeleteByMetadata` does not exist. The purge step deletes the River MD file only and logs a TODO for Forest chunk cleanup — that follow-up is tracked separately.

- [ ] **Step 1: Read the existing http-routes structure**

Run: `cd /home/ellie/ellie-dev && head -80 src/http-routes.ts`

Identify the pattern used to register routes (likely a switch statement or a route registry).

- [ ] **Step 2: Create the knowledge API module**

Create `/home/ellie/ellie-dev/src/api/knowledge.ts`:

```typescript
/**
 * Knowledge API — ingest and purge endpoints.
 *
 * POST   /api/knowledge/ingest  — base64-in-JSON upload, runs the pipeline
 * DELETE /api/knowledge/purge   — remove a previously-ingested file
 *
 * Style note: Node http (IncomingMessage / ServerResponse), NOT Fetch API.
 * Mirrors the existing /api/ingest/file block at http-routes.ts:6942.
 *
 * See: docs/superpowers/specs/2026-04-06-knowledge-surface-and-ingestion-design.md
 */

import type { IncomingMessage, ServerResponse } from "http";
import { promises as fs } from "fs";
import * as path from "path";
import { log } from "../logger.ts";
import { runIngestion, type IngestionEvent } from "../ingestion-pipeline";
import { broadcastToEllieChatClients } from "../relay-state.ts";
import { authenticateBridgeKey } from "./bridge.ts";

const logger = log.child("api:knowledge");

const RIVER_VAULT_ROOT = process.env.RIVER_ROOT || "/home/ellie/obsidian-vault/ellie-river";

// Server-side enforcement: max 50 in-flight ingestions per process
const MAX_IN_FLIGHT = 50;
let inFlight = 0;

/**
 * Build a tiny mock ApiResponse so we can reuse authenticateBridgeKey
 * (which expects an Express-ish res object) on top of raw Node res.
 * Same pattern used in http-routes.ts around line 6999.
 */
function mockApiResFor(res: ServerResponse) {
  return {
    status: (code: number) => ({
      json: (data: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      },
    }),
    json: (data: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    },
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

export async function handleIngest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Auth (shared bridge-key middleware)
  const authRes = mockApiResFor(res);
  const bridgeKey = await authenticateBridgeKey(
    req.headers["x-bridge-key"] as string | undefined,
    authRes as any,
    "write",
  );
  if (!bridgeKey) return; // 401/403 already sent

  if (inFlight >= MAX_IN_FLIGHT) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "too many in-flight ingestions" }));
    return;
  }

  let body: { filename?: string; content?: string; target_folder?: string; proposal_id?: string };
  try {
    body = (await readJsonBody(req)) as any;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  const { filename, content, target_folder, proposal_id } = body;
  if (!filename || !content || !target_folder) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "filename, content (base64), and target_folder are required" }));
    return;
  }

  const buffer = Buffer.from(content, "base64");

  inFlight++;
  try {
    const result = await runIngestion({
      filename,
      target_folder,
      buffer,
      proposal_id,
      onEvent: (event: IngestionEvent) => {
        broadcastToEllieChatClients({
          type: "ingest_event",
          ...event,
          ts: Date.now(),
        });
      },
    });

    // Final ingest_complete event (only on success)
    if (result.status === "done") {
      broadcastToEllieChatClients({
        type: "ingest_complete",
        ingestion_id: result.ingestion_id,
        river_path: result.river_path,
        forest_chunk_count: result.forest_chunk_count,
        target_folder,
        file_name: filename,
        source_hash: result.source_hash,
        ts: Date.now(),
      });
    }

    res.writeHead(result.status === "failed" ? 500 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } finally {
    inFlight--;
  }
}

export async function handlePurge(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const authRes = mockApiResFor(res);
  const bridgeKey = await authenticateBridgeKey(
    req.headers["x-bridge-key"] as string | undefined,
    authRes as any,
    "write",
  );
  if (!bridgeKey) return;

  let body: { river_path?: string; ingestion_id?: string; target_folder?: string };
  try {
    body = (await readJsonBody(req)) as any;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  if (!body.river_path && !body.ingestion_id && !body.target_folder) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "must provide river_path, ingestion_id, or target_folder" }));
    return;
  }

  const removed = { river_md: 0, raw_files: 0, forest_chunks: 0 };

  if (body.river_path) {
    const fullPath = path.join(RIVER_VAULT_ROOT, body.river_path);
    try {
      await fs.unlink(fullPath);
      removed.river_md++;
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
        return;
      }
    }
    // TODO: Forest chunk cleanup by river_doc_path metadata.
    // No bridge helper exists yet for "delete memories where metadata.river_doc_path = X".
    // Tracked as a follow-up — purge is a developer tool until the UI catches up.
    logger.info({ river_path: body.river_path }, "purged river MD; forest chunks left in place (TODO)");
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: true, removed }));
}
```

- [ ] **Step 3: Register the routes in http-routes.ts**

Open `src/http-routes.ts` and add the import at the top of the file (alongside the other `./api/...` imports), then add the two route blocks immediately after the existing `/api/ingest/url` block (~line 6992):

```typescript
// At the top of http-routes.ts, near other api imports:
import { handleIngest as handleKnowledgeIngest, handlePurge as handleKnowledgePurge } from "./api/knowledge.ts";
```

```typescript
// After the existing /api/ingest/url block (around line 6992):

// ── ELLIE-1455: Knowledge ingestion pipeline ──
if (url.pathname === "/api/knowledge/ingest" && req.method === "POST") {
  (async () => { await handleKnowledgeIngest(req, res); })();
  return;
}
if (url.pathname === "/api/knowledge/purge" && req.method === "DELETE") {
  (async () => { await handleKnowledgePurge(req, res); })();
  return;
}
```

The wrapping IIFE matches the pattern used by other async route handlers in `http-routes.ts` (search for `(async () => { ... })();`).

- [ ] **Step 4: Restart the relay and smoke-test the ingest endpoint**

```bash
systemctl --user restart ellie-chat-relay
```

In another terminal, post a small test markdown file (base64-in-JSON, matching `/api/ingest/file`):

```bash
echo -e "# Test Doc\n\nThis is a test paragraph.\n\nAnother paragraph here." > /tmp/test-ingest.md
B64=$(base64 -w0 /tmp/test-ingest.md)
curl -s -X POST http://localhost:3001/api/knowledge/ingest \
  -H "x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" \
  -H "Content-Type: application/json" \
  -d "{\"filename\":\"test-ingest.md\",\"content\":\"$B64\",\"target_folder\":\"test-ingest/\"}" | jq .
```

Expected: `{ "ingestion_id": "ing_...", "status": "done", "river_path": "test-ingest/test-ingest.md", "forest_chunk_count": 1, ... }`

Then verify the file landed:

```bash
ls -la /home/ellie/obsidian-vault/ellie-river/test-ingest/
ls -la /home/ellie/uploads-archive/test-ingest/
```

Both should contain entries for the test file. Drop the same file again to verify dedup:

```bash
curl -s -X POST http://localhost:3001/api/knowledge/ingest \
  -H "x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" \
  -H "Content-Type: application/json" \
  -d "{\"filename\":\"test-ingest.md\",\"content\":\"$B64\",\"target_folder\":\"test-ingest/\"}" | jq .
```

Expected: `{ "status": "duplicate", "duplicate_of": { ... } }`

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/api/knowledge.ts src/http-routes.ts
git commit -m "[ELLIE-1455] add /api/knowledge/ingest and /api/knowledge/purge endpoints

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Layer 3 retrieval enumeration for cross-scope queries

**Files:**
- Modify: `/home/ellie/ellie-dev/src/prompt-layers/knowledge.ts`

**Context:** When Ellie is on `/ellie-chat`, Telegram, or any non-knowledge surface, her Layer 3 retrieval doesn't know to look in `2/river-ingest/*` for ingested content. Without this fix, ingested PDFs are unfindable from anywhere except the surface they were uploaded on.

**Audit corrections (2026-04-06):**
- `fetchForestKnowledge(message, scopePath)` is **module-private** in `knowledge.ts:165` and returns a **rendered string** (`## KNOWLEDGE\n- [type, scope] content\n…`), not arrays of memory objects. There is no score-based merging to do — we fan out to multiple scopes, get back rendered strings, and concatenate.
- `listScopes` does **not** exist in `src/api/bridge.ts` (only `bridgeScopesEndpoint(req, res)` does). The cross-scope walk uses `fetch("http://localhost:3001/api/bridge/scopes")` to list scopes — same self-fetch pattern as the existing `fetchForestKnowledge`.
- The strategy is: keep the existing single-scope fetch path untouched, and for non-surface modes ALSO call a new `fetchRiverIngestKnowledge` that enumerates `2/river-ingest/*` scopes and unions their rendered results into `forestKnowledge`.

- [ ] **Step 1: Inspect the current knowledge layer**

Run: `grep -n "fetchForestKnowledge\|retrieveKnowledge\|BRIDGE_KEY\|/api/bridge/read" /home/ellie/ellie-dev/src/prompt-layers/knowledge.ts`

Confirm:
- `fetchForestKnowledge(message, scopePath)` is private and returns `Promise<string>`.
- `retrieveKnowledge(message, mode, agent)` returns `KnowledgeResult` with `forestKnowledge: string`.
- A `BRIDGE_KEY` constant is already defined and used in `fetchForestKnowledge`.

- [ ] **Step 2: Add a multi-scope fetch + scope enumerator**

Add these two functions to `src/prompt-layers/knowledge.ts`, just below the existing `fetchForestKnowledge`:

```typescript
/**
 * Enumerate child scopes under 2/river-ingest/ via /api/bridge/scopes.
 * Returns scope paths like ["2/river-ingest/research", "2/river-ingest/architecture"].
 */
async function enumerateRiverIngestScopes(): Promise<string[]> {
  try {
    const res = await fetch("http://localhost:3001/api/bridge/scopes", {
      headers: { "x-bridge-key": BRIDGE_KEY },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { scopes?: Array<{ scope_path?: string; path?: string }> };
    const list = data.scopes ?? [];
    return list
      .map((s) => s.scope_path || s.path || "")
      .filter((p): p is string => typeof p === "string" && p.startsWith("2/river-ingest/"));
  } catch (err) {
    logger.warn("river-ingest scope enumeration failed", { err });
    return [];
  }
}

/**
 * Fan out fetchForestKnowledge across all 2/river-ingest/* scopes and
 * concatenate the rendered results. Each call already returns a "## KNOWLEDGE\n…"
 * block; we strip duplicate headers and merge under a single header.
 */
async function fetchRiverIngestKnowledge(message: string): Promise<string> {
  const scopes = await enumerateRiverIngestScopes();
  if (scopes.length === 0) return "";
  const results = await Promise.all(scopes.map((s) => fetchForestKnowledge(message, s)));
  const lines = results
    .filter((r) => r && r.trim().length > 0)
    .map((r) => r.replace(/^##\s+KNOWLEDGE\n?/i, "").trim())
    .filter((r) => r.length > 0);
  if (lines.length === 0) return "";
  return `## KNOWLEDGE (river-ingest)\n${lines.join("\n")}`;
}
```

- [ ] **Step 3: Call the new helper from `retrieveKnowledge` for non-surface modes**

Edit the existing `retrieveKnowledge` function. Replace the `Promise.all` block with:

```typescript
  const [registry, forestKnowledge, expansion, riverIngestKnowledge] = await Promise.all([
    loadSkillRegistry(),
    fetchForestKnowledge(message, scopePath),
    fetchContextualExpansion(message, agent),
    // Surface-mode requests already target the right scope; for the rest,
    // walk 2/river-ingest/* and union the results.
    mode === "surface" ? Promise.resolve("") : fetchRiverIngestKnowledge(message),
  ]);
```

Then merge the two forest strings before returning:

```typescript
  const mergedForest = [forestKnowledge, riverIngestKnowledge]
    .filter((s) => s && s.trim().length > 0)
    .join("\n\n");

  return { skillDocs, forestKnowledge: mergedForest, expansion };
```

If the project's `LayeredMode` type does not have a `"surface"` literal, gate on `mode !== "heartbeat"` instead — the goal is "skip when we already targeted the right scope, do it everywhere else."

- [ ] **Step 3a: Confirm `LayeredMode` literals**

Run: `grep -n "type LayeredMode\|LayeredMode =" /home/ellie/ellie-dev/src/prompt-layers/types.ts`

Use whichever literal denotes a surface-scoped request. If unsure, fall back to the heartbeat-only gate.

- [ ] **Step 4: Restart relay and verify ingested content is findable from /ellie-chat**

```bash
systemctl --user restart ellie-chat-relay
```

In `/ellie-chat`, ask "what's in test-ingest?" or "summarize the test doc I just loaded." Ellie's response should reference content from the test markdown file ingested in Task 4.

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/prompt-layers/knowledge.ts
git commit -m "[ELLIE-1455] Layer 3 retrieval enumerates 2/river-ingest/* scopes

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Surface-scoped thread auto-creation for River panel — **DEFERRED**

**Status:** ⛔ DEFERRED out of Phase 2 during pre-execution audit (2026-04-06).

**Why:** `useEllieChat` is currently a module-level singleton with shared `messages` ref and `currentChannelId`. Switching channels from inside `EllieSurfacePanel.vue` on mount would mutate the shared state and pollute every other page using the composable (top bar, sidebar, conversation pages). Shipping surface-scoped threads requires redesigning `useEllieChat` for non-singleton usage (factory pattern or scoped instances) — out of scope for Phase 2.

**Forest record:** memory `dd8ac554-a01c-4dcc-bb18-8e94cb2a95b5` (scope `2/1`).

**Follow-up ticket:** TODO — file as separate Plane issue ("Surface-scoped chat threads — useEllieChat redesign").

**Phase 2 behavior without this task:** River panel uses the same default thread as the rest of the dashboard. Surface context still flows through the layered prompt + tool layer (Tasks 1–5), so Ellie still knows the user is in `knowledge-river`. Only thread isolation is missing.

---

### Task 7: RiverNavigationZone component (Zone A)

**Files:**
- Create: `/home/ellie/ellie-home/app/components/knowledge/RiverNavigationZone.vue`

**Context:** Zone A is the top portion of the River tab. It has the search-as-command-bar, the selected folder header, and the folder contents grid. Selection changes emit events that the parent uses to update the surface context.

- [ ] **Step 1: Create the component**

Create `/home/ellie/ellie-home/app/components/knowledge/RiverNavigationZone.vue`:

```vue
<template>
  <div class="bg-gray-900 border border-gray-700/50 rounded-lg p-3 flex flex-col h-full">
    <!-- Header -->
    <div class="flex items-center gap-2 mb-2">
      <span class="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">River — Obsidian Vault</span>
      <span class="text-[10px] text-gray-600">{{ totalDocs }} docs · {{ totalFolders }} folders</span>
      <div class="flex-1"></div>
      <button v-if="selectedFolder !== '/'" @click="navigateUp" class="text-[10px] text-gray-500 hover:text-gray-300">↑ up</button>
    </div>

    <!-- Search box -->
    <input
      v-model="searchInput"
      @keydown.enter="onCommit"
      placeholder="Search River — type to find or create folder…"
      class="w-full bg-gray-950 border border-gray-700 text-gray-200 px-3 py-1.5 rounded text-xs focus:outline-none focus:border-cyan-600 mb-2"
    />

    <!-- Search results / contents -->
    <div class="flex-1 overflow-y-auto">
      <div v-if="searchInput.trim() && searchResults.length === 0" class="text-xs text-cyan-400 cursor-pointer hover:text-cyan-300 px-2 py-1.5" @click="createFolderFromSearch">
        + Create '{{ searchInput.trim() }}' here →
      </div>

      <template v-if="!searchInput.trim()">
        <div class="text-[10px] text-gray-600 mb-1">SELECTED: <span class="text-cyan-400">{{ selectedFolder || '(none)' }}</span> — {{ contents.length }} items</div>
        <div class="grid grid-cols-2 gap-1">
          <div
            v-for="item in contents"
            :key="item.path"
            @click="onItemClick(item)"
            class="text-xs text-gray-300 hover:text-cyan-300 cursor-pointer truncate"
          >
            <span v-if="item.is_folder">📁</span>
            <span v-else>📄</span>
            {{ item.name }}
            <span v-if="item.is_new" class="text-[9px] bg-emerald-700 text-emerald-100 px-1 rounded ml-1">NEW</span>
          </div>
        </div>
      </template>

      <template v-else>
        <div
          v-for="result in searchResults"
          :key="result.path"
          @click="selectFolder(result.path)"
          class="text-xs text-gray-300 hover:text-cyan-300 cursor-pointer px-2 py-1"
        >
          📁 {{ result.path }}
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'

interface RiverItem {
  path: string
  name: string
  is_folder: boolean
  is_new?: boolean
}

const props = defineProps<{
  selectedFolder: string
  contents: RiverItem[]
  totalDocs: number
  totalFolders: number
  allFolders: string[]  // for client-side search filtering
}>()

const emit = defineEmits<{
  'select-folder': [path: string]
  'create-folder': [path: string]
  'navigate-up': []
}>()

const searchInput = ref('')

const searchResults = computed(() => {
  const q = searchInput.value.trim().toLowerCase()
  if (!q) return []
  return props.allFolders
    .filter(f => f.toLowerCase().includes(q))
    .slice(0, 20)
    .map(path => ({ path }))
})

function selectFolder(path: string) {
  emit('select-folder', path)
  searchInput.value = ''
}

function createFolderFromSearch() {
  const name = searchInput.value.trim()
  if (!name) return
  // If user typed "research/quantum/", treat as a relative path under current selection
  const fullPath = name.includes('/') ? name : `${props.selectedFolder.replace(/\/$/, '')}/${name}/`
  emit('create-folder', fullPath.endsWith('/') ? fullPath : fullPath + '/')
  searchInput.value = ''
}

function onCommit() {
  if (searchResults.value.length > 0) {
    selectFolder(searchResults.value[0].path)
  } else if (searchInput.value.trim()) {
    createFolderFromSearch()
  }
}

function onItemClick(item: RiverItem) {
  if (item.is_folder) {
    emit('select-folder', item.path)
  }
  // Files: future = open preview modal
}

function navigateUp() {
  emit('navigate-up')
}
</script>
```

- [ ] **Step 2: Build and verify**

Run: `cd /home/ellie/ellie-home && bun run build 2>&1 | tail -5`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-home
git add app/components/knowledge/RiverNavigationZone.vue
git commit -m "[ELLIE-1455] add RiverNavigationZone component (Zone A of River tab)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: IngestDropZone component (Zone B)

**Files:**
- Create: `/home/ellie/ellie-home/app/components/knowledge/IngestDropZone.vue`

**Context:** Zone B is collapsible. Default state is a thin bar at the bottom; expands on click, hover, or file drag. Shows progress per file during ingestion.

- [ ] **Step 1: Create the component**

Create `/home/ellie/ellie-home/app/components/knowledge/IngestDropZone.vue`:

```vue
<template>
  <div
    @mouseenter="onHover"
    @mouseleave="onUnhover"
    @dragover.prevent="onDragOver"
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
    class="bg-gray-900 border-2 border-dashed transition-all duration-200"
    :class="[
      expanded ? 'border-cyan-600' : 'border-gray-700',
      expanded ? 'h-[260px]' : 'h-[40px]',
      isDragging ? 'bg-cyan-950/40' : ''
    ]"
  >
    <!-- Collapsed bar -->
    <div
      v-if="!expanded"
      @click="expanded = true"
      class="h-full flex items-center px-3 cursor-pointer text-xs text-cyan-400 hover:text-cyan-300"
    >
      ⬆ Ingest into <span class="font-semibold mx-1">{{ targetFolder || '(select a folder above)' }}</span>
      <div class="flex-1"></div>
      <span class="text-[10px] text-gray-500">click to expand</span>
    </div>

    <!-- Expanded zone -->
    <div v-else class="h-full p-4 flex flex-col">
      <div class="flex items-center mb-3">
        <span class="text-xs text-cyan-400 font-bold">⬆ INGEST INTO {{ targetFolder || '(select a folder above)' }}</span>
        <div class="flex-1"></div>
        <button @click="expanded = false" class="text-[10px] text-gray-500 hover:text-gray-300">collapse ↑</button>
      </div>

      <div class="flex-1 flex flex-col items-center justify-center" v-if="!ingestionRows.length">
        <div class="text-xs text-gray-400 mb-2">Drop files here — or click below to browse</div>
        <input ref="fileInputRef" type="file" multiple class="hidden" @change="onFileSelect" />
        <button
          @click="fileInputRef?.click()"
          :disabled="!targetFolder"
          class="bg-cyan-700 text-cyan-50 px-3 py-1.5 rounded text-xs font-semibold hover:bg-cyan-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Choose Files
        </button>
        <div class="text-[9px] text-gray-600 mt-2">PDF · Word · HTML · CSV · JSON · MD · …</div>
        <div class="text-[9px] text-gray-700 mt-1">raw → uploads-archive/{{ targetFolder }} · md → {{ targetFolder }} · summary → Forest</div>
      </div>

      <!-- Progress display -->
      <div v-else class="flex-1 overflow-y-auto space-y-1">
        <div
          v-for="row in ingestionRows"
          :key="row.id"
          class="text-xs flex items-center gap-2"
        >
          <span class="flex-1 truncate text-gray-300">{{ row.filename }}</span>
          <span class="text-[10px]" :class="statusColor(row.status)">{{ statusLabel(row.status) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'

interface IngestionRow {
  id: string
  filename: string
  status: 'queued' | 'uploading' | 'converting' | 'planting' | 'done' | 'duplicate' | 'failed'
  error?: string
}

const props = defineProps<{
  targetFolder: string
  rows: IngestionRow[]
}>()

const emit = defineEmits<{
  'files-selected': [files: File[]]
  'expand': []
  'collapse': []
}>()

const expanded = ref(false)
const isDragging = ref(false)
const fileInputRef = ref<HTMLInputElement | null>(null)
let hoverTimer: ReturnType<typeof setTimeout> | null = null

const ingestionRows = computed(() => props.rows)

// Auto-collapse 5 seconds after the last row finishes
watch(() => props.rows, (rows) => {
  if (rows.length === 0) return
  const allDone = rows.every(r => r.status === 'done' || r.status === 'failed' || r.status === 'duplicate')
  if (allDone && expanded.value) {
    setTimeout(() => { if (props.rows.every(r => r.status === 'done' || r.status === 'failed' || r.status === 'duplicate')) expanded.value = false }, 5000)
  }
})

function onHover() {
  if (hoverTimer) return
  hoverTimer = setTimeout(() => {
    expanded.value = true
    emit('expand')
  }, 300)
}

function onUnhover() {
  if (hoverTimer) {
    clearTimeout(hoverTimer)
    hoverTimer = null
  }
}

function onDragOver(e: DragEvent) {
  isDragging.value = true
  expanded.value = true
  emit('expand')
}

function onDragLeave() {
  isDragging.value = false
}

function onDrop(e: DragEvent) {
  isDragging.value = false
  const files = Array.from(e.dataTransfer?.files || [])
  if (files.length > 0) emit('files-selected', files)
}

function onFileSelect(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files || [])
  if (files.length > 0) emit('files-selected', files)
}

function statusLabel(s: IngestionRow['status']): string {
  return {
    queued: 'queued',
    uploading: 'uploading…',
    converting: 'converting…',
    planting: 'planting…',
    done: '✓ done',
    duplicate: '⊘ duplicate',
    failed: '✗ failed',
  }[s]
}

function statusColor(s: IngestionRow['status']): string {
  if (s === 'done') return 'text-emerald-400'
  if (s === 'failed') return 'text-red-400'
  if (s === 'duplicate') return 'text-gray-500'
  return 'text-cyan-400'
}
</script>
```

- [ ] **Step 2: Build and verify**

Run: `cd /home/ellie/ellie-home && bun run build 2>&1 | tail -5`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-home
git add app/components/knowledge/IngestDropZone.vue
git commit -m "[ELLIE-1455] add IngestDropZone component (Zone B of River tab)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: River tab refactor in knowledge.vue

**Files:**
- Modify: `/home/ellie/ellie-home/app/pages/knowledge.vue`

**Context:** Replace the existing River tab content with the two-zone layout: Zone A on top (RiverNavigationZone), Zone B on bottom (IngestDropZone). Wire the selected folder, file uploads, and surface context.

**Audit corrections (2026-04-06):**

1. **Existing River block to delete (verified against current file):**
   - Template: `app/pages/knowledge.vue` **lines 39–90** — the entire `<!-- River View (ELLIE-150) -->` div (search box + results list + doc viewer).
   - Script setup: **lines 498–547** — `RiverDoc` interface, `riverQuery`, `riverResults`, `riverLoading`, `riverDocContent`, `riverDocId` refs, `searchRiver()` and `viewRiverDoc()` functions. Delete all of them; the new layout uses different state and never calls `/api/knowledge/river` or `/api/knowledge/river-doc` (these Nuxt server routes can stay — other places may use them).
   - Line numbers will shift as edits are made; re-grep before each delete.

2. **`/api/bridge/river/list` does NOT exist on the relay.** The plan called a fictional endpoint. Folder navigation must be derived client-side from `/api/bridge/river/catalog`, which returns a flat `{ docs: [{ docid, path, size, updated_at }] }`. From that response we can:
   - Derive `riverAllFolders` by extracting unique directory prefixes from each `path`.
   - Derive `riverContents` for the currently-selected folder by filtering `docs` whose path starts with `${selectedFolder}` and grouping into "files in this folder" vs "subfolders".

3. **Use direct fetch to `http://localhost:3001/api/bridge/...`, not `$fetch('/api/bridge/...')`.** No Nuxt proxy exists for `/api/bridge/*`; `$fetch('/api/bridge/...')` would hit the Nuxt server and 404. The bridge key comes from `useRuntimeConfig().public.bridgeKey`.

4. **`/api/knowledge/ingest` body is base64-in-JSON, not FormData.** Match the new Task 4 contract — read each file with `await file.arrayBuffer()`, base64 it, and POST `{ filename, content, target_folder }` as JSON. (`FormData` would fail because the relay endpoint reads the body with `req.on("data")` and `JSON.parse`.)

5. **Layout interaction with Phase 1 wrapper.** The Phase 1 patch added a `<div class="flex-1 overflow-y-auto">` wrapper around the tab content area. The new River two-zone layout uses `flex flex-col h-full`, which only fills the parent if the parent has a fixed height. Either remove the `overflow-y-auto` wrapper for the river tab specifically, or change the river root to `min-h-[600px]` so it has explicit height. The audit-then-execute step for Task 9 must verify this is correct in the current file before committing.

**Replace Steps 1–5 of the original task with this corrected sequence:**

- [ ] **Step 1: Verify what to delete**

Run: `grep -n "River View (ELLIE-150)\|riverQuery\|riverResults\|searchRiver\|viewRiverDoc\|RiverDoc" /home/ellie/ellie-home/app/pages/knowledge.vue`

Confirm the line ranges still match this audit note (template ~39–90, script ~498–547). If they have shifted, use the new line ranges.

- [ ] **Step 2: Replace the River block with the two-zone layout**

In `app/pages/knowledge.vue`, replace the existing River tab content with:

```vue
<!-- River tab — two zones -->
<div v-if="activeTab === 'river'" class="flex flex-col h-full gap-2">
  <!-- Zone A: navigation -->
  <div class="flex-[3] min-h-0">
    <RiverNavigationZone
      :selected-folder="riverSelectedFolder"
      :contents="riverContents"
      :total-docs="riverState.total_docs"
      :total-folders="riverState.total_folders"
      :all-folders="riverAllFolders"
      @select-folder="onRiverSelectFolder"
      @create-folder="onRiverCreateFolder"
      @navigate-up="onRiverNavigateUp"
    />
  </div>
  <!-- Zone B: ingest drop zone (collapsible) -->
  <IngestDropZone
    :target-folder="riverSelectedFolder"
    :rows="ingestionRows"
    @files-selected="onFilesSelected"
  />
</div>
```

- [ ] **Step 3: Add the River state and handlers in <script setup>**

Direct-fetch to `http://localhost:3001/api/bridge/...` (no Nuxt proxy). `loadRiverState` and `onRiverSelectFolder` both derive from a single catalog response.

```typescript
import RiverNavigationZone from '~/components/knowledge/RiverNavigationZone.vue'
import IngestDropZone from '~/components/knowledge/IngestDropZone.vue'
import type { KnowledgeRiverContext } from '~/types/surface-context'

interface RiverCatalogEntry { docid: string; path: string; size: string; updated_at: string }

const RELAY_BASE = 'http://localhost:3001'
const bridgeKey = (useRuntimeConfig().public as any).bridgeKey as string

const riverSelectedFolder = ref('')
const riverCatalog = ref<RiverCatalogEntry[]>([])
const riverContents = ref<{ path: string; name: string; is_folder: boolean; is_new?: boolean }[]>([])
const riverAllFolders = ref<string[]>([])
const riverState = ref({ total_docs: 0, total_folders: 0 })
const ingestionRows = ref<{ id: string; filename: string; status: any; error?: string }[]>([])

function deriveAllFolders(docs: RiverCatalogEntry[]): string[] {
  const set = new Set<string>()
  for (const d of docs) {
    const parts = d.path.split('/').slice(0, -1)
    for (let i = 1; i <= parts.length; i++) {
      set.add(parts.slice(0, i).join('/') + '/')
    }
  }
  return Array.from(set).sort()
}

function deriveFolderContents(docs: RiverCatalogEntry[], folder: string) {
  const prefix = folder.replace(/\/+$/, '')
  const items: { path: string; name: string; is_folder: boolean }[] = []
  const subfolderSet = new Set<string>()
  for (const d of docs) {
    if (prefix && !d.path.startsWith(prefix + '/')) continue
    const rel = prefix ? d.path.slice(prefix.length + 1) : d.path
    const slash = rel.indexOf('/')
    if (slash === -1) {
      items.push({ path: d.path, name: rel, is_folder: false })
    } else {
      const sub = rel.slice(0, slash)
      if (!subfolderSet.has(sub)) {
        subfolderSet.add(sub)
        const subPath = (prefix ? prefix + '/' : '') + sub + '/'
        items.push({ path: subPath, name: sub, is_folder: true })
      }
    }
  }
  return items.sort((a, b) => Number(b.is_folder) - Number(a.is_folder) || a.name.localeCompare(b.name))
}

async function loadRiverState() {
  try {
    const res = await fetch(`${RELAY_BASE}/api/bridge/river/catalog`, {
      headers: { 'x-bridge-key': bridgeKey },
    })
    if (!res.ok) throw new Error(`catalog ${res.status}`)
    const data = await res.json() as { docs: RiverCatalogEntry[] }
    riverCatalog.value = data.docs || []
    riverAllFolders.value = deriveAllFolders(riverCatalog.value)
    riverState.value = {
      total_docs: riverCatalog.value.length,
      total_folders: riverAllFolders.value.length,
    }
    if (riverSelectedFolder.value) {
      riverContents.value = deriveFolderContents(riverCatalog.value, riverSelectedFolder.value)
    }
  } catch (err) {
    console.warn('[knowledge] failed to load river state', err)
  }
}

async function onRiverSelectFolder(path: string) {
  riverSelectedFolder.value = path
  riverContents.value = deriveFolderContents(riverCatalog.value, path)
}

async function onRiverCreateFolder(path: string) {
  // Create the folder by writing a placeholder .gitkeep marker via /api/bridge/river/write.
  try {
    const cleanPath = path.replace(/\/$/, '')
    const res = await fetch(`${RELAY_BASE}/api/bridge/river/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bridge-key': bridgeKey },
      body: JSON.stringify({
        path: `${cleanPath}/.gitkeep.md`,
        content: '<!-- folder marker -->\n',
        operation: 'create',
      }),
    })
    if (!res.ok) throw new Error(`write ${res.status}`)
    await loadRiverState()
    await onRiverSelectFolder(cleanPath + '/')
  } catch (err) {
    console.warn('[knowledge] create folder failed', err)
  }
}

function onRiverNavigateUp() {
  const parts = riverSelectedFolder.value.replace(/\/$/, '').split('/').filter(Boolean)
  parts.pop()
  const next = parts.length > 0 ? parts.join('/') + '/' : ''
  riverSelectedFolder.value = next
  riverContents.value = deriveFolderContents(riverCatalog.value, next)
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

async function onFilesSelected(files: File[]) {
  for (const file of files) {
    const id = `local-${crypto.randomUUID().slice(0, 8)}`
    ingestionRows.value.push({ id, filename: file.name, status: 'queued' })
    try {
      const buf = await file.arrayBuffer()
      const content = bufferToBase64(buf)
      const res = await fetch(`${RELAY_BASE}/api/knowledge/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bridge-key': bridgeKey },
        body: JSON.stringify({
          filename: file.name,
          content,
          target_folder: riverSelectedFolder.value,
        }),
      })
      const result = await res.json()
      const rowIdx = ingestionRows.value.findIndex(r => r.id === id)
      if (rowIdx >= 0) {
        ingestionRows.value[rowIdx].status = result.status
        if (result.error) ingestionRows.value[rowIdx].error = result.error
      }
    } catch (err: any) {
      const rowIdx = ingestionRows.value.findIndex(r => r.id === id)
      if (rowIdx >= 0) {
        ingestionRows.value[rowIdx].status = 'failed'
        ingestionRows.value[rowIdx].error = String(err)
      }
    }
  }
  // Refresh catalog (and current folder contents) after batch
  await loadRiverState()
}

// Surface context for River tab (used by EllieSurfacePanel)
const riverSurfaceContext = computed<KnowledgeRiverContext>(() => ({
  surface_id: 'knowledge-river',
  surface_origin: surfaceOrigin,
  selection: {
    folder: riverSelectedFolder.value || null,
    folder_file_count: riverContents.value.filter(c => !c.is_folder).length,
    folder_subfolder_count: riverContents.value.filter(c => c.is_folder).length,
    last_files: riverContents.value.filter(c => !c.is_folder).slice(0, 5).map(c => c.name),
  },
  ingestion_state: {
    in_progress: ingestionRows.value.some(r => r.status === 'uploading' || r.status === 'converting' || r.status === 'planting'),
    queued: ingestionRows.value.filter(r => r.status === 'queued').length,
    last_ingested_at: null,
  },
  river_summary: riverState.value,
}))

// Update the surfaceContext computed (added in Phase 1) to switch on activeTab.
// **DO NOT replace the entire computed** — the existing one already returns a
// KnowledgeTreeContext for the tree tab. Instead, find the early-return for the
// `tree` branch and add a `river` branch alongside it. Sketch:
//
//   const surfaceContext = computed(() => {
//     if (activeTab.value === 'tree') {
//       // ...existing tree context, already in file...
//       return treeContext
//     }
//     if (activeTab.value === 'river') {
//       return riverSurfaceContext.value
//     }
//     return null
//   })

// Load river state when tab becomes active. The Phase 1 file already has a
// `watch(activeTab, ...)` block (~line 901). Extend it instead of adding a
// duplicate watcher:
//
//   watch(activeTab, (tab) => {
//     // ...existing logic...
//     if (tab === 'river') loadRiverState()
//   })
```

- [ ] **Step 4: Add Phase 2 action handler in handleSurfaceAction**

Replace the Phase 1 stub with real handlers:

```typescript
async function handleSurfaceAction(action: SurfaceAction) {
  if (action.tool === 'propose_create_folder') {
    const paths = (action.args.paths as string[]) || []
    for (const p of paths) {
      await onRiverCreateFolder(p)
    }
    return
  }
  if (action.tool === 'propose_move_folder') {
    // Phase 2 stub: implement move via river bridge in a follow-up
    console.warn('[knowledge] move not implemented yet')
    return
  }
  if (action.tool === 'propose_select_folder') {
    const p = action.args.path as string
    if (p) await onRiverSelectFolder(p)
    return
  }
  if (action.tool === 'propose_switch_tab') {
    const t = action.args.tab as string
    if (t) activeTab.value = t as any
    return
  }
  if (action.tool === 'highlight_drop_zone') {
    const t = action.args.target_folder as string
    if (t) {
      await onRiverSelectFolder(t)
      // Drop zone expands automatically via watch on rows + manual signal
    }
    return
  }
}
```

- [ ] **Step 5: Subscribe to ingest_complete WS events**

Update the WS message handling so the dashboard updates folder contents when other clients ingest files. This may use the existing realtime channel or directly hook into the WS handler. Simplest approach: in the page's `onMounted`, listen for messages on the existing ellie-chat WebSocket and refresh contents:

```typescript
// In onMounted:
const { messages } = useEllieChat()
watch(messages, (newMessages) => {
  // The relay broadcasts ingest_complete on the same channel as chat messages.
  // useEllieChat doesn't expose raw WS events, so we add a side-channel via a custom event:
  // — defer this; for now, the foreground upload flow refreshes contents after each batch.
}, { deep: false })
```

(Refreshing after the batch in `onFilesSelected` is sufficient for v1. Real-time WS event handling can come later if multiple clients become a concern.)

- [ ] **Step 6: Build and restart**

```bash
cd /home/ellie/ellie-home && bun run build && sudo systemctl restart ellie-dashboard
```

Hard-refresh the browser, navigate to `/knowledge` → River tab. Verify the two-zone layout appears.

- [ ] **Step 7: Commit**

```bash
cd /home/ellie/ellie-home
git add app/pages/knowledge.vue
git commit -m "[ELLIE-1455] River tab two-zone layout with ingest action handlers

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: End-to-end smoke test

**Files:**
- No file changes — manual verification

- [ ] **Step 1: Restart both services**

```bash
systemctl --user restart ellie-chat-relay
sudo systemctl restart ellie-dashboard
```

- [ ] **Step 2: Manual ingestion test**

Hard-refresh the dashboard. Navigate to `/knowledge` → River tab.

- Type a folder name (e.g., `research-test`) in the search box → click "Create"
- Select the new folder
- Click "Choose Files" in Zone B → select a small PDF or .txt file from your filesystem
- Verify the file shows up in Zone A's contents grid after the upload completes
- Verify the file appears in `/home/ellie/obsidian-vault/ellie-river/research-test/`
- Verify the raw file is in `/home/ellie/uploads-archive/research-test/`
- Verify Forest chunks were planted: `curl -s -X POST http://localhost:3001/api/bridge/list -H "x-bridge-key: bk_..." -d '{"scope_path": "2/river-ingest/research-test", "limit": 10}' | jq .`

- [ ] **Step 3: Cross-surface retrieval test**

Open `/ellie-chat` in another tab. Ask Ellie about the content of the file you just ingested. She should reference details from the document, proving Layer 3 cross-scope retrieval is working.

- [ ] **Step 4: Conversational ingestion test**

Back on `/knowledge` → River tab, in the Ellie panel input, say:
> "I want to load some research about quantum computing."

Ellie should propose creating folders. The proposal preview card should appear in the panel with checkboxes. Click "Accept selected".

Verify:
- The folders appear in Zone A
- The drop zone (Zone B) expands automatically (if Ellie also called `highlight_drop_zone`)
- Ellie's reply acknowledges the action

Drop a file into the now-expanded drop zone. Verify the full ingestion completes.

- [ ] **Step 5: Deduplication test**

Drop the same file again into the same folder. Verify the response shows a duplicate message (per-folder, not system-wide).

- [ ] **Step 6: Send Workshop debrief**

```bash
bun -e 'await fetch("http://localhost:3001/api/workshop/debrief", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-bridge-key": "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" },
  body: JSON.stringify({
    session: "Phase 2: Knowledge Surface River Ingestion",
    repo: "ellie-dev",
    branch: "ellie/memory-system-fixes-1423-1427",
    work_item_id: "ELLIE-1455",
    decisions: [
      "Ingestion pipeline lives on the relay (ellie-dev), not ellie-home",
      "Per-folder Forest scopes (2/river-ingest/{slug}) keep semantic neighborhoods clean",
      "Layer 3 retrieval enumerates 2/river-ingest/* sub-scopes for non-surface contexts",
      "SHA-256 dedup via per-folder .hashes.jsonl with serialized check inside the orchestrator",
      "Single River write per file — chunks computed BEFORE the write, frontmatter.forest_chunks already populated"
    ],
    docs_created: ["docs/superpowers/plans/2026-04-06-knowledge-surface-phase2.md"],
    files_changed: [
      "src/markdown-chunker.ts",
      "src/river-folder-scope.ts",
      "src/ingestion-pipeline.ts",
      "src/api/knowledge.ts",
      "src/http-routes.ts",
      "src/prompt-layers/knowledge.ts",
      "ellie-home/app/composables/useThreads.ts",
      "ellie-home/app/components/ellie/EllieSurfacePanel.vue",
      "ellie-home/app/components/knowledge/RiverNavigationZone.vue",
      "ellie-home/app/components/knowledge/IngestDropZone.vue",
      "ellie-home/app/pages/knowledge.vue"
    ],
    scopes: ["2/1", "2/3"],
    summary: "Phase 2 complete: full data ingestion control surface on /knowledge River tab. Files drop in, get archived, converted to MD, planted into Forest as semantically searchable chunks. Conversational flow with Ellie works end-to-end. Cross-surface retrieval confirmed."
  })
}).then(r => r.json()).then(console.log)'
```

- [ ] **Step 7: Final commit**

```bash
git add -A && git commit -m "[ELLIE-1455] Phase 2 smoke-test fixes" || true
```

---

## Notes for Implementers

### Bridge write helper
The pipeline calls `bridgeWrite` from `src/api/bridge.ts` to plant Forest chunks. The exact name and signature may differ — read `src/api/bridge.ts` first to find the in-process write function. If only an HTTP endpoint exists, you can call it via `fetch` to localhost:3001 (the relay calling itself), but the in-process call is faster.

### River bridge folder creation
The spec assumes the River bridge supports folder creation. If `POST /api/bridge/river/write` does NOT support empty-folder creation, Task 9's `onRiverCreateFolder` workaround writes a `.gitkeep.md` placeholder to the new folder. That works but leaves a marker file. A cleaner path would be to add a `mkdir` operation to `bridge-river.ts` — that's a potential follow-up.

### Layer 3 enumeration fallback
Task 5's `enumerateRiverIngestScopes` depends on a bridge function for listing scopes. If that function doesn't exist, the fallback is to query the Forest database directly via the existing query helpers. The simplest approach: read `src/api/bridge.ts` for whatever scope-listing function exists, and use that.

### Ingestion progress events via WebSocket
Phase 2 broadcasts ingestion stage events as `type: "ingest_event"` and a final `type: "ingest_complete"`. The dashboard's foreground upload flow (Task 9) doesn't subscribe to these — it tracks status via the HTTP response only. That's fine for v1 single-user. If multiple users need real-time progress (e.g., Dave on his desktop and his phone both watching), Task 9 needs to subscribe to the WS events and update `ingestionRows` from there. Defer to a follow-up unless it surfaces as a real problem.

### LLM summary generation (deferred stub)
The pipeline includes a `generateAndPlantSummary` stub that logs and skips. The actual LLM summary call should use the same model selector as Ellie's chat (`ELLIE_MODEL`). Implement in a Phase 2.5 task once the core pipeline is verified working — you don't want to debug LLM latency while also debugging the chunker.

### What Phase 2 does NOT include
- Folder rename / move handling (orphans Forest scopes — known v1 limitation)
- Move folder action (`propose_move_folder` is a Phase 2 stub)
- Automated reconcile/cleanup job (Phase 3)
- LLM summary chunks (deferred — pipeline runs without them, doc is still indexed)
- Multi-client real-time progress sync via WS events
- Content-based smart Forest scope detection (folders are the only signal for v1)
- The SHA-256 dedup migration from `.hashes.jsonl` to a Forest table (v2)

After Phase 2 ships, the full Big Rock 1 vision is real: Dave drops PDFs into River, Ellie helps organize them conversationally, and the content is semantically searchable from any chat surface.
