/**
 * Ticket Context Cards — ELLIE-567
 *
 * Auto-creates `tickets/ELLIE-{ID}.md` in River on first mention.
 * Appends work history after each session. Writes handoff notes on timeout.
 *
 * Two layers:
 *  - Pure content builders (zero deps, fully testable)
 *  - Effectful writers (fs + QMD reindex, non-fatal)
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { RIVER_ROOT, qmdReindex } from "./api/bridge-river.ts";
import { log } from "./logger.ts";
import { AsyncMutex } from "./async-mutex.ts";

const logger = log.child("ticket-context");

/** Shared mutex for all ticket context card read-modify-write operations. */
const _contextCardLock = new AsyncMutex();

/** Exposed for testing — allows tests to verify lock state. */
export function _getContextCardLockForTesting(): AsyncMutex {
  return _contextCardLock;
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TicketMetadata {
  workItemId: string;
  title: string;
  priority?: string;
  agent?: string;
}

export interface WorkHistoryEntry {
  agent?: string;
  outcome: "completed" | "timeout" | "crashed" | "blocked" | "paused";
  summary?: string;
  durationMinutes?: number;
  timestamp?: string;
}

export interface HandoffNote {
  whatWasAttempted: string;
  whatToDoDifferently?: string;
  filesInvolved?: string[];
  blockers?: string[];
  timestamp?: string;
}

// ── Pure: Path builder ─────────────────────────────────────────────────────────

/** Build the context card path for a ticket. E.g. "tickets/ELLIE-567.md" */
export function buildContextCardPath(workItemId: string): string {
  return `tickets/${workItemId}.md`;
}

// ── Pure: Content builders ─────────────────────────────────────────────────────

/** Build initial context card content for a new ticket. */
export function buildContextCardContent(meta: TicketMetadata): string {
  const lines = [
    "---",
    "type: ticket-context-card",
    `work_item_id: ${meta.workItemId}`,
    `title: "${meta.title.replace(/"/g, '\\"')}"`,
    meta.priority ? `priority: ${meta.priority}` : null,
    "---",
    "",
    `# ${meta.workItemId} — ${meta.title}`,
    "",
    "## Metadata",
    "",
    `- **Status:** in-progress`,
    `- **Priority:** ${meta.priority ?? "unknown"}`,
    meta.agent ? `- **Last Agent:** ${meta.agent}` : null,
    "",
    "## Work History",
    "",
    "*No sessions recorded yet.*",
    "",
    "## Files Involved",
    "",
    "*None recorded.*",
    "",
    "## Dependencies & Blockers",
    "",
    "*None recorded.*",
    "",
    "## Handoff Notes",
    "",
    "*No handoff notes.*",
    "",
  ];
  return lines.filter((l) => l !== null).join("\n");
}

/** Build a work history entry to append. */
export function buildWorkHistoryAppend(entry: WorkHistoryEntry): string {
  const ts = entry.timestamp ?? new Date().toISOString();
  const lines = [
    "",
    `### Session — ${ts.slice(0, 16)}`,
    "",
    `- **Outcome:** ${entry.outcome}`,
  ];
  if (entry.agent) lines.push(`- **Agent:** ${entry.agent}`);
  if (entry.durationMinutes !== undefined) {
    lines.push(`- **Duration:** ${entry.durationMinutes} minutes`);
  }
  if (entry.summary) lines.push(`- **Summary:** ${entry.summary}`);
  lines.push("");
  return lines.join("\n");
}

/** Build a handoff note to append (for timeouts/crashes). */
export function buildHandoffAppend(note: HandoffNote): string {
  const ts = note.timestamp ?? new Date().toISOString();
  const lines = [
    "",
    `### Handoff — ${ts.slice(0, 16)}`,
    "",
    `**What was attempted:** ${note.whatWasAttempted}`,
  ];
  if (note.whatToDoDifferently) {
    lines.push(`**What to do differently:** ${note.whatToDoDifferently}`);
  }
  if (note.filesInvolved?.length) {
    lines.push("**Files involved:**");
    for (const f of note.filesInvolved) {
      lines.push(`- \`${f}\``);
    }
  }
  if (note.blockers?.length) {
    lines.push("**Blockers:**");
    for (const b of note.blockers) {
      lines.push(`- ${b}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ── Effectful: Read/Write context cards ────────────────────────────────────────

/**
 * Ensure a context card exists for a ticket.
 * Creates it if missing, returns true. Skips if already exists.
 */
export async function ensureContextCard(
  meta: TicketMetadata,
): Promise<boolean> {
  try {
    return await _contextCardLock.withLock(async () => {
      const path = buildContextCardPath(meta.workItemId);
      const fullPath = join(RIVER_ROOT, path);

      // Check if already exists
      try {
        await readFile(fullPath, "utf-8");
        return true; // Already exists
      } catch {
        // Doesn't exist — create it
      }

      await mkdir(dirname(fullPath), { recursive: true });
      const content = buildContextCardContent(meta);
      await writeFile(fullPath, content, "utf-8");
      logger.info("Context card created", { workItemId: meta.workItemId });
      await qmdReindex();
      return true;
    });
  } catch (err) {
    logger.warn("ensureContextCard failed (non-fatal)", err);
    return false;
  }
}

/**
 * Append work history to a ticket's context card.
 * Creates the card if it doesn't exist yet.
 */
export async function appendWorkHistory(
  workItemId: string,
  title: string,
  entry: WorkHistoryEntry,
): Promise<boolean> {
  try {
    return await _contextCardLock.withLock(async () => {
      const path = buildContextCardPath(workItemId);
      const fullPath = join(RIVER_ROOT, path);

      let existing: string;
      try {
        existing = await readFile(fullPath, "utf-8");
      } catch {
        // Card doesn't exist — create it first (lock already held)
        const meta = { workItemId, title, agent: entry.agent };
        const createPath = join(RIVER_ROOT, buildContextCardPath(workItemId));
        await mkdir(dirname(createPath), { recursive: true });
        await writeFile(createPath, buildContextCardContent(meta), "utf-8");
        logger.info("Context card created", { workItemId });
        try {
          existing = await readFile(fullPath, "utf-8");
        } catch {
          return false;
        }
      }

      // Remove "No sessions recorded yet" placeholder
      const cleaned = existing.replace(
        "*No sessions recorded yet.*\n",
        "",
      );

      // Find the "## Work History" section and append after it
      const historyIdx = cleaned.indexOf("## Work History");
      if (historyIdx === -1) {
        // Fallback: just append at end
        const content = cleaned.trimEnd() + "\n" + buildWorkHistoryAppend(entry);
        await writeFile(fullPath, content, "utf-8");
      } else {
        // Find the next ## section after Work History
        const afterHistory = cleaned.slice(historyIdx + "## Work History".length);
        const nextSectionIdx = afterHistory.indexOf("\n## ");
        if (nextSectionIdx === -1) {
          // No next section — append at end
          const content = cleaned.trimEnd() + "\n" + buildWorkHistoryAppend(entry);
          await writeFile(fullPath, content, "utf-8");
        } else {
          // Insert before the next section
          const insertPoint = historyIdx + "## Work History".length + nextSectionIdx;
          const content =
            cleaned.slice(0, insertPoint) +
            buildWorkHistoryAppend(entry) +
            cleaned.slice(insertPoint);
          await writeFile(fullPath, content, "utf-8");
        }
      }

      logger.info("Work history appended", { workItemId });
      await qmdReindex();
      return true;
    });
  } catch (err) {
    logger.warn("appendWorkHistory failed (non-fatal)", err);
    return false;
  }
}

/**
 * Append handoff notes to a ticket's context card.
 * Used when an agent times out or crashes.
 */
export async function appendHandoffNote(
  workItemId: string,
  title: string,
  note: HandoffNote,
): Promise<boolean> {
  try {
    return await _contextCardLock.withLock(async () => {
      const path = buildContextCardPath(workItemId);
      const fullPath = join(RIVER_ROOT, path);

      let existing: string;
      try {
        existing = await readFile(fullPath, "utf-8");
      } catch {
        // Card doesn't exist — create it (lock already held)
        const createPath = join(RIVER_ROOT, buildContextCardPath(workItemId));
        await mkdir(dirname(createPath), { recursive: true });
        await writeFile(createPath, buildContextCardContent({ workItemId, title }), "utf-8");
        logger.info("Context card created", { workItemId });
        try {
          existing = await readFile(fullPath, "utf-8");
        } catch {
          return false;
        }
      }

      // Remove "No handoff notes" placeholder
      const cleaned = existing.replace("*No handoff notes.*\n", "");

      // Append at end (handoff notes section is last)
      const content = cleaned.trimEnd() + "\n" + buildHandoffAppend(note);
      await writeFile(fullPath, content, "utf-8");

      logger.info("Handoff note appended", { workItemId });
      await qmdReindex();
      return true;
    });
  } catch (err) {
    logger.warn("appendHandoffNote failed (non-fatal)", err);
    return false;
  }
}

/**
 * Read a ticket's context card content. Returns null if not found.
 */
export async function readContextCard(
  workItemId: string,
): Promise<string | null> {
  try {
    const path = buildContextCardPath(workItemId);
    const fullPath = join(RIVER_ROOT, path);
    return await readFile(fullPath, "utf-8");
  } catch {
    return null;
  }
}
