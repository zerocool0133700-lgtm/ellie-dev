/**
 * River Bridge Endpoints — ELLIE-457
 *
 * REST interface to the River (R scope) — Obsidian/QMD document knowledge.
 * All reads route to the local QMD CLI.
 *
 * Endpoints:
 *   POST /api/bridge/river/search   — BM25 keyword search across R/R via QMD
 *   GET  /api/bridge/river/catalog  — List all documents in R/R with metadata
 *   GET  /api/bridge/river/doc      — Retrieve full document by ?id=qmd://...
 *   POST /api/bridge/river/link     — Record a vine from a Forest memory to a River doc
 *   POST /api/bridge/river/write    — Write/create/append documents in the River (ELLIE-529)
 */

import { spawn } from 'bun'
import { readFile, writeFile as writeFileFn, mkdir } from 'fs/promises'
import { join } from 'path'
import { writeMemory, sql } from '../../../ellie-forest/src/index'
import { authenticateBridgeKey as _authenticateBridgeKey } from './bridge.ts'
import type { ApiRequest, ApiResponse } from './types.ts'
import { log } from '../logger.ts'

const logger = log.child('bridge-river')

/** Auth function — exported for test injection via `_setBridgeAuth()`. */
let bridgeAuth = _authenticateBridgeKey
export function _setBridgeAuth(fn: typeof _authenticateBridgeKey) { bridgeAuth = fn }

const QMD_BIN = '/home/ellie/.bun/bin/qmd'
const RIVER_COLLECTION = 'ellie-river'

// ── QMD subprocess helpers ─────────────────────────────────────────────────────

async function qmdRun(args: string[]): Promise<{ stdout: string; ok: boolean }> {
  const proc = spawn([QMD_BIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  return { stdout, ok: exitCode === 0 }
}

// ── POST /api/bridge/river/search ─────────────────────────────────────────────

/**
 * BM25 keyword search across R/R (ellie-river collection).
 * Body: { query: string, limit?: number }
 * Returns: { success, count, results: [{docid, score, file, title, snippet}] }
 */
export async function bridgeRiverSearchEndpoint(req: ApiRequest, res: ApiResponse) {
  const { query, limit } = req.body

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing required field: query' })
  }

  const n = Math.min(Number(limit) || 10, 50)

  try {
    const { stdout, ok } = await qmdRun([
      'search', query,
      '-c', RIVER_COLLECTION,
      '--json',
      '-n', String(n),
    ])

    if (!ok) {
      logger.warn('QMD search returned non-zero exit', { query })
      return res.status(502).json({ error: 'QMD search failed' })
    }

    const results = JSON.parse(stdout) as Array<{
      docid: string
      score: number
      file: string
      title: string
      snippet: string
    }>

    // Wrap in Forest memory format with source: "river"
    const memories = results.map(r => ({
      id: r.docid,
      content: r.snippet,
      type: 'document',
      scope: 'tree',
      scope_path: 'R/R',
      source: 'river',
      doc_id: r.docid,
      file: r.file,
      title: r.title,
      score: r.score,
      confidence: Math.min(1, (r.score ?? 0) / 10 + 0.5),
    }))

    return res.json({ success: true, count: memories.length, memories })
  } catch (err) {
    logger.error('River search failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ── GET /api/bridge/river/catalog ─────────────────────────────────────────────

interface CatalogEntry {
  docid: string
  path: string
  size: string
  updated_at: string
}

/**
 * List all documents in R/R with metadata (path, size, last modified).
 * Sourced from `qmd ls ellie-river`.
 * Returns: { success, count, docs: [{docid, path, size, updated_at}] }
 */
export async function bridgeRiverCatalogEndpoint(req: ApiRequest, res: ApiResponse) {
  try {
    const { stdout, ok } = await qmdRun(['ls', RIVER_COLLECTION])

    if (!ok) {
      return res.status(502).json({ error: 'QMD catalog failed' })
    }

    const docs: CatalogEntry[] = []
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.includes('qmd://')) continue

      // Format: "4.7 KB  Mar  3 15:08  qmd://ellie-river/path/to/file.md"
      // Last whitespace-delimited token is the docid
      const parts = trimmed.split(/\s+/)
      const docid = parts[parts.length - 1]
      if (!docid?.startsWith('qmd://')) continue

      const path = docid.replace(`qmd://${RIVER_COLLECTION}/`, '')
      // Size is first two tokens (e.g. "4.7 KB")
      const size = parts.slice(0, 2).join(' ')
      // Date tokens: e.g. "Mar", "3", "15:08" — indices 2,3,4
      const updated_at = parts.slice(2, -1).join(' ')

      docs.push({ docid, path, size, updated_at })
    }

    return res.json({ success: true, count: docs.length, docs })
  } catch (err) {
    logger.error('River catalog failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ── GET /api/bridge/river/doc?id=qmd://... ────────────────────────────────────

/**
 * Retrieve the full content of a River document by its QMD docid.
 * Query: ?id=qmd://ellie-river/path/to/file.md
 * Returns: { success, docid, content }
 */
export async function bridgeRiverDocEndpoint(req: ApiRequest, res: ApiResponse) {
  const docid = req.query.id

  if (!docid) {
    return res.status(400).json({ error: 'Missing required query param: id' })
  }

  if (!docid.startsWith('qmd://')) {
    return res.status(400).json({ error: 'id must be a qmd:// URI' })
  }

  try {
    const { stdout, ok } = await qmdRun(['get', docid])

    if (!ok || !stdout.trim()) {
      return res.status(404).json({ error: 'Document not found' })
    }

    return res.json({ success: true, docid, content: stdout })
  } catch (err) {
    logger.error('River doc fetch failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ── POST /api/bridge/river/link ───────────────────────────────────────────────

/**
 * Record a vine from a Forest entity to a River document.
 * Stores a shared_memory in R/R scope encoding the relationship.
 * Body: { doc_id, tree_id?, memory_id?, link_type?, description? }
 * Returns: { success, memory_id }
 */
export async function bridgeRiverLinkEndpoint(req: ApiRequest, res: ApiResponse) {
  const { doc_id, tree_id, memory_id, link_type = 'related', description } = req.body

  if (!doc_id || typeof doc_id !== 'string') {
    return res.status(400).json({ error: 'Missing required field: doc_id' })
  }

  if (!tree_id && !memory_id) {
    return res.status(400).json({ error: 'Provide at least one of: tree_id, memory_id' })
  }

  try {
    const linkDesc = description ?? `${link_type} link to ${doc_id}`

    const memory = await writeMemory({
      content: linkDesc,
      type: 'finding',
      scope: 'tree',
      scope_path: 'R/R',
      confidence: 0.9,
      tags: ['river-link', link_type],
      metadata: {
        river_doc_id: doc_id,
        ...(tree_id ? { target_tree_id: tree_id } : {}),
        ...(memory_id ? { target_memory_id: memory_id } : {}),
        link_type,
        source: 'river',
      },
      duration: 'long_term',
    })

    logger.info('River link created', { doc_id, tree_id, memory_id, link_type, memory_id: memory.id })
    return res.json({ success: true, memory_id: memory.id })
  } catch (err) {
    logger.error('River link failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ── QMD search helper (used by bridgeReadEndpoint R/R routing + Oak Catalog) ──

/**
 * Run a QMD BM25 search and return raw JSON results.
 * Called from bridgeReadEndpoint when scope_path starts with 'R'.
 */
export async function searchRiver(query: string, limit = 10): Promise<Array<{
  docid: string
  score: number
  file: string
  title: string
  snippet: string
}>> {
  const { stdout, ok } = await qmdRun([
    'search', query,
    '-c', RIVER_COLLECTION,
    '--json',
    '-n', String(Math.min(limit, 50)),
  ])
  if (!ok) return []
  try {
    return JSON.parse(stdout)
  } catch {
    return []
  }
}

// ── Single document fetch (used by prompt-builder River cache) ─────────────────

/**
 * Fetch a single document from the River by relative path.
 * Non-fatal — returns null on any failure.
 *
 * @param docPath — path relative to ellie-river collection, e.g. "prompts/protocols/memory-management.md"
 */
export async function getRiverDoc(docPath: string): Promise<string | null> {
  const docid = `qmd://${RIVER_COLLECTION}/${docPath}`;
  try {
    const { stdout, ok } = await qmdRun(['get', docid]);
    if (!ok || !stdout.trim()) return null;
    return stdout.trim();
  } catch {
    return null;
  }
}

// ── Oak Catalog sync (called by relay.ts daily cron) ──────────────────────────

export interface OakScopeEntry {
  scope_path: string;
  name: string;
  count: number;
  topFacts: string[];
}

/**
 * Build Oak convergence index content from scope data.
 * Pure function — no I/O.
 */
export function buildOakSummary(scopeData: OakScopeEntry[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const totalMemories = scopeData.reduce((sum, s) => sum + s.count, 0);

  const lines = [
    `Oak Knowledge Index — ${scopeData.length} domains, ${totalMemories} total memories (${date})`,
    "",
  ];

  for (const scope of scopeData) {
    lines.push(`## ${scope.name} (${scope.scope_path}) — ${scope.count} memories`);
    for (const fact of scope.topFacts.slice(0, 5)) {
      lines.push(`  - ${fact}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Scan QMD and write an updated document manifest + knowledge convergence index
 * to R/1 (Oak Catalog) scope. Called daily by the Oak cron in relay.ts.
 */
export async function syncOakCatalog(): Promise<void> {
  const forestSql = (await import("../../../ellie-forest/src/db.ts")).default;

  // Step 1: QMD catalog (existing behavior)
  const { stdout, ok } = await qmdRun(['ls', RIVER_COLLECTION])
  const qmdEntries: string[] = []
  if (ok) {
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (trimmed && trimmed.includes('qmd://')) qmdEntries.push(trimmed)
    }
  }

  // Step 2: Scope convergence — top memories per active scope
  const scopeStats = await forestSql`
    SELECT
      ks.scope_path,
      ks.name,
      COUNT(sm.id)::int as memory_count
    FROM knowledge_scopes ks
    LEFT JOIN shared_memories sm
      ON sm.scope_path = ks.scope_path
      AND sm.status = 'active'
    WHERE ks.scope_path NOT LIKE '3/%'
    GROUP BY ks.scope_path, ks.name
    HAVING COUNT(sm.id) > 0
    ORDER BY COUNT(sm.id) DESC
    LIMIT 30
  `

  const scopeData: OakScopeEntry[] = []
  for (const stat of scopeStats) {
    const topMemories = await forestSql`
      SELECT content
      FROM shared_memories
      WHERE scope_path = ${stat.scope_path}
        AND status = 'active'
      ORDER BY weight DESC NULLS LAST, importance_score DESC NULLS LAST, created_at DESC
      LIMIT 5
    `

    scopeData.push({
      scope_path: stat.scope_path,
      name: stat.name,
      count: stat.memory_count,
      topFacts: topMemories.map((m: any) => m.content.slice(0, 150)),
    })
  }

  // Step 3: Build combined Oak content
  const convergenceIndex = buildOakSummary(scopeData)
  const qmdSection = qmdEntries.length > 0
    ? `\n## River Documents (${qmdEntries.length})\n${qmdEntries.join("\n")}`
    : ""

  const content = convergenceIndex + qmdSection

  // Step 4: Write to R/1
  await writeMemory({
    content,
    type: 'fact',
    scope: 'tree',
    scope_path: 'R/1',
    confidence: 1.0,
    tags: ['oak-index', 'convergence', 'manifest'],
    metadata: {
      domain_count: scopeData.length,
      total_memories: scopeData.reduce((s, d) => s + d.count, 0),
      qmd_count: qmdEntries.length,
      synced_at: new Date().toISOString(),
      source: 'oak-convergence',
    },
    duration: 'long_term',
    category: 'work',
  })

  logger.info('Oak convergence sync complete', {
    domains: scopeData.length,
    qmdDocs: qmdEntries.length,
  })
}

// ── POST /api/bridge/river/write (ELLIE-529) ──────────────────────────────────

/** Disk location of the ellie-river Obsidian vault. */
export const RIVER_ROOT = process.env.RIVER_ROOT || '/home/ellie/obsidian-vault/ellie-river'

export type RiverWriteOperation = 'create' | 'update' | 'append'

/**
 * Validate a relative River file path.
 * Pure — no file system access.
 *
 * Rules:
 *  - Must be a non-empty string
 *  - Must be relative (no leading slash)
 *  - No path traversal (..)
 *  - Must end with .md
 *  - No null bytes
 */
export function validateRiverPath(path: unknown): { valid: boolean; error?: string } {
  if (!path || typeof path !== 'string') return { valid: false, error: 'path is required and must be a string' }
  if (path.startsWith('/')) return { valid: false, error: 'path must be relative (no leading slash)' }
  if (path.includes('..')) return { valid: false, error: 'path traversal (..) not allowed' }
  if (!path.endsWith('.md')) return { valid: false, error: 'path must end with .md' }
  if (/[\0\r]/.test(path)) return { valid: false, error: 'invalid characters in path' }
  return { valid: true }
}

/**
 * Parse a simple YAML scalar value from a raw string.
 * Pure — handles null/bool/number/quoted-string/unquoted-string.
 */
export function parseYamlScalar(raw: string): unknown {
  if (raw === '' || raw === 'null' || raw === '~') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10)
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw)
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1)
  }
  return raw
}

/**
 * Parse YAML frontmatter from markdown content.
 * Pure — no I/O. Supports simple key: value pairs.
 *
 * Returns { frontmatter, body } where body is the content after the closing ---.
 * If no frontmatter block found, returns { frontmatter: {}, body: content }.
 */
export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: content }
  const fm: Record<string, unknown> = {}
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    if (!key) continue
    fm[key] = parseYamlScalar(line.slice(colonIdx + 1).trim())
  }
  return { frontmatter: fm, body: match[2] }
}

/**
 * Serialize a frontmatter object and body back to markdown string.
 * Pure — no I/O. Produces `---\nkey: value\n---\nbody`.
 * If frontmatter is empty, returns body unchanged.
 */
export function serializeWithFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  if (Object.keys(frontmatter).length === 0) return body
  const lines = Object.entries(frontmatter).map(([k, v]) => {
    if (v === null || v === undefined) return `${k}: null`
    if (typeof v === 'boolean' || typeof v === 'number') return `${k}: ${v}`
    if (Array.isArray(v)) return `${k}: [${v.join(', ')}]`
    const s = String(v)
    if (s.includes(':') || s.includes('#') || s.includes('\n')) return `${k}: "${s.replace(/"/g, '\\"')}"`
    return `${k}: ${s}`
  })
  return `---\n${lines.join('\n')}\n---\n${body}`
}

/**
 * Merge two frontmatter objects. Incoming values override existing ones.
 * Pure — no I/O.
 */
export function mergeFrontmatter(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  return { ...existing, ...incoming }
}

/**
 * Parse existing frontmatter, merge with incoming, re-serialize.
 * Pure — no I/O.
 */
export function applyFrontmatter(content: string, incomingFm: Record<string, unknown>): string {
  if (Object.keys(incomingFm).length === 0) return content
  const { frontmatter, body } = parseFrontmatter(content)
  const merged = mergeFrontmatter(frontmatter, incomingFm)
  return serializeWithFrontmatter(merged, body)
}

/**
 * Trigger QMD reindex after a write (non-fatal wrapper).
 * Exported for mocking in tests.
 */
export async function qmdReindex(): Promise<boolean> {
  try {
    const { ok } = await qmdRun(['update'])
    return ok
  } catch {
    return false
  }
}

/**
 * Write, create, or append a markdown document in the River vault.
 *
 * POST /api/bridge/river/write
 * Body: {
 *   path: string            — relative path within ellie-river (e.g. "notes/my-doc.md")
 *   content: string         — document body (markdown)
 *   operation?: string      — "create" (default) | "update" | "append"
 *   frontmatter?: object    — YAML frontmatter to merge into the document
 * }
 *
 * Operations:
 *  - create: creates a new file; fails with 409 if it already exists
 *  - update: overwrites an existing file; fails with 404 if it doesn't exist
 *  - append: appends content to the end of an existing file; creates if absent
 *
 * After writing, triggers `qmd update` to reindex the collection.
 */
export async function bridgeRiverWriteEndpoint(req: ApiRequest, res: ApiResponse) {
  // ── Auth (ELLIE-1418) ──────────────────────────────────────
  const key = await bridgeAuth(req.bridgeKey, res, 'write')
  if (!key) return

  const { path, content, operation = 'create', frontmatter: incomingFm = {} } = req.body

  // ── Input validation ────────────────────────────────────────

  const pathCheck = validateRiverPath(path)
  if (!pathCheck.valid) {
    return res.status(400).json({ error: pathCheck.error })
  }

  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'content is required and must be a string' })
  }

  const validOps: RiverWriteOperation[] = ['create', 'update', 'append']
  if (!validOps.includes(operation as RiverWriteOperation)) {
    return res.status(400).json({ error: `operation must be one of: ${validOps.join(', ')}` })
  }

  const fullPath = join(RIVER_ROOT, path as string)

  try {
    // ── Read existing file (if any) ─────────────────────────
    let existingContent: string | null = null
    try {
      existingContent = await readFile(fullPath, 'utf-8')
    } catch {
      existingContent = null
    }

    if (operation === 'create' && existingContent !== null) {
      return res.status(409).json({ error: 'File already exists. Use operation: update to overwrite.' })
    }

    if (operation === 'update' && existingContent === null) {
      return res.status(404).json({ error: 'File not found. Use operation: create to create a new file.' })
    }

    // ── Build final content ──────────────────────────────────
    const fm = (incomingFm && typeof incomingFm === 'object' && !Array.isArray(incomingFm))
      ? incomingFm as Record<string, unknown>
      : {}

    let finalContent: string
    if (operation === 'append' && existingContent !== null) {
      // Merge frontmatter into existing file, then append new body
      const baseWithFm = applyFrontmatter(existingContent, fm)
      finalContent = baseWithFm.trimEnd() + '\n\n' + content
    } else {
      // create or update: apply frontmatter to the provided content
      finalContent = applyFrontmatter(content, fm)
    }

    // ── Ensure parent directory exists ───────────────────────
    const lastSlash = (path as string).lastIndexOf('/')
    if (lastSlash > 0) {
      await mkdir(join(RIVER_ROOT, (path as string).slice(0, lastSlash)), { recursive: true })
    }

    // ── Write to disk ────────────────────────────────────────
    await writeFileFn(fullPath, finalContent, 'utf-8')
    logger.info('River write', { path, operation })

    // ── QMD reindex (non-fatal) ──────────────────────────────
    const reindexed = await qmdReindex()
    if (!reindexed) {
      logger.warn('QMD reindex failed after river write', { path })
    }

    return res.json({
      success: true,
      path,
      docid: `qmd://${RIVER_COLLECTION}/${path}`,
      operation,
      reindexed,
    })
  } catch (err) {
    logger.error('River write failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
