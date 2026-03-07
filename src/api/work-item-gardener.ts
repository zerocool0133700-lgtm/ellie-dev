/**
 * Work Item Gardener — ELLIE-407
 *
 * Nightly job that detects orphaned sessions, stale work, and
 * Plane ↔ Forest state mismatches. Follows the same parallel
 * detector pattern as the Channel Gardener (ELLIE-335).
 *
 * Five detectors:
 *  1. collectWorkItemSnapshots — gather Plane + Forest state per work item
 *  2. detectOrphanedSessions  — "In Progress" in Plane, no active Forest tree
 *  3. detectStaleSessions     — Forest tree growing but 24h+ no activity
 *  4. detectMismatches        — Plane state ≠ Forest state
 *  5. detectDeadAgents        — Agent sessions with no work item context
 *
 * Schedule: 3:15 AM CST nightly (after channel gardener at 3 AM).
 * HTTP:     POST /api/work-item-gardener/run   — on-demand trigger
 *           GET  /api/work-item-gardener/findings — list pending findings
 */

import type { IncomingMessage, ServerResponse } from "http";
import { log } from "../logger.ts";
import { getNotifyCtx } from "../relay-state.ts";
import { notify } from "../notification-policy.ts";

const logger = log.child("work-item-gardener");

// ── Types ──────────────────────────────────────────────────────────────────

/** Snapshot of a single work item's state across Plane and Forest. */
export interface WorkItemSnapshot {
  workItemId: string;
  planeName: string;
  planeState: "started" | "unstarted" | "backlog" | "completed" | "cancelled";
  forestTreeId?: string;
  forestTreeState?: string; // nursery, seedling, growing, mature, dormant, archived, composted
  forestLastActivity?: string; // ISO timestamp
  forestCreatedAt?: string;
  hasActiveCreature?: boolean;
  agentName?: string;
}

/** An agent session snapshot for dead-agent detection. */
export interface AgentSnapshot {
  agentName: string;
  status: "idle" | "busy" | "offline";
  sessionId?: string;
  lastActiveAt: string;
  workItemId?: string; // resolved from the tree's work_item_id, if any
}

/** A finding emitted by one of the detectors. */
export interface GardenerFinding {
  type: "orphaned_session" | "stale_session" | "state_mismatch" | "dead_agent";
  workItemId?: string;
  agentName?: string;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  severity: "critical" | "warning" | "info";
  suggestedAction: string;
}

/** Result from the full gardener run. */
export interface GardenerRunResult {
  snapshotCount: number;
  findings: GardenerFinding[];
}

// ── Pure Detectors ─────────────────────────────────────────────────────────

const STALE_THRESHOLD_HOURS = 24;

/**
 * Detect orphaned sessions: work items "In Progress" in Plane but with
 * no active Forest tree (no tree, or tree in dormant/archived/composted state).
 */
export function detectOrphanedSessions(snapshots: WorkItemSnapshot[]): GardenerFinding[] {
  const findings: GardenerFinding[] = [];

  for (const snap of snapshots) {
    if (snap.planeState !== "started") continue;

    const isOrphaned =
      !snap.forestTreeId ||
      ["dormant", "archived", "composted"].includes(snap.forestTreeState ?? "");

    if (isOrphaned) {
      findings.push({
        type: "orphaned_session",
        workItemId: snap.workItemId,
        title: `Orphaned: ${snap.workItemId} — ${snap.planeName}`,
        description: snap.forestTreeId
          ? `In Progress in Plane but Forest tree is ${snap.forestTreeState}. No active session.`
          : `In Progress in Plane but no Forest tree exists.`,
        evidence: {
          planeState: snap.planeState,
          forestTreeId: snap.forestTreeId ?? null,
          forestTreeState: snap.forestTreeState ?? null,
          forestLastActivity: snap.forestLastActivity ?? null,
        },
        severity: "warning",
        suggestedAction: snap.forestTreeId
          ? "Move Plane ticket back to Todo or close it."
          : "Move Plane ticket back to Todo — no session was ever started.",
      });
    }
  }

  return findings;
}

/**
 * Detect stale sessions: Forest tree still "growing" but last activity
 * is 24+ hours ago, suggesting the session was abandoned.
 */
export function detectStaleSessions(
  snapshots: WorkItemSnapshot[],
  now?: Date,
): GardenerFinding[] {
  const findings: GardenerFinding[] = [];
  const currentTime = (now ?? new Date()).getTime();
  const thresholdMs = STALE_THRESHOLD_HOURS * 60 * 60 * 1000;

  for (const snap of snapshots) {
    if (!snap.forestTreeId) continue;
    if (!["growing", "seedling"].includes(snap.forestTreeState ?? "")) continue;

    const lastActivity = snap.forestLastActivity ?? snap.forestCreatedAt;
    if (!lastActivity) continue;

    const ageMs = currentTime - new Date(lastActivity).getTime();
    if (ageMs < thresholdMs) continue;

    const ageHours = Math.round(ageMs / (60 * 60 * 1000));

    findings.push({
      type: "stale_session",
      workItemId: snap.workItemId,
      title: `Stale: ${snap.workItemId} — ${ageHours}h inactive`,
      description: `Forest tree is "${snap.forestTreeState}" but last activity was ${ageHours}h ago. Session may be abandoned.`,
      evidence: {
        forestTreeId: snap.forestTreeId,
        forestTreeState: snap.forestTreeState,
        forestLastActivity: lastActivity,
        ageHours,
        hasActiveCreature: snap.hasActiveCreature ?? false,
      },
      severity: ageHours > 72 ? "critical" : "warning",
      suggestedAction: "Check if the session is still active. If abandoned, mark tree dormant and move Plane ticket to Todo.",
    });
  }

  return findings;
}

/**
 * Detect state mismatches: Plane state and Forest state are contradictory.
 *
 * Cases:
 *  - Plane=completed but Forest tree still growing (should be dormant/archived)
 *  - Plane=started but Forest tree is dormant/archived (orphaned, but from the Forest side)
 */
export function detectMismatches(snapshots: WorkItemSnapshot[]): GardenerFinding[] {
  const findings: GardenerFinding[] = [];

  for (const snap of snapshots) {
    if (!snap.forestTreeId) continue;

    // Case 1: Plane says done, Forest still active
    if (
      snap.planeState === "completed" &&
      ["growing", "seedling", "nursery"].includes(snap.forestTreeState ?? "")
    ) {
      findings.push({
        type: "state_mismatch",
        workItemId: snap.workItemId,
        title: `Mismatch: ${snap.workItemId} — Plane=done, Forest=${snap.forestTreeState}`,
        description: `Plane shows completed but Forest tree is still "${snap.forestTreeState}". The tree should be marked dormant or archived.`,
        evidence: {
          planeState: snap.planeState,
          forestTreeState: snap.forestTreeState,
          forestTreeId: snap.forestTreeId,
        },
        severity: "warning",
        suggestedAction: "Mark Forest tree as dormant/archived to match Plane completion.",
      });
    }

    // Case 2: Plane says in-progress, Forest is dormant (already covered by orphan detector,
    // but this catches the specific mismatch case with a different framing)
    if (
      snap.planeState === "started" &&
      snap.forestTreeState === "mature"
    ) {
      findings.push({
        type: "state_mismatch",
        workItemId: snap.workItemId,
        title: `Mismatch: ${snap.workItemId} — Plane=in-progress, Forest=mature`,
        description: `Plane shows In Progress but Forest tree is mature (session completed). Plane ticket may need to be moved to Done.`,
        evidence: {
          planeState: snap.planeState,
          forestTreeState: snap.forestTreeState,
          forestTreeId: snap.forestTreeId,
        },
        severity: "warning",
        suggestedAction: "Move Plane ticket to Done — Forest session already completed.",
      });
    }
  }

  return findings;
}

/**
 * Detect dead agent sessions: agents marked as "busy" with a session
 * but no corresponding active Forest tree for their work.
 */
export function detectDeadAgents(
  agents: AgentSnapshot[],
  now?: Date,
): GardenerFinding[] {
  const findings: GardenerFinding[] = [];
  const currentTime = (now ?? new Date()).getTime();
  const staleAgentThresholdMs = 2 * 60 * 60 * 1000; // 2 hours

  for (const agent of agents) {
    if (agent.status !== "busy") continue;
    if (!agent.sessionId) continue;

    const lastActiveMs = new Date(agent.lastActiveAt).getTime();
    const ageMs = currentTime - lastActiveMs;

    // Only flag if the agent has been "busy" without activity for 2+ hours
    if (ageMs < staleAgentThresholdMs) continue;

    const ageHours = Math.round(ageMs / (60 * 60 * 1000));

    findings.push({
      type: "dead_agent",
      agentName: agent.agentName,
      workItemId: agent.workItemId,
      title: `Dead agent: ${agent.agentName} — busy ${ageHours}h, no activity`,
      description: agent.workItemId
        ? `Agent "${agent.agentName}" marked busy on ${agent.workItemId} but inactive for ${ageHours}h.`
        : `Agent "${agent.agentName}" marked busy with session ${agent.sessionId} but no work item and inactive for ${ageHours}h.`,
      evidence: {
        agentName: agent.agentName,
        sessionId: agent.sessionId,
        lastActiveAt: agent.lastActiveAt,
        ageHours,
        workItemId: agent.workItemId ?? null,
      },
      severity: ageHours > 12 ? "critical" : "warning",
      suggestedAction: `Mark agent "${agent.agentName}" as idle and clean up the orphaned session.`,
    });
  }

  return findings;
}

/**
 * Run all detectors against the given snapshots and agent data.
 * Returns a combined list of findings.
 */
export function runAllDetectors(
  snapshots: WorkItemSnapshot[],
  agents: AgentSnapshot[],
  now?: Date,
): GardenerFinding[] {
  return [
    ...detectOrphanedSessions(snapshots),
    ...detectStaleSessions(snapshots, now),
    ...detectMismatches(snapshots),
    ...detectDeadAgents(agents, now),
  ];
}

/**
 * Format findings into a human-readable summary for notifications.
 */
export function formatFindings(findings: GardenerFinding[]): string {
  if (!findings.length) return "Work Item Gardener: all clear, no issues found.";

  const byType: Record<string, GardenerFinding[]> = {};
  for (const f of findings) {
    (byType[f.type] ??= []).push(f);
  }

  const lines: string[] = [`🌿 Work Item Gardener: ${findings.length} issue(s) found\n`];

  const typeLabels: Record<string, string> = {
    orphaned_session: "Orphaned Sessions",
    stale_session: "Stale Sessions",
    state_mismatch: "State Mismatches",
    dead_agent: "Dead Agents",
  };

  for (const [type, items] of Object.entries(byType)) {
    lines.push(`**${typeLabels[type] ?? type}** (${items.length}):`);
    for (const item of items) {
      const sev = item.severity === "critical" ? "[!]" : item.severity === "warning" ? "[~]" : "";
      lines.push(`${sev} ${item.title}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Effectful Collector ─────────────────────────────────────────────────────

/**
 * Collect work item snapshots by querying Plane (In Progress issues)
 * and Forest (trees with work_item_id).
 *
 * This is the I/O boundary — detectors are pure and testable.
 */
export async function collectWorkItemSnapshots(): Promise<WorkItemSnapshot[]> {
  const snapshots: WorkItemSnapshot[] = [];

  try {
    // Get In Progress issues from Plane
    const { listOpenIssues } = await import("../plane.ts");
    const openIssues = await listOpenIssues("ELLIE", 100);

    // Get Forest trees with work_item_ids
    const { default: forestSql } = await import("../../../ellie-forest/src/db");

    const forestTrees = await forestSql<Array<{
      id: string;
      work_item_id: string;
      state: string;
      last_activity: Date | null;
      created_at: Date;
      owner_id: string | null;
    }>>`
      SELECT id, work_item_id, state, last_activity, created_at, owner_id
      FROM trees
      WHERE work_item_id IS NOT NULL
      AND state NOT IN ('composted')
      ORDER BY created_at DESC
    `;

    // Index Forest trees by work_item_id (most recent per item)
    const treeByWorkItem = new Map<string, typeof forestTrees[0]>();
    for (const tree of forestTrees) {
      if (!treeByWorkItem.has(tree.work_item_id)) {
        treeByWorkItem.set(tree.work_item_id, tree);
      }
    }

    // Check for active creatures in active trees
    const activeTreeIds = forestTrees
      .filter(t => ["growing", "seedling", "nursery"].includes(t.state))
      .map(t => t.id);

    const activeCreatures = activeTreeIds.length > 0
      ? await forestSql<Array<{ tree_id: string }>>`
          SELECT DISTINCT tree_id FROM creatures
          WHERE tree_id = ANY(${activeTreeIds})
          AND state IN ('dispatched', 'working')
        `
      : [];

    const treesWithActiveCreatures = new Set(activeCreatures.map(c => c.tree_id));

    // Build snapshots for open Plane issues
    for (const issue of openIssues) {
      const workItemId = `ELLIE-${issue.sequenceId}`;
      const tree = treeByWorkItem.get(workItemId);

      snapshots.push({
        workItemId,
        planeName: issue.name,
        planeState: "started", // listOpenIssues filters out completed/cancelled
        forestTreeId: tree?.id,
        forestTreeState: tree?.state,
        forestLastActivity: tree?.last_activity?.toISOString(),
        forestCreatedAt: tree?.created_at?.toISOString(),
        hasActiveCreature: tree ? treesWithActiveCreatures.has(tree.id) : false,
        agentName: tree?.owner_id ?? undefined,
      });
    }

    // Also check: Forest trees that are still growing but Plane says completed
    for (const tree of forestTrees) {
      if (!["growing", "seedling"].includes(tree.state)) continue;
      // Skip if already in snapshots (open in Plane)
      if (snapshots.some(s => s.workItemId === tree.work_item_id)) continue;

      // This tree is active in Forest but not in open Plane issues → might be completed
      snapshots.push({
        workItemId: tree.work_item_id,
        planeName: "(not in open issues)",
        planeState: "completed", // Inferred: not in open list = completed or cancelled
        forestTreeId: tree.id,
        forestTreeState: tree.state,
        forestLastActivity: tree.last_activity?.toISOString(),
        forestCreatedAt: tree.created_at?.toISOString(),
        hasActiveCreature: treesWithActiveCreatures.has(tree.id),
        agentName: tree.owner_id ?? undefined,
      });
    }
  } catch (err) {
    logger.warn("collectWorkItemSnapshots failed", err);
  }

  return snapshots;
}

/**
 * Collect agent snapshots from the agent registry.
 */
export async function collectAgentSnapshots(): Promise<AgentSnapshot[]> {
  try {
    const { listAgents } = await import("../agent-registry.ts");
    const agents = listAgents();

    // For busy agents, try to resolve their work_item_id from Forest
    const agentSnapshots: AgentSnapshot[] = [];

    for (const agent of agents) {
      let workItemId: string | undefined;

      if (agent.status === "busy" && agent.sessionId) {
        try {
          const { default: forestSql } = await import("../../../ellie-forest/src/db");
          const [tree] = await forestSql<Array<{ work_item_id: string | null }>>`
            SELECT work_item_id FROM trees WHERE id = ${agent.sessionId} LIMIT 1
          `;
          workItemId = tree?.work_item_id ?? undefined;
        } catch {
          // Forest query failed — non-fatal
        }
      }

      agentSnapshots.push({
        agentName: agent.agentName,
        status: agent.status,
        sessionId: agent.sessionId,
        lastActiveAt: agent.lastActiveAt,
        workItemId,
      });
    }

    return agentSnapshots;
  } catch (err) {
    logger.warn("collectAgentSnapshots failed", err);
    return [];
  }
}

// ── Main Runner ─────────────────────────────────────────────────────────────

/**
 * Full nightly gardener run:
 * 1. Collect work item snapshots (Plane + Forest).
 * 2. Collect agent snapshots.
 * 3. Run all detectors.
 * 4. Notify if findings exist.
 */
export async function runWorkItemGardener(): Promise<GardenerRunResult> {
  logger.info("Work item gardener starting");

  const snapshots = await collectWorkItemSnapshots();
  const agents = await collectAgentSnapshots();

  const findings = runAllDetectors(snapshots, agents);

  if (findings.length > 0) {
    const summary = formatFindings(findings);
    notify(getNotifyCtx(), {
      event: "rollup",
      telegramMessage: summary,
    });
    logger.info(`Work item gardener: ${findings.length} finding(s)`, {
      byType: findings.reduce((acc, f) => {
        acc[f.type] = (acc[f.type] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    });
  } else {
    logger.info("Work item gardener: all clear");
  }

  return { snapshotCount: snapshots.length, findings };
}

// ── HTTP Handlers ──────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/** POST /api/work-item-gardener/run — trigger on-demand */
export async function workItemGardenerRunHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const result = await runWorkItemGardener();
    sendJson(res, 200, {
      ok: true,
      snapshotCount: result.snapshotCount,
      findingCount: result.findings.length,
      findings: result.findings,
    });
  } catch (err: unknown) {
    logger.error("workItemGardenerRunHandler error", err);
    sendJson(res, 500, { error: "Work item gardener run failed" });
  }
}

/** GET /api/work-item-gardener/findings — list findings from last run */
export async function workItemGardenerFindingsHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Re-run detectors to get current findings (stateless — no DB storage needed)
  try {
    const result = await runWorkItemGardener();
    sendJson(res, 200, { findings: result.findings });
  } catch (err: unknown) {
    logger.error("workItemGardenerFindingsHandler error", err);
    sendJson(res, 500, { error: "Failed to collect findings" });
  }
}
