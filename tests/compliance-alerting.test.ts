/**
 * Tests for Compliance Alerting — ELLIE-625
 *
 * Covers: threshold resolution, compliance checking, deduplication,
 *         alert formatting, and per-archetype custom thresholds.
 */

import { describe, it, expect, beforeEach } from "bun:test";

import {
  DEFAULT_THRESHOLDS,
  resolveThresholds,
  checkSessionCompliance,
  shouldSuppressAlert,
  recordAlertSent,
  filterDeduplicated,
  formatComplianceAlert,
  checkAndFormat,
  _resetAlertingForTesting,
  _setDedupWindowForTesting,
  type ComplianceViolation,
} from "../src/compliance-alerting";

import {
  METRIC_TASK_COMPLETION,
  METRIC_BLOCKER_SPEED,
  METRIC_COMMIT_QUALITY,
} from "../src/session-metric-hooks";

import { recordMetric, _resetMetricsForTesting } from "../src/growth-metrics-collector";

import {
  _resetLoaderForTesting as _resetArchetypeLoader,
  _injectArchetypeForTesting,
  type ArchetypeConfig,
} from "../src/archetype-loader";

import {
  _resetBindingsForTesting,
  registerBinding,
} from "../src/agent-identity-binding";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeArchetypeConfig(species: string, thresholds?: Record<string, number>): ArchetypeConfig {
  return {
    species,
    schema: {
      frontmatter: {
        species,
        cognitive_style: `${species}-style`,
        token_budget: 10000,
        ...(thresholds ? { compliance_thresholds: thresholds } : {}),
      },
      sections: [],
      body: "",
    },
    validation: { valid: true, errors: [] },
    filePath: `config/archetypes/${species}.md`,
    loadedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  _resetMetricsForTesting();
  _resetArchetypeLoader();
  _resetBindingsForTesting();
  _resetAlertingForTesting();
});

// ── resolveThresholds ───────────────────────────────────────────────────────

describe("resolveThresholds", () => {
  it("returns default thresholds when no binding exists", () => {
    const thresholds = resolveThresholds("unknown-agent");
    expect(thresholds).toEqual(DEFAULT_THRESHOLDS);
  });

  it("returns default thresholds when archetype has no custom thresholds", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const thresholds = resolveThresholds("dev");
    expect(thresholds).toEqual(DEFAULT_THRESHOLDS);
  });

  it("overrides defaults with archetype custom thresholds", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant", {
      [METRIC_TASK_COMPLETION]: 0.8,
      [METRIC_COMMIT_QUALITY]: 0.7,
    }));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const thresholds = resolveThresholds("dev");
    const taskThreshold = thresholds.find(t => t.metricName === METRIC_TASK_COMPLETION);
    const commitThreshold = thresholds.find(t => t.metricName === METRIC_COMMIT_QUALITY);
    const blockerThreshold = thresholds.find(t => t.metricName === METRIC_BLOCKER_SPEED);

    expect(taskThreshold!.minValue).toBe(0.8);
    expect(commitThreshold!.minValue).toBe(0.7);
    expect(blockerThreshold!.maxValue).toBe(600); // unchanged default
  });

  it("overrides blocker speed maxValue with custom threshold", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant", {
      [METRIC_BLOCKER_SPEED]: 300, // 5 minutes instead of 10
    }));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const thresholds = resolveThresholds("dev");
    const blockerThreshold = thresholds.find(t => t.metricName === METRIC_BLOCKER_SPEED);
    expect(blockerThreshold!.maxValue).toBe(300);
  });
});

// ── checkSessionCompliance ──────────────────────────────────────────────────

describe("checkSessionCompliance", () => {
  it("returns no violations when no metrics recorded", () => {
    const result = checkSessionCompliance("dev", "session-1");
    expect(result.violations).toEqual([]);
    expect(result.checked).toBe(0);
  });

  it("returns no violations when metrics are above thresholds", () => {
    recordMetric("dev", "session-1", METRIC_TASK_COMPLETION, 1);
    recordMetric("dev", "session-1", METRIC_COMMIT_QUALITY, 0.8);

    const result = checkSessionCompliance("dev", "session-1");
    expect(result.violations).toEqual([]);
    expect(result.checked).toBe(2);
  });

  it("detects task completion below threshold", () => {
    recordMetric("dev", "session-1", METRIC_TASK_COMPLETION, 0);

    const result = checkSessionCompliance("dev", "session-1");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].metricName).toBe(METRIC_TASK_COMPLETION);
    expect(result.violations[0].currentValue).toBe(0);
    expect(result.violations[0].threshold).toBe(0.5);
    expect(result.violations[0].direction).toBe("below");
  });

  it("detects commit quality below threshold", () => {
    recordMetric("dev", "session-1", METRIC_COMMIT_QUALITY, 0.3);

    const result = checkSessionCompliance("dev", "session-1");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].metricName).toBe(METRIC_COMMIT_QUALITY);
    expect(result.violations[0].direction).toBe("below");
  });

  it("detects blocker speed above threshold", () => {
    recordMetric("dev", "session-1", METRIC_BLOCKER_SPEED, 900); // 15 minutes

    const result = checkSessionCompliance("dev", "session-1");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].metricName).toBe(METRIC_BLOCKER_SPEED);
    expect(result.violations[0].currentValue).toBe(900);
    expect(result.violations[0].threshold).toBe(600);
    expect(result.violations[0].direction).toBe("above");
  });

  it("detects multiple violations at once", () => {
    recordMetric("dev", "session-1", METRIC_TASK_COMPLETION, 0);
    recordMetric("dev", "session-1", METRIC_COMMIT_QUALITY, 0.2);
    recordMetric("dev", "session-1", METRIC_BLOCKER_SPEED, 1200);

    const result = checkSessionCompliance("dev", "session-1");
    expect(result.violations).toHaveLength(3);
    expect(result.checked).toBe(3);
  });

  it("uses custom archetype thresholds", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant", {
      [METRIC_TASK_COMPLETION]: 0.9,
    }));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    recordMetric("dev", "session-1", METRIC_TASK_COMPLETION, 0.7);

    const result = checkSessionCompliance("dev", "session-1");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].threshold).toBe(0.9);
  });

  it("passes with default threshold but fails with stricter custom threshold", () => {
    // 0.6 passes default (0.5) but fails custom (0.8)
    _injectArchetypeForTesting(makeArchetypeConfig("ant", {
      [METRIC_TASK_COMPLETION]: 0.8,
    }));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    recordMetric("dev", "session-1", METRIC_TASK_COMPLETION, 0.6);

    const result = checkSessionCompliance("dev", "session-1");
    expect(result.violations).toHaveLength(1);
  });
});

// ── Deduplication ───────────────────────────────────────────────────────────

describe("deduplication", () => {
  it("does not suppress first alert", () => {
    expect(shouldSuppressAlert("dev", METRIC_TASK_COMPLETION)).toBe(false);
  });

  it("suppresses alert after recording", () => {
    recordAlertSent("dev", METRIC_TASK_COMPLETION);
    expect(shouldSuppressAlert("dev", METRIC_TASK_COMPLETION)).toBe(true);
  });

  it("does not suppress different metric for same agent", () => {
    recordAlertSent("dev", METRIC_TASK_COMPLETION);
    expect(shouldSuppressAlert("dev", METRIC_COMMIT_QUALITY)).toBe(false);
  });

  it("does not suppress same metric for different agent", () => {
    recordAlertSent("dev", METRIC_TASK_COMPLETION);
    expect(shouldSuppressAlert("research", METRIC_TASK_COMPLETION)).toBe(false);
  });

  it("allows alert after dedup window expires", () => {
    _setDedupWindowForTesting(10); // 10ms window
    recordAlertSent("dev", METRIC_TASK_COMPLETION);

    // Should be suppressed immediately
    expect(shouldSuppressAlert("dev", METRIC_TASK_COMPLETION)).toBe(true);

    // Wait for window to expire
    const start = Date.now();
    while (Date.now() - start < 15) { /* busy wait */ }

    expect(shouldSuppressAlert("dev", METRIC_TASK_COMPLETION)).toBe(false);
  });

  it("filterDeduplicated removes recently alerted violations", () => {
    recordAlertSent("dev", METRIC_TASK_COMPLETION);

    const violations: ComplianceViolation[] = [
      { agentName: "dev", metricName: METRIC_TASK_COMPLETION, currentValue: 0, threshold: 0.5, direction: "below" },
      { agentName: "dev", metricName: METRIC_COMMIT_QUALITY, currentValue: 0.2, threshold: 0.5, direction: "below" },
    ];

    const filtered = filterDeduplicated(violations);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].metricName).toBe(METRIC_COMMIT_QUALITY);
  });

  it("resets dedup state on _resetAlertingForTesting", () => {
    recordAlertSent("dev", METRIC_TASK_COMPLETION);
    expect(shouldSuppressAlert("dev", METRIC_TASK_COMPLETION)).toBe(true);

    _resetAlertingForTesting();
    expect(shouldSuppressAlert("dev", METRIC_TASK_COMPLETION)).toBe(false);
  });
});

// ── formatComplianceAlert ───────────────────────────────────────────────────

describe("formatComplianceAlert", () => {
  it("returns empty string for no violations", () => {
    expect(formatComplianceAlert([])).toBe("");
  });

  it("formats single violation", () => {
    const violations: ComplianceViolation[] = [
      { agentName: "dev", metricName: METRIC_TASK_COMPLETION, currentValue: 0, threshold: 0.5, direction: "below" },
    ];

    const alert = formatComplianceAlert(violations);
    expect(alert).toContain("Compliance Alert: dev");
    expect(alert).toContain("Task Completion");
    expect(alert).toContain("0%");
    expect(alert).toContain("min: 50%");
  });

  it("formats blocker speed with seconds", () => {
    const violations: ComplianceViolation[] = [
      { agentName: "dev", metricName: METRIC_BLOCKER_SPEED, currentValue: 900, threshold: 600, direction: "above" },
    ];

    const alert = formatComplianceAlert(violations);
    expect(alert).toContain("900s");
    expect(alert).toContain("max: 600s");
  });

  it("formats multiple violations", () => {
    const violations: ComplianceViolation[] = [
      { agentName: "dev", metricName: METRIC_TASK_COMPLETION, currentValue: 0, threshold: 0.5, direction: "below" },
      { agentName: "dev", metricName: METRIC_COMMIT_QUALITY, currentValue: 0.2, threshold: 0.5, direction: "below" },
    ];

    const alert = formatComplianceAlert(violations);
    expect(alert).toContain("Task Completion");
    expect(alert).toContain("Commit Quality");
  });
});

// ── checkAndFormat ──────────────────────────────────────────────────────────

describe("checkAndFormat", () => {
  it("returns null alert when no violations", () => {
    recordMetric("dev", "session-1", METRIC_TASK_COMPLETION, 1);

    const result = checkAndFormat("dev", "session-1");
    expect(result.alert).toBeNull();
    expect(result.violations).toEqual([]);
  });

  it("returns alert and violations when thresholds violated", () => {
    recordMetric("dev", "session-1", METRIC_TASK_COMPLETION, 0);

    const result = checkAndFormat("dev", "session-1");
    expect(result.alert).not.toBeNull();
    expect(result.violations).toHaveLength(1);
    expect(result.alert).toContain("Task Completion");
  });

  it("filters out deduplicated violations", () => {
    recordMetric("dev", "session-1", METRIC_TASK_COMPLETION, 0);
    recordMetric("dev", "session-1", METRIC_COMMIT_QUALITY, 0.2);
    recordAlertSent("dev", METRIC_TASK_COMPLETION);

    const result = checkAndFormat("dev", "session-1");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].metricName).toBe(METRIC_COMMIT_QUALITY);
  });

  it("returns null when all violations are deduplicated", () => {
    recordMetric("dev", "session-1", METRIC_TASK_COMPLETION, 0);
    recordAlertSent("dev", METRIC_TASK_COMPLETION);

    const result = checkAndFormat("dev", "session-1");
    expect(result.alert).toBeNull();
    expect(result.violations).toEqual([]);
  });
});
