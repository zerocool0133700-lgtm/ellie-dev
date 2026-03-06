/**
 * Tests for Growth Metrics Collector — ELLIE-609
 *
 * Covers: metric definition parsing, recording, queries,
 * summaries, reports, and integration with archetype loader.
 */

import { describe, it, expect, beforeEach } from "bun:test";

import {
  parseMetricDefinitions,
  getMetricDefinitions,
  getAgentMetricDefinitions,
  recordMetric,
  recordSessionMetrics,
  getAgentDataPoints,
  getMetricDataPoints,
  getSessionDataPoints,
  getAgentSessionIds,
  computeMetricSummary,
  buildAgentReport,
  buildMetricsSummary,
  _resetMetricsForTesting,
} from "../src/growth-metrics-collector";

import {
  _resetLoaderForTesting as _resetArchetypeLoaderForTesting,
  _injectArchetypeForTesting,
} from "../src/archetype-loader";

import {
  registerBinding,
  _resetBindingsForTesting,
} from "../src/agent-identity-binding";

// ── Helpers ──────────────────────────────────────────────────────────────────

function injectAntArchetype() {
  _injectArchetypeForTesting({
    species: "ant",
    schema: {
      frontmatter: { species: "ant", cognitive_style: "depth-first" as const },
      sections: [
        { heading: "Working Pattern", content: "Focus on one task at a time." },
        { heading: "Communication Style", content: "Code over prose." },
        { heading: "Anti-Patterns", content: "Never context-switch mid-task." },
        {
          heading: "Growth Metrics",
          content: [
            "Track these over time to deepen specialization:",
            "",
            "- **Task completion rate** — tickets marked Done with no rework needed",
            "- **Investigation depth** — how thoroughly you trace before fixing",
            "- **Blocker identification speed** — turns between blocker appearing and being surfaced",
            "- **Scope discipline** — changes in PR match the ticket scope",
          ].join("\n"),
        },
      ],
      body: "",
    },
    validation: { valid: true, errors: [] },
    filePath: "config/archetypes/ant.md",
    loadedAt: new Date().toISOString(),
  });
}

function setupDevAgent() {
  injectAntArchetype();
  registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetMetricsForTesting();
  _resetArchetypeLoaderForTesting();
  _resetBindingsForTesting();
});

// ── parseMetricDefinitions ──────────────────────────────────────────────────

describe("parseMetricDefinitions", () => {
  it("parses metric definitions with em dash", () => {
    const content = "- **Task completion rate** — tickets marked Done with no rework";
    const defs = parseMetricDefinitions(content);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("Task completion rate");
    expect(defs[0].description).toBe("tickets marked Done with no rework");
  });

  it("parses metric definitions with double dash", () => {
    const content = "- **Investigation depth** -- how thoroughly you trace before fixing";
    const defs = parseMetricDefinitions(content);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("Investigation depth");
    expect(defs[0].description).toBe("how thoroughly you trace before fixing");
  });

  it("parses metric definitions with en dash", () => {
    const content = "- **Speed** – how fast the agent completes work";
    const defs = parseMetricDefinitions(content);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("Speed");
  });

  it("parses multiple metrics", () => {
    const content = [
      "Track these over time:",
      "",
      "- **Task completion rate** — tickets marked Done",
      "- **Investigation depth** — files read per task",
      "- **Blocker speed** — turns to surface blockers",
      "- **Scope discipline** — PR changes match ticket",
    ].join("\n");
    const defs = parseMetricDefinitions(content);
    expect(defs).toHaveLength(4);
    expect(defs[0].name).toBe("Task completion rate");
    expect(defs[3].name).toBe("Scope discipline");
  });

  it("skips non-metric lines", () => {
    const content = [
      "Track these over time:",
      "",
      "Some intro text.",
      "- **Real metric** — description",
      "- Not a metric definition",
      "- **Another** — description",
    ].join("\n");
    const defs = parseMetricDefinitions(content);
    expect(defs).toHaveLength(2);
  });

  it("handles empty content", () => {
    expect(parseMetricDefinitions("")).toEqual([]);
  });

  it("handles content with no metrics", () => {
    expect(parseMetricDefinitions("Just some text.\nNo bullets here.")).toEqual([]);
  });
});

// ── getMetricDefinitions ────────────────────────────────────────────────────

describe("getMetricDefinitions", () => {
  it("returns definitions for a loaded archetype", () => {
    injectAntArchetype();
    const defs = getMetricDefinitions("ant");
    expect(defs).toHaveLength(4);
    expect(defs[0].name).toBe("Task completion rate");
  });

  it("returns empty for unknown archetype", () => {
    expect(getMetricDefinitions("dragon")).toEqual([]);
  });

  it("is case-insensitive", () => {
    injectAntArchetype();
    expect(getMetricDefinitions("ANT")).toHaveLength(4);
  });
});

// ── getAgentMetricDefinitions ───────────────────────────────────────────────

describe("getAgentMetricDefinitions", () => {
  it("returns definitions via agent binding", () => {
    setupDevAgent();
    const defs = getAgentMetricDefinitions("dev");
    expect(defs).toHaveLength(4);
  });

  it("returns empty for unbound agent", () => {
    expect(getAgentMetricDefinitions("unknown")).toEqual([]);
  });
});

// ── recordMetric ────────────────────────────────────────────────────────────

describe("recordMetric", () => {
  it("records a data point", () => {
    const dp = recordMetric("dev", "session-1", "Task completion rate", 0.85);
    expect(dp.agentName).toBe("dev");
    expect(dp.sessionId).toBe("session-1");
    expect(dp.metricName).toBe("Task completion rate");
    expect(dp.value).toBe(0.85);
    expect(dp.recordedAt).toBeTruthy();
  });

  it("normalizes agent name to lowercase", () => {
    const dp = recordMetric("DEV", "session-1", "metric", 1);
    expect(dp.agentName).toBe("dev");
  });

  it("stores optional metadata", () => {
    const dp = recordMetric("dev", "s1", "metric", 1, { ticketId: "ELLIE-100" });
    expect(dp.metadata).toEqual({ ticketId: "ELLIE-100" });
  });
});

// ── recordSessionMetrics ────────────────────────────────────────────────────

describe("recordSessionMetrics", () => {
  it("records multiple metrics at once", () => {
    const points = recordSessionMetrics("dev", "session-1", [
      { name: "Task completion rate", value: 0.9 },
      { name: "Investigation depth", value: 12 },
      { name: "Scope discipline", value: 1.0 },
    ]);
    expect(points).toHaveLength(3);
    expect(getAgentDataPoints("dev")).toHaveLength(3);
  });
});

// ── getAgentDataPoints ──────────────────────────────────────────────────────

describe("getAgentDataPoints", () => {
  it("returns all data points for an agent", () => {
    recordMetric("dev", "s1", "m1", 1);
    recordMetric("dev", "s2", "m2", 2);
    recordMetric("research", "s3", "m1", 3);

    expect(getAgentDataPoints("dev")).toHaveLength(2);
    expect(getAgentDataPoints("research")).toHaveLength(1);
  });

  it("returns empty for unknown agent", () => {
    expect(getAgentDataPoints("unknown")).toEqual([]);
  });

  it("is case-insensitive", () => {
    recordMetric("dev", "s1", "m1", 1);
    expect(getAgentDataPoints("DEV")).toHaveLength(1);
  });
});

// ── getMetricDataPoints ─────────────────────────────────────────────────────

describe("getMetricDataPoints", () => {
  it("filters by agent and metric name", () => {
    recordMetric("dev", "s1", "completion", 0.8);
    recordMetric("dev", "s1", "depth", 5);
    recordMetric("dev", "s2", "completion", 0.9);

    const points = getMetricDataPoints("dev", "completion");
    expect(points).toHaveLength(2);
    expect(points.every(p => p.metricName === "completion")).toBe(true);
  });
});

// ── getSessionDataPoints ────────────────────────────────────────────────────

describe("getSessionDataPoints", () => {
  it("returns all data points for a session", () => {
    recordMetric("dev", "s1", "m1", 1);
    recordMetric("dev", "s1", "m2", 2);
    recordMetric("dev", "s2", "m1", 3);

    expect(getSessionDataPoints("s1")).toHaveLength(2);
    expect(getSessionDataPoints("s2")).toHaveLength(1);
  });

  it("returns empty for unknown session", () => {
    expect(getSessionDataPoints("unknown")).toEqual([]);
  });
});

// ── getAgentSessionIds ──────────────────────────────────────────────────────

describe("getAgentSessionIds", () => {
  it("returns unique session IDs", () => {
    recordMetric("dev", "s1", "m1", 1);
    recordMetric("dev", "s1", "m2", 2);
    recordMetric("dev", "s2", "m1", 3);

    const ids = getAgentSessionIds("dev");
    expect(ids).toHaveLength(2);
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
  });

  it("returns empty for unknown agent", () => {
    expect(getAgentSessionIds("unknown")).toEqual([]);
  });
});

// ── computeMetricSummary ────────────────────────────────────────────────────

describe("computeMetricSummary", () => {
  it("computes summary statistics", () => {
    recordMetric("dev", "s1", "completion", 0.7);
    recordMetric("dev", "s2", "completion", 0.9);
    recordMetric("dev", "s3", "completion", 0.8);

    const summary = computeMetricSummary("dev", "completion");
    expect(summary).not.toBeNull();
    expect(summary!.metricName).toBe("completion");
    expect(summary!.count).toBe(3);
    expect(summary!.min).toBe(0.7);
    expect(summary!.max).toBe(0.9);
    expect(summary!.average).toBeCloseTo(0.8, 5);
    expect(summary!.total).toBeCloseTo(2.4, 5);
    expect(summary!.latest).toBe(0.8);
  });

  it("returns null for no data", () => {
    expect(computeMetricSummary("dev", "nonexistent")).toBeNull();
  });

  it("handles single data point", () => {
    recordMetric("dev", "s1", "depth", 10);
    const summary = computeMetricSummary("dev", "depth");
    expect(summary!.count).toBe(1);
    expect(summary!.average).toBe(10);
    expect(summary!.min).toBe(10);
    expect(summary!.max).toBe(10);
  });
});

// ── buildAgentReport ────────────────────────────────────────────────────────

describe("buildAgentReport", () => {
  it("builds full report with definitions and summaries", () => {
    setupDevAgent();
    recordMetric("dev", "s1", "Task completion rate", 0.85);
    recordMetric("dev", "s2", "Task completion rate", 0.90);
    recordMetric("dev", "s1", "Investigation depth", 8);

    const report = buildAgentReport("dev");
    expect(report.agentName).toBe("dev");
    expect(report.archetype).toBe("ant");
    expect(report.definitions).toHaveLength(4);
    expect(report.summaries).toHaveLength(2);
    expect(report.dataPoints).toHaveLength(3);
    expect(report.sessionCount).toBe(2);
  });

  it("returns empty report for unknown agent", () => {
    const report = buildAgentReport("unknown");
    expect(report.archetype).toBeNull();
    expect(report.definitions).toEqual([]);
    expect(report.summaries).toEqual([]);
    expect(report.dataPoints).toEqual([]);
    expect(report.sessionCount).toBe(0);
  });

  it("returns definitions even with no data points", () => {
    setupDevAgent();
    const report = buildAgentReport("dev");
    expect(report.definitions).toHaveLength(4);
    expect(report.summaries).toEqual([]);
    expect(report.dataPoints).toEqual([]);
  });
});

// ── buildMetricsSummary ─────────────────────────────────────────────────────

describe("buildMetricsSummary", () => {
  it("returns no-data message for unknown agent", () => {
    const summary = buildMetricsSummary("dev");
    expect(summary).toContain("No metrics recorded");
  });

  it("includes agent name and archetype", () => {
    setupDevAgent();
    recordMetric("dev", "s1", "completion", 0.9);
    const summary = buildMetricsSummary("dev");
    expect(summary).toContain("dev");
    expect(summary).toContain("ant");
  });

  it("includes metric averages", () => {
    setupDevAgent();
    recordMetric("dev", "s1", "completion", 0.8);
    recordMetric("dev", "s2", "completion", 0.9);
    const summary = buildMetricsSummary("dev");
    expect(summary).toContain("completion");
    expect(summary).toContain("avg=0.85");
  });

  it("includes session count", () => {
    setupDevAgent();
    recordMetric("dev", "s1", "m1", 1);
    recordMetric("dev", "s2", "m1", 2);
    const summary = buildMetricsSummary("dev");
    expect(summary).toContain("sessions: 2");
  });
});

// ── Full scenario ───────────────────────────────────────────────────────────

describe("full scenario", () => {
  it("ant-dev agent: record metrics across sessions and build report", () => {
    setupDevAgent();

    // Session 1: completed 4/5 tasks, read 12 files, blocker in 2 turns
    recordSessionMetrics("dev", "session-001", [
      { name: "Task completion rate", value: 0.80 },
      { name: "Investigation depth", value: 12 },
      { name: "Blocker identification speed", value: 2 },
      { name: "Scope discipline", value: 1.0 },
    ]);

    // Session 2: completed 5/5, read 8 files, no blockers, stayed in scope
    recordSessionMetrics("dev", "session-002", [
      { name: "Task completion rate", value: 1.0 },
      { name: "Investigation depth", value: 8 },
      { name: "Scope discipline", value: 1.0 },
    ]);

    // Session 3: completed 3/4, read 15 files, blocker in 5 turns
    recordSessionMetrics("dev", "session-003", [
      { name: "Task completion rate", value: 0.75 },
      { name: "Investigation depth", value: 15 },
      { name: "Blocker identification speed", value: 5 },
      { name: "Scope discipline", value: 0.8, metadata: { outOfScope: ["refactored utils"] } },
    ]);

    const report = buildAgentReport("dev");
    expect(report.sessionCount).toBe(3);
    expect(report.dataPoints).toHaveLength(11);
    expect(report.definitions).toHaveLength(4);

    // Check completion rate trend
    const completionSummary = report.summaries.find(s => s.metricName === "Task completion rate");
    expect(completionSummary).toBeDefined();
    expect(completionSummary!.count).toBe(3);
    expect(completionSummary!.average).toBeCloseTo(0.85, 2);
    expect(completionSummary!.min).toBe(0.75);
    expect(completionSummary!.max).toBe(1.0);

    // Check scope discipline
    const scopeSummary = report.summaries.find(s => s.metricName === "Scope discipline");
    expect(scopeSummary).toBeDefined();
    expect(scopeSummary!.count).toBe(3);
    expect(scopeSummary!.average).toBeCloseTo(0.933, 2);

    // Summary string
    const summaryText = buildMetricsSummary("dev");
    expect(summaryText).toContain("ant");
    expect(summaryText).toContain("sessions: 3");
  });

  it("multiple agents tracked independently", () => {
    setupDevAgent();
    _injectArchetypeForTesting({
      species: "owl",
      schema: {
        frontmatter: { species: "owl", cognitive_style: "breadth-first" as const },
        sections: [
          { heading: "Growth Metrics", content: "- **Research breadth** — topics explored per session" },
        ],
        body: "",
      },
      validation: { valid: true, errors: [] },
      filePath: "config/archetypes/owl.md",
      loadedAt: new Date().toISOString(),
    });
    registerBinding({ agentName: "research", archetype: "owl", role: "researcher" });

    recordMetric("dev", "s1", "completion", 0.9);
    recordMetric("research", "s2", "breadth", 5);

    expect(getAgentDataPoints("dev")).toHaveLength(1);
    expect(getAgentDataPoints("research")).toHaveLength(1);

    const devReport = buildAgentReport("dev");
    expect(devReport.archetype).toBe("ant");
    expect(devReport.definitions).toHaveLength(4);

    const researchReport = buildAgentReport("research");
    expect(researchReport.archetype).toBe("owl");
    expect(researchReport.definitions).toHaveLength(1);
    expect(researchReport.definitions[0].name).toBe("Research breadth");
  });
});

// ── _resetMetricsForTesting ─────────────────────────────────────────────────

describe("_resetMetricsForTesting", () => {
  it("clears all data points", () => {
    recordMetric("dev", "s1", "m1", 1);
    expect(getAgentDataPoints("dev")).toHaveLength(1);
    _resetMetricsForTesting();
    expect(getAgentDataPoints("dev")).toEqual([]);
  });
});
