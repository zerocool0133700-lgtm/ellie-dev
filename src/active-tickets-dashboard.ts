/**
 * Active Tickets Dashboard — ELLIE-566
 *
 * Maintains a living `dashboards/active-tickets.md` in River,
 * updated on every dispatch lifecycle event (start, complete, pause, timeout).
 *
 * Three sections:
 *  - In Progress: ticket, agent, start time, last update
 *  - Blocked: ticket, blocker description
 *  - Completed Today: ticket, completion time, summary
 *
 * Two layers:
 *  - Pure: in-memory state model + content builder (zero deps, testable)
 *  - Effectful: read/write to River vault + QMD reindex (non-fatal)
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { RIVER_ROOT, qmdReindex } from "./api/bridge-river.ts";
import { log } from "./logger.ts";
import { AsyncMutex } from "./async-mutex.ts";

const logger = log.child("active-tickets");

// Re-export for backwards compatibility (tests import from here)
export { AsyncMutex } from "./async-mutex.ts";

/** Shared mutex for all dashboard read-modify-write operations. */
const _dashboardLock = new AsyncMutex();

/** Exposed for testing — allows tests to verify lock state. */
export function _getDashboardLockForTesting(): AsyncMutex {
  return _dashboardLock;
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TicketEntry {
  workItemId: string;
  title: string;
  agent?: string;
  startedAt: string;
  lastUpdate?: string;
}

export interface BlockedEntry {
  workItemId: string;
  title: string;
  blocker: string;
  since: string;
}

export interface CompletedEntry {
  workItemId: string;
  title: string;
  agent?: string;
  completedAt: string;
  summary: string;
  durationMinutes?: number;
}

export interface DashboardState {
  inProgress: TicketEntry[];
  blocked: BlockedEntry[];
  completedToday: CompletedEntry[];
  lastUpdated: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

export const DASHBOARD_PATH = "dashboards/active-tickets.md";

// ── Pure: State operations ─────────────────────────────────────────────────────

/** Create an empty dashboard state. */
export function emptyState(): DashboardState {
  return {
    inProgress: [],
    blocked: [],
    completedToday: [],
    lastUpdated: new Date().toISOString(),
  };
}

/** Add a ticket to in-progress (or update if already there). */
export function addInProgress(
  state: DashboardState,
  entry: TicketEntry,
): DashboardState {
  const filtered = state.inProgress.filter(
    (t) => t.workItemId !== entry.workItemId,
  );
  return {
    ...state,
    inProgress: [...filtered, entry],
    lastUpdated: new Date().toISOString(),
  };
}

/** Move a ticket from in-progress to completed. */
export function markCompleted(
  state: DashboardState,
  completed: CompletedEntry,
): DashboardState {
  return {
    ...state,
    inProgress: state.inProgress.filter(
      (t) => t.workItemId !== completed.workItemId,
    ),
    blocked: state.blocked.filter(
      (t) => t.workItemId !== completed.workItemId,
    ),
    completedToday: [...state.completedToday, completed],
    lastUpdated: new Date().toISOString(),
  };
}

/** Move a ticket to blocked. */
export function markBlocked(
  state: DashboardState,
  entry: BlockedEntry,
): DashboardState {
  return {
    ...state,
    inProgress: state.inProgress.filter(
      (t) => t.workItemId !== entry.workItemId,
    ),
    blocked: [
      ...state.blocked.filter((t) => t.workItemId !== entry.workItemId),
      entry,
    ],
    lastUpdated: new Date().toISOString(),
  };
}

/** Remove a ticket from in-progress (paused or timed out without completion). */
export function removeInProgress(
  state: DashboardState,
  workItemId: string,
): DashboardState {
  return {
    ...state,
    inProgress: state.inProgress.filter((t) => t.workItemId !== workItemId),
    lastUpdated: new Date().toISOString(),
  };
}

/** Prune completed entries older than today (based on date string comparison). */
export function pruneOldCompleted(
  state: DashboardState,
  today?: string,
): DashboardState {
  const d = today ?? new Date().toISOString().slice(0, 10);
  return {
    ...state,
    completedToday: state.completedToday.filter(
      (c) => c.completedAt.slice(0, 10) === d,
    ),
  };
}

// ── Pure: Content builder ──────────────────────────────────────────────────────

/** Build the full dashboard markdown from state. */
export function buildDashboardContent(state: DashboardState): string {
  const lines: string[] = [
    "---",
    "type: active-tickets-dashboard",
    `last_updated: ${state.lastUpdated}`,
    "---",
    "",
    "# Active Tickets Dashboard",
    "",
    `> Last updated: ${state.lastUpdated}`,
    "",
  ];

  // In Progress
  lines.push("## In Progress");
  lines.push("");
  if (state.inProgress.length === 0) {
    lines.push("*No tickets in progress.*");
  } else {
    lines.push("| Ticket | Title | Agent | Started | Last Update |");
    lines.push("|--------|-------|-------|---------|-------------|");
    for (const t of state.inProgress) {
      lines.push(
        `| ${t.workItemId} | ${t.title} | ${t.agent ?? "-"} | ${t.startedAt.slice(0, 16)} | ${(t.lastUpdate ?? t.startedAt).slice(0, 16)} |`,
      );
    }
  }
  lines.push("");

  // Blocked
  lines.push("## Blocked");
  lines.push("");
  if (state.blocked.length === 0) {
    lines.push("*No blocked tickets.*");
  } else {
    lines.push("| Ticket | Title | Blocker | Since |");
    lines.push("|--------|-------|---------|-------|");
    for (const b of state.blocked) {
      lines.push(
        `| ${b.workItemId} | ${b.title} | ${b.blocker} | ${b.since.slice(0, 16)} |`,
      );
    }
  }
  lines.push("");

  // Completed Today
  lines.push("## Completed Today");
  lines.push("");
  if (state.completedToday.length === 0) {
    lines.push("*No tickets completed today.*");
  } else {
    lines.push("| Ticket | Title | Agent | Completed | Duration | Summary |");
    lines.push("|--------|-------|-------|-----------|----------|---------|");
    for (const c of state.completedToday) {
      const dur = c.durationMinutes !== undefined ? `${c.durationMinutes}m` : "-";
      lines.push(
        `| ${c.workItemId} | ${c.title} | ${c.agent ?? "-"} | ${c.completedAt.slice(0, 16)} | ${dur} | ${c.summary} |`,
      );
    }
  }
  lines.push("");

  return lines.join("\n");
}

// ── Pure: Parse state from markdown ────────────────────────────────────────────

/**
 * Parse dashboard state from existing markdown content.
 * Best-effort: returns empty state on parse failure.
 */
export function parseDashboardContent(content: string): DashboardState {
  const state = emptyState();

  // Extract last_updated from frontmatter
  const fmMatch = content.match(/last_updated:\s*(.+)/);
  if (fmMatch) state.lastUpdated = fmMatch[1].trim();

  // Parse In Progress table
  const ipSection = extractSection(content, "## In Progress", "##");
  for (const row of parseTableRows(ipSection)) {
    if (row.length >= 5) {
      state.inProgress.push({
        workItemId: row[0],
        title: row[1],
        agent: row[2] === "-" ? undefined : row[2],
        startedAt: row[3],
        lastUpdate: row[4],
      });
    }
  }

  // Parse Blocked table
  const bSection = extractSection(content, "## Blocked", "##");
  for (const row of parseTableRows(bSection)) {
    if (row.length >= 4) {
      state.blocked.push({
        workItemId: row[0],
        title: row[1],
        blocker: row[2],
        since: row[3],
      });
    }
  }

  // Parse Completed Today table
  const cSection = extractSection(content, "## Completed Today", "##");
  for (const row of parseTableRows(cSection)) {
    if (row.length >= 6) {
      state.completedToday.push({
        workItemId: row[0],
        title: row[1],
        agent: row[2] === "-" ? undefined : row[2],
        completedAt: row[3],
        durationMinutes: row[4] !== "-" ? parseInt(row[4]) : undefined,
        summary: row[5],
      });
    }
  }

  return state;
}

function extractSection(
  content: string,
  startHeader: string,
  nextHeaderPrefix: string,
): string {
  const startIdx = content.indexOf(startHeader);
  if (startIdx === -1) return "";
  const afterStart = content.slice(startIdx + startHeader.length);
  const nextIdx = afterStart.indexOf(nextHeaderPrefix);
  return nextIdx === -1 ? afterStart : afterStart.slice(0, nextIdx);
}

function parseTableRows(section: string): string[][] {
  const lines = section.split("\n").filter((l) => l.startsWith("|"));
  // Skip header + separator rows (first two)
  return lines.slice(2).map((line) =>
    line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim()),
  );
}

// ── Effectful: Read/Write dashboard ────────────────────────────────────────────

/** Read current dashboard state from disk. Returns empty state if file missing. */
export async function readDashboardState(): Promise<DashboardState> {
  try {
    const fullPath = join(RIVER_ROOT, DASHBOARD_PATH);
    const content = await readFile(fullPath, "utf-8");
    return parseDashboardContent(content);
  } catch {
    return emptyState();
  }
}

/** Write dashboard state to disk and trigger QMD reindex. */
export async function writeDashboardState(
  state: DashboardState,
): Promise<boolean> {
  try {
    const fullPath = join(RIVER_ROOT, DASHBOARD_PATH);
    await mkdir(dirname(fullPath), { recursive: true });
    const content = buildDashboardContent(state);
    await writeFile(fullPath, content, "utf-8");
    logger.info("Dashboard updated", {
      inProgress: state.inProgress.length,
      blocked: state.blocked.length,
      completed: state.completedToday.length,
    });
    await qmdReindex();
    return true;
  } catch (err) {
    logger.warn("writeDashboardState failed (non-fatal)", err);
    return false;
  }
}

// ── Effectful: High-level lifecycle hooks ──────────────────────────────────────

/** Called when a work session starts. */
export async function dashboardOnStart(
  entry: TicketEntry,
): Promise<void> {
  try {
    await _dashboardLock.withLock(async () => {
      const state = await readDashboardState();
      const pruned = pruneOldCompleted(state);
      const updated = addInProgress(pruned, entry);
      await writeDashboardState(updated);
    });
  } catch (err) {
    logger.warn("dashboardOnStart failed (non-fatal)", err);
  }
}

/** Called when a work session completes. */
export async function dashboardOnComplete(
  entry: CompletedEntry,
): Promise<void> {
  try {
    await _dashboardLock.withLock(async () => {
      const state = await readDashboardState();
      const updated = markCompleted(state, entry);
      await writeDashboardState(updated);
    });
  } catch (err) {
    logger.warn("dashboardOnComplete failed (non-fatal)", err);
  }
}

/** Called when a work session is paused. */
export async function dashboardOnPause(workItemId: string): Promise<void> {
  try {
    await _dashboardLock.withLock(async () => {
      const state = await readDashboardState();
      const updated = removeInProgress(state, workItemId);
      await writeDashboardState(updated);
    });
  } catch (err) {
    logger.warn("dashboardOnPause failed (non-fatal)", err);
  }
}

/** Called when a work session is blocked. */
export async function dashboardOnBlocked(
  entry: BlockedEntry,
): Promise<void> {
  try {
    await _dashboardLock.withLock(async () => {
      const state = await readDashboardState();
      const updated = markBlocked(state, entry);
      await writeDashboardState(updated);
    });
  } catch (err) {
    logger.warn("dashboardOnBlocked failed (non-fatal)", err);
  }
}

// ── Startup Reconciliation (ELLIE-580) ──────────────────────────────────────

export interface ReconciliationResult {
  checked: number;
  removed: number;
  stale: number;
  errors: number;
}

export interface ReconciliationDeps {
  /** Check if a work item is Done or Cancelled in Plane. */
  isWorkItemDone: (workItemId: string) => Promise<boolean>;
  /** Check if a work item has an active (growing) Forest session. */
  hasActiveSession: (workItemId: string) => Promise<boolean>;
}

/**
 * Reconcile the active-tickets dashboard on relay startup.
 *
 * For each "in progress" entry:
 *  - If Done/Cancelled in Plane → remove from dashboard
 *  - If still In Progress but no active Forest session → mark as stale
 *
 * Non-fatal: catches all errors.
 */
export async function reconcileDashboard(
  deps: ReconciliationDeps,
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = { checked: 0, removed: 0, stale: 0, errors: 0 };

  try {
    await _dashboardLock.withLock(async () => {
      let state = await readDashboardState();
      const toRemove: string[] = [];
      const toStale: TicketEntry[] = [];

      for (const entry of state.inProgress) {
        result.checked++;
        try {
          const done = await deps.isWorkItemDone(entry.workItemId);
          if (done) {
            toRemove.push(entry.workItemId);
            result.removed++;
            continue;
          }

          const active = await deps.hasActiveSession(entry.workItemId);
          if (!active) {
            toStale.push(entry);
            result.stale++;
          }
        } catch (err) {
          result.errors++;
          logger.warn("reconcileDashboard: error checking entry", {
            workItemId: entry.workItemId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (toRemove.length > 0 || toStale.length > 0) {
        // Remove completed/cancelled tickets
        for (const id of toRemove) {
          state = removeInProgress(state, id);
        }

        // Mark stale tickets with a lastUpdate containing "STALE"
        const now = new Date().toISOString().slice(0, 16);
        state = {
          ...state,
          inProgress: state.inProgress.map((t) => {
            if (toStale.some((s) => s.workItemId === t.workItemId)) {
              return { ...t, lastUpdate: `STALE ${now}` };
            }
            return t;
          }),
        };

        await writeDashboardState(state);
      }
    });

    logger.info("Dashboard reconciliation complete", {
      checked: result.checked,
      removed: result.removed,
      stale: result.stale,
      errors: result.errors,
    });
  } catch (err) {
    logger.warn("reconcileDashboard failed (non-fatal)", err);
  }

  return result;
}
