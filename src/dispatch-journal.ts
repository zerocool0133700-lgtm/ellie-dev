/**
 * Dispatch Journal — ELLIE-565
 *
 * Logs every agent dispatch to River as a structured journal entry.
 * One daily journal file at `dispatch-journal/YYYY-MM-DD.md` with
 * H3 entries per dispatch. Queryable via QMD for timeline reconstruction.
 *
 * Two layers:
 *  - Pure content builders (zero deps, fully testable)
 *  - Effectful writers (fs + QMD reindex, non-fatal)
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join } from "path";
import { RIVER_ROOT, qmdReindex } from "./api/bridge-river.ts";
import { log } from "./logger.ts";
import { AsyncMutex } from "./async-mutex.ts";

const logger = log.child("dispatch-journal");

/** Shared mutex for all journal append operations. */
const _journalLock = new AsyncMutex();

/** Exposed for testing — allows tests to verify lock state. */
export function _getJournalLockForTesting(): AsyncMutex {
  return _journalLock;
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface JournalStartEntry {
  workItemId: string;
  title: string;
  agent?: string;
  sessionId: string;
  pid?: number;
  startedAt?: string;
}

export interface JournalEndEntry {
  workItemId: string;
  agent?: string;
  outcome: "completed" | "timeout" | "crashed" | "blocked" | "paused";
  summary?: string;
  durationMinutes?: number;
  endedAt?: string;
}

// ── Pure: Path builder ─────────────────────────────────────────────────────────

/**
 * Build the journal file path for a given date.
 * E.g. "dispatch-journal/2026-03-05.md"
 */
export function buildJournalPath(date?: string): string {
  const d = date ?? new Date().toISOString().slice(0, 10);
  return `dispatch-journal/${d}.md`;
}

// ── Pure: Content builders ─────────────────────────────────────────────────────

/**
 * Build the frontmatter + header for a new daily journal file.
 */
export function buildJournalHeader(date?: string): string {
  const d = date ?? new Date().toISOString().slice(0, 10);
  return [
    "---",
    "type: dispatch-journal",
    `date: ${d}`,
    "---",
    "",
    `# Dispatch Journal — ${d}`,
    "",
  ].join("\n");
}

/**
 * Build a journal entry for a dispatch start.
 */
export function buildStartEntry(entry: JournalStartEntry): string {
  const ts = entry.startedAt ?? new Date().toISOString();
  const lines = [
    "",
    `### ${entry.workItemId} — Started`,
    "",
    `- **Time:** ${ts}`,
    `- **Title:** ${entry.title}`,
    `- **Session:** \`${entry.sessionId}\``,
  ];
  if (entry.agent) lines.push(`- **Agent:** ${entry.agent}`);
  if (entry.pid) lines.push(`- **PID:** ${entry.pid}`);
  lines.push(`- **Status:** in-progress`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Build a journal entry for a dispatch end (completion, timeout, crash, etc.).
 */
export function buildEndEntry(entry: JournalEndEntry): string {
  const ts = entry.endedAt ?? new Date().toISOString();
  const lines = [
    "",
    `### ${entry.workItemId} — ${capitalize(entry.outcome)}`,
    "",
    `- **Time:** ${ts}`,
    `- **Outcome:** ${entry.outcome}`,
  ];
  if (entry.agent) lines.push(`- **Agent:** ${entry.agent}`);
  if (entry.durationMinutes !== undefined) {
    lines.push(`- **Duration:** ${entry.durationMinutes} minutes`);
  }
  if (entry.summary) {
    lines.push(`- **Summary:** ${entry.summary}`);
  }
  lines.push("");
  return lines.join("\n");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Effectful: Write to River ──────────────────────────────────────────────────

/**
 * Append a journal entry to the daily dispatch journal file.
 * Creates the file with header if it doesn't exist.
 * Non-fatal: catches all errors.
 */
export async function appendJournalEntry(
  content: string,
  date?: string,
): Promise<boolean> {
  try {
    return await _journalLock.withLock(async () => {
      const path = buildJournalPath(date);
      const fullPath = join(RIVER_ROOT, path);
      const dirPath = join(RIVER_ROOT, "dispatch-journal");

      await mkdir(dirPath, { recursive: true });

      let existing = "";
      try {
        existing = await readFile(fullPath, "utf-8");
      } catch {
        // File doesn't exist — create with header
        existing = buildJournalHeader(date);
      }

      await writeFile(fullPath, existing.trimEnd() + "\n" + content, "utf-8");
      logger.info("Journal entry appended", { path });

      await qmdReindex();
      return true;
    });
  } catch (err) {
    logger.warn("appendJournalEntry failed (non-fatal)", err);
    return false;
  }
}

// ── Convenience: High-level dispatch lifecycle ─────────────────────────────────

/**
 * Log a dispatch start to the daily journal. Fire-and-forget.
 */
export async function journalDispatchStart(
  entry: JournalStartEntry,
): Promise<boolean> {
  const content = buildStartEntry(entry);
  return appendJournalEntry(content);
}

/**
 * Log a dispatch end to the daily journal. Fire-and-forget.
 */
export async function journalDispatchEnd(
  entry: JournalEndEntry,
): Promise<boolean> {
  const content = buildEndEntry(entry);
  return appendJournalEntry(content);
}
