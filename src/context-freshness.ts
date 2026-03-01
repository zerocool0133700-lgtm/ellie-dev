/**
 * Context Freshness — Staleness Detection & Auto-Refresh
 *
 * ELLIE-327: Tracks when each context source was last fetched, defines
 * priority tiers per mode (critical vs supplemental), and triggers
 * auto-refresh for stale critical sources.
 *
 * Architecture:
 * - ContextFreshnessTracker: records fetch timestamps per source
 * - Priority tiers: critical sources per mode get auto-refreshed
 * - Freshness logging: structured logs for journalctl visibility
 * - Timestamp injection: adds fetch time annotations to prompt sections
 */

import { log } from "./logger.ts";
import type { ContextMode } from "./context-mode.ts";

const logger = log.child("context:freshness");
const modeLogger = log.child("context:mode");

const USER_TIMEZONE = process.env.USER_TIMEZONE || "America/Chicago";

// ── Types ────────────────────────────────────────────────────

export type FreshnessStatus = "fresh" | "aging" | "stale";
export type SourceTier = "critical" | "supplemental";

export interface SourceFreshnessRecord {
  source: string;
  fetchedAt: number;       // Date.now() timestamp
  latencyMs?: number;      // How long the fetch took
  tier?: SourceTier;       // Set when mode is known
}

export interface FreshnessCheck {
  source: string;
  ageMs: number;
  ageFormatted: string;
  status: FreshnessStatus;
  tier: SourceTier;
  needsRefresh: boolean;
}

// ── Constants ────────────────────────────────────────────────

/** Default thresholds — used when no per-source override exists. */
const DEFAULT_STALE_MS = 5 * 60_000;  // 5 minutes
const DEFAULT_AGING_MS = 2 * 60_000;  // 2 minutes

// ── Per-Source Decay Thresholds (ELLIE-329) ──────────────────
// Different sources go stale at different rates.
// Ticket states change fast in workflow mode, calendar is slow to change.
// Profile/soul are session-stable and never go stale.

interface DecayThreshold {
  agingMs: number;
  staleMs: number;
}

/** "never" sentinel — source is treated as permanently fresh. */
const NEVER: DecayThreshold = { agingMs: Infinity, staleMs: Infinity };

/**
 * Per-source decay thresholds, optionally overridden per mode.
 * Structure: source → { default, modeOverrides? }
 */
const SOURCE_DECAY: Record<string, {
  default: DecayThreshold;
  modeOverrides?: Partial<Record<ContextMode, DecayThreshold>>;
}> = {
  // Fast-changing sources — short decay
  "work-item": {
    default: { agingMs: 3 * 60_000, staleMs: 10 * 60_000 },
    modeOverrides: {
      workflow: { agingMs: 2 * 60_000, staleMs: 5 * 60_000 },
      "deep-work": { agingMs: 2 * 60_000, staleMs: 5 * 60_000 },
    },
  },
  "queue": {
    default: { agingMs: 2 * 60_000, staleMs: 5 * 60_000 },
    modeOverrides: {
      workflow: { agingMs: 1 * 60_000, staleMs: 3 * 60_000 },
    },
  },
  "structured-context": {
    default: { agingMs: 3 * 60_000, staleMs: 8 * 60_000 },
  },
  "context-docket": {
    default: { agingMs: 3 * 60_000, staleMs: 8 * 60_000 },
  },
  "recent-messages": {
    default: { agingMs: 2 * 60_000, staleMs: 5 * 60_000 },
  },
  "goals": {
    default: { agingMs: 5 * 60_000, staleMs: 15 * 60_000 },
  },

  // Medium-changing sources
  "search": {
    default: { agingMs: 5 * 60_000, staleMs: 15 * 60_000 },
  },
  "forest-awareness": {
    default: { agingMs: 10 * 60_000, staleMs: 30 * 60_000 },
  },
  "agent-memory": {
    default: { agingMs: 10 * 60_000, staleMs: 30 * 60_000 },
  },

  // Slow-changing sources — long decay
  "calendar": {
    default: { agingMs: 15 * 60_000, staleMs: 30 * 60_000 },
  },
  "gmail": {
    default: { agingMs: 10 * 60_000, staleMs: 30 * 60_000 },
  },
  "outlook": {
    default: { agingMs: 10 * 60_000, staleMs: 30 * 60_000 },
  },
  "google_tasks": {
    default: { agingMs: 15 * 60_000, staleMs: 30 * 60_000 },
  },

  // Session-stable sources — never stale
  "skills": { default: NEVER },
};

/**
 * Get decay thresholds for a source in a specific mode.
 * Falls back: mode override → source default → global default.
 */
function getDecayThreshold(source: string, mode?: ContextMode): DecayThreshold {
  const entry = SOURCE_DECAY[source];
  if (!entry) return { agingMs: DEFAULT_AGING_MS, staleMs: DEFAULT_STALE_MS };

  if (mode && entry.modeOverrides?.[mode]) {
    return entry.modeOverrides[mode]!;
  }
  return entry.default;
}

// ── Priority Tiers per Mode ─────────────────────────────────
// Critical sources are auto-refreshed when stale.
// Supplemental sources get a staleness annotation but no auto-refresh.

const MODE_CRITICAL_SOURCES: Record<ContextMode, string[]> = {
  conversation: [
    "recent-messages",
    "goals",
    "structured-context",
    "work-item",
  ],
  strategy: [
    "context-docket",
    "structured-context",
    "forest-awareness",
    "goals",
  ],
  workflow: [
    "structured-context",
    "queue",
    "context-docket",
    "agent-memory",
  ],
  "deep-work": [
    "work-item",
    "forest-awareness",
    "agent-memory",
    "search",
  ],
};

const MODE_SUPPLEMENTAL_SOURCES: Record<ContextMode, string[]> = {
  conversation: [
    "context-docket",
    "calendar",
    "gmail",
    "outlook",
    "google_tasks",
    "queue",
    "skills",
  ],
  strategy: [
    "agent-memory",
    "recent-messages",
    "queue",
    "calendar",
    "gmail",
    "outlook",
    "skills",
  ],
  workflow: [
    "forest-awareness",
    "recent-messages",
    "calendar",
    "gmail",
    "outlook",
    "skills",
  ],
  "deep-work": [
    "structured-context",
    "recent-messages",
    "context-docket",
    "calendar",
    "gmail",
    "outlook",
    "skills",
    "queue",
  ],
};

// ── Freshness Tracker ────────────────────────────────────────

/** Singleton tracker for context source fetch times. */
class ContextFreshnessTracker {
  private records: Map<string, SourceFreshnessRecord> = new Map();

  /**
   * Record that a context source was just fetched.
   * Call this immediately after a source fetch completes.
   */
  recordFetch(source: string, latencyMs?: number): void {
    const record: SourceFreshnessRecord = {
      source,
      fetchedAt: Date.now(),
      latencyMs,
    };
    this.records.set(source, record);

    logger.info(`source=${source} latency=${latencyMs ?? "?"}ms status=fetched`);
  }

  /**
   * Get the freshness record for a source. Returns null if never fetched.
   */
  getRecord(source: string): SourceFreshnessRecord | null {
    return this.records.get(source) || null;
  }

  /**
   * Get the age of a source in milliseconds. Returns Infinity if never fetched.
   */
  getAge(source: string): number {
    const record = this.records.get(source);
    if (!record) return Infinity;
    return Date.now() - record.fetchedAt;
  }

  /**
   * Determine the freshness status of a source.
   * Uses per-source decay thresholds when available.
   */
  getStatus(source: string, mode?: ContextMode): FreshnessStatus {
    const age = this.getAge(source);
    const threshold = getDecayThreshold(source, mode);
    if (age >= threshold.staleMs) return "stale";
    if (age >= threshold.agingMs) return "aging";
    return "fresh";
  }

  /**
   * Check freshness of a source in the context of a specific mode.
   * Returns whether it needs refresh and its tier.
   */
  checkSource(source: string, mode: ContextMode): FreshnessCheck {
    const age = this.getAge(source);
    const status = this.getStatus(source, mode);
    const tier = this.getSourceTier(source, mode);
    const needsRefresh = tier === "critical" && status === "stale";

    return {
      source,
      ageMs: age,
      ageFormatted: formatAge(age),
      status,
      tier,
      needsRefresh,
    };
  }

  /**
   * Get the tier of a source for a given mode.
   */
  getSourceTier(source: string, mode: ContextMode): SourceTier {
    if (MODE_CRITICAL_SOURCES[mode]?.includes(source)) return "critical";
    return "supplemental";
  }

  /**
   * Get all sources that need refresh for a given mode.
   */
  getStaleCriticalSources(mode: ContextMode): FreshnessCheck[] {
    const critical = MODE_CRITICAL_SOURCES[mode] || [];
    return critical
      .map(source => this.checkSource(source, mode))
      .filter(check => check.needsRefresh);
  }

  /**
   * Generate a freshness timestamp annotation for a prompt section.
   * Format: `[source] fetched: Feb 28, 7:37 AM (2 min ago)`
   */
  getTimestamp(source: string): string {
    const record = this.records.get(source);
    if (!record) return `[${source}] not yet fetched`;

    const age = Date.now() - record.fetchedAt;
    const fetchTime = new Date(record.fetchedAt).toLocaleString("en-US", {
      timeZone: USER_TIMEZONE,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    return `[${source}] fetched: ${fetchTime} (${formatAge(age)} ago)`;
  }

  /**
   * Get all timestamps as a formatted block for prompt injection.
   */
  getAllTimestamps(): string {
    if (this.records.size === 0) return "";
    const lines = Array.from(this.records.values())
      .sort((a, b) => a.source.localeCompare(b.source))
      .map(r => this.getTimestamp(r.source));
    return lines.join("\n");
  }

  /**
   * Log the mode configuration showing critical vs supplemental sources.
   * Format: [context:mode] conversation — critical: [recent-messages, key-facts, goals] supplemental: [work-items, queue]
   */
  logModeConfig(mode: ContextMode): void {
    const critical = MODE_CRITICAL_SOURCES[mode] || [];
    const supplemental = MODE_SUPPLEMENTAL_SOURCES[mode] || [];
    modeLogger.info(
      `${mode} — critical: [${critical.join(", ")}] supplemental: [${supplemental.join(", ")}]`
    );
  }

  /**
   * Log freshness status for all tracked sources.
   * Format matches ticket spec: [context:freshness] source=X age=Ym status=Z
   */
  logAllFreshness(mode: ContextMode): void {
    for (const [source] of this.records) {
      const check = this.checkSource(source, mode);
      const tierLabel = check.tier === "critical" ? ` tier=critical` : "";
      const refreshLabel = check.needsRefresh ? " — auto-refreshing" : "";
      logger.info(
        `source=${source} age=${check.ageFormatted} status=${check.status}${tierLabel}${refreshLabel}`
      );
    }
  }

  /**
   * Log a completed refresh event.
   */
  logRefreshComplete(source: string, latencyMs: number): void {
    logger.info(
      `refresh complete source=${source} latency=${latencyMs}ms`
    );
  }

  /**
   * Log that a stale source is being auto-refreshed.
   */
  logAutoRefreshStart(source: string, ageFormatted: string): void {
    logger.info(
      `source=${source} age=${ageFormatted} status=stale tier=critical — auto-refreshing`
    );
  }

  /**
   * Invalidate a source, forcing it to be treated as stale.
   * Used by correction-triggered refresh (ELLIE-329) to force
   * re-fetch of sources that contained wrong information.
   */
  invalidate(source: string): void {
    const record = this.records.get(source);
    if (record) {
      // Set fetchedAt to 0 so the source is maximally stale
      record.fetchedAt = 0;
      logger.info(`source=${source} status=invalidated reason=correction`);
    }
    // If never fetched, nothing to invalidate — it will be fetched fresh
  }

  /**
   * Clear all records. Useful for testing or full context refresh.
   */
  clear(): void {
    this.records.clear();
  }

  /**
   * Get a full snapshot of all tracked sources for dashboard display.
   * Returns structured data for the /api/freshness endpoint.
   */
  getSnapshot(mode: ContextMode): {
    mode: ContextMode;
    sources: Array<{
      source: string;
      fetchedAt: number;
      ageMs: number;
      ageFormatted: string;
      status: FreshnessStatus;
      tier: SourceTier;
      needsRefresh: boolean;
      thresholds: { agingMs: number; staleMs: number };
    }>;
    staleCritical: string[];
  } {
    const sources = Array.from(this.records.values())
      .sort((a, b) => a.source.localeCompare(b.source))
      .map(r => {
        const check = this.checkSource(r.source, mode);
        const threshold = getDecayThreshold(r.source, mode);
        return {
          source: r.source,
          fetchedAt: r.fetchedAt,
          ageMs: check.ageMs,
          ageFormatted: check.ageFormatted,
          status: check.status,
          tier: check.tier,
          needsRefresh: check.needsRefresh,
          thresholds: {
            agingMs: isFinite(threshold.agingMs) ? threshold.agingMs : -1,
            staleMs: isFinite(threshold.staleMs) ? threshold.staleMs : -1,
          },
        };
      });

    const staleCritical = this.getStaleCriticalSources(mode).map(c => c.source);

    return { mode, sources, staleCritical };
  }
}

// ── Singleton export ─────────────────────────────────────────

export const freshnessTracker = new ContextFreshnessTracker();

// ── Helpers ──────────────────────────────────────────────────

/**
 * Format milliseconds into a human-readable age string.
 * Examples: "2m", "45s", "1h 3m", "just now"
 */
function formatAge(ms: number): string {
  if (!isFinite(ms)) return "never";
  if (ms < 5_000) return "just now";

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMin = minutes % 60;
    return remainingMin > 0 ? `${hours}h ${remainingMin}m` : `${hours}h`;
  }
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/**
 * Get the priority tier definitions for a mode.
 * Returns the critical and supplemental source lists.
 */
export function getModeTiers(mode: ContextMode): {
  critical: string[];
  supplemental: string[];
} {
  return {
    critical: MODE_CRITICAL_SOURCES[mode] || [],
    supplemental: MODE_SUPPLEMENTAL_SOURCES[mode] || [],
  };
}

/**
 * Check if any critical sources need refresh for the given mode.
 * Returns true if at least one critical source is stale.
 */
export function hasStaleCriticalSources(mode: ContextMode): boolean {
  return freshnessTracker.getStaleCriticalSources(mode).length > 0;
}

// ── Staleness Warning Builder (ELLIE-328) ────────────────────

/**
 * Build a user-facing staleness warning for the current mode.
 * Returns empty string if all critical sources are fresh.
 *
 * Example output:
 *   ⚠ STALE CONTEXT WARNING:
 *   - goals: stale (8m old) — auto-refreshed
 *   - structured-context: aging (3m old)
 *   Treat claims from these sources as unverified. Check Plane/Forest directly for current state.
 */
export function buildStalenessWarning(
  mode: ContextMode,
  refreshedSources?: string[],
): string {
  const critical = MODE_CRITICAL_SOURCES[mode] || [];
  const warnings: string[] = [];

  for (const source of critical) {
    const check = freshnessTracker.checkSource(source, mode);
    if (check.status === "fresh") continue;

    const refreshed = refreshedSources?.includes(source);
    const suffix = refreshed ? " — auto-refreshed" : "";
    warnings.push(`- ${source}: ${check.status} (${check.ageFormatted} old)${suffix}`);
  }

  // Also check for conflicts (ELLIE-329)
  const conflictWarning = buildConflictWarning();

  if (!warnings.length && !conflictWarning) return "";

  let result = "";
  if (warnings.length) {
    result += (
      "⚠ STALE CONTEXT WARNING:\n" +
      warnings.join("\n") +
      "\nTreat claims from these sources as unverified. " +
      "Use the verify skill to check Plane/Forest/systemctl directly for current state."
    );
  }
  if (conflictWarning) {
    if (result) result += "\n\n";
    result += conflictWarning;
  }
  return result;
}

// ── Conflict Detection (ELLIE-329) ───────────────────────────
// Detects when sources fetched at different times might conflict.
// Example: structured-context says ticket is "In Progress" but
// work-item (fetched 10 min later) says "Done".

export interface ConflictSignal {
  sourceA: string;
  sourceB: string;
  ageDeltaMs: number;
  ageDeltaFormatted: string;
  warning: string;
}

/**
 * Source groups that can conflict with each other.
 * If sources in the same group were fetched at very different times,
 * they may contain contradictory information.
 */
const CONFLICT_GROUPS: string[][] = [
  ["work-item", "structured-context", "queue"],
  ["calendar", "recent-messages"],
  ["forest-awareness", "agent-memory", "structured-context"],
];

/** Threshold: if two sources in the same group differ by more than this, flag it. */
const CONFLICT_AGE_DELTA_MS = 5 * 60_000; // 5 minutes

/**
 * Detect potential conflicts between related sources.
 * Returns signals for any groups where sources have large age gaps.
 */
export function detectConflicts(): ConflictSignal[] {
  const signals: ConflictSignal[] = [];

  for (const group of CONFLICT_GROUPS) {
    // Get fetched sources in this group
    const fetched = group
      .map(s => ({ source: s, record: freshnessTracker.getRecord(s) }))
      .filter(x => x.record !== null) as Array<{ source: string; record: SourceFreshnessRecord }>;

    if (fetched.length < 2) continue;

    // Check all pairs for large age deltas
    for (let i = 0; i < fetched.length; i++) {
      for (let j = i + 1; j < fetched.length; j++) {
        const a = fetched[i];
        const b = fetched[j];
        const delta = Math.abs(a.record.fetchedAt - b.record.fetchedAt);

        if (delta > CONFLICT_AGE_DELTA_MS) {
          const newer = a.record.fetchedAt > b.record.fetchedAt ? a : b;
          const older = a.record.fetchedAt > b.record.fetchedAt ? b : a;
          signals.push({
            sourceA: older.source,
            sourceB: newer.source,
            ageDeltaMs: delta,
            ageDeltaFormatted: formatAge(delta),
            warning: `${older.source} (${formatAge(Date.now() - older.record.fetchedAt)} old) may conflict with ${newer.source} (${formatAge(Date.now() - newer.record.fetchedAt)} old)`,
          });
        }
      }
    }
  }

  return signals;
}

/**
 * Build a conflict warning for prompt injection.
 * Returns empty string if no conflicts detected.
 */
export function buildConflictWarning(): string {
  const conflicts = detectConflicts();
  if (!conflicts.length) return "";

  const lines = conflicts.map(c => `- ${c.warning}`);
  return (
    "⚠ POTENTIAL CONTEXT CONFLICT:\n" +
    lines.join("\n") +
    "\nSome context sources were fetched at different times and may contain contradictory information. " +
    "Verify key claims before responding."
  );
}

// ── Auto-refresh coordinator ─────────────────────────────────

/** Map of section labels to refresh function keys (used by autoRefreshStaleSources). */
type RefreshFn = () => Promise<string>;

export interface AutoRefreshResult {
  refreshed: string[];
  results: Record<string, string>;
}

/**
 * Auto-refresh stale critical sources for the given mode.
 * Caller provides refresh callbacks for each section that can be refreshed.
 * Returns which sources were refreshed and their new content.
 */
export async function autoRefreshStaleSources(
  mode: ContextMode,
  refreshFns: Record<string, RefreshFn>,
): Promise<AutoRefreshResult> {
  const stale = freshnessTracker.getStaleCriticalSources(mode);
  if (!stale.length) return { refreshed: [], results: {} };

  const refreshed: string[] = [];
  const results: Record<string, string> = {};

  await Promise.all(
    stale.map(async (check) => {
      const fn = refreshFns[check.source];
      if (!fn) return; // No refresh function for this source

      freshnessTracker.logAutoRefreshStart(check.source, check.ageFormatted);
      const start = Date.now();
      try {
        const content = await fn();
        const latencyMs = Date.now() - start;
        freshnessTracker.recordFetch(check.source, latencyMs);
        freshnessTracker.logRefreshComplete(check.source, latencyMs);
        refreshed.push(check.source);
        results[check.source] = content;
      } catch (err) {
        logger.warn(`auto-refresh failed source=${check.source}`, err);
      }
    })
  );

  return { refreshed, results };
}
