/**
 * Growth Metrics Collector — ELLIE-609
 *
 * Tracks archetype compliance metrics for agents over work sessions.
 * Each archetype defines measurable Growth Metrics (task completion rate,
 * investigation depth, etc.). This module:
 *
 *   1. Parses metric definitions from archetype Growth Metrics sections
 *   2. Records metric data points per agent per session
 *   3. Queries metric history and computes trends
 *   4. Exposes summaries for API/dashboard consumption
 *
 * Metrics are archetype-specific — different archetypes track different things.
 * Collection is lightweight: observe existing events, don't add overhead.
 *
 * Depends on:
 *   archetype-loader.ts (ELLIE-604) — archetype config access
 *   agent-identity-binding.ts (ELLIE-607) — agent→archetype mapping
 *
 * Pure module — in-memory store, zero external side effects.
 */

import { getArchetype } from "./archetype-loader";
import { getBinding } from "./agent-identity-binding";
import { getSection } from "./archetype-schema";
import type { ArchetypeSchema } from "./archetype-schema";

// ── Types ────────────────────────────────────────────────────────────────────

/** A metric definition parsed from an archetype's Growth Metrics section. */
export interface MetricDefinition {
  name: string;
  description: string;
}

/** A recorded metric data point. */
export interface MetricDataPoint {
  agentName: string;
  sessionId: string;
  metricName: string;
  value: number;
  recordedAt: string;
  metadata?: Record<string, unknown>;
}

/** Summary of a single metric across sessions. */
export interface MetricSummary {
  metricName: string;
  count: number;
  total: number;
  average: number;
  min: number;
  max: number;
  latest: number;
  latestAt: string;
}

/** Full metrics report for an agent. */
export interface AgentMetricsReport {
  agentName: string;
  archetype: string | null;
  definitions: MetricDefinition[];
  summaries: MetricSummary[];
  dataPoints: MetricDataPoint[];
  sessionCount: number;
}

// ── Storage ──────────────────────────────────────────────────────────────────

const _dataPoints: MetricDataPoint[] = [];

// ── Metric Definition Parsing ────────────────────────────────────────────────

/**
 * Parse metric definitions from a Growth Metrics section body.
 * Expects markdown bullet points like:
 *   - **Metric Name** — description text
 *   - **Metric Name** -- description text
 */
export function parseMetricDefinitions(sectionContent: string): MetricDefinition[] {
  const definitions: MetricDefinition[] = [];
  const lines = sectionContent.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // Match: - **Name** — description  OR  - **Name** -- description
    const match = trimmed.match(/^-\s+\*\*(.+?)\*\*\s*(?:—|--|–)\s*(.+)$/);
    if (match) {
      definitions.push({
        name: match[1].trim(),
        description: match[2].trim(),
      });
    }
  }

  return definitions;
}

/**
 * Get metric definitions for an archetype by name.
 * Reads the Growth Metrics section from the loaded archetype schema.
 */
export function getMetricDefinitions(archetypeName: string): MetricDefinition[] {
  const config = getArchetype(archetypeName);
  if (!config) return [];

  const section = getSection(config.schema, "Growth Metrics");
  if (!section) return [];

  return parseMetricDefinitions(section.content);
}

/**
 * Get metric definitions for an agent via its binding.
 */
export function getAgentMetricDefinitions(agentName: string): MetricDefinition[] {
  const binding = getBinding(agentName);
  if (!binding) return [];
  return getMetricDefinitions(binding.archetype);
}

// ── Recording ────────────────────────────────────────────────────────────────

/**
 * Record a metric data point for an agent session.
 */
export function recordMetric(
  agentName: string,
  sessionId: string,
  metricName: string,
  value: number,
  metadata?: Record<string, unknown>,
): MetricDataPoint {
  const dataPoint: MetricDataPoint = {
    agentName: agentName.toLowerCase(),
    sessionId,
    metricName,
    value,
    recordedAt: new Date().toISOString(),
    metadata,
  };
  _dataPoints.push(dataPoint);
  return dataPoint;
}

/**
 * Record multiple metrics for a session at once.
 */
export function recordSessionMetrics(
  agentName: string,
  sessionId: string,
  metrics: Array<{ name: string; value: number; metadata?: Record<string, unknown> }>,
): MetricDataPoint[] {
  return metrics.map(m => recordMetric(agentName, sessionId, m.name, m.value, m.metadata));
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Get all data points for an agent.
 */
export function getAgentDataPoints(agentName: string): MetricDataPoint[] {
  const normalized = agentName.toLowerCase();
  return _dataPoints.filter(dp => dp.agentName === normalized);
}

/**
 * Get data points for an agent filtered by metric name.
 */
export function getMetricDataPoints(agentName: string, metricName: string): MetricDataPoint[] {
  const normalized = agentName.toLowerCase();
  return _dataPoints.filter(dp => dp.agentName === normalized && dp.metricName === metricName);
}

/**
 * Get data points for a specific session.
 */
export function getSessionDataPoints(sessionId: string): MetricDataPoint[] {
  return _dataPoints.filter(dp => dp.sessionId === sessionId);
}

/**
 * Get unique session IDs for an agent.
 */
export function getAgentSessionIds(agentName: string): string[] {
  const normalized = agentName.toLowerCase();
  const sessionIds = new Set<string>();
  for (const dp of _dataPoints) {
    if (dp.agentName === normalized) {
      sessionIds.add(dp.sessionId);
    }
  }
  return [...sessionIds];
}

// ── Summaries ────────────────────────────────────────────────────────────────

/**
 * Compute summary statistics for a specific metric of an agent.
 */
export function computeMetricSummary(agentName: string, metricName: string): MetricSummary | null {
  const points = getMetricDataPoints(agentName, metricName);
  if (points.length === 0) return null;

  const values = points.map(p => p.value);
  const total = values.reduce((sum, v) => sum + v, 0);
  const latest = points[points.length - 1];

  return {
    metricName,
    count: points.length,
    total,
    average: total / points.length,
    min: Math.min(...values),
    max: Math.max(...values),
    latest: latest.value,
    latestAt: latest.recordedAt,
  };
}

/**
 * Build a full metrics report for an agent.
 * ELLIE-613: Ensures historical data is hydrated from Forest before building.
 */
export async function buildAgentReport(agentName: string): Promise<AgentMetricsReport> {
  await ensureHydrated();
  const binding = getBinding(agentName);
  const definitions = binding ? getMetricDefinitions(binding.archetype) : [];
  const dataPoints = getAgentDataPoints(agentName);
  const sessionIds = getAgentSessionIds(agentName);

  // Compute summaries for all metrics that have data
  const metricNames = new Set(dataPoints.map(dp => dp.metricName));
  const summaries: MetricSummary[] = [];
  for (const name of metricNames) {
    const summary = computeMetricSummary(agentName, name);
    if (summary) summaries.push(summary);
  }

  return {
    agentName: agentName.toLowerCase(),
    archetype: binding?.archetype ?? null,
    definitions,
    summaries,
    dataPoints,
    sessionCount: sessionIds.length,
  };
}

/**
 * Build a compact summary string for logging/display.
 */
export async function buildMetricsSummary(agentName: string): Promise<string> {
  const report = await buildAgentReport(agentName);

  if (report.dataPoints.length === 0) {
    return `No metrics recorded for agent "${agentName}".`;
  }

  const lines = [
    `Growth Metrics for "${report.agentName}" (archetype: ${report.archetype ?? "unbound"}, sessions: ${report.sessionCount}):`,
  ];

  for (const summary of report.summaries) {
    lines.push(
      `  ${summary.metricName}: avg=${summary.average.toFixed(2)}, min=${summary.min}, max=${summary.max}, count=${summary.count}`,
    );
  }

  return lines.join("\n");
}

// ── Persistence (ELLIE-613) ──────────────────────────────────────────────────

const BRIDGE_URL = "http://localhost:3001/api/bridge";
const BRIDGE_KEY = process.env.BRIDGE_KEY || "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";
const METRICS_SCOPE = "2/1"; // ellie-dev scope

let _hydrated = false;
let _hydratePromise: Promise<void> | null = null;

/** Serializable snapshot of all metrics for persistence. */
export interface MetricsSnapshot {
  version: 1;
  exportedAt: string;
  dataPoints: MetricDataPoint[];
}

/**
 * Build a snapshot of current in-memory metrics.
 */
export function buildSnapshot(): MetricsSnapshot {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    dataPoints: [..._dataPoints],
  };
}

/**
 * Import data points from a snapshot, deduplicating by (agentName, sessionId, metricName, recordedAt).
 * Returns the number of new points added.
 */
export function importSnapshot(snapshot: MetricsSnapshot): number {
  if (!snapshot?.dataPoints || !Array.isArray(snapshot.dataPoints)) return 0;

  const existing = new Set(
    _dataPoints.map(dp => `${dp.agentName}|${dp.sessionId}|${dp.metricName}|${dp.recordedAt}`),
  );

  let added = 0;
  for (const dp of snapshot.dataPoints) {
    const key = `${dp.agentName}|${dp.sessionId}|${dp.metricName}|${dp.recordedAt}`;
    if (!existing.has(key)) {
      _dataPoints.push(dp);
      existing.add(key);
      added++;
    }
  }
  return added;
}

/**
 * Persist current metrics to Forest via the bridge API.
 * Writes a single memory entry with the full snapshot as metadata.
 * Non-fatal — returns false on failure.
 */
export async function persistToForest(): Promise<boolean> {
  try {
    if (_dataPoints.length === 0) return true; // nothing to persist

    const snapshot = buildSnapshot();
    const resp = await fetch(`${BRIDGE_URL}/write`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-key": BRIDGE_KEY,
      },
      body: JSON.stringify({
        content: `Growth metrics snapshot: ${snapshot.dataPoints.length} data points across ${new Set(snapshot.dataPoints.map(dp => dp.agentName)).size} agents`,
        type: "fact",
        scope_path: METRICS_SCOPE,
        confidence: 0.8,
        metadata: {
          metrics_snapshot: true,
          snapshot: JSON.stringify(snapshot),
        },
      }),
    });

    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Hydrate metrics from Forest on first access.
 * Searches for the most recent metrics snapshot and imports it.
 * Non-fatal — if Forest is unavailable, in-memory still works.
 */
export async function hydrateFromForest(): Promise<number> {
  try {
    const resp = await fetch(`${BRIDGE_URL}/read`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-key": BRIDGE_KEY,
      },
      body: JSON.stringify({
        query: "growth metrics snapshot",
        scope_path: METRICS_SCOPE,
      }),
    });

    if (!resp.ok) return 0;

    const data = await resp.json() as {
      success: boolean;
      memories?: Array<{
        metadata?: { metrics_snapshot?: boolean; snapshot?: string };
      }>;
    };

    if (!data.success || !data.memories?.length) return 0;

    // Find the most recent snapshot entry
    const snapshotEntry = data.memories.find(m => m.metadata?.metrics_snapshot && m.metadata?.snapshot);
    if (!snapshotEntry?.metadata?.snapshot) return 0;

    const snapshot: MetricsSnapshot = JSON.parse(snapshotEntry.metadata.snapshot);
    if (snapshot.version !== 1) return 0;

    return importSnapshot(snapshot);
  } catch {
    return 0;
  }
}

/**
 * Ensure metrics are hydrated from Forest (once, lazily).
 * Call this before any read operation that should reflect historical data.
 */
export async function ensureHydrated(): Promise<void> {
  if (_hydrated) return;
  if (_hydratePromise) {
    await _hydratePromise;
    return;
  }
  _hydratePromise = hydrateFromForest().then(() => { _hydrated = true; }).catch(() => { _hydrated = true; });
  await _hydratePromise;
  _hydratePromise = null;
}

// ── Testing ──────────────────────────────────────────────────────────────────

/** Reset all state — for testing only. */
export function _resetMetricsForTesting(): void {
  _dataPoints.length = 0;
  _hydrated = false;
  _hydratePromise = null;
}
