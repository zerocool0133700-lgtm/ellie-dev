/**
 * Pending Commitments Prompt Section — ELLIE-590 + ELLIE-591 + ELLIE-598
 *
 * Builds a prompt section listing pending commitments so agents
 * never forget in-flight promises. Injected at priority 2 in buildPrompt.
 *
 * ELLIE-591: Escalation tiers for aging commitments:
 *  - Normal: < threshold turns (default 3)
 *  - Escalated: >= threshold — bold, sorted to top, warning prefix
 *  - Critical: >= 2x threshold — explicit instruction to address before continuing
 *
 * ELLIE-598: Sub-commitments displayed indented under their parent.
 *
 * Uses a cache pattern (like working memory) so the prompt builder
 * stays pure and testable.
 */

import {
  listCommitments,
  isSubCommitment,
  listSubCommitments,
  type Commitment,
} from "./commitment-ledger.ts";

// ── Cache ────────────────────────────────────────────────────────────────────

let _cachedSessionId: string | null = null;
let _cachedTurn: number = 0;

/**
 * Set the session context for the next buildPrompt call.
 * Called before buildPrompt in the chat handler.
 */
export function setPendingCommitmentsContext(sessionId: string, currentTurn: number): void {
  _cachedSessionId = sessionId;
  _cachedTurn = currentTurn;
}

/**
 * Inject values directly for testing — bypasses the ledger.
 */
let _testCommitments: Commitment[] | null = null;

export function _injectPendingCommitmentsForTesting(commitments: Commitment[] | null): void {
  _testCommitments = commitments;
}

// ── Configuration ────────────────────────────────────────────────────────────

/** Default escalation threshold in turns. */
const DEFAULT_ESCALATION_THRESHOLD = 3;

// ── Pure: Escalation tier ────────────────────────────────────────────────────

export type EscalationTier = "normal" | "escalated" | "critical";

/**
 * Determine the escalation tier for a commitment based on its age.
 */
export function getEscalationTier(turnsAgo: number, threshold: number = DEFAULT_ESCALATION_THRESHOLD): EscalationTier {
  if (turnsAgo >= threshold * 2) return "critical";
  if (turnsAgo >= threshold) return "escalated";
  return "normal";
}

// ── Pure builder ─────────────────────────────────────────────────────────────

/**
 * Format a single commitment line for the prompt.
 * Escalated commitments are bolded with a warning prefix.
 * Critical commitments get an urgent prefix.
 */
export function formatCommitmentLine(c: Commitment, currentTurn: number, threshold?: number): string {
  const turnsAgo = currentTurn - c.turnCreated;
  const ageLabel = turnsAgo === 0 ? "this turn" : turnsAgo === 1 ? "1 turn ago" : `${turnsAgo} turns ago`;
  const tier = getEscalationTier(turnsAgo, threshold);

  if (tier === "critical") {
    return `- **[OVERDUE]** **[${c.source}] ${c.description}** (${ageLabel})`;
  }
  if (tier === "escalated") {
    return `- **[${c.source}] ${c.description}** (${ageLabel})`;
  }
  return `- [${c.source}] ${c.description} (${ageLabel})`;
}

/**
 * ELLIE-598: Format a sub-commitment line, indented under its parent.
 */
export function formatSubCommitmentLine(c: Commitment, currentTurn: number, threshold?: number): string {
  const turnsAgo = currentTurn - c.turnCreated;
  const ageLabel = turnsAgo === 0 ? "this turn" : turnsAgo === 1 ? "1 turn ago" : `${turnsAgo} turns ago`;
  const tier = getEscalationTier(turnsAgo, threshold);
  const agentLabel = c.targetAgent ? `→${c.targetAgent}` : "";
  const durationLabel = c.estimatedDuration ? ` ~${c.estimatedDuration}m` : "";

  if (tier === "critical") {
    return `  - **[OVERDUE]** **${agentLabel} ${c.description}**${durationLabel} (${ageLabel})`;
  }
  if (tier === "escalated") {
    return `  - **${agentLabel} ${c.description}**${durationLabel} (${ageLabel})`;
  }
  return `  - ${agentLabel} ${c.description}${durationLabel} (${ageLabel})`;
}

/**
 * Build the PENDING COMMITMENTS prompt section from a list of commitments.
 * Returns null if there are no pending commitments (section is omitted).
 *
 * ELLIE-591: Escalated commitments sorted to top. Critical commitments
 * generate an explicit instruction to address them.
 *
 * ELLIE-598: Sub-commitments displayed indented under their parent.
 */
export function buildPendingCommitmentsSection(
  commitments: Commitment[],
  currentTurn: number,
  threshold: number = DEFAULT_ESCALATION_THRESHOLD,
): string | null {
  const pending = commitments.filter(c => c.status === "pending");
  if (pending.length === 0) return null;

  // Separate top-level and sub-commitments
  const topLevel = pending.filter(c => !isSubCommitment(c));
  const subsByParent = new Map<string, Commitment[]>();
  for (const c of pending) {
    if (isSubCommitment(c) && c.parentCommitmentId) {
      const subs = subsByParent.get(c.parentCommitmentId) ?? [];
      subs.push(c);
      subsByParent.set(c.parentCommitmentId, subs);
    }
  }

  // Sort top-level: critical first, then escalated, then normal
  const sorted = [...topLevel].sort((a, b) => {
    const tierOrder: Record<EscalationTier, number> = { critical: 0, escalated: 1, normal: 2 };
    const aTier = getEscalationTier(currentTurn - a.turnCreated, threshold);
    const bTier = getEscalationTier(currentTurn - b.turnCreated, threshold);
    return tierOrder[aTier] - tierOrder[bTier];
  });

  // Build lines with sub-commitments nested under parents
  const lines: string[] = [];
  for (const c of sorted) {
    lines.push(formatCommitmentLine(c, currentTurn, threshold));
    const subs = subsByParent.get(c.id);
    if (subs && subs.length > 0) {
      for (const sub of subs) {
        lines.push(formatSubCommitmentLine(sub, currentTurn, threshold));
      }
    }
  }

  // Also show orphaned sub-commitments (parent resolved but sub still pending)
  for (const [parentId, subs] of subsByParent) {
    if (!sorted.some(c => c.id === parentId)) {
      for (const sub of subs) {
        lines.push(formatSubCommitmentLine(sub, currentTurn, threshold));
      }
    }
  }

  // Check for critical commitments — add explicit instruction
  const criticalCommitments = pending.filter(c =>
    getEscalationTier(currentTurn - c.turnCreated, threshold) === "critical"
  );

  let section =
    `\nPENDING COMMITMENTS (${pending.length}):\n` +
    `These promises are in-flight. Track their progress and resolve when complete.\n` +
    lines.join("\n");

  if (criticalCommitments.length > 0) {
    const ages = criticalCommitments.map(c => currentTurn - c.turnCreated);
    const maxAge = Math.max(...ages);
    section += `\n\nYou have ${criticalCommitments.length === 1 ? "an unresolved commitment" : `${criticalCommitments.length} unresolved commitments`} that ${criticalCommitments.length === 1 ? "is" : "are"} ${maxAge} turns old. Address ${criticalCommitments.length === 1 ? "it" : "them"} before continuing.`;
  }

  return section;
}

/**
 * Get the pending commitments section for the current cached session.
 * Called by buildPrompt — returns null if no pending commitments.
 */
export function getPendingCommitmentsForPrompt(): string | null {
  // Test injection takes precedence
  if (_testCommitments !== null) {
    return buildPendingCommitmentsSection(_testCommitments, _cachedTurn);
  }

  if (!_cachedSessionId) return null;

  const commitments = listCommitments(_cachedSessionId);
  return buildPendingCommitmentsSection(commitments, _cachedTurn);
}
