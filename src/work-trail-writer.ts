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
 * - If the file doesn't exist, creates it with just the appended content.
 * - Non-fatal: catches all errors and returns false.
 * - Triggers QMD reindex after write.
 *
 * @param workItemId     Ticket identifier
 * @param appendContent  Content to append
 * @param date           YYYY-MM-DD date for path (optional, defaults to today)
 */
export async function appendWorkTrailProgress(
  workItemId: string,
  appendContent: string,
  date?: string,
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

    await writeFile(fullPath, existing.trimEnd() + '\n' + appendContent, 'utf-8')
    logger.info('Work trail appended', { path })

    await qmdReindex()
    return true
  } catch (err) {
    logger.warn('appendWorkTrailProgress failed (non-fatal)', err)
    return false
  }
}
