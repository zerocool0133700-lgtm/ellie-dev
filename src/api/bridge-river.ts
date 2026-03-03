/**
 * River Bridge Endpoints — ELLIE-457
 *
 * REST interface to the River (R scope) — Obsidian/QMD document knowledge.
 * All reads route to the local QMD CLI. R scope is read-only from Forest;
 * documents are edited in Obsidian and re-indexed by QMD automatically.
 *
 * Endpoints:
 *   POST /api/bridge/river/search   — BM25 keyword search across R/R via QMD
 *   GET  /api/bridge/river/catalog  — List all documents in R/R with metadata
 *   GET  /api/bridge/river/doc      — Retrieve full document by ?id=qmd://...
 *   POST /api/bridge/river/link     — Record a vine from a Forest memory to a River doc
 */

import { spawn } from 'bun'
import { writeMemory, sql } from '../../../ellie-forest/src/index'
import type { ApiRequest, ApiResponse } from './types.ts'
import { log } from '../logger.ts'

const logger = log.child('bridge-river')

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

// ── Oak Catalog sync (called by relay.ts daily cron) ──────────────────────────

/**
 * Scan QMD and write an updated document manifest to R/1 (Oak Catalog) scope.
 * Called daily by the Oak cron in relay.ts.
 */
export async function syncOakCatalog(): Promise<void> {
  const { stdout, ok } = await qmdRun(['ls', RIVER_COLLECTION])
  if (!ok) {
    logger.warn('Oak Catalog sync: qmd ls failed')
    return
  }

  const entries: string[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.includes('qmd://')) continue
    entries.push(trimmed)
  }

  if (entries.length === 0) {
    logger.warn('Oak Catalog sync: no documents found')
    return
  }

  const content = [
    `Oak Catalog — ${entries.length} River documents (synced ${new Date().toISOString().slice(0, 10)})`,
    '',
    ...entries,
  ].join('\n')

  await writeMemory({
    content,
    type: 'fact',
    scope: 'tree',
    scope_path: 'R/1',
    confidence: 1.0,
    tags: ['oak-catalog', 'river', 'manifest'],
    metadata: {
      doc_count: entries.length,
      synced_at: new Date().toISOString(),
      source: 'oak-cron',
    },
    duration: 'long_term',
    category: 'work',
  })

  logger.info('Oak Catalog synced', { doc_count: entries.length })
}
