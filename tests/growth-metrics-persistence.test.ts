/**
 * Tests for ELLIE-613: Growth metrics persistence to Forest
 *
 * Covers: buildSnapshot, importSnapshot, persistToForest, hydrateFromForest,
 * ensureHydrated, and buildAgentReport with hydration.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  recordMetric,
  recordSessionMetrics,
  buildSnapshot,
  importSnapshot,
  persistToForest,
  hydrateFromForest,
  ensureHydrated,
  buildAgentReport,
  buildMetricsSummary,
  getAgentDataPoints,
  _resetMetricsForTesting,
  type MetricsSnapshot,
  type MetricDataPoint,
} from "../src/growth-metrics-collector";

// ── Fetch mock ──────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; body: any; headers: any }> = [];
let fetchResponse: { ok: boolean; status: number; body: any } = { ok: true, status: 200, body: {} };

function mockFetch(resp: { ok?: boolean; status?: number; body?: any } = {}) {
  fetchResponse = {
    ok: resp.ok ?? true,
    status: resp.status ?? 200,
    body: resp.body ?? {},
  };
  fetchCalls = [];
  globalThis.fetch = ((url: string | URL | Request, options?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    const body = options?.body ? JSON.parse(options.body as string) : null;
    const headers = options?.headers;
    fetchCalls.push({ url: urlStr, body, headers });
    return Promise.resolve({
      ok: fetchResponse.ok,
      status: fetchResponse.status,
      json: () => Promise.resolve(fetchResponse.body),
      text: () => Promise.resolve(JSON.stringify(fetchResponse.body)),
    } as Response);
  }) as any;
}

function mockFetchFailure() {
  fetchCalls = [];
  globalThis.fetch = (() => Promise.reject(new Error("network error"))) as any;
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  _resetMetricsForTesting();
  fetchCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── buildSnapshot ───────────────────────────────────────────────────────────

describe("buildSnapshot", () => {
  it("returns empty snapshot when no data", () => {
    const snap = buildSnapshot();
    expect(snap.version).toBe(1);
    expect(snap.dataPoints).toHaveLength(0);
    expect(snap.exportedAt).toBeTruthy();
  });

  it("includes all recorded data points", () => {
    recordMetric("dev", "s1", "task_completion", 0.85);
    recordMetric("dev", "s1", "code_quality", 0.9);
    recordMetric("research", "s2", "depth_score", 0.7);

    const snap = buildSnapshot();
    expect(snap.version).toBe(1);
    expect(snap.dataPoints).toHaveLength(3);
    expect(snap.dataPoints[0].agentName).toBe("dev");
    expect(snap.dataPoints[2].agentName).toBe("research");
  });

  it("returns a copy — modifying snapshot doesn't affect internal state", () => {
    recordMetric("dev", "s1", "metric", 1);
    const snap = buildSnapshot();
    snap.dataPoints.push({ agentName: "fake", sessionId: "x", metricName: "y", value: 0, recordedAt: "" });
    expect(getAgentDataPoints("dev")).toHaveLength(1);
    expect(getAgentDataPoints("fake")).toHaveLength(0);
  });
});

// ── importSnapshot ──────────────────────────────────────────────────────────

describe("importSnapshot", () => {
  it("imports data points from a valid snapshot", () => {
    const snap: MetricsSnapshot = {
      version: 1,
      exportedAt: "2026-03-06T00:00:00Z",
      dataPoints: [
        { agentName: "dev", sessionId: "s1", metricName: "task_completion", value: 0.85, recordedAt: "2026-03-06T00:00:00Z" },
        { agentName: "dev", sessionId: "s1", metricName: "code_quality", value: 0.9, recordedAt: "2026-03-06T00:01:00Z" },
      ],
    };

    const added = importSnapshot(snap);
    expect(added).toBe(2);
    expect(getAgentDataPoints("dev")).toHaveLength(2);
  });

  it("deduplicates existing data points", () => {
    recordMetric("dev", "s1", "task_completion", 0.85);
    const existing = getAgentDataPoints("dev")[0];

    const snap: MetricsSnapshot = {
      version: 1,
      exportedAt: "2026-03-06T00:00:00Z",
      dataPoints: [
        { ...existing }, // exact duplicate
        { agentName: "dev", sessionId: "s2", metricName: "task_completion", value: 0.9, recordedAt: "2026-03-06T01:00:00Z" },
      ],
    };

    const added = importSnapshot(snap);
    expect(added).toBe(1); // only the new one
    expect(getAgentDataPoints("dev")).toHaveLength(2);
  });

  it("returns 0 for null/invalid snapshot", () => {
    expect(importSnapshot(null as any)).toBe(0);
    expect(importSnapshot({} as any)).toBe(0);
    expect(importSnapshot({ version: 1, exportedAt: "", dataPoints: null } as any)).toBe(0);
  });
});

// ── persistToForest ─────────────────────────────────────────────────────────

describe("persistToForest", () => {
  it("writes snapshot to Forest bridge API", async () => {
    recordMetric("dev", "s1", "task_completion", 0.85);
    mockFetch({ ok: true, status: 200, body: { success: true } });

    const result = await persistToForest();

    expect(result).toBe(true);
    const bridgeCalls = fetchCalls.filter(c => c.url.includes("bridge/write"));
    expect(bridgeCalls).toHaveLength(1);

    const call = bridgeCalls[0];
    expect(call.body.type).toBe("fact");
    expect(call.body.scope_path).toBe("2/1");
    expect(call.body.metadata.metrics_snapshot).toBe(true);

    const snapshot = JSON.parse(call.body.metadata.snapshot);
    expect(snapshot.version).toBe(1);
    expect(snapshot.dataPoints).toHaveLength(1);
    expect(snapshot.dataPoints[0].value).toBe(0.85);
  });

  it("returns true when no data to persist", async () => {
    mockFetch();
    const result = await persistToForest();
    expect(result).toBe(true);
    expect(fetchCalls).toHaveLength(0);
  });

  it("returns false on API failure", async () => {
    recordMetric("dev", "s1", "metric", 1);
    mockFetch({ ok: false, status: 500 });

    const result = await persistToForest();
    expect(result).toBe(false);
  });

  it("returns false on network error", async () => {
    recordMetric("dev", "s1", "metric", 1);
    mockFetchFailure();

    const result = await persistToForest();
    expect(result).toBe(false);
  });

  it("includes bridge key in headers", async () => {
    recordMetric("dev", "s1", "metric", 1);
    mockFetch();

    await persistToForest();

    const call = fetchCalls.find(c => c.url.includes("bridge/write"));
    expect(call).toBeTruthy();
    const headers = call!.headers as Record<string, string>;
    expect(headers["x-bridge-key"]).toBeTruthy();
  });
});

// ── hydrateFromForest ───────────────────────────────────────────────────────

describe("hydrateFromForest", () => {
  it("imports data points from Forest response", async () => {
    const snapshot: MetricsSnapshot = {
      version: 1,
      exportedAt: "2026-03-06T00:00:00Z",
      dataPoints: [
        { agentName: "dev", sessionId: "s1", metricName: "task_completion", value: 0.85, recordedAt: "2026-03-06T00:00:00Z" },
        { agentName: "research", sessionId: "s2", metricName: "depth", value: 0.7, recordedAt: "2026-03-06T01:00:00Z" },
      ],
    };

    mockFetch({
      ok: true,
      body: {
        success: true,
        memories: [{
          metadata: {
            metrics_snapshot: true,
            snapshot: JSON.stringify(snapshot),
          },
        }],
      },
    });

    const added = await hydrateFromForest();
    expect(added).toBe(2);
    expect(getAgentDataPoints("dev")).toHaveLength(1);
    expect(getAgentDataPoints("research")).toHaveLength(1);
  });

  it("returns 0 when Forest returns no memories", async () => {
    mockFetch({ ok: true, body: { success: true, memories: [] } });
    const added = await hydrateFromForest();
    expect(added).toBe(0);
  });

  it("returns 0 when no snapshot entry found", async () => {
    mockFetch({
      ok: true,
      body: {
        success: true,
        memories: [{ metadata: { some_other: true } }],
      },
    });
    const added = await hydrateFromForest();
    expect(added).toBe(0);
  });

  it("returns 0 on API failure", async () => {
    mockFetch({ ok: false, status: 500 });
    const added = await hydrateFromForest();
    expect(added).toBe(0);
  });

  it("returns 0 on network error", async () => {
    mockFetchFailure();
    const added = await hydrateFromForest();
    expect(added).toBe(0);
  });

  it("skips snapshots with wrong version", async () => {
    mockFetch({
      ok: true,
      body: {
        success: true,
        memories: [{
          metadata: {
            metrics_snapshot: true,
            snapshot: JSON.stringify({ version: 99, exportedAt: "", dataPoints: [{ agentName: "x", sessionId: "y", metricName: "z", value: 1, recordedAt: "" }] }),
          },
        }],
      },
    });
    const added = await hydrateFromForest();
    expect(added).toBe(0);
  });
});

// ── ensureHydrated ──────────────────────────────────────────────────────────

describe("ensureHydrated", () => {
  it("calls hydrateFromForest only once", async () => {
    mockFetch({ ok: true, body: { success: true, memories: [] } });

    await ensureHydrated();
    await ensureHydrated();
    await ensureHydrated();

    // Only 1 fetch call for the hydration read
    const bridgeCalls = fetchCalls.filter(c => c.url.includes("bridge/read"));
    expect(bridgeCalls).toHaveLength(1);
  });

  it("sets hydrated flag even on failure", async () => {
    mockFetchFailure();

    await ensureHydrated();
    // Should not throw, and subsequent calls should not re-fetch
    globalThis.fetch = originalFetch; // restore
    mockFetch({ ok: true, body: { success: true, memories: [] } });
    await ensureHydrated();

    // No additional calls after failure
    const bridgeCalls = fetchCalls.filter(c => c.url.includes("bridge/read"));
    expect(bridgeCalls).toHaveLength(0);
  });
});

// ── buildAgentReport with hydration ─────────────────────────────────────────

describe("buildAgentReport — with persistence", () => {
  it("returns report including hydrated historical data", async () => {
    const snapshot: MetricsSnapshot = {
      version: 1,
      exportedAt: "2026-03-05T00:00:00Z",
      dataPoints: [
        { agentName: "dev", sessionId: "old-session", metricName: "task_completion", value: 0.7, recordedAt: "2026-03-05T00:00:00Z" },
      ],
    };

    mockFetch({
      ok: true,
      body: {
        success: true,
        memories: [{
          metadata: { metrics_snapshot: true, snapshot: JSON.stringify(snapshot) },
        }],
      },
    });

    // Record a new metric in current session
    recordMetric("dev", "new-session", "task_completion", 0.9);

    const report = await buildAgentReport("dev");

    // Should have both historical and current data
    expect(report.dataPoints).toHaveLength(2);
    expect(report.sessionCount).toBe(2);

    const summary = report.summaries.find(s => s.metricName === "task_completion");
    expect(summary).toBeTruthy();
    expect(summary!.count).toBe(2);
    expect(summary!.average).toBe(0.8); // (0.7 + 0.9) / 2
    expect(summary!.min).toBe(0.7);
    expect(summary!.max).toBe(0.9);
  });

  it("works with no Forest data (graceful degradation)", async () => {
    mockFetchFailure();
    recordMetric("dev", "s1", "metric", 1);

    const report = await buildAgentReport("dev");
    expect(report.dataPoints).toHaveLength(1);
    expect(report.sessionCount).toBe(1);
  });
});

// ── buildMetricsSummary with hydration ───────────────────────────────────────

describe("buildMetricsSummary — with persistence", () => {
  it("includes historical data in summary string", async () => {
    mockFetch({ ok: true, body: { success: true, memories: [] } });
    recordMetric("dev", "s1", "task_completion", 0.85);

    const summary = await buildMetricsSummary("dev");
    expect(summary).toContain("task_completion");
    expect(summary).toContain("avg=0.85");
  });

  it("returns no-data message when empty", async () => {
    mockFetch({ ok: true, body: { success: true, memories: [] } });

    const summary = await buildMetricsSummary("dev");
    expect(summary).toContain("No metrics recorded");
  });
});

// ── Round-trip: persist then hydrate ────────────────────────────────────────

describe("round-trip persistence", () => {
  it("data survives persist → reset → hydrate cycle", async () => {
    // Record some metrics
    recordMetric("dev", "s1", "task_completion", 0.85);
    recordMetric("dev", "s1", "code_quality", 0.9);
    recordMetric("research", "s2", "depth_score", 0.7);

    // Capture what persistToForest would write
    const snapshot = buildSnapshot();

    // Simulate: reset (like a restart)
    _resetMetricsForTesting();
    expect(getAgentDataPoints("dev")).toHaveLength(0);

    // Simulate: hydrate from what was persisted
    mockFetch({
      ok: true,
      body: {
        success: true,
        memories: [{
          metadata: { metrics_snapshot: true, snapshot: JSON.stringify(snapshot) },
        }],
      },
    });

    const added = await hydrateFromForest();
    expect(added).toBe(3);
    expect(getAgentDataPoints("dev")).toHaveLength(2);
    expect(getAgentDataPoints("research")).toHaveLength(1);
  });
});
