/**
 * Compliance Alerting — ELLIE-625
 *
 * Checks growth metrics against configurable thresholds after work session
 * completion. Sends Telegram alerts when an agent's metrics drop below
 * threshold values.
 *
 * Thresholds are resolved in order:
 *   1. Per-archetype: compliance_thresholds in archetype frontmatter
 *   2. Default: hardcoded per-metric defaults
 *
 * Deduplication: alerts for the same agent+metric are suppressed within
 * a configurable window (default: 1 hour).
 */

import { getBinding } from "./agent-identity-binding";
import { getArchetype } from "./archetype-loader";
import { getSessionDataPoints, computeMetricSummary } from "./growth-metrics-collector";
import {
  METRIC_TASK_COMPLETION,
  METRIC_BLOCKER_SPEED,
  METRIC_COMMIT_QUALITY,
} from "./session-metric-hooks";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ComplianceThreshold {
  metricName: string;
  /** Minimum acceptable value. Values below this trigger an alert. */
  minValue: number;
  /** For "higher is worse" metrics (like blocker speed), use maxValue instead. */
  maxValue?: number;
}

export interface ComplianceViolation {
  agentName: string;
  metricName: string;
  currentValue: number;
  threshold: number;
  direction: "below" | "above";
}

export interface ComplianceCheckResult {
  agentName: string;
  sessionId: string;
  violations: ComplianceViolation[];
  checked: number;
}

// ── Default Thresholds ──────────────────────────────────────────────────────

/** Default thresholds applied when archetype doesn't define custom ones. */
export const DEFAULT_THRESHOLDS: ComplianceThreshold[] = [
  { metricName: METRIC_TASK_COMPLETION, minValue: 0.5 },
  { metricName: METRIC_COMMIT_QUALITY, minValue: 0.5 },
  { metricName: METRIC_BLOCKER_SPEED, maxValue: 600 }, // 10 minutes max
];

// ── Deduplication ───────────────────────────────────────────────────────────

/** Tracks last alert time per agent+metric to prevent spam. */
const _lastAlertTime = new Map<string, number>();

/** Default deduplication window in milliseconds (1 hour). */
export const DEFAULT_DEDUP_WINDOW_MS = 60 * 60 * 1000;

let _dedupWindowMs = DEFAULT_DEDUP_WINDOW_MS;

function dedupKey(agentName: string, metricName: string): string {
  return `${agentName.toLowerCase()}:${metricName}`;
}

/**
 * Check if an alert should be suppressed (already fired within the window).
 */
export function shouldSuppressAlert(agentName: string, metricName: string): boolean {
  const key = dedupKey(agentName, metricName);
  const lastTime = _lastAlertTime.get(key);
  if (!lastTime) return false;
  return Date.now() - lastTime < _dedupWindowMs;
}

/**
 * Record that an alert was sent for deduplication tracking.
 */
export function recordAlertSent(agentName: string, metricName: string): void {
  _lastAlertTime.set(dedupKey(agentName, metricName), Date.now());
}

// ── Threshold Resolution ────────────────────────────────────────────────────

/**
 * Resolve thresholds for an agent. Checks archetype frontmatter first,
 * then falls back to defaults.
 */
export function resolveThresholds(agentName: string): ComplianceThreshold[] {
  const binding = getBinding(agentName);
  if (!binding) return [...DEFAULT_THRESHOLDS];

  const archetype = getArchetype(binding.archetype);
  if (!archetype?.schema.frontmatter.compliance_thresholds) return [...DEFAULT_THRESHOLDS];

  const custom = archetype.schema.frontmatter.compliance_thresholds;
  return DEFAULT_THRESHOLDS.map((defaultThreshold) => {
    const customValue = custom[defaultThreshold.metricName];
    if (customValue === undefined) return { ...defaultThreshold };

    // For maxValue metrics (blocker speed), the custom value overrides maxValue
    if (defaultThreshold.maxValue !== undefined) {
      return { ...defaultThreshold, maxValue: customValue };
    }
    // For minValue metrics, the custom value overrides minValue
    return { ...defaultThreshold, minValue: customValue };
  });
}

// ── Compliance Check ────────────────────────────────────────────────────────

/**
 * Check a session's metrics against thresholds.
 * Returns violations for metrics that fall outside acceptable ranges.
 */
export function checkSessionCompliance(
  agentName: string,
  sessionId: string,
): ComplianceCheckResult {
  const thresholds = resolveThresholds(agentName);
  const sessionPoints = getSessionDataPoints(sessionId);
  const violations: ComplianceViolation[] = [];
  let checked = 0;

  for (const threshold of thresholds) {
    const point = sessionPoints.find((p) => p.metricName === threshold.metricName);
    if (!point) continue;

    checked++;

    if (threshold.maxValue !== undefined) {
      // "Higher is worse" metric (e.g., blocker speed in seconds)
      if (point.value > threshold.maxValue) {
        violations.push({
          agentName,
          metricName: threshold.metricName,
          currentValue: point.value,
          threshold: threshold.maxValue,
          direction: "above",
        });
      }
    } else {
      // "Higher is better" metric (e.g., task completion, commit quality)
      if (point.value < threshold.minValue) {
        violations.push({
          agentName,
          metricName: threshold.metricName,
          currentValue: point.value,
          threshold: threshold.minValue,
          direction: "below",
        });
      }
    }
  }

  return { agentName, sessionId, violations, checked };
}

// ── Alert Formatting ────────────────────────────────────────────────────────

/** Human-readable metric labels. */
const METRIC_LABELS: Record<string, string> = {
  [METRIC_TASK_COMPLETION]: "Task Completion",
  [METRIC_BLOCKER_SPEED]: "Blocker Speed",
  [METRIC_COMMIT_QUALITY]: "Commit Quality",
};

function metricLabel(name: string): string {
  return METRIC_LABELS[name] || name;
}

function formatValue(metricName: string, value: number): string {
  if (metricName === METRIC_BLOCKER_SPEED) {
    return `${Math.round(value)}s`;
  }
  return `${(value * 100).toFixed(0)}%`;
}

function formatThreshold(metricName: string, threshold: number, direction: "below" | "above"): string {
  const prefix = direction === "below" ? "min" : "max";
  if (metricName === METRIC_BLOCKER_SPEED) {
    return `${prefix}: ${Math.round(threshold)}s`;
  }
  return `${prefix}: ${(threshold * 100).toFixed(0)}%`;
}

/**
 * Format compliance violations into a Telegram-ready message.
 */
export function formatComplianceAlert(violations: ComplianceViolation[]): string {
  if (violations.length === 0) return "";

  const agentName = violations[0].agentName;
  const lines = [
    `\u26A0\uFE0F **Compliance Alert: ${agentName}**`,
    "",
  ];

  for (const v of violations) {
    lines.push(
      `- **${metricLabel(v.metricName)}**: ${formatValue(v.metricName, v.currentValue)} (${formatThreshold(v.metricName, v.threshold, v.direction)})`,
    );
  }

  return lines.join("\n");
}

/**
 * Filter violations to only those not recently alerted (dedup).
 */
export function filterDeduplicated(violations: ComplianceViolation[]): ComplianceViolation[] {
  return violations.filter((v) => !shouldSuppressAlert(v.agentName, v.metricName));
}

/**
 * Run compliance check, filter duplicates, and return formatted alert.
 * Returns null if no actionable violations.
 *
 * Call recordAlertSent() for each violation after successfully sending.
 */
export function checkAndFormat(agentName: string, sessionId: string): {
  alert: string | null;
  violations: ComplianceViolation[];
} {
  const result = checkSessionCompliance(agentName, sessionId);
  const actionable = filterDeduplicated(result.violations);

  if (actionable.length === 0) {
    return { alert: null, violations: [] };
  }

  return {
    alert: formatComplianceAlert(actionable),
    violations: actionable,
  };
}

// ── Testing ─────────────────────────────────────────────────────────────────

/** Reset dedup state — for testing only. */
export function _resetAlertingForTesting(): void {
  _lastAlertTime.clear();
  _dedupWindowMs = DEFAULT_DEDUP_WINDOW_MS;
}

/** Override dedup window — for testing only. */
export function _setDedupWindowForTesting(ms: number): void {
  _dedupWindowMs = ms;
}
