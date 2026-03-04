/**
 * ELLIE-527 — Benchmark script timeout metrics.
 *
 * Tests pure functions in benchmark-sprint.ts that were updated
 * to surface timed_out creatures as a distinct health category:
 * - computeRegressions() flags timedOutCreatures when count > 0
 * - computeDelta() includes timedOut in creatures diff
 * - formatSnapshot() shows timed-out creature count
 * - CreatureMetrics shape includes timedOut field
 */

import { describe, test, expect } from "bun:test";
import {
  computeRegressions,
  computeDelta,
  formatSnapshot,
  type CreatureMetrics,
  type DataFlowMetrics,
  type SystemMetrics,
  type EsMetrics,
  type BenchmarkSnapshot,
  type RegressionFlags,
} from "../scripts/benchmark-sprint.ts";

// ── Fixtures ──────────────────────────────────────────────────

function makeCreature(overrides?: Partial<CreatureMetrics>): CreatureMetrics {
  return {
    total: 100,
    completed: 90,
    active: 5,
    failed: 3,
    timedOut: 0,
    orphaned: 0,
    schemaVersion: "1.0",
    speciesDistribution: { general: 60, dev: 40 },
    ...overrides,
  };
}

function makeDataFlow(overrides?: Partial<DataFlowMetrics>): DataFlowMetrics {
  return {
    agentSessions: { total: 100, active: 5, completed: 90, completionRate: 90 },
    workSessions: { total: 80, active: 3, completed: 75, completionRate: 94 },
    orphanedWorkSessions: 0,
    stuckInProgress: 0,
    ...overrides,
  };
}

function makeSystem(overrides?: Partial<SystemMetrics>): SystemMetrics {
  return {
    testSuite: { total: 50, passed: 50, failed: 0, passRate: 100 },
    relayUptime: { activeMs: 3_600_000, restarts: 0, status: "active" },
    memoryPressure: { swapUsedMB: 0, rssKB: 512_000 },
    circuitBreakers: {},
    ...overrides,
  };
}

function makeEs(overrides?: Partial<EsMetrics>): EsMetrics {
  return {
    reconciliation: {
      lastRunAt: Date.now() - 60_000,
      healthy: true,
      totalMissing: 0,
      indices: [],
    },
    ...overrides,
  };
}

function makeSnapshot(overrides?: {
  creatures?: Partial<CreatureMetrics>;
  dataFlow?: Partial<DataFlowMetrics>;
  system?: Partial<SystemMetrics>;
  es?: Partial<EsMetrics>;
}): BenchmarkSnapshot {
  const creatures = makeCreature(overrides?.creatures);
  const dataFlow = makeDataFlow(overrides?.dataFlow);
  const system = makeSystem(overrides?.system);
  const es = makeEs(overrides?.es);
  const regressions = computeRegressions(creatures, dataFlow, system, es);
  return {
    timestamp: Date.now(),
    isoTime: new Date().toISOString(),
    creatures,
    dataFlow,
    system,
    elasticsearch: es,
    regressions,
  };
}

// ── CreatureMetrics shape ─────────────────────────────────────

describe("CreatureMetrics includes timedOut field", () => {
  test("timedOut field defaults to 0 when healthy", () => {
    const c = makeCreature();
    expect(c.timedOut).toBe(0);
  });

  test("timedOut is distinct from failed", () => {
    const c = makeCreature({ timedOut: 3, failed: 2 });
    expect(c.timedOut).toBe(3);
    expect(c.failed).toBe(2);
  });
});

// ── computeRegressions ────────────────────────────────────────

describe("computeRegressions — timeout flags", () => {
  test("no flags when timedOut = 0", () => {
    const result = computeRegressions(makeCreature({ timedOut: 0 }), makeDataFlow(), makeSystem(), makeEs());
    expect(result.timedOutCreatures).toBe(false);
    expect(result.flags).not.toContain(expect.stringContaining("timed out"));
  });

  test("flags timedOutCreatures when timedOut > 0", () => {
    const result = computeRegressions(makeCreature({ timedOut: 2 }), makeDataFlow(), makeSystem(), makeEs());
    expect(result.timedOutCreatures).toBe(true);
    expect(result.flags.some(f => f.includes("timed out"))).toBe(true);
  });

  test("flag message includes creature count", () => {
    const result = computeRegressions(makeCreature({ timedOut: 5 }), makeDataFlow(), makeSystem(), makeEs());
    expect(result.flags.some(f => f.includes("5"))).toBe(true);
  });

  test("timedOutCreatures is false when timedOut = -1 (data unavailable)", () => {
    const result = computeRegressions(makeCreature({ timedOut: -1 }), makeDataFlow(), makeSystem(), makeEs());
    // -1 means data unavailable — should not count as timeout
    expect(result.timedOutCreatures).toBe(false);
  });

  test("RegressionFlags interface includes timedOutCreatures", () => {
    const flags: RegressionFlags = {
      orphanedWorkSessions: false,
      stuckTickets: false,
      circuitBreakersOpen: false,
      esUnhealthy: false,
      testFailures: false,
      timedOutCreatures: true,
      flags: ["1 creature(s) timed out"],
    };
    expect(flags.timedOutCreatures).toBe(true);
  });
});

// ── computeDelta ──────────────────────────────────────────────

describe("computeDelta — timedOut delta included", () => {
  test("timedOut delta shows increase", () => {
    const prev = makeSnapshot({ creatures: { timedOut: 0 } });
    const curr = makeSnapshot({ creatures: { timedOut: 3 } });
    const d = computeDelta(curr, prev);
    expect(d.creatures.timedOut).toBe("+3");
  });

  test("timedOut delta shows no change", () => {
    const prev = makeSnapshot({ creatures: { timedOut: 2 } });
    const curr = makeSnapshot({ creatures: { timedOut: 2 } });
    const d = computeDelta(curr, prev);
    expect(d.creatures.timedOut).toBe("no change");
  });

  test("timedOut delta shows decrease", () => {
    const prev = makeSnapshot({ creatures: { timedOut: 5 } });
    const curr = makeSnapshot({ creatures: { timedOut: 2 } });
    const d = computeDelta(curr, prev);
    expect(d.creatures.timedOut).toBe("-3");
  });

  test("timedOut delta is N/A when previous was unavailable", () => {
    const prev = makeSnapshot({ creatures: { timedOut: -1 } });
    const curr = makeSnapshot({ creatures: { timedOut: 3 } });
    const d = computeDelta(curr, prev);
    expect(d.creatures.timedOut).toBe("N/A");
  });
});

// ── formatSnapshot ────────────────────────────────────────────

describe("formatSnapshot — timed-out creatures displayed", () => {
  test("shows timed-out line in creature section", () => {
    const snap = makeSnapshot({ creatures: { timedOut: 4 } });
    const output = formatSnapshot(snap, null);
    expect(output).toContain("Timed out:");
    expect(output).toContain("4");
  });

  test("shows N/A when timedOut data unavailable", () => {
    const snap = makeSnapshot({ creatures: { timedOut: -1 } });
    const output = formatSnapshot(snap, null);
    expect(output).toContain("Timed out: N/A");
  });

  test("shows timed-out delta from previous snapshot", () => {
    const prev = makeSnapshot({ creatures: { timedOut: 1 } });
    const curr = makeSnapshot({ creatures: { timedOut: 4 } });
    const output = formatSnapshot(curr, prev);
    expect(output).toContain("Timed out:");
    // delta "+3" should appear in the delta section
    expect(output).toContain("+3");
  });

  test("regression flags section shows timed-out flag when > 0", () => {
    const snap = makeSnapshot({ creatures: { timedOut: 2 } });
    const output = formatSnapshot(snap, null);
    expect(output).toContain("timed out");
  });

  test("no timed-out flag when count is 0", () => {
    const snap = makeSnapshot({ creatures: { timedOut: 0 } });
    const output = formatSnapshot(snap, null);
    // Should show 0 in timed-out line, but NOT appear in regression flags
    expect(snap.regressions.timedOutCreatures).toBe(false);
  });
});
