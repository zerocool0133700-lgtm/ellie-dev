/**
 * Ticket Status Query — ELLIE-568
 *
 * QMD-first status queries with Plane reconciliation.
 * Queries River via QMD for work trails, verification logs, dispatch journal,
 * and context cards — then reconciles against Plane canonical state.
 *
 * Two layers:
 *  - Pure: reconciliation logic, discrepancy detection (zero deps, testable)
 *  - Effectful: QMD search + Plane query + assembly (non-fatal)
 */

import { searchRiver } from "./api/bridge-river.ts";
import { readContextCard } from "./ticket-context-card.ts";
import { log } from "./logger.ts";

const logger = log.child("ticket-status");

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RiverEvidence {
  workTrails: RiverDoc[];
  verificationLogs: RiverDoc[];
  journalEntries: RiverDoc[];
  contextCard: string | null;
}

export interface RiverDoc {
  file: string;
  title: string;
  snippet: string;
  score: number;
}

export interface PlaneState {
  stateGroup: string | null; // "backlog" | "unstarted" | "started" | "completed" | "cancelled"
  stateName: string | null;
  title: string | null;
  priority: string | null;
  updatedAt: string | null;
}

export interface Discrepancy {
  field: string;
  riverSays: string;
  planeSays: string;
  severity: "info" | "warning" | "critical";
}

export interface StatusReport {
  workItemId: string;
  river: RiverEvidence;
  plane: PlaneState;
  discrepancies: Discrepancy[];
  lastVerifiedAt: string | null;
  summary: string;
}

// ── Pure: State group mapping ───────────────────────────────────────────────────

const STATE_GROUP_LABELS: Record<string, string> = {
  backlog: "Backlog",
  unstarted: "Todo",
  started: "In Progress",
  completed: "Done",
  cancelled: "Cancelled",
};

export function stateGroupLabel(group: string | null): string {
  if (!group) return "Unknown";
  return STATE_GROUP_LABELS[group] ?? group;
}

// ── Pure: Extract verified timestamp from verification logs ─────────────────────

/**
 * Extract the most recent verification timestamp from River evidence.
 * Looks for ISO timestamps in verification log snippets.
 */
export function extractLastVerifiedAt(verificationLogs: RiverDoc[]): string | null {
  if (verificationLogs.length === 0) return null;

  let latest: string | null = null;
  for (const doc of verificationLogs) {
    const match = doc.snippet.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    if (match) {
      if (!latest || match[0] > latest) {
        latest = match[0];
      }
    }
  }
  return latest;
}

// ── Pure: Extract outcome from River evidence ───────────────────────────────────

/**
 * Extract the most recent outcome from River evidence (journal/work trails).
 * Returns the outcome string or null if not found.
 */
export function extractRiverOutcome(river: RiverEvidence): string | null {
  // Check journal entries first (most recent events)
  for (const doc of river.journalEntries) {
    const outcomeMatch = doc.snippet.match(/\*\*Outcome:\*\*\s*(\w+)/);
    if (outcomeMatch) return outcomeMatch[1];

    // Also check H3 headers like "### ELLIE-567 — Completed"
    const headerMatch = doc.snippet.match(/###\s+\S+\s+—\s+(\w+)/);
    if (headerMatch) return headerMatch[1].toLowerCase();
  }

  // Check work trails
  for (const doc of river.workTrails) {
    const statusMatch = doc.snippet.match(/status:\s*(\S+)/);
    if (statusMatch) return statusMatch[1];
  }

  // Check context card
  if (river.contextCard) {
    const outcomeMatch = river.contextCard.match(/\*\*Outcome:\*\*\s*(\w+)/);
    if (outcomeMatch) return outcomeMatch[1];
  }

  return null;
}

// ── Pure: Map River outcome to expected Plane state group ───────────────────────

/**
 * Map a River-recorded outcome to the expected Plane state group.
 */
export function expectedPlaneStateGroup(outcome: string): string | null {
  switch (outcome.toLowerCase()) {
    case "completed":
    case "done":
      return "completed";
    case "timeout":
    case "crashed":
    case "paused":
    case "blocked":
    case "in-progress":
      return "started";
    default:
      return null;
  }
}

// ── Pure: Detect discrepancies between River and Plane ──────────────────────────

/**
 * Compare River evidence against Plane state and return discrepancies.
 */
export function findDiscrepancies(
  river: RiverEvidence,
  plane: PlaneState,
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];

  const riverOutcome = extractRiverOutcome(river);
  if (!riverOutcome || !plane.stateGroup) return discrepancies;

  const expectedGroup = expectedPlaneStateGroup(riverOutcome);
  if (!expectedGroup) return discrepancies;

  // Check state mismatch
  if (expectedGroup !== plane.stateGroup) {
    const severity = determineSeverity(riverOutcome, plane.stateGroup);
    discrepancies.push({
      field: "state",
      riverSays: `${riverOutcome} (expected Plane: ${stateGroupLabel(expectedGroup)})`,
      planeSays: stateGroupLabel(plane.stateGroup),
      severity,
    });
  }

  // Check for timeout/crash with Plane still showing In Progress
  if (
    (riverOutcome === "timeout" || riverOutcome === "crashed") &&
    plane.stateGroup === "started"
  ) {
    discrepancies.push({
      field: "stale_state",
      riverSays: `Agent ${riverOutcome} — no successful completion recorded`,
      planeSays: "Still showing In Progress",
      severity: "critical",
    });
  }

  return discrepancies;
}

function determineSeverity(
  riverOutcome: string,
  planeGroup: string,
): "info" | "warning" | "critical" {
  // Critical: River says done but Plane disagrees, or vice versa
  if (
    (riverOutcome === "completed" && planeGroup !== "completed") ||
    (planeGroup === "completed" && riverOutcome !== "completed" && riverOutcome !== "done")
  ) {
    return "critical";
  }
  // Warning: stale state (timeout/crash but still In Progress)
  if (
    (riverOutcome === "timeout" || riverOutcome === "crashed") &&
    planeGroup === "started"
  ) {
    return "warning";
  }
  return "info";
}

// ── Pure: Build status summary ──────────────────────────────────────────────────

/**
 * Build a human-readable status summary from the report data.
 */
export function buildStatusSummary(
  workItemId: string,
  river: RiverEvidence,
  plane: PlaneState,
  discrepancies: Discrepancy[],
  lastVerifiedAt: string | null,
): string {
  const lines: string[] = [];

  lines.push(`## Status: ${workItemId}`);
  lines.push("");

  // Plane state
  lines.push(`**Plane State:** ${stateGroupLabel(plane.stateGroup)}`);
  if (plane.title) lines.push(`**Title:** ${plane.title}`);
  if (plane.priority) lines.push(`**Priority:** ${plane.priority}`);
  lines.push("");

  // River evidence
  const riverOutcome = extractRiverOutcome(river);
  if (riverOutcome) {
    lines.push(`**River Outcome:** ${riverOutcome}`);
  }

  const evidenceCount =
    river.workTrails.length +
    river.verificationLogs.length +
    river.journalEntries.length +
    (river.contextCard ? 1 : 0);

  lines.push(`**River Evidence:** ${evidenceCount} document(s) found`);

  if (river.workTrails.length > 0) {
    lines.push(`  - ${river.workTrails.length} work trail(s)`);
  }
  if (river.verificationLogs.length > 0) {
    lines.push(`  - ${river.verificationLogs.length} verification log(s)`);
  }
  if (river.journalEntries.length > 0) {
    lines.push(`  - ${river.journalEntries.length} journal entry(ies)`);
  }
  if (river.contextCard) {
    lines.push("  - Context card found");
  }

  if (lastVerifiedAt) {
    lines.push(`**Last Verified:** ${lastVerifiedAt}`);
  }
  lines.push("");

  // Discrepancies
  if (discrepancies.length > 0) {
    lines.push("### Discrepancies");
    lines.push("");
    for (const d of discrepancies) {
      const icon =
        d.severity === "critical" ? "🔴" :
        d.severity === "warning" ? "🟡" : "🔵";
      lines.push(`${icon} **${d.field}**: River says "${d.riverSays}" but Plane says "${d.planeSays}"`);
    }
  } else {
    lines.push("*No discrepancies detected — River and Plane are consistent.*");
  }
  lines.push("");

  return lines.join("\n");
}

// ── Effectful: Query River via QMD ──────────────────────────────────────────────

/**
 * Gather all River evidence for a work item.
 * Searches work trails, verification logs, journal entries, and context cards.
 */
export async function queryRiver(
  workItemId: string,
  searchFn: typeof searchRiver = searchRiver,
  readCardFn: typeof readContextCard = readContextCard,
): Promise<RiverEvidence> {
  // Run searches in parallel
  const [allResults, contextCard] = await Promise.all([
    searchFn(workItemId, 20),
    readCardFn(workItemId),
  ]);

  // Categorize results by file path
  const workTrails: RiverDoc[] = [];
  const verificationLogs: RiverDoc[] = [];
  const journalEntries: RiverDoc[] = [];

  for (const r of allResults) {
    const doc: RiverDoc = {
      file: r.file,
      title: r.title,
      snippet: r.snippet,
      score: r.score,
    };

    if (r.file.startsWith("work-trails/")) {
      workTrails.push(doc);
    } else if (r.file.startsWith("verification/") || r.file.includes("verification")) {
      verificationLogs.push(doc);
    } else if (r.file.startsWith("dispatch-journal/")) {
      journalEntries.push(doc);
    }
  }

  return { workTrails, verificationLogs, journalEntries, contextCard };
}

// ── Effectful: Query Plane ──────────────────────────────────────────────────────

/**
 * Fetch canonical state from Plane for a work item.
 * Injectable for testing.
 */
export async function queryPlane(
  workItemId: string,
  planeFetchFn?: (id: string) => Promise<PlaneState>,
): Promise<PlaneState> {
  if (planeFetchFn) return planeFetchFn(workItemId);

  try {
    const { resolveWorkItemId, getIssueStateGroup } = await import("./plane.ts");
    const resolved = await resolveWorkItemId(workItemId);
    if (!resolved) {
      return { stateGroup: null, stateName: null, title: null, priority: null, updatedAt: null };
    }

    const stateGroup = await getIssueStateGroup(resolved.projectId, resolved.issueId as string);
    return {
      stateGroup,
      stateName: stateGroupLabel(stateGroup),
      title: null,
      priority: null,
      updatedAt: null,
    };
  } catch (err) {
    logger.warn("Plane query failed (non-fatal)", err);
    return { stateGroup: null, stateName: null, title: null, priority: null, updatedAt: null };
  }
}

// ── Effectful: Full status query ────────────────────────────────────────────────

/**
 * Run a full QMD-first status query with Plane reconciliation.
 * Returns a complete StatusReport.
 */
export async function queryTicketStatus(
  workItemId: string,
  opts?: {
    searchFn?: typeof searchRiver;
    readCardFn?: typeof readContextCard;
    planeFetchFn?: (id: string) => Promise<PlaneState>;
  },
): Promise<StatusReport> {
  try {
    // Query River first, then Plane
    const [river, plane] = await Promise.all([
      queryRiver(workItemId, opts?.searchFn, opts?.readCardFn),
      queryPlane(workItemId, opts?.planeFetchFn),
    ]);

    const discrepancies = findDiscrepancies(river, plane);
    const lastVerifiedAt = extractLastVerifiedAt(river.verificationLogs);
    const summary = buildStatusSummary(workItemId, river, plane, discrepancies, lastVerifiedAt);

    return {
      workItemId,
      river,
      plane,
      discrepancies,
      lastVerifiedAt,
      summary,
    };
  } catch (err) {
    logger.warn("queryTicketStatus failed", err);
    return {
      workItemId,
      river: { workTrails: [], verificationLogs: [], journalEntries: [], contextCard: null },
      plane: { stateGroup: null, stateName: null, title: null, priority: null, updatedAt: null },
      discrepancies: [],
      lastVerifiedAt: null,
      summary: `## Status: ${workItemId}\n\n*Unable to query status — both River and Plane queries failed.*\n`,
    };
  }
}
