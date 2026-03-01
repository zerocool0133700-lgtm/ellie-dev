/**
 * Context Verification — Lightweight Health Checks & Claim Verification
 *
 * ELLIE-328: Priority-aware verification with fast targeted queries.
 * Builds on Phase 1 (ELLIE-327) priority tiers and freshness tracking.
 *
 * Health checks are single-source, fast (<500ms) queries that verify
 * specific claim types without doing a full context reload.
 */

import { spawn } from "bun";
import { stat } from "fs/promises";
import { log } from "./logger.ts";
import { freshnessTracker, type SourceTier } from "./context-freshness.ts";
import { logVerificationTrail, type VerificationEntry } from "./data-quality.ts";
import type { ContextMode } from "./context-mode.ts";
import { fetchWorkItemDetails, isPlaneConfigured } from "./plane.ts";

const logger = log.child("context:verify");

// ── Types ────────────────────────────────────────────────────

export type ClaimType = "ticket-state" | "service-health" | "file-exists" | "recent-commit";

export interface HealthCheckResult {
  claim: ClaimType;
  target: string;
  source: string;
  tier: SourceTier;
  latencyMs: number;
  result: "confirmed" | "stale" | "failed" | "unavailable";
  value?: string;       // The verified value (e.g. "Done", "active", "exists")
  error?: string;
}

// ── State ID → Label mapping (from verify skill) ────────────

const PLANE_STATE_LABELS: Record<string, string> = {
  "f3546cc1": "Backlog",
  "92d0bdb9": "Todo",
  "e551b5a8": "In Progress",
  "41fddf8d": "Done",
  "3273d02b": "Cancelled",
};

function resolveStateLabel(stateId: string): string {
  // Match against known prefixes (Plane state IDs are full UUIDs)
  for (const [prefix, label] of Object.entries(PLANE_STATE_LABELS)) {
    if (stateId.startsWith(prefix)) return label;
  }
  return "Unknown";
}

// ── Health Check Functions ────────────────────────────────────

/**
 * Verify a Plane ticket's current state.
 * Single API call, typically <500ms.
 */
async function checkTicketState(ticketId: string): Promise<HealthCheckResult> {
  const start = Date.now();
  const result: HealthCheckResult = {
    claim: "ticket-state",
    target: ticketId,
    source: "plane",
    tier: "critical",
    latencyMs: 0,
    result: "failed",
  };

  if (!isPlaneConfigured()) {
    result.latencyMs = Date.now() - start;
    result.result = "unavailable";
    result.error = "Plane not configured";
    return result;
  }

  try {
    const details = await fetchWorkItemDetails(ticketId);
    result.latencyMs = Date.now() - start;

    if (!details) {
      result.result = "failed";
      result.error = "Ticket not found";
      return result;
    }

    result.result = "confirmed";
    result.value = resolveStateLabel(details.state);
    return result;
  } catch (err: any) {
    result.latencyMs = Date.now() - start;
    result.result = "failed";
    result.error = err.message;
    return result;
  }
}

/**
 * Verify a systemd service's health status.
 * Single systemctl call, typically <100ms.
 */
async function checkServiceHealth(serviceName: string): Promise<HealthCheckResult> {
  const start = Date.now();
  const result: HealthCheckResult = {
    claim: "service-health",
    target: serviceName,
    source: "systemctl",
    tier: "critical",
    latencyMs: 0,
    result: "failed",
  };

  try {
    // Try system-level first, then user-level
    const proc = spawn(["systemctl", "is-active", serviceName], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = (await new Response(proc.stdout).text()).trim();
    const exitCode = await proc.exited;
    result.latencyMs = Date.now() - start;

    if (exitCode === 0 && output === "active") {
      result.result = "confirmed";
      result.value = "active";
    } else {
      // Try user-level service
      const userProc = spawn(["systemctl", "--user", "is-active", serviceName], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const userOutput = (await new Response(userProc.stdout).text()).trim();
      const userExit = await userProc.exited;
      result.latencyMs = Date.now() - start;

      if (userExit === 0 && userOutput === "active") {
        result.result = "confirmed";
        result.value = "active";
      } else {
        result.result = "confirmed";
        result.value = userOutput || output || "inactive";
      }
    }

    return result;
  } catch (err: any) {
    result.latencyMs = Date.now() - start;
    result.result = "failed";
    result.error = err.message;
    return result;
  }
}

/**
 * Verify a file exists on the filesystem.
 * Single stat call, typically <50ms.
 */
async function checkFileExists(filePath: string): Promise<HealthCheckResult> {
  const start = Date.now();
  const result: HealthCheckResult = {
    claim: "file-exists",
    target: filePath,
    source: "filesystem",
    tier: "supplemental",
    latencyMs: 0,
    result: "failed",
  };

  try {
    const st = await stat(filePath);
    result.latencyMs = Date.now() - start;
    result.result = "confirmed";
    result.value = st.isDirectory() ? "directory" : `file (${st.size} bytes)`;
    return result;
  } catch (err: any) {
    result.latencyMs = Date.now() - start;
    if (err.code === "ENOENT") {
      result.result = "confirmed";
      result.value = "not found";
    } else {
      result.result = "failed";
      result.error = err.message;
    }
    return result;
  }
}

/**
 * Get the most recent commit in a repo.
 * Single git log call, typically <100ms.
 */
async function checkRecentCommit(repoPath?: string): Promise<HealthCheckResult> {
  const start = Date.now();
  const result: HealthCheckResult = {
    claim: "recent-commit",
    target: repoPath || ".",
    source: "git",
    tier: "supplemental",
    latencyMs: 0,
    result: "failed",
  };

  try {
    const proc = spawn(["git", "log", "--oneline", "-1"], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: repoPath || undefined,
    });

    const output = (await new Response(proc.stdout).text()).trim();
    const exitCode = await proc.exited;
    result.latencyMs = Date.now() - start;

    if (exitCode === 0 && output) {
      result.result = "confirmed";
      result.value = output;
    } else {
      result.result = "failed";
      result.error = "No commits or not a git repo";
    }

    return result;
  } catch (err: any) {
    result.latencyMs = Date.now() - start;
    result.result = "failed";
    result.error = err.message;
    return result;
  }
}

// ── Health Check Dispatcher ──────────────────────────────────

/**
 * Run a single health check by type and target.
 * Returns a structured result with latency and outcome.
 */
export async function runHealthCheck(
  claim: ClaimType,
  target: string,
): Promise<HealthCheckResult> {
  let result: HealthCheckResult;

  switch (claim) {
    case "ticket-state":
      result = await checkTicketState(target);
      break;
    case "service-health":
      result = await checkServiceHealth(target);
      break;
    case "file-exists":
      result = await checkFileExists(target);
      break;
    case "recent-commit":
      result = await checkRecentCommit(target);
      break;
    default:
      result = {
        claim,
        target,
        source: "unknown",
        tier: "supplemental",
        latencyMs: 0,
        result: "failed",
        error: `Unknown claim type: ${claim}`,
      };
  }

  // Log the verification event
  logger.info(
    `claim=${result.claim} source=${result.source} tier=${result.tier} ` +
    `latency=${result.latencyMs}ms result=${result.result}` +
    (result.value ? ` value=${result.value}` : "") +
    (result.error ? ` error=${result.error}` : ""),
  );

  return result;
}

/**
 * Run multiple health checks in parallel.
 * Returns all results, maintaining order.
 */
export async function runHealthChecks(
  checks: Array<{ claim: ClaimType; target: string }>,
): Promise<HealthCheckResult[]> {
  return Promise.all(checks.map(c => runHealthCheck(c.claim, c.target)));
}

// ── Priority-Aware Verification ──────────────────────────────

/**
 * Determine verification depth based on source tier.
 * Critical-tier claims: always verify before responding.
 * Supplemental-tier claims: trust unless flagged.
 */
export function getVerificationDepth(
  source: string,
  mode: ContextMode,
): "always" | "on-flag" {
  const tier = freshnessTracker.getSourceTier(source, mode);
  return tier === "critical" ? "always" : "on-flag";
}

/**
 * Check if a specific context source should be verified before responding.
 * Returns true for critical sources that are aging or stale.
 */
export function shouldVerifyBeforeResponding(
  source: string,
  mode: ContextMode,
): boolean {
  const tier = freshnessTracker.getSourceTier(source, mode);
  if (tier !== "critical") return false;

  const status = freshnessTracker.getStatus(source, mode);
  return status === "aging" || status === "stale";
}

/**
 * Get all sources that should be verified in the current mode.
 * Returns sources with their freshness status and tier.
 */
export function getSourcesNeedingVerification(mode: ContextMode): Array<{
  source: string;
  status: string;
  tier: SourceTier;
  reason: string;
}> {
  const results: Array<{ source: string; status: string; tier: SourceTier; reason: string }> = [];
  const criticalSources = freshnessTracker.getStaleCriticalSources(mode);

  for (const check of criticalSources) {
    results.push({
      source: check.source,
      status: check.status,
      tier: check.tier,
      reason: `${check.source} is ${check.status} (${check.ageFormatted} old)`,
    });
  }

  return results;
}

// ── Verification Trail Persistence (ELLIE-250 Phase 2) ───────

/**
 * Run health checks AND persist the verification trail to the Forest.
 * Use this when you want an audit trail of what was verified.
 *
 * Fire-and-forget: the trail is written asynchronously after results are returned.
 */
export async function runHealthChecksWithTrail(
  checks: Array<{ claim: ClaimType; target: string; expectedValue?: string }>,
  options: { channel: string; agent: string; conversationId?: string },
): Promise<HealthCheckResult[]> {
  const results = await runHealthChecks(checks);

  // Build verification entries for the trail
  const entries: VerificationEntry[] = results.map((r, i) => ({
    claim: `${r.claim}:${r.target}`,
    source: r.source,
    result: r.result === "confirmed" ? (
      checks[i].expectedValue && r.value !== checks[i].expectedValue ? "corrected" : "confirmed"
    ) : r.result === "stale" ? "unverified" : "unverified",
    checked_value: r.value,
    expected_value: checks[i].expectedValue,
    latency_ms: r.latencyMs,
  }));

  // Persist trail asynchronously — don't block the response
  logVerificationTrail({
    channel: options.channel,
    agent: options.agent,
    conversation_id: options.conversationId,
    entries,
    timestamp: new Date().toISOString(),
  }).catch(err => logger.warn("Failed to persist verification trail", err));

  return results;
}
