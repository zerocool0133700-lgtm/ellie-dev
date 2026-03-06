/**
 * Dispatch Pattern Analyzer — ELLIE-587
 *
 * Reads dispatch journal entries from River and extracts recurring patterns:
 *  - Average completion time by agent
 *  - Failure rate by agent
 *  - Agent affinity (which agents succeed on which work items)
 *
 * Discovered patterns are written to Forest as `finding` nodes.
 *
 * Two layers:
 *  - Pure: parsers + pattern detectors (zero deps, testable)
 *  - Effectful: reads journal files + writes to Forest (injectable deps)
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { RIVER_ROOT } from "./api/bridge-river.ts";
import { RELAY_BASE_URL } from "./relay-config.ts";
import { log } from "./logger.ts";

const logger = log.child("dispatch-pattern-analyzer");

const BRIDGE_KEY = "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";

// ── Types ────────────────────────────────────────────────────────────────────

export type Outcome = "completed" | "timeout" | "crashed" | "blocked" | "paused";

export interface ParsedEntry {
  workItemId: string;
  event: "started" | Outcome;
  time?: string;
  title?: string;
  agent?: string;
  sessionId?: string;
  durationMinutes?: number;
  summary?: string;
}

export interface CompletedDispatch {
  workItemId: string;
  agent?: string;
  outcome: Outcome;
  durationMinutes?: number;
  title?: string;
}

export interface DurationPattern {
  agent: string;
  avgMinutes: number;
  count: number;
}

export interface FailureRatePattern {
  agent: string;
  totalDispatches: number;
  failures: number;
  failureRate: number;
}

export interface AgentAffinityPattern {
  agent: string;
  completions: number;
  failures: number;
  successRate: number;
}

export interface DispatchPatterns {
  duration: DurationPattern[];
  failureRate: FailureRatePattern[];
  agentAffinity: AgentAffinityPattern[];
  totalDispatches: number;
  dateRange: { earliest?: string; latest?: string };
}

export interface ForestPatternFinding {
  content: string;
  type: "finding";
  scope_path: string;
  confidence: number;
  metadata: {
    source: string;
    pattern_type: string;
    sample_size: number;
  };
}

// ── Pure: Parse journal markdown ─────────────────────────────────────────────

/**
 * Parse a single journal markdown file into structured entries.
 */
export function parseJournalEntries(markdown: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  const blocks = markdown.split(/^### /m).slice(1); // split on H3, skip pre-header

  for (const block of blocks) {
    const headerMatch = block.match(/^(ELLIE-\d+)\s*—\s*(.+)/);
    if (!headerMatch) continue;

    const workItemId = headerMatch[1];
    const eventRaw = headerMatch[2].trim().toLowerCase();

    const entry: ParsedEntry = {
      workItemId,
      event: eventRaw === "started" ? "started" : eventRaw as Outcome,
    };

    // Parse bullet fields
    const timeMatch = block.match(/\*\*Time:\*\*\s*(.+)/);
    if (timeMatch) entry.time = timeMatch[1].trim();

    const titleMatch = block.match(/\*\*Title:\*\*\s*(.+)/);
    if (titleMatch) entry.title = titleMatch[1].trim();

    const agentMatch = block.match(/\*\*Agent:\*\*\s*(.+)/);
    if (agentMatch) entry.agent = agentMatch[1].trim();

    const sessionMatch = block.match(/\*\*Session:\*\*\s*`(.+)`/);
    if (sessionMatch) entry.sessionId = sessionMatch[1].trim();

    const durationMatch = block.match(/\*\*Duration:\*\*\s*(\d+)/);
    if (durationMatch) entry.durationMinutes = parseInt(durationMatch[1], 10);

    const summaryMatch = block.match(/\*\*Summary:\*\*\s*(.+)/);
    if (summaryMatch) entry.summary = summaryMatch[1].trim();

    const outcomeMatch = block.match(/\*\*Outcome:\*\*\s*(.+)/);
    if (outcomeMatch) entry.event = outcomeMatch[1].trim() as Outcome;

    entries.push(entry);
  }

  return entries;
}

/**
 * Match start/end pairs from parsed entries into completed dispatches.
 * Calculates duration from timestamps if not explicitly provided.
 */
export function matchDispatchPairs(entries: ParsedEntry[]): CompletedDispatch[] {
  const starts = new Map<string, ParsedEntry>();
  const dispatches: CompletedDispatch[] = [];

  for (const entry of entries) {
    if (entry.event === "started") {
      starts.set(entry.workItemId, entry);
    } else {
      const start = starts.get(entry.workItemId);
      let duration = entry.durationMinutes;

      // Calculate duration from timestamps if not explicit
      if (duration === undefined && start?.time && entry.time) {
        const startMs = new Date(start.time).getTime();
        const endMs = new Date(entry.time).getTime();
        if (!isNaN(startMs) && !isNaN(endMs) && endMs > startMs) {
          duration = Math.round((endMs - startMs) / 60000);
        }
      }

      dispatches.push({
        workItemId: entry.workItemId,
        agent: entry.agent ?? start?.agent,
        outcome: entry.event as Outcome,
        durationMinutes: duration,
        title: start?.title,
      });

      starts.delete(entry.workItemId);
    }
  }

  return dispatches;
}

// ── Pure: Pattern detection ──────────────────────────────────────────────────

/**
 * Compute average completion duration per agent.
 */
export function detectDurationPatterns(dispatches: CompletedDispatch[]): DurationPattern[] {
  const byAgent = new Map<string, number[]>();

  for (const d of dispatches) {
    if (d.durationMinutes === undefined || !d.agent) continue;
    if (d.outcome !== "completed") continue;
    const existing = byAgent.get(d.agent) ?? [];
    existing.push(d.durationMinutes);
    byAgent.set(d.agent, existing);
  }

  return Array.from(byAgent.entries()).map(([agent, durations]) => ({
    agent,
    avgMinutes: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
    count: durations.length,
  }));
}

/**
 * Compute failure rate per agent.
 */
export function detectFailureRatePatterns(dispatches: CompletedDispatch[]): FailureRatePattern[] {
  const byAgent = new Map<string, { total: number; failures: number }>();

  for (const d of dispatches) {
    if (!d.agent) continue;
    const existing = byAgent.get(d.agent) ?? { total: 0, failures: 0 };
    existing.total++;
    if (d.outcome !== "completed") existing.failures++;
    byAgent.set(d.agent, existing);
  }

  return Array.from(byAgent.entries()).map(([agent, stats]) => ({
    agent,
    totalDispatches: stats.total,
    failures: stats.failures,
    failureRate: stats.total > 0 ? Math.round((stats.failures / stats.total) * 100) / 100 : 0,
  }));
}

/**
 * Compute agent affinity — success rate per agent.
 */
export function detectAgentAffinityPatterns(dispatches: CompletedDispatch[]): AgentAffinityPattern[] {
  const byAgent = new Map<string, { completions: number; failures: number }>();

  for (const d of dispatches) {
    if (!d.agent) continue;
    const existing = byAgent.get(d.agent) ?? { completions: 0, failures: 0 };
    if (d.outcome === "completed") existing.completions++;
    else existing.failures++;
    byAgent.set(d.agent, existing);
  }

  return Array.from(byAgent.entries()).map(([agent, stats]) => {
    const total = stats.completions + stats.failures;
    return {
      agent,
      completions: stats.completions,
      failures: stats.failures,
      successRate: total > 0 ? Math.round((stats.completions / total) * 100) / 100 : 0,
    };
  });
}

/**
 * Run all pattern detectors on a set of completed dispatches.
 */
export function analyzePatterns(dispatches: CompletedDispatch[], dateRange?: { earliest?: string; latest?: string }): DispatchPatterns {
  return {
    duration: detectDurationPatterns(dispatches),
    failureRate: detectFailureRatePatterns(dispatches),
    agentAffinity: detectAgentAffinityPatterns(dispatches),
    totalDispatches: dispatches.length,
    dateRange: dateRange ?? {},
  };
}

// ── Pure: Build Forest finding payloads ──────────────────────────────────────

/**
 * Confidence based on sample size — more data = higher confidence.
 */
export function confidenceForSampleSize(n: number): number {
  if (n >= 50) return 0.9;
  if (n >= 20) return 0.8;
  if (n >= 10) return 0.7;
  if (n >= 5) return 0.6;
  return 0.5;
}

/**
 * Build Forest finding payloads from detected patterns.
 */
export function buildPatternFindings(patterns: DispatchPatterns): ForestPatternFinding[] {
  const findings: ForestPatternFinding[] = [];

  // Duration patterns
  for (const dp of patterns.duration) {
    if (dp.count < 2) continue; // Need at least 2 data points
    findings.push({
      content: `Dispatch pattern: Agent "${dp.agent}" averages ${dp.avgMinutes} minutes per completed task (based on ${dp.count} dispatches).`,
      type: "finding",
      scope_path: "2/1",
      confidence: confidenceForSampleSize(dp.count),
      metadata: {
        source: "dispatch-pattern-analyzer",
        pattern_type: "duration",
        sample_size: dp.count,
      },
    });
  }

  // Failure rate patterns (only report if there are failures)
  for (const fr of patterns.failureRate) {
    if (fr.failures === 0 || fr.totalDispatches < 2) continue;
    findings.push({
      content: `Dispatch pattern: Agent "${fr.agent}" has a ${Math.round(fr.failureRate * 100)}% failure rate (${fr.failures}/${fr.totalDispatches} dispatches).`,
      type: "finding",
      scope_path: "2/1",
      confidence: confidenceForSampleSize(fr.totalDispatches),
      metadata: {
        source: "dispatch-pattern-analyzer",
        pattern_type: "failure-rate",
        sample_size: fr.totalDispatches,
      },
    });
  }

  // Agent affinity (only report agents with meaningful track record)
  for (const aa of patterns.agentAffinity) {
    const total = aa.completions + aa.failures;
    if (total < 3) continue;
    findings.push({
      content: `Dispatch pattern: Agent "${aa.agent}" has ${Math.round(aa.successRate * 100)}% success rate (${aa.completions} completed, ${aa.failures} failed out of ${total} dispatches).`,
      type: "finding",
      scope_path: "2/1",
      confidence: confidenceForSampleSize(total),
      metadata: {
        source: "dispatch-pattern-analyzer",
        pattern_type: "agent-affinity",
        sample_size: total,
      },
    });
  }

  return findings;
}

// ── Effectful: Read journal files ────────────────────────────────────────────

/**
 * Read all dispatch journal files from River and return parsed entries.
 */
export async function readJournalFiles(
  riverRoot?: string,
  readDirFn: typeof readdir = readdir,
  readFileFn: typeof readFile = readFile,
): Promise<{ entries: ParsedEntry[]; dateRange: { earliest?: string; latest?: string } }> {
  const root = riverRoot ?? RIVER_ROOT;
  const journalDir = join(root, "dispatch-journal");

  let files: string[];
  try {
    const dirEntries = await readDirFn(journalDir);
    files = (dirEntries as string[])
      .filter(f => typeof f === "string" && f.endsWith(".md"))
      .sort();
  } catch {
    return { entries: [], dateRange: {} };
  }

  const allEntries: ParsedEntry[] = [];
  let earliest: string | undefined;
  let latest: string | undefined;

  for (const file of files) {
    const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})\.md$/);
    if (dateMatch) {
      if (!earliest || dateMatch[1] < earliest) earliest = dateMatch[1];
      if (!latest || dateMatch[1] > latest) latest = dateMatch[1];
    }

    try {
      const content = await readFileFn(join(journalDir, file), "utf-8");
      const entries = parseJournalEntries(content as string);
      allEntries.push(...entries);
    } catch {
      logger.warn(`Failed to read journal file: ${file}`);
    }
  }

  return { entries: allEntries, dateRange: { earliest, latest } };
}

// ── Effectful: Write patterns to Forest ──────────────────────────────────────

/**
 * Write pattern findings to Forest via Bridge API.
 * Returns the number of findings successfully written.
 */
export async function writePatternsToForest(
  findings: ForestPatternFinding[],
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  let written = 0;

  for (const finding of findings) {
    try {
      const resp = await fetchFn(`${RELAY_BASE_URL}/api/bridge/write`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-bridge-key": BRIDGE_KEY,
        },
        body: JSON.stringify(finding),
      });

      if (resp.ok) {
        written++;
      } else {
        logger.warn("Pattern finding write failed", { status: resp.status, pattern: finding.metadata.pattern_type });
      }
    } catch (err) {
      logger.warn("Pattern finding write error (non-fatal)", err);
    }
  }

  return written;
}

// ── Main: Analyze and write ──────────────────────────────────────────────────

/**
 * Full pipeline: read journals, detect patterns, write to Forest.
 * Can be triggered on demand or scheduled.
 */
export async function analyzeDispatchPatterns(
  riverRoot?: string,
  fetchFn?: typeof fetch,
  readDirFn?: typeof readdir,
  readFileFn?: typeof readFile,
): Promise<{ patterns: DispatchPatterns; findingsWritten: number }> {
  const { entries, dateRange } = await readJournalFiles(riverRoot, readDirFn, readFileFn);

  if (entries.length === 0) {
    logger.info("No journal entries found — skipping analysis");
    return { patterns: analyzePatterns([]), findingsWritten: 0 };
  }

  const dispatches = matchDispatchPairs(entries);
  const patterns = analyzePatterns(dispatches, dateRange);
  const findings = buildPatternFindings(patterns);

  logger.info("Dispatch patterns analyzed", {
    totalEntries: entries.length,
    dispatches: dispatches.length,
    findings: findings.length,
    dateRange,
  });

  const findingsWritten = findings.length > 0
    ? await writePatternsToForest(findings, fetchFn)
    : 0;

  return { patterns, findingsWritten };
}
