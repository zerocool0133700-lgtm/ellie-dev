/**
 * ELLIE-526 — Benchmark Sprint Tests
 *
 * Tests the pure functions in the benchmark script: regression computation,
 * delta calculation, snapshot formatting, and checkpoint persistence.
 * Collectors that hit live DBs are not tested here (they're integration-level).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  computeRegressions,
  computeDelta,
  formatSnapshot,
  saveBenchmark,
  loadPrevious,
  type BenchmarkSnapshot,
  type CreatureMetrics,
  type DataFlowMetrics,
  type SystemMetrics,
  type EsMetrics,
} from "../scripts/benchmark-sprint.ts";

// ── Fixtures ────────────────────────────────────────────────

function makeCreatures(overrides?: Partial<CreatureMetrics>): CreatureMetrics {
  return {
    total: 700,
    completed: 690,
    active: 3,
    failed: 7,
    orphaned: 0,
    schemaVersion: "v025",
    speciesDistribution: { ant: 350, bee: 200, squirrel: 150 },
    ...overrides,
  };
}

function makeDataFlow(overrides?: Partial<DataFlowMetrics>): DataFlowMetrics {
  return {
    agentSessions: { total: 100, active: 2, completed: 95, completionRate: 95 },
    workSessions: { total: 50, active: 1, completed: 48, completionRate: 96 },
    orphanedWorkSessions: 0,
    stuckInProgress: 0,
    ...overrides,
  };
}

function makeSystem(overrides?: Partial<SystemMetrics>): SystemMetrics {
  return {
    testSuite: { total: 618, passed: 618, failed: 0, passRate: 100 },
    relayUptime: { activeMs: 7_200_000, restarts: 0, status: "active" },
    memoryPressure: { swapUsedMB: 26, rssKB: 512_000 },
    circuitBreakers: {
      plane: { state: "closed", failures: 0 },
      bridge: { state: "closed", failures: 0 },
      edgeFn: { state: "closed", failures: 0 },
    },
    ...overrides,
  };
}

function makeEs(overrides?: Partial<EsMetrics["reconciliation"]>): EsMetrics {
  return {
    reconciliation: {
      lastRunAt: Date.now() - 10 * 60_000,
      healthy: true,
      totalMissing: 0,
      indices: [
        { index: "messages", sourceCount: 5000, esCount: 5000, missingIds: 0 },
        { index: "creatures", sourceCount: 700, esCount: 700, missingIds: 0 },
      ],
      ...overrides,
    },
  };
}

function makeSnapshot(overrides?: Partial<BenchmarkSnapshot>): BenchmarkSnapshot {
  const creatures = makeCreatures();
  const dataFlow = makeDataFlow();
  const system = makeSystem();
  const es = makeEs();
  return {
    timestamp: Date.now(),
    isoTime: new Date().toISOString(),
    creatures,
    dataFlow,
    system,
    elasticsearch: es,
    regressions: computeRegressions(creatures, dataFlow, system, es),
    ...overrides,
  };
}

// ── computeRegressions ──────────────────────────────────────

describe("computeRegressions", () => {
  test("returns no flags when everything is healthy", () => {
    const r = computeRegressions(makeCreatures(), makeDataFlow(), makeSystem(), makeEs());
    expect(r.flags).toHaveLength(0);
    expect(r.orphanedWorkSessions).toBe(false);
    expect(r.stuckTickets).toBe(false);
    expect(r.circuitBreakersOpen).toBe(false);
    expect(r.esUnhealthy).toBe(false);
    expect(r.testFailures).toBe(false);
  });

  test("flags orphaned work sessions", () => {
    const r = computeRegressions(
      makeCreatures(),
      makeDataFlow({ orphanedWorkSessions: 2 }),
      makeSystem(),
      makeEs(),
    );
    expect(r.orphanedWorkSessions).toBe(true);
    expect(r.flags).toContain("2 orphaned work session(s)");
  });

  test("flags stuck tickets", () => {
    const r = computeRegressions(
      makeCreatures(),
      makeDataFlow({ stuckInProgress: 3 }),
      makeSystem(),
      makeEs(),
    );
    expect(r.stuckTickets).toBe(true);
    expect(r.flags.some(f => f.includes("stuck in progress"))).toBe(true);
  });

  test("flags open circuit breakers", () => {
    const r = computeRegressions(
      makeCreatures(),
      makeDataFlow(),
      makeSystem({
        circuitBreakers: {
          plane: { state: "open", failures: 3 },
          bridge: { state: "closed", failures: 0 },
        },
      }),
      makeEs(),
    );
    expect(r.circuitBreakersOpen).toBe(true);
    expect(r.flags.some(f => f.includes("plane"))).toBe(true);
  });

  test("flags ES unhealthy", () => {
    const r = computeRegressions(
      makeCreatures(),
      makeDataFlow(),
      makeSystem(),
      makeEs({ healthy: false, totalMissing: 42 }),
    );
    expect(r.esUnhealthy).toBe(true);
    expect(r.flags.some(f => f.includes("42 missing"))).toBe(true);
  });

  test("flags test failures", () => {
    const r = computeRegressions(
      makeCreatures(),
      makeDataFlow(),
      makeSystem({ testSuite: { total: 618, passed: 615, failed: 3, passRate: 99 } }),
      makeEs(),
    );
    expect(r.testFailures).toBe(true);
    expect(r.flags.some(f => f.includes("3 test(s) failing"))).toBe(true);
  });

  test("flags orphaned creatures", () => {
    const r = computeRegressions(
      makeCreatures({ orphaned: 5 }),
      makeDataFlow(),
      makeSystem(),
      makeEs(),
    );
    expect(r.flags.some(f => f.includes("5 orphaned creature"))).toBe(true);
  });

  test("reports multiple flags simultaneously", () => {
    const r = computeRegressions(
      makeCreatures({ orphaned: 1 }),
      makeDataFlow({ orphanedWorkSessions: 1, stuckInProgress: 2 }),
      makeSystem({ testSuite: { total: 100, passed: 98, failed: 2, passRate: 98 } }),
      makeEs({ healthy: false, totalMissing: 10 }),
    );
    expect(r.flags.length).toBeGreaterThanOrEqual(4);
  });
});

// ── computeDelta ────────────────────────────────────────────

describe("computeDelta", () => {
  test("computes deltas between two snapshots", () => {
    const prev = makeSnapshot();
    const current = makeSnapshot({
      creatures: makeCreatures({ total: 710, completed: 700 }),
      system: { ...makeSystem(), testSuite: { total: 630, passed: 630, failed: 0, passRate: 100 } },
    });

    const d = computeDelta(current, prev);
    expect(d.creatures.total).toBe("+10");
    expect(d.creatures.completed).toBe("+10");
    expect(d.system.testsPassed).toBe("+12");
  });

  test("shows no change when values are equal", () => {
    const snap = makeSnapshot();
    const d = computeDelta(snap, snap);
    expect(d.creatures.total).toBe("no change");
    expect(d.creatures.orphaned).toBe("no change");
  });

  test("shows negative deltas", () => {
    const prev = makeSnapshot({
      dataFlow: makeDataFlow({
        agentSessions: { total: 100, active: 2, completed: 95, completionRate: 95 },
      }),
    });
    const current = makeSnapshot({
      dataFlow: makeDataFlow({
        agentSessions: { total: 110, active: 5, completed: 95, completionRate: 86 },
      }),
    });

    const d = computeDelta(current, prev);
    expect(d.dataFlow.agentCompletionRate).toBe("-9");
  });

  test("returns N/A when previous was skipped (-1)", () => {
    const prev = makeSnapshot({
      creatures: makeCreatures({ total: -1 }),
    });
    const current = makeSnapshot();
    const d = computeDelta(current, prev);
    expect(d.creatures.total).toBe("N/A");
  });
});

// ── formatSnapshot ──────────────────────────────────────────

describe("formatSnapshot", () => {
  test("produces readable output for healthy snapshot", () => {
    const snap = makeSnapshot();
    const output = formatSnapshot(snap, null);

    expect(output).toContain("Hardening Sprint Checkpoint");
    expect(output).toContain("PASS");
    expect(output).toContain("Creature Ecosystem");
    expect(output).toContain("Data Flow");
    expect(output).toContain("System Stability");
    expect(output).toContain("Elasticsearch");
    expect(output).toContain("Regression Flags");
    expect(output).toContain("None detected");
  });

  test("shows FAIL for test failures", () => {
    const snap = makeSnapshot({
      system: makeSystem({ testSuite: { total: 618, passed: 610, failed: 8, passRate: 98 } }),
    });
    snap.regressions = computeRegressions(snap.creatures, snap.dataFlow, snap.system, snap.elasticsearch);
    const output = formatSnapshot(snap, null);

    expect(output).toContain("FAIL");
    expect(output).toContain("8");
  });

  test("shows WARN for orphaned creatures", () => {
    const snap = makeSnapshot({
      creatures: makeCreatures({ orphaned: 2 }),
    });
    snap.regressions = computeRegressions(snap.creatures, snap.dataFlow, snap.system, snap.elasticsearch);
    const output = formatSnapshot(snap, null);

    expect(output).toContain("WARN");
    expect(output).toContain("TARGET MISSED");
  });

  test("includes delta when previous is provided", () => {
    const prev = makeSnapshot();
    const current = makeSnapshot({
      creatures: makeCreatures({ total: 710 }),
      system: makeSystem({ testSuite: { total: 630, passed: 630, failed: 0, passRate: 100 } }),
    });
    current.regressions = computeRegressions(current.creatures, current.dataFlow, current.system, current.elasticsearch);
    const output = formatSnapshot(current, prev);

    expect(output).toContain("Delta from Last Checkpoint");
    expect(output).toContain("+10");
    expect(output).toContain("+12");
  });

  test("shows species distribution", () => {
    const snap = makeSnapshot();
    const output = formatSnapshot(snap, null);
    expect(output).toContain("ant:350");
    expect(output).toContain("bee:200");
  });

  test("shows circuit breaker status", () => {
    const snap = makeSnapshot();
    const output = formatSnapshot(snap, null);
    expect(output).toContain("plane:closed");
  });

  test("shows SKIP for skipped sections", () => {
    const snap = makeSnapshot({
      creatures: { total: -1, completed: -1, active: -1, failed: -1, orphaned: -1, schemaVersion: null, speciesDistribution: {} },
    });
    snap.regressions = computeRegressions(snap.creatures, snap.dataFlow, snap.system, snap.elasticsearch);
    const output = formatSnapshot(snap, null);
    expect(output).toContain("SKIP");
  });
});

// ── Checkpoint persistence ──────────────────────────────────

describe("saveBenchmark / loadPrevious", () => {
  const testDir = join(import.meta.dir, ".benchmark-test-tmp");
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    // Override checkpoint dir via env
    process.env.HOME = testDir;
    await mkdir(join(testDir, ".claude-relay", "benchmarks"), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(testDir, { recursive: true, force: true });
  });

  test("saves and loads a benchmark snapshot", async () => {
    const snap = makeSnapshot();
    const filepath = await saveBenchmark(snap);

    expect(filepath).toContain("benchmark-");
    expect(filepath).toContain(".json");

    const loaded = await loadPrevious();
    expect(loaded).not.toBeNull();
    expect(loaded!.timestamp).toBe(snap.timestamp);
    expect(loaded!.creatures.total).toBe(snap.creatures.total);
    expect(loaded!.regressions.flags).toEqual(snap.regressions.flags);
  });

  test("loadPrevious returns null when no checkpoint exists", async () => {
    // Remove the benchmarks dir so there's no latest.json
    await rm(join(testDir, ".claude-relay", "benchmarks"), { recursive: true, force: true });
    const loaded = await loadPrevious();
    expect(loaded).toBeNull();
  });

  test("saves timestamped file alongside latest.json", async () => {
    const snap = makeSnapshot();
    const filepath = await saveBenchmark(snap);

    // Both files should exist
    const latestPath = join(testDir, ".claude-relay", "benchmarks", "latest.json");
    const latestRaw = await readFile(latestPath, "utf-8");
    const savedRaw = await readFile(filepath, "utf-8");

    expect(JSON.parse(latestRaw).timestamp).toBe(snap.timestamp);
    expect(JSON.parse(savedRaw).timestamp).toBe(snap.timestamp);
  });

  test("overwrites latest.json on second save", async () => {
    const snap1 = makeSnapshot();
    await saveBenchmark(snap1);

    const snap2 = makeSnapshot({ timestamp: snap1.timestamp + 60_000 });
    await saveBenchmark(snap2);

    const loaded = await loadPrevious();
    expect(loaded!.timestamp).toBe(snap2.timestamp);
  });
});
