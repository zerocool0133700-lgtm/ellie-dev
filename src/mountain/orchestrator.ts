/**
 * MountainOrchestrator — ELLIE-658
 *
 * Manages Mountain source connectors. Handles registration, listing,
 * and dispatching harvest jobs to individual sources.
 */

import { log } from "../logger.ts";
import type {
  MountainSource,
  HarvestJob,
  HarvestResult,
  HarvestError,
  SourceStatus,
} from "./types.ts";

const logger = log.child("mountain");

// ── Orchestrator ─────────────────────────────────────────────

export class MountainOrchestrator {
  private sources = new Map<string, MountainSource>();

  /**
   * Register a source connector. Throws if a source with the same ID
   * is already registered.
   */
  register(source: MountainSource): void {
    if (this.sources.has(source.id)) {
      throw new Error(`Mountain source "${source.id}" is already registered`);
    }
    this.sources.set(source.id, source);
    logger.info(`Source registered: ${source.name}`, { sourceId: source.id });
  }

  /**
   * Unregister a source by ID. Returns true if removed, false if not found.
   */
  unregister(sourceId: string): boolean {
    const removed = this.sources.delete(sourceId);
    if (removed) {
      logger.info(`Source unregistered`, { sourceId });
    }
    return removed;
  }

  /**
   * Get a registered source by ID, or undefined if not found.
   */
  getSource(sourceId: string): MountainSource | undefined {
    return this.sources.get(sourceId);
  }

  /**
   * List all registered sources with their current status.
   */
  listSources(): Array<{ id: string; name: string; status: SourceStatus }> {
    return Array.from(this.sources.values()).map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
    }));
  }

  /**
   * Run a harvest job against a specific source.
   * Returns the HarvestResult on success, or a failed result on error.
   */
  async harvest(job: HarvestJob): Promise<HarvestResult> {
    const source = this.sources.get(job.sourceId);
    if (!source) {
      throw new Error(`Unknown source: "${job.sourceId}"`);
    }

    logger.info(`Harvest started`, {
      jobId: job.id,
      sourceId: job.sourceId,
      since: job.since?.toISOString(),
      until: job.until?.toISOString(),
    });

    const startedAt = new Date();
    try {
      source.status = "harvesting";
      const result = await source.harvest(job);
      source.status = "idle";

      logger.info(`Harvest completed`, {
        jobId: job.id,
        sourceId: job.sourceId,
        itemCount: result.items.length,
        errorCount: result.errors.length,
        truncated: result.truncated,
      });

      return result;
    } catch (err) {
      source.status = "error";
      const completedAt = new Date();
      const message = err instanceof Error ? err.message : String(err);

      logger.error(`Harvest failed`, {
        jobId: job.id,
        sourceId: job.sourceId,
        error: message,
      });

      const harvestError: HarvestError = {
        message,
        retryable: false,
      };

      return {
        jobId: job.id,
        sourceId: job.sourceId,
        items: [],
        errors: [harvestError],
        startedAt,
        completedAt,
        truncated: false,
      };
    }
  }

  /**
   * Run health checks on all registered sources (or a specific one).
   * Returns a map of source ID to health status.
   */
  async healthCheck(
    sourceId?: string,
  ): Promise<Map<string, boolean | null>> {
    const results = new Map<string, boolean | null>();
    const targets = sourceId
      ? [this.sources.get(sourceId)].filter(Boolean) as MountainSource[]
      : Array.from(this.sources.values());

    for (const source of targets) {
      if (!source.healthCheck) {
        results.set(source.id, null);
        continue;
      }
      try {
        const healthy = await source.healthCheck();
        results.set(source.id, healthy);
      } catch {
        results.set(source.id, false);
      }
    }

    return results;
  }
}
