/**
 * Work Trail Writer — ELLIE-531
 *
 * Writes River vault documents for agent work sessions.
 * Called fire-and-forget from work-session lifecycle hooks (start/update/complete).
 *
 * Two layers:
 *  - Pure content builders (zero deps, fully testable)
 *  - Effectful writers (fs + QMD reindex, non-fatal on error)
 */

import { writeFile, mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import { spawn } from 'bun'
import { buildWorkTrailPath } from './work-trail.ts'
import { RIVER_ROOT, qmdReindex } from './api/bridge-river.ts'
import { log } from './logger.ts'

const logger = log.child('work-trail-writer')

// ── Pure content builders ──────────────────────────────────────────────────────

/**
 * Build the initial work trail document content for a new session.
 *
 * @param workItemId  Ticket identifier (e.g. "ELLIE-531")
 * @param title       Ticket title
 * @param agent       Agent name (optional, defaults to "claude-code")
 * @param startedAt   ISO 8601 timestamp (optional, defaults to now — injectable for tests)
 */
export function buildWorkTrailStartContent(
  workItemId: string,
  title: string,
  agent?: string,
  startedAt?: string,
): string {
  const ts = startedAt ?? new Date().toISOString()
  const date = ts.slice(0, 10)
  const agentVal = agent ?? 'claude-code'

  return [
    '---',
    `work_item_id: ${workItemId}`,
    `agent: ${agentVal}`,
    'status: in-progress',
    `started_at: ${ts}`,
    'completed_at: null',
    'scope_path: 2/1',
    '---',
    '',
    `# Work Trail: ${workItemId} — ${title}`,
    '',
    `> Started ${date}. Working on: ${title}`,
    '',
    '## Context',
    '',
    '<!-- Pre-work briefing findings, prior decisions, related work -->',
    '',
    '## What Was Done',
    '',
    '<!-- Step-by-step progress (updated via session/update calls) -->',
    '',
    '## Files Changed',
    '',
    '| File | Change |',
    '|------|--------|',
    '',
    '## Decisions',
    '',
    '<!-- Key choices and reasoning -->',
    '',
    '## Findings',
    '',
    '## Unresolved',
    '',
    '---',
    '',
    `*Cross-refs: [[${workItemId}]] · Scope: \`2/1\` (ellie-dev)*`,
  ].join('\n')
}

/**
 * Build the content to append for a progress update.
 *
 * @param message  Progress message
 * @param ts       ISO 8601 timestamp (optional, defaults to now — injectable for tests)
 */
export function buildWorkTrailUpdateAppend(message: string, ts?: string): string {
  const timestamp = ts ?? new Date().toISOString()
  return `\n### Update — ${timestamp}\n\n${message}\n`
}

/**
 * Build the content to append when a session completes.
 *
 * @param summary  Completion summary
 * @param ts       ISO 8601 timestamp (optional, defaults to now — injectable for tests)
 */
export function buildWorkTrailCompleteAppend(summary: string, ts?: string): string {
  const timestamp = ts ?? new Date().toISOString()
  return `\n## Completion Summary\n\n**Completed at:** ${timestamp}\n\n${summary}\n`
}

/**
 * Build the content to append for a decision log entry (ELLIE-630).
 *
 * @param message  Decision description
 * @param agent    Agent name (optional)
 * @param ts       ISO 8601 timestamp (optional, defaults to now — injectable for tests)
 */
export function buildWorkTrailDecisionAppend(message: string, agent?: string, ts?: string): string {
  const timestamp = ts ?? new Date().toISOString()
  const prefix = agent ? `**${agent}:** ` : ''
  return `\n### Decision — ${timestamp}\n\n${prefix}${message}\n`
}

// ── Section-aware content insertion (ELLIE-630) ──────────────────────────────

/**
 * Insert content into a specific ## section of a work trail document.
 *
 * Finds the section heading, then inserts content before the next ## heading
 * (or before the `---` footer). Replaces HTML comment placeholders if present.
 *
 * Pure — no file system access.
 *
 * @param content     Full document content
 * @param section     Section heading (e.g. "## What Was Done")
 * @param insertText  Content to insert/append inside the section
 * @returns           Updated document content, or null if section not found
 */
export function insertIntoSection(
  content: string,
  section: string,
  insertText: string,
): string | null {
  const sectionIdx = content.indexOf(section)
  if (sectionIdx === -1) return null

  // Find the end of the section heading line
  const headingEnd = content.indexOf('\n', sectionIdx)
  if (headingEnd === -1) return null

  // Find the next ## heading or the --- footer
  const afterHeading = content.slice(headingEnd + 1)
  const nextSectionMatch = afterHeading.match(/^## /m)
  const footerIdx = afterHeading.indexOf('\n---\n')

  let insertPos: number
  if (nextSectionMatch && nextSectionMatch.index !== undefined) {
    const nextIdx = nextSectionMatch.index
    // If footer comes first, use that
    if (footerIdx !== -1 && footerIdx < nextIdx) {
      insertPos = headingEnd + 1 + footerIdx
    } else {
      insertPos = headingEnd + 1 + nextIdx
    }
  } else if (footerIdx !== -1) {
    insertPos = headingEnd + 1 + footerIdx
  } else {
    // No next section or footer — append at end
    insertPos = content.length
  }

  // Get current section body (between heading and next section)
  let sectionBody = content.slice(headingEnd + 1, insertPos)

  // Remove HTML comment placeholders
  sectionBody = sectionBody.replace(/<!--[^>]*-->\n?/g, '')

  // For the Files Changed table, keep the header row
  const trimmed = sectionBody.trimEnd()

  // Build the new section body
  const newBody = trimmed
    ? trimmed + '\n' + insertText + '\n\n'
    : '\n' + insertText + '\n\n'

  return content.slice(0, headingEnd + 1) + newBody + content.slice(insertPos)
}

/**
 * Build a Files Changed markdown table from git diff data (ELLIE-630).
 *
 * @param files  Array of { file, change } entries
 */
export function buildFilesChangedTable(
  files: Array<{ file: string; change: string }>,
): string {
  if (!files.length) return '| (none) | — |'
  return files.map(f => `| \`${f.file}\` | ${f.change} |`).join('\n')
}

/**
 * Collect recently changed files from git (ELLIE-630).
 *
 * Looks at the most recent commit's diff stat. Non-fatal — returns empty on error.
 */
export async function collectGitFilesChanged(
  cwd: string = process.cwd(),
): Promise<Array<{ file: string; change: string }>> {
  try {
    const proc = spawn({
      cmd: ['git', 'diff', '--name-status', 'HEAD~1..HEAD'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const text = await new Response(proc.stdout).text()
    await proc.exited

    if (!text.trim()) return []

    return text.trim().split('\n').map(line => {
      const [status, ...parts] = line.split('\t')
      const file = parts.join('\t')
      const changeMap: Record<string, string> = {
        A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed',
      }
      return { file, change: changeMap[status?.[0] ?? ''] ?? status ?? 'Changed' }
    }).filter(f => f.file)
  } catch {
    return []
  }
}

// ── Pure frontmatter updaters ─────────────────────────────────────────────

/**
 * Update frontmatter fields in a work trail document (ELLIE-630).
 *
 * Replaces values between the `---` delimiters. If a field doesn't exist, it's added.
 * Returns the updated content, or null if the document has no valid frontmatter.
 *
 * Pure — no file system access.
 */
export function updateWorkTrailFrontmatter(
  content: string,
  updates: Record<string, string>,
): string | null {
  const fmStart = content.indexOf('---')
  if (fmStart === -1) return null
  const fmEnd = content.indexOf('---', fmStart + 3)
  if (fmEnd === -1) return null

  const before = content.slice(0, fmStart + 3)
  const fmBlock = content.slice(fmStart + 3, fmEnd)
  const after = content.slice(fmEnd)

  const lines = fmBlock.split('\n')
  const updatedKeys = new Set<string>()

  const updatedLines = lines.map(line => {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) return line
    const key = line.slice(0, colonIdx).trim()
    if (key in updates) {
      updatedKeys.add(key)
      return `${key}: ${updates[key]}`
    }
    return line
  })

  // Add any keys that weren't already present
  for (const [key, value] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) {
      // Insert before the last empty line (if any)
      updatedLines.push(`${key}: ${value}`)
    }
  }

  return before + updatedLines.join('\n') + after
}

// ── Effectful writers ──────────────────────────────────────────────────────────

/**
 * Create a new work trail document for a session start.
 *
 * - Skips silently if the file already exists (idempotent).
 * - Non-fatal: catches all errors and returns false.
 * - Triggers QMD reindex after write.
 *
 * @param workItemId  Ticket identifier
 * @param title       Ticket title
 * @param agent       Agent name (optional)
 * @param date        YYYY-MM-DD date for path (optional, defaults to today)
 */
export async function writeWorkTrailStart(
  workItemId: string,
  title: string,
  agent?: string,
  date?: string,
): Promise<boolean> {
  try {
    const path = buildWorkTrailPath(workItemId, date)
    const fullPath = join(RIVER_ROOT, path)
    const dirPath = join(RIVER_ROOT, `work-trails/${workItemId}`)

    await mkdir(dirPath, { recursive: true })

    // Skip if file already exists — don't overwrite an in-progress trail
    try {
      await readFile(fullPath, 'utf-8')
      logger.info('Work trail already exists, skipping create', { path })
      return true
    } catch {
      // File doesn't exist — proceed to create
    }

    const content = buildWorkTrailStartContent(workItemId, title, agent)
    await writeFile(fullPath, content, 'utf-8')
    logger.info('Work trail created', { path })

    await qmdReindex()
    return true
  } catch (err) {
    logger.warn('writeWorkTrailStart failed (non-fatal)', err)
    return false
  }
}

/**
 * Append content to an existing work trail (for updates and completion).
 *
 * - If `section` is provided, inserts content into the named ## section (ELLIE-630).
 * - Otherwise, appends at the end of the file (legacy behavior).
 * - If the file doesn't exist, creates it with just the appended content.
 * - Non-fatal: catches all errors and returns false.
 * - Triggers QMD reindex after write.
 *
 * @param workItemId     Ticket identifier
 * @param appendContent  Content to append
 * @param date           YYYY-MM-DD date for path (optional, defaults to today)
 * @param section        Section heading to insert into (e.g. "## What Was Done")
 */
export async function appendWorkTrailProgress(
  workItemId: string,
  appendContent: string,
  date?: string,
  section?: string,
): Promise<boolean> {
  try {
    const path = buildWorkTrailPath(workItemId, date)
    const fullPath = join(RIVER_ROOT, path)
    const dirPath = join(RIVER_ROOT, `work-trails/${workItemId}`)

    let existing = ''
    try {
      existing = await readFile(fullPath, 'utf-8')
    } catch {
      // File doesn't exist — create parent dir and start fresh
      await mkdir(dirPath, { recursive: true })
    }

    let result: string
    if (section && existing) {
      const inserted = insertIntoSection(existing, section, appendContent)
      result = inserted ?? (existing.trimEnd() + '\n' + appendContent)
    } else {
      result = existing.trimEnd() + '\n' + appendContent
    }

    await writeFile(fullPath, result, 'utf-8')
    logger.info('Work trail appended', { path, section: section ?? 'end' })

    await qmdReindex()
    return true
  } catch (err) {
    logger.warn('appendWorkTrailProgress failed (non-fatal)', err)
    return false
  }
}

/**
 * Finalize a work trail — update frontmatter status to 'done' and set completed_at (ELLIE-630).
 *
 * Non-fatal: catches all errors and returns false.
 * Triggers QMD reindex after write.
 */
export async function finalizeWorkTrail(
  workItemId: string,
  completedAt?: string,
  date?: string,
): Promise<boolean> {
  try {
    const path = buildWorkTrailPath(workItemId, date)
    const fullPath = join(RIVER_ROOT, path)

    let existing: string
    try {
      existing = await readFile(fullPath, 'utf-8')
    } catch {
      logger.info('No work trail to finalize', { path })
      return false
    }

    const ts = completedAt ?? new Date().toISOString()
    const updated = updateWorkTrailFrontmatter(existing, {
      status: 'done',
      completed_at: ts,
    })

    if (!updated) {
      logger.warn('Could not parse work trail frontmatter for finalization', { path })
      return false
    }

    await writeFile(fullPath, updated, 'utf-8')
    logger.info('Work trail finalized', { path })

    await qmdReindex()
    return true
  } catch (err) {
    logger.warn('finalizeWorkTrail failed (non-fatal)', err)
    return false
  }
}
