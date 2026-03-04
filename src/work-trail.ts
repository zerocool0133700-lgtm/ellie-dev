/**
 * Work Trail — format constants and pure validators (ELLIE-530).
 *
 * Work trails are markdown documents recorded in the River vault after
 * significant ticket work. They capture context, steps taken, decisions,
 * findings, and unresolved items for future agent reference.
 *
 * Location convention: work-trails/{TICKET-ID}/{TICKET-ID}-{YYYY-MM-DD}.md
 * Template:            vault/templates/work-trail.md
 *
 * Zero external dependencies — safe to import in unit tests without mocking.
 */

// ── Constants ──────────────────────────────────────────────────────────────────

/** Valid values for the `status` frontmatter field. */
export const WORK_TRAIL_STATUSES = ['in-progress', 'done', 'blocked'] as const
export type WorkTrailStatus = typeof WORK_TRAIL_STATUSES[number]

/** Required H2 section headings in a work trail body. */
export const REQUIRED_SECTIONS = ['## Context', '## What Was Done', '## Files Changed', '## Decisions'] as const

/** Regex matching the work-trail path convention: work-trails/TICKET-ID/TICKET-ID-YYYY-MM-DD.md */
const WORK_TRAIL_PATH_RE =
  /^work-trails\/([A-Z]+-\d+)\/([A-Z]+-\d+)-(\d{4}-\d{2}-\d{2})\.md$/

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WorkTrailFrontmatter {
  work_item_id: string
  status: WorkTrailStatus
  started_at: string
  agent?: string
  completed_at?: string | null
  scope_path?: string
  [key: string]: unknown
}

export interface WorkTrailValidationError {
  field: string
  message: string
}

export interface WorkTrailValidationResult {
  valid: boolean
  errors: WorkTrailValidationError[]
}

// ── validateWorkTrail ─────────────────────────────────────────────────────────

/**
 * Validate a parsed work trail document.
 *
 * Checks:
 *  - Required frontmatter fields are present and have correct types
 *  - `status` is one of the allowed values
 *  - `started_at` is a valid ISO 8601 timestamp
 *  - `completed_at`, if present, is also a valid ISO 8601 timestamp
 *  - Required H2 sections exist in the body
 *
 * Pure — no file system or network access.
 */
export function validateWorkTrail(
  frontmatter: Record<string, unknown>,
  body: string,
): WorkTrailValidationResult {
  const errors: WorkTrailValidationError[] = []

  // ── Required frontmatter ───────────────────────────────────────────────────

  if (!frontmatter.work_item_id || typeof frontmatter.work_item_id !== 'string') {
    errors.push({ field: 'work_item_id', message: 'Required string field missing or invalid' })
  } else if (!/^[A-Z]+-\d+$/.test(frontmatter.work_item_id as string)) {
    errors.push({ field: 'work_item_id', message: 'Must match pattern PROJ-123 (uppercase letters, dash, digits)' })
  }

  if (!frontmatter.status || typeof frontmatter.status !== 'string') {
    errors.push({ field: 'status', message: 'Required string field missing or invalid' })
  } else if (!(WORK_TRAIL_STATUSES as readonly string[]).includes(frontmatter.status as string)) {
    errors.push({
      field: 'status',
      message: `Must be one of: ${WORK_TRAIL_STATUSES.join(', ')}`,
    })
  }

  if (!frontmatter.started_at || typeof frontmatter.started_at !== 'string') {
    errors.push({ field: 'started_at', message: 'Required string field missing or invalid' })
  } else if (!isValidIso8601(frontmatter.started_at as string)) {
    errors.push({ field: 'started_at', message: 'Must be a valid ISO 8601 timestamp' })
  }

  // ── Optional frontmatter ───────────────────────────────────────────────────

  if (
    frontmatter.completed_at !== undefined &&
    frontmatter.completed_at !== null &&
    typeof frontmatter.completed_at === 'string' &&
    !isValidIso8601(frontmatter.completed_at)
  ) {
    errors.push({ field: 'completed_at', message: 'Must be a valid ISO 8601 timestamp when present' })
  }

  // ── Required sections ──────────────────────────────────────────────────────

  for (const section of REQUIRED_SECTIONS) {
    if (!body.includes(section)) {
      errors.push({ field: 'body', message: `Missing required section: ${section}` })
    }
  }

  return { valid: errors.length === 0, errors }
}

// ── parseWorkTrailPath ────────────────────────────────────────────────────────

export interface WorkTrailPathInfo {
  ticketId: string
  date: string
}

/**
 * Parse and validate a work-trail file path.
 *
 * Expected format: work-trails/{TICKET-ID}/{TICKET-ID}-{YYYY-MM-DD}.md
 * Returns `{ ok: true, info }` on match, or `{ ok: false, error }` on mismatch.
 *
 * Additionally checks that the ticket ID in the directory matches the one in the filename.
 *
 * Pure — no file system access.
 */
export function parseWorkTrailPath(
  path: string,
): { ok: true; info: WorkTrailPathInfo } | { ok: false; error: string } {
  if (!path || typeof path !== 'string') {
    return { ok: false, error: 'Path must be a non-empty string' }
  }

  const match = path.match(WORK_TRAIL_PATH_RE)
  if (!match) {
    return {
      ok: false,
      error: 'Path must match work-trails/{TICKET-ID}/{TICKET-ID}-{YYYY-MM-DD}.md',
    }
  }

  const [, dirTicket, fileTicket, date] = match

  if (dirTicket !== fileTicket) {
    return {
      ok: false,
      error: `Ticket ID mismatch: directory has "${dirTicket}" but filename has "${fileTicket}"`,
    }
  }

  return { ok: true, info: { ticketId: dirTicket, date } }
}

// ── buildWorkTrailPath ────────────────────────────────────────────────────────

/**
 * Build a canonical work-trail path from a ticket ID and date.
 * Date defaults to today (UTC) if not provided.
 *
 * Pure — no file system access.
 */
export function buildWorkTrailPath(ticketId: string, date?: string): string {
  const d = date ?? new Date().toISOString().slice(0, 10)
  return `work-trails/${ticketId}/${ticketId}-${d}.md`
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Check whether a string is a valid ISO 8601 date or datetime.
 * Accepts full datetime strings (with T separator) and date-only strings (YYYY-MM-DD).
 * Pure — no side effects.
 */
export function isValidIso8601(value: string): boolean {
  if (!value || typeof value !== 'string') return false
  // Date-only: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return !isNaN(Date.parse(value))
  }
  // Full datetime must contain 'T' separator
  if (!value.includes('T')) return false
  return !isNaN(Date.parse(value))
}
