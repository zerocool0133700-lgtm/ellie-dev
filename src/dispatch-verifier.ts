/**
 * Dispatch Verifier — ELLIE-564
 *
 * After every agent dispatch (success, timeout, or failure), checks reality
 * against what the agent reported and writes a verification log to River.
 *
 * Checks:
 *  - Did expected files get created/modified on disk?
 *  - Were commits made with the expected [TICKET-ID] prefix?
 *  - Does Plane issue state match the reported outcome?
 *
 * Two layers:
 *  - Pure functions for building checks and content (fully testable)
 *  - Effectful writer (fs + git + Plane + River, non-fatal)
 */

import { execSync } from "child_process";
import { statSync } from "fs";
import { log } from "./logger.ts";
import { resolveWorkItemId } from "./plane.ts";
import { appendWorkTrailProgress } from "./work-trail-writer.ts";

const logger = log.child("dispatch-verifier");

// ── Types ──────────────────────────────────────────────────────────────────────

export interface VerifyDispatchOpts {
  workItemId: string;
  agent?: string;
  outcome: "success" | "timeout" | "failure";
  summary?: string;
  reportedActions?: string[];
  expectedFiles?: string[];
  expectedCommitPrefix?: string;
  repo?: string;
}

export interface FileCheck {
  path: string;
  exists: boolean;
  modifiedWithinMinutes?: number;
}

export interface CommitCheck {
  prefix: string;
  found: boolean;
  recentCommits: string[];
}

export interface PlaneCheck {
  workItemId: string;
  currentState: string | null;
  expectedState: string | null;
  matches: boolean;
}

export interface VerificationResult {
  workItemId: string;
  agent?: string;
  outcome: string;
  timestamp: string;
  verified: boolean;
  fileChecks: FileCheck[];
  commitCheck: CommitCheck | null;
  planeCheck: PlaneCheck | null;
  discrepancies: string[];
}

// ── Pure: File checks ──────────────────────────────────────────────────────────

/**
 * Check whether files exist on disk and when they were last modified.
 * Pure relative to its statFn dependency (injectable for tests).
 */
export function checkFiles(
  files: string[],
  statFn: (path: string) => { mtimeMs: number } | null = defaultStat,
): FileCheck[] {
  const now = Date.now();
  return files.map((path) => {
    const stat = statFn(path);
    if (!stat) return { path, exists: false };
    const minutesAgo = Math.round((now - stat.mtimeMs) / 60_000);
    return { path, exists: true, modifiedWithinMinutes: minutesAgo };
  });
}

function defaultStat(path: string): { mtimeMs: number } | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

// ── Pure: Commit checks ────────────────────────────────────────────────────────

/**
 * Check recent git commits for the expected prefix (e.g. "[ELLIE-564]").
 * Pure relative to its execFn dependency (injectable for tests).
 */
export function checkCommits(
  prefix: string,
  repo: string,
  execFn: (cmd: string, opts: object) => string = defaultExec,
): CommitCheck {
  try {
    const output = execFn("git log --oneline -20", {
      cwd: repo,
      encoding: "utf-8",
      timeout: 5000,
    });
    const lines = output.trim().split("\n").filter(Boolean);
    const found = lines.some((line) => line.includes(prefix));
    return { prefix, found, recentCommits: lines.slice(0, 5) };
  } catch {
    return { prefix, found: false, recentCommits: [] };
  }
}

function defaultExec(cmd: string, opts: object): string {
  return execSync(cmd, opts as Parameters<typeof execSync>[1]) as unknown as string;
}

// ── Pure: Plane state check ────────────────────────────────────────────────────

/**
 * Determine expected Plane state from the dispatch outcome.
 */
export function expectedPlaneState(
  outcome: "success" | "timeout" | "failure",
): string | null {
  if (outcome === "success") return "completed";
  return null; // timeout/failure — no specific expected state
}

// ── Pure: Discrepancy detection ────────────────────────────────────────────────

/**
 * Analyze checks and produce a list of discrepancies (human-readable strings).
 */
export function findDiscrepancies(
  outcome: string,
  fileChecks: FileCheck[],
  commitCheck: CommitCheck | null,
  planeCheck: PlaneCheck | null,
): string[] {
  const issues: string[] = [];

  // Files that were expected but don't exist
  for (const fc of fileChecks) {
    if (!fc.exists) {
      issues.push(`File missing: ${fc.path}`);
    }
  }

  // Agent said success but no commits found
  if (outcome === "success" && commitCheck && !commitCheck.found) {
    issues.push(`No commits found with prefix "${commitCheck.prefix}"`);
  }

  // Plane state mismatch
  if (planeCheck && planeCheck.expectedState && !planeCheck.matches) {
    issues.push(
      `Plane state mismatch: expected "${planeCheck.expectedState}", got "${planeCheck.currentState}"`,
    );
  }

  return issues;
}

// ── Pure: Build verification log content ───────────────────────────────────────

/**
 * Build markdown content for the verification log (appended to work trail).
 */
export function buildVerificationContent(result: VerificationResult): string {
  const lines: string[] = [
    "",
    `### Verification — ${result.timestamp}`,
    "",
    `**Outcome:** ${result.outcome}`,
    `**Verified:** ${result.verified ? "PASS" : "FAIL"}`,
    result.agent ? `**Agent:** ${result.agent}` : "",
    "",
  ];

  if (result.fileChecks.length > 0) {
    lines.push("**File Checks:**");
    for (const fc of result.fileChecks) {
      const status = fc.exists
        ? `exists (modified ${fc.modifiedWithinMinutes}m ago)`
        : "MISSING";
      lines.push(`- \`${fc.path}\`: ${status}`);
    }
    lines.push("");
  }

  if (result.commitCheck) {
    const status = result.commitCheck.found ? "found" : "NOT FOUND";
    lines.push(`**Commit Check:** prefix \`${result.commitCheck.prefix}\` — ${status}`);
    if (result.commitCheck.recentCommits.length > 0) {
      lines.push("Recent commits:");
      for (const c of result.commitCheck.recentCommits) {
        lines.push(`- \`${c}\``);
      }
    }
    lines.push("");
  }

  if (result.planeCheck) {
    lines.push(
      `**Plane State:** ${result.planeCheck.currentState ?? "unknown"} ` +
        `(expected: ${result.planeCheck.expectedState ?? "any"}) — ` +
        `${result.planeCheck.matches ? "OK" : "MISMATCH"}`,
    );
    lines.push("");
  }

  if (result.discrepancies.length > 0) {
    lines.push("**Discrepancies:**");
    for (const d of result.discrepancies) {
      lines.push(`- ${d}`);
    }
    lines.push("");
  }

  return lines.filter((l) => l !== undefined).join("\n");
}

// ── Effectful: Run full verification ───────────────────────────────────────────

/**
 * Run all verification checks and write results to River (via work trail append).
 *
 * Non-fatal: catches all errors and logs them. Returns the result for callers
 * that want to inspect it (e.g., coordinator).
 */
export async function verifyDispatch(
  opts: VerifyDispatchOpts,
): Promise<VerificationResult | null> {
  try {
    const timestamp = new Date().toISOString();
    const repo = opts.repo ?? process.env.ELLIE_DEV_PATH ?? process.cwd();
    const prefix = opts.expectedCommitPrefix ?? `[${opts.workItemId}]`;

    // 1. File checks
    const fileChecks = opts.expectedFiles?.length
      ? checkFiles(opts.expectedFiles)
      : [];

    // 2. Commit checks
    const commitCheck = checkCommits(prefix, repo);

    // 3. Plane state check
    let planeCheck: PlaneCheck | null = null;
    const expected = expectedPlaneState(opts.outcome);
    try {
      const resolved = await resolveWorkItemId(opts.workItemId);
      if (resolved) {
        const { getIssueStateGroup } = await import("./plane.ts");
        const currentState = await getIssueStateGroup(
          resolved.projectId,
          resolved.issueId,
        );
        planeCheck = {
          workItemId: opts.workItemId,
          currentState,
          expectedState: expected,
          matches: expected ? currentState === expected : true,
        };
      }
    } catch (err) {
      logger.warn("Plane check failed (non-fatal)", err);
      planeCheck = {
        workItemId: opts.workItemId,
        currentState: null,
        expectedState: expected,
        matches: expected === null,
      };
    }

    // 4. Find discrepancies
    const discrepancies = findDiscrepancies(
      opts.outcome,
      fileChecks,
      commitCheck,
      planeCheck,
    );

    const result: VerificationResult = {
      workItemId: opts.workItemId,
      agent: opts.agent,
      outcome: opts.outcome,
      timestamp,
      verified: discrepancies.length === 0,
      fileChecks,
      commitCheck,
      planeCheck,
      discrepancies,
    };

    // 5. Write to River (append to work trail)
    const content = buildVerificationContent(result);
    await appendWorkTrailProgress(opts.workItemId, content);

    logger.info("Dispatch verified", {
      workItemId: opts.workItemId,
      verified: result.verified,
      discrepancies: discrepancies.length,
    });

    return result;
  } catch (err) {
    logger.error("verifyDispatch failed (non-fatal)", err);
    return null;
  }
}
