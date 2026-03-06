/**
 * Tests for Agent Compliance API — ELLIE-624
 *
 * Covers: agentComplianceEndpoint() — per-agent archetype compliance overview
 * with identity bindings and growth metric summaries.
 */

import { describe, it, expect, beforeEach } from "bun:test";

import {
  agentComplianceEndpoint,
  type ComplianceResponse,
} from "../src/api/agent-compliance";

import type { ApiRequest, ApiResponse } from "../src/api/types";

import {
  _resetBindingsForTesting,
  registerBinding,
  loadDefaultBindings,
} from "../src/agent-identity-binding";

import {
  _resetMetricsForTesting,
  _markHydratedForTesting,
  recordMetric,
} from "../src/growth-metrics-collector";

import {
  METRIC_TASK_COMPLETION,
  METRIC_BLOCKER_SPEED,
  METRIC_COMMIT_QUALITY,
} from "../src/session-metric-hooks";

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockReqRes(): { req: ApiRequest; res: ApiResponse; result: () => ComplianceResponse } {
  let captured: ComplianceResponse | null = null;
  const res: ApiResponse = {
    json: (data: unknown) => { captured = data as ComplianceResponse; },
    status: (code: number) => ({
      json: (data: unknown) => { captured = { ...data as ComplianceResponse, _statusCode: code } as any; },
    }),
  };
  return {
    req: {},
    res,
    result: () => captured!,
  };
}

/** Find a summary by metric name in the summaries array. */
function findSummary(summaries: Array<{ metricName: string; [k: string]: unknown }>, name: string) {
  return summaries.find(s => s.metricName === name);
}

beforeEach(() => {
  _resetBindingsForTesting();
  _resetMetricsForTesting();
  _markHydratedForTesting(); // Skip Forest hydration in tests
});

// ── agentComplianceEndpoint ──────────────────────────────────────────────────

describe("agentComplianceEndpoint", () => {
  it("returns default bindings when no runtime bindings registered", async () => {
    const { req, res, result } = mockReqRes();
    await agentComplianceEndpoint(req, res);

    const data = result();
    expect(data.success).toBe(true);
    expect(data.bindingsSource).toBe("defaults");
    expect(data.agents.length).toBe(8); // 8 default bindings
  });

  it("returns runtime bindings when registered", async () => {
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    registerBinding({ agentName: "research", archetype: "owl", role: "researcher" });

    const { req, res, result } = mockReqRes();
    await agentComplianceEndpoint(req, res);

    const data = result();
    expect(data.success).toBe(true);
    expect(data.bindingsSource).toBe("runtime");
    expect(data.agents.length).toBe(2);
  });

  it("includes archetype and role per agent", async () => {
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const { req, res, result } = mockReqRes();
    await agentComplianceEndpoint(req, res);

    const agent = result().agents[0];
    expect(agent.agentName).toBe("dev");
    expect(agent.archetype).toBe("ant");
    expect(agent.role).toBe("dev");
  });

  it("returns empty metrics when no data recorded", async () => {
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const { req, res, result } = mockReqRes();
    await agentComplianceEndpoint(req, res);

    const agent = result().agents[0];
    expect(agent.metrics).not.toBeNull();
    expect(agent.metrics!.dataPoints).toHaveLength(0);
    expect(agent.metrics!.summaries).toHaveLength(0);
    expect(agent.metrics!.sessionCount).toBe(0);
  });

  it("includes metric data when metrics are recorded", async () => {
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    recordMetric("dev", "session-1", METRIC_TASK_COMPLETION, 1);
    recordMetric("dev", "session-1", METRIC_COMMIT_QUALITY, 0.8);
    recordMetric("dev", "session-2", METRIC_TASK_COMPLETION, 1);

    const { req, res, result } = mockReqRes();
    await agentComplianceEndpoint(req, res);

    const agent = result().agents[0];
    expect(agent.metrics).not.toBeNull();
    expect(agent.metrics!.dataPoints.length).toBe(3);

    // summaries is an array — find by metricName
    const taskSummary = findSummary(agent.metrics!.summaries, METRIC_TASK_COMPLETION);
    const commitSummary = findSummary(agent.metrics!.summaries, METRIC_COMMIT_QUALITY);
    expect(taskSummary).toBeDefined();
    expect(commitSummary).toBeDefined();
  });

  it("returns correct metric summary values", async () => {
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    recordMetric("dev", "session-1", METRIC_TASK_COMPLETION, 1);
    recordMetric("dev", "session-2", METRIC_TASK_COMPLETION, 0);
    recordMetric("dev", "session-3", METRIC_TASK_COMPLETION, 1);

    const { req, res, result } = mockReqRes();
    await agentComplianceEndpoint(req, res);

    const summary = findSummary(result().agents[0].metrics!.summaries, METRIC_TASK_COMPLETION)!;
    expect(summary.count).toBe(3);
    expect(summary.average).toBeCloseTo(0.667, 1);
    expect(summary.min).toBe(0);
    expect(summary.max).toBe(1);
  });

  it("handles multiple agents independently", async () => {
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    registerBinding({ agentName: "research", archetype: "owl", role: "researcher" });

    recordMetric("dev", "s1", METRIC_TASK_COMPLETION, 1);
    recordMetric("research", "s2", METRIC_TASK_COMPLETION, 0);

    const { req, res, result } = mockReqRes();
    await agentComplianceEndpoint(req, res);

    const agents = result().agents;
    const dev = agents.find(a => a.agentName === "dev")!;
    const research = agents.find(a => a.agentName === "research")!;

    const devSummary = findSummary(dev.metrics!.summaries, METRIC_TASK_COMPLETION)!;
    const resSummary = findSummary(research.metrics!.summaries, METRIC_TASK_COMPLETION)!;
    expect(devSummary.average).toBe(1);
    expect(resSummary.average).toBe(0);
  });

  it("truncates dataPoints to last 50 for large datasets", async () => {
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    for (let i = 0; i < 60; i++) {
      recordMetric("dev", `session-${i}`, METRIC_TASK_COMPLETION, i % 2);
    }

    const { req, res, result } = mockReqRes();
    await agentComplianceEndpoint(req, res);

    const agent = result().agents[0];
    expect(agent.metrics!.dataPoints.length).toBeLessThanOrEqual(50);
  });

  it("uses all default bindings with expected agents", async () => {
    loadDefaultBindings();

    const { req, res, result } = mockReqRes();
    await agentComplianceEndpoint(req, res);

    const agentNames = result().agents.map(a => a.agentName).sort();
    expect(agentNames).toContain("dev");
    expect(agentNames).toContain("general");
    expect(agentNames).toContain("research");
    expect(agentNames).toContain("strategy");
    expect(agentNames).toContain("critic");
    expect(agentNames).toContain("content");
    expect(agentNames).toContain("finance");
    expect(agentNames).toContain("ops");
    expect(result().bindingsSource).toBe("runtime");
  });

  it("includes blocker speed metrics with correct values", async () => {
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    recordMetric("dev", "s1", METRIC_BLOCKER_SPEED, 300);
    recordMetric("dev", "s2", METRIC_BLOCKER_SPEED, 600);

    const { req, res, result } = mockReqRes();
    await agentComplianceEndpoint(req, res);

    const summary = findSummary(result().agents[0].metrics!.summaries, METRIC_BLOCKER_SPEED)!;
    expect(summary.count).toBe(2);
    expect(summary.average).toBe(450);
    expect(summary.min).toBe(300);
    expect(summary.max).toBe(600);
  });

  it("reports session count correctly", async () => {
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    recordMetric("dev", "s1", METRIC_TASK_COMPLETION, 1);
    recordMetric("dev", "s1", METRIC_COMMIT_QUALITY, 0.8);
    recordMetric("dev", "s2", METRIC_TASK_COMPLETION, 0);

    const { req, res, result } = mockReqRes();
    await agentComplianceEndpoint(req, res);

    expect(result().agents[0].metrics!.sessionCount).toBe(2);
  });
});
