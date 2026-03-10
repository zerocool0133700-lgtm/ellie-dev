/**
 * Mountain — Core Types
 *
 * Type definitions for the Mountain data harvesting system.
 * Mountain pulls data from external sources (connectors) into the Forest.
 */

// ── Source Interface ─────────────────────────────────────────

/** Status of a registered source connector */
export type SourceStatus = "idle" | "harvesting" | "error" | "disabled";

/**
 * MountainSource — connector contract.
 *
 * Every external data source (Gmail, Calendar, GitHub, etc.) implements
 * this interface. The orchestrator calls `harvest()` on a schedule or
 * on demand, and the source returns structured results.
 */
export interface MountainSource {
  /** Unique identifier for this source (e.g. "gmail", "github-issues") */
  readonly id: string;

  /** Human-readable name shown in dashboards */
  readonly name: string;

  /** Current operational status */
  status: SourceStatus;

  /**
   * Run a harvest — pull data from the external source.
   * Returns a HarvestResult with items found and any errors.
   */
  harvest(job: HarvestJob): Promise<HarvestResult>;

  /**
   * Optional health check. Returns true if the source is reachable
   * and credentials are valid.
   */
  healthCheck?(): Promise<boolean>;
}

// ── Harvest Job ──────────────────────────────────────────────

/**
 * HarvestJob — describes what to harvest.
 *
 * Passed to `MountainSource.harvest()`. Contains the time window,
 * optional filters, and metadata for tracking.
 */
export interface HarvestJob {
  /** Unique job ID for tracking and deduplication */
  id: string;

  /** Source ID this job targets */
  sourceId: string;

  /** Start of the time window to harvest (inclusive) */
  since?: Date;

  /** End of the time window (exclusive). Defaults to now. */
  until?: Date;

  /** Source-specific filters (e.g. label, folder, repo) */
  filters?: Record<string, unknown>;

  /** Maximum number of items to fetch. 0 = unlimited. */
  limit?: number;
}

// ── Harvest Result ───────────────────────────────────────────

/**
 * A single harvested item ready to be written to the Forest.
 */
export interface HarvestItem {
  /** External ID from the source (for deduplication) */
  externalId: string;

  /** Content of the harvested item */
  content: string;

  /** When the item was created/occurred in the source */
  sourceTimestamp: Date;

  /** Source-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * HarvestResult — output of a single harvest run.
 */
export interface HarvestResult {
  /** The job that produced this result */
  jobId: string;

  /** Source that was harvested */
  sourceId: string;

  /** Items successfully harvested */
  items: HarvestItem[];

  /** Errors encountered during harvest (non-fatal) */
  errors: HarvestError[];

  /** When the harvest started */
  startedAt: Date;

  /** When the harvest completed */
  completedAt: Date;

  /** Whether the harvest was truncated by a limit */
  truncated: boolean;
}

/**
 * A non-fatal error encountered during harvest.
 * The harvest continues but logs the issue.
 */
export interface HarvestError {
  /** What failed */
  message: string;

  /** Optional error code from the source API */
  code?: string;

  /** Whether this error is transient (retryable) */
  retryable: boolean;
}
