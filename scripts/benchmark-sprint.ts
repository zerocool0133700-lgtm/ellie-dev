/**
 * Hardening Sprint Benchmark — ELLIE-526
 *
 * Snapshots system health at milestone checkpoints during hardening sprints.
 * Catches regressions before they compound when touching orchestration,
 * dispatch, checkpoints, and synthesis code.
 *
 * Usage:
 *   bun run benchmark                    # full snapshot + delta from last
 *   bun run benchmark --json             # machine-readable output
 *   bun run benchmark --section creature # run only one section
 */

import "dotenv/config";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";

// ── Types ───────────────────────────────────────────────────

export interface CreatureMetrics {
  total: number;
  completed: number;
  active: number;
  failed: number;
  orphaned: number;
  schemaVersion: string | null;
  speciesDistribution: Record<string, number>;
}

export interface DataFlowMetrics {
  agentSessions: { total: number; active: number; completed: number; completionRate: number };
  workSessions: { total: number; active: number; completed: number; completionRate: number };
  orphanedWorkSessions: number;
  stuckInProgress: number;
}

export interface SystemMetrics {
  testSuite: { total: number; passed: number; failed: number; passRate: number };
  relayUptime: { activeMs: number; restarts: number; status: string };
  memoryPressure: { swapUsedMB: number; rssKB: number };
  circuitBreakers: Record<string, { state: string; failures: number }>;
}

export interface EsMetrics {
  reconciliation: {
    lastRunAt: number | null;
    healthy: boolean;
    totalMissing: number;
    indices: Array<{ index: string; sourceCount: number; esCount: number; missingIds: number }>;
  };
}

export interface RegressionFlags {
  orphanedWorkSessions: boolean;
  stuckTickets: boolean;
  circuitBreakersOpen: boolean;
  esUnhealthy: boolean;
  testFailures: boolean;
  flags: string[];
}

export interface BenchmarkSnapshot {
  timestamp: number;
  isoTime: string;
  creatures: CreatureMetrics;
  dataFlow: DataFlowMetrics;
  system: SystemMetrics;
  elasticsearch: EsMetrics;
  regressions: RegressionFlags;
}

export interface BenchmarkDelta {
  creatures: Record<string, string>;
  dataFlow: Record<string, string>;
  system: Record<string, string>;
  elasticsearch: Record<string, string>;
}

// ── Config ──────────────────────────────────────────────────

function getCheckpointDir(): string {
  return join(process.env.HOME ?? "~", ".claude-relay", "benchmarks");
}
function getLatestPath(): string {
  return join(getCheckpointDir(), "latest.json");
}

// ── Collectors ──────────────────────────────────────────────

export async function collectCreatureMetrics(): Promise<CreatureMetrics> {
  const sql = (await import("../../ellie-forest/src/db")).default;

  try {
    const [counts] = await sql<[{ total: string; completed: string; active: string; failed: string }]>`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE state = 'completed')::text AS completed,
        COUNT(*) FILTER (WHERE state IN ('dispatched', 'working'))::text AS active,
        COUNT(*) FILTER (WHERE state IN ('failed', 'preempted'))::text AS failed
      FROM creatures
    `;

    // Orphaned = active creatures whose agent session is gone (> 2 min old)
    const [orphanCount] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count
      FROM creatures
      WHERE state IN ('dispatched', 'working')
        AND created_at < NOW() - INTERVAL '2 minutes'
        AND NOT EXISTS (
          SELECT 1 FROM branches b
          WHERE b.id = creatures.branch_id
          AND EXISTS (
            SELECT 1 FROM trunks t WHERE t.tree_id = b.tree_id
          )
        )
    `;

    const schemaRows = await sql<{ version: string }[]>`
      SELECT value AS version FROM tree_metadata
      WHERE key = 'creature_schema_version'
      ORDER BY created_at DESC LIMIT 1
    `;

    const speciesRows = await sql<{ species: string; count: string }[]>`
      SELECT
        COALESCE(agent_species, 'unassigned') AS species,
        COUNT(*)::text AS count
      FROM creatures
      GROUP BY agent_species
      ORDER BY count DESC
    `;

    const distribution: Record<string, number> = {};
    for (const row of speciesRows) {
      distribution[row.species] = parseInt(row.count);
    }

    return {
      total: parseInt(counts.total),
      completed: parseInt(counts.completed),
      active: parseInt(counts.active),
      failed: parseInt(counts.failed),
      orphaned: parseInt(orphanCount.count),
      schemaVersion: schemaRows[0]?.version ?? null,
      speciesDistribution: distribution,
    };
  } catch (err) {
    console.error("[benchmark] Forest DB query failed:", (err as Error).message);
    return {
      total: -1, completed: -1, active: -1, failed: -1, orphaned: -1,
      schemaVersion: null, speciesDistribution: {},
    };
  }
}

export async function collectDataFlowMetrics(): Promise<DataFlowMetrics> {
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    console.error("[benchmark] SUPABASE_URL or SUPABASE_ANON_KEY not set");
    return {
      agentSessions: { total: 0, active: 0, completed: 0, completionRate: 0 },
      workSessions: { total: 0, active: 0, completed: 0, completionRate: 0 },
      orphanedWorkSessions: 0,
      stuckInProgress: 0,
    };
  }

  const supabase = createClient(url, key);

  // Agent sessions
  const { count: agentTotal } = await supabase.from("agent_sessions").select("*", { count: "exact", head: true });
  const { count: agentActive } = await supabase.from("agent_sessions").select("*", { count: "exact", head: true }).eq("state", "active");
  const { count: agentCompleted } = await supabase.from("agent_sessions").select("*", { count: "exact", head: true }).eq("state", "completed");

  const aTotal = agentTotal ?? 0;
  const aActive = agentActive ?? 0;
  const aCompleted = agentCompleted ?? 0;

  // Work sessions
  const { count: wsTotal } = await supabase.from("work_sessions").select("*", { count: "exact", head: true });
  const { count: wsActive } = await supabase.from("work_sessions").select("*", { count: "exact", head: true }).eq("status", "active");
  const { count: wsCompleted } = await supabase.from("work_sessions").select("*", { count: "exact", head: true }).eq("status", "completed");

  const wTotal = wsTotal ?? 0;
  const wActive = wsActive ?? 0;
  const wCompleted = wsCompleted ?? 0;

  // Orphaned work sessions: active but no corresponding agent session
  const { data: activeWs } = await supabase
    .from("work_sessions")
    .select("id, work_item_id, started_at")
    .eq("status", "active");

  const { data: activeAs } = await supabase
    .from("agent_sessions")
    .select("work_item_id")
    .eq("state", "active");

  const activeWorkItems = new Set((activeAs ?? []).map(a => a.work_item_id));
  const orphaned = (activeWs ?? []).filter(ws => !activeWorkItems.has(ws.work_item_id));

  // Stuck in progress: work sessions active for > 24h
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const { count: stuckCount } = await supabase
    .from("work_sessions")
    .select("*", { count: "exact", head: true })
    .eq("status", "active")
    .lt("started_at", oneDayAgo);

  return {
    agentSessions: {
      total: aTotal,
      active: aActive,
      completed: aCompleted,
      completionRate: aTotal > 0 ? Math.round((aCompleted / aTotal) * 100) : 100,
    },
    workSessions: {
      total: wTotal,
      active: wActive,
      completed: wCompleted,
      completionRate: wTotal > 0 ? Math.round((wCompleted / wTotal) * 100) : 100,
    },
    orphanedWorkSessions: orphaned.length,
    stuckInProgress: stuckCount ?? 0,
  };
}

export async function collectSystemMetrics(): Promise<SystemMetrics> {
  // Test suite
  let testTotal = 0, testPassed = 0, testFailed = 0;
  try {
    const output = execSync("bun test 2>&1", {
      cwd: join(import.meta.dir, ".."),
      timeout: 120_000,
      encoding: "utf-8",
    });
    const passMatch = output.match(/(\d+) pass/);
    const failMatch = output.match(/(\d+) fail/);
    testPassed = passMatch ? parseInt(passMatch[1]) : 0;
    testFailed = failMatch ? parseInt(failMatch[1]) : 0;
    testTotal = testPassed + testFailed;
  } catch (err: any) {
    // bun test exits non-zero on failures — still parse
    const output = err.stdout || err.stderr || "";
    const passMatch = output.match(/(\d+) pass/);
    const failMatch = output.match(/(\d+) fail/);
    testPassed = passMatch ? parseInt(passMatch[1]) : 0;
    testFailed = failMatch ? parseInt(failMatch[1]) : 0;
    testTotal = testPassed + testFailed;
  }

  // Relay uptime
  let relayUptime = { activeMs: 0, restarts: 0, status: "unknown" };
  try {
    const statusOutput = execSync(
      "systemctl --user show -p ActiveEnterTimestamp -p NRestarts -p ActiveState claude-telegram-relay 2>/dev/null",
      { encoding: "utf-8", timeout: 5000 }
    );
    const activeMatch = statusOutput.match(/ActiveEnterTimestamp=(.+)/);
    const restartMatch = statusOutput.match(/NRestarts=(\d+)/);
    const stateMatch = statusOutput.match(/ActiveState=(\w+)/);

    if (activeMatch?.[1]?.trim()) {
      const activeDate = new Date(activeMatch[1].trim());
      relayUptime.activeMs = Date.now() - activeDate.getTime();
    }
    relayUptime.restarts = restartMatch ? parseInt(restartMatch[1]) : 0;
    relayUptime.status = stateMatch ? stateMatch[1] : "unknown";
  } catch {
    // systemd not available or service not found
  }

  // Memory pressure
  let swapUsedMB = 0, rssKB = 0;
  try {
    const swapOutput = execSync("free -m 2>/dev/null | grep Swap", { encoding: "utf-8", timeout: 5000 });
    const swapMatch = swapOutput.match(/Swap:\s+\d+\s+(\d+)/);
    swapUsedMB = swapMatch ? parseInt(swapMatch[1]) : 0;

    // RSS of relay process
    const rssOutput = execSync(
      "ps -o rss= -p $(systemctl --user show -p MainPID claude-telegram-relay 2>/dev/null | cut -d= -f2) 2>/dev/null",
      { encoding: "utf-8", timeout: 5000 }
    );
    rssKB = parseInt(rssOutput.trim()) || 0;
  } catch {
    // fine — system commands not available
  }

  // Circuit breakers (query live relay health endpoint)
  let breakerStatus: Record<string, { state: string; failures: number }> = {};
  try {
    const res = await fetch("http://localhost:3001/health", { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const health = await res.json() as any;
      breakerStatus = health.circuitBreakers ?? {};
    }
  } catch {
    // relay not running
  }

  return {
    testSuite: {
      total: testTotal,
      passed: testPassed,
      failed: testFailed,
      passRate: testTotal > 0 ? Math.round((testPassed / testTotal) * 100) : 0,
    },
    relayUptime,
    memoryPressure: { swapUsedMB, rssKB },
    circuitBreakers: breakerStatus,
  };
}

export async function collectEsMetrics(): Promise<EsMetrics> {
  try {
    const res = await fetch("http://localhost:3001/health", { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const health = await res.json() as any;
      const recon = health.esReconciliation;
      if (recon) {
        return {
          reconciliation: {
            lastRunAt: recon.lastRunAt,
            healthy: recon.healthy,
            totalMissing: recon.totalMissing,
            indices: (recon.results ?? []).map((r: any) => ({
              index: r.index,
              sourceCount: r.sourceCount,
              esCount: r.esCount,
              missingIds: r.missingIds?.length ?? 0,
            })),
          },
        };
      }
    }
  } catch {
    // relay not running or no reconciliation data
  }

  return {
    reconciliation: {
      lastRunAt: null,
      healthy: true,
      totalMissing: 0,
      indices: [],
    },
  };
}

export function computeRegressions(
  creatures: CreatureMetrics,
  dataFlow: DataFlowMetrics,
  system: SystemMetrics,
  es: EsMetrics,
): RegressionFlags {
  const flags: string[] = [];

  const orphanedWs = dataFlow.orphanedWorkSessions > 0;
  if (orphanedWs) flags.push(`${dataFlow.orphanedWorkSessions} orphaned work session(s)`);

  const stuck = dataFlow.stuckInProgress > 0;
  if (stuck) flags.push(`${dataFlow.stuckInProgress} ticket(s) stuck in progress > 24h`);

  const breakersOpen = Object.values(system.circuitBreakers).some(b => b.state === "open");
  if (breakersOpen) {
    const openNames = Object.entries(system.circuitBreakers)
      .filter(([, b]) => b.state === "open")
      .map(([name]) => name);
    flags.push(`Circuit breakers open: ${openNames.join(", ")}`);
  }

  const esUnhealthy = !es.reconciliation.healthy;
  if (esUnhealthy) flags.push(`ES reconciliation unhealthy — ${es.reconciliation.totalMissing} missing`);

  const testFailures = system.testSuite.failed > 0;
  if (testFailures) flags.push(`${system.testSuite.failed} test(s) failing`);

  if (creatures.orphaned > 0) flags.push(`${creatures.orphaned} orphaned creature(s)`);

  return {
    orphanedWorkSessions: orphanedWs,
    stuckTickets: stuck,
    circuitBreakersOpen: breakersOpen,
    esUnhealthy,
    testFailures,
    flags,
  };
}

// ── Snapshot & Storage ──────────────────────────────────────

export async function collectSnapshot(sections?: string[]): Promise<BenchmarkSnapshot> {
  const all = !sections || sections.length === 0;
  const shouldRun = (s: string) => all || sections!.includes(s);

  const [creatures, dataFlow, system, es] = await Promise.all([
    shouldRun("creature") ? collectCreatureMetrics() : emptyCreature(),
    shouldRun("dataflow") ? collectDataFlowMetrics() : emptyDataFlow(),
    shouldRun("system") ? collectSystemMetrics() : emptySystem(),
    shouldRun("es") ? collectEsMetrics() : emptyEs(),
  ]);

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

function emptyCreature(): CreatureMetrics {
  return { total: -1, completed: -1, active: -1, failed: -1, orphaned: -1, schemaVersion: null, speciesDistribution: {} };
}
function emptyDataFlow(): DataFlowMetrics {
  return {
    agentSessions: { total: 0, active: 0, completed: 0, completionRate: 0 },
    workSessions: { total: 0, active: 0, completed: 0, completionRate: 0 },
    orphanedWorkSessions: 0, stuckInProgress: 0,
  };
}
function emptySystem(): SystemMetrics {
  return {
    testSuite: { total: 0, passed: 0, failed: 0, passRate: 0 },
    relayUptime: { activeMs: 0, restarts: 0, status: "unknown" },
    memoryPressure: { swapUsedMB: 0, rssKB: 0 },
    circuitBreakers: {},
  };
}
function emptyEs(): EsMetrics {
  return { reconciliation: { lastRunAt: null, healthy: true, totalMissing: 0, indices: [] } };
}

export async function saveBenchmark(snapshot: BenchmarkSnapshot): Promise<string> {
  const dir = getCheckpointDir();
  await mkdir(dir, { recursive: true });

  const filename = `benchmark-${new Date(snapshot.timestamp).toISOString().replace(/[:.]/g, "-")}.json`;
  const filepath = join(dir, filename);

  await writeFile(filepath, JSON.stringify(snapshot, null, 2));
  await writeFile(getLatestPath(), JSON.stringify(snapshot, null, 2));

  return filepath;
}

export async function loadPrevious(): Promise<BenchmarkSnapshot | null> {
  try {
    const raw = await readFile(getLatestPath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Delta computation ───────────────────────────────────────

function delta(current: number, previous: number): string {
  if (previous === -1 || current === -1) return "N/A";
  const diff = current - previous;
  if (diff === 0) return "no change";
  const sign = diff > 0 ? "+" : "";
  return `${sign}${diff}`;
}

export function computeDelta(current: BenchmarkSnapshot, previous: BenchmarkSnapshot): BenchmarkDelta {
  return {
    creatures: {
      total: delta(current.creatures.total, previous.creatures.total),
      completed: delta(current.creatures.completed, previous.creatures.completed),
      active: delta(current.creatures.active, previous.creatures.active),
      orphaned: delta(current.creatures.orphaned, previous.creatures.orphaned),
    },
    dataFlow: {
      agentCompletionRate: delta(
        current.dataFlow.agentSessions.completionRate,
        previous.dataFlow.agentSessions.completionRate,
      ),
      workSessionCompletionRate: delta(
        current.dataFlow.workSessions.completionRate,
        previous.dataFlow.workSessions.completionRate,
      ),
      orphanedWorkSessions: delta(current.dataFlow.orphanedWorkSessions, previous.dataFlow.orphanedWorkSessions),
    },
    system: {
      testsPassed: delta(current.system.testSuite.passed, previous.system.testSuite.passed),
      testsFailed: delta(current.system.testSuite.failed, previous.system.testSuite.failed),
      relayRestarts: delta(current.system.relayUptime.restarts, previous.system.relayUptime.restarts),
    },
    elasticsearch: {
      totalMissing: delta(
        current.elasticsearch.reconciliation.totalMissing,
        previous.elasticsearch.reconciliation.totalMissing,
      ),
    },
  };
}

// ── Formatters ──────────────────────────────────────────────

function formatUptime(ms: number): string {
  if (ms <= 0) return "unknown";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function formatSnapshot(snapshot: BenchmarkSnapshot, previous: BenchmarkSnapshot | null): string {
  const c = snapshot.creatures;
  const df = snapshot.dataFlow;
  const s = snapshot.system;
  const es = snapshot.elasticsearch;
  const r = snapshot.regressions;
  const d = previous ? computeDelta(snapshot, previous) : null;

  const lines: string[] = [];

  lines.push(`\n  Hardening Sprint Checkpoint — ${new Date(snapshot.timestamp).toLocaleString()}\n`);

  // Creatures
  const cStatus = c.total >= 0 ? (c.orphaned === 0 ? "PASS" : "WARN") : "SKIP";
  lines.push(`${cStatus === "PASS" ? "  PASS" : cStatus === "WARN" ? "  WARN" : "  SKIP"} Creature Ecosystem`);
  if (c.total >= 0) {
    lines.push(`   - Total creatures: ${c.total}${d ? ` (${d.creatures.total})` : ""}`);
    lines.push(`   - Completed: ${c.completed}${d ? ` (${d.creatures.completed})` : ""}`);
    lines.push(`   - Active: ${c.active}${d ? ` (${d.creatures.active})` : ""}`);
    lines.push(`   - Orphaned: ${c.orphaned} ${c.orphaned === 0 ? "(target met)" : "(TARGET MISSED)"}`);
    if (c.schemaVersion) lines.push(`   - Schema: ${c.schemaVersion}`);
    if (Object.keys(c.speciesDistribution).length > 0) {
      lines.push(`   - Species: ${Object.entries(c.speciesDistribution).map(([k, v]) => `${k}:${v}`).join(", ")}`);
    }
  }
  lines.push("");

  // Data Flow
  const dfStatus = df.orphanedWorkSessions === 0 && df.stuckInProgress === 0 ? "PASS" : "WARN";
  lines.push(`${dfStatus === "PASS" ? "  PASS" : "  WARN"} Data Flow`);
  lines.push(`   - Agent sessions: ${df.agentSessions.completed}/${df.agentSessions.total} completed (${df.agentSessions.completionRate}%${d ? `, ${d.dataFlow.agentCompletionRate}` : ""})`);
  lines.push(`   - Work sessions: ${df.workSessions.completed}/${df.workSessions.total} completed (${df.workSessions.completionRate}%${d ? `, ${d.dataFlow.workSessionCompletionRate}` : ""})`);
  lines.push(`   - Orphaned work sessions: ${df.orphanedWorkSessions}${d ? ` (${d.dataFlow.orphanedWorkSessions})` : ""}`);
  lines.push(`   - Stuck in progress > 24h: ${df.stuckInProgress}`);
  lines.push("");

  // System
  const sStatus = s.testSuite.failed === 0 ? "PASS" : "FAIL";
  lines.push(`${sStatus === "PASS" ? "  PASS" : "  FAIL"} System Stability`);
  lines.push(`   - Tests: ${s.testSuite.passed}/${s.testSuite.total} passing (${s.testSuite.passRate}%${d ? `, ${d.system.testsPassed} tests` : ""})`);
  if (s.testSuite.failed > 0) lines.push(`   - Failures: ${s.testSuite.failed}`);
  lines.push(`   - Relay: ${s.relayUptime.status}, uptime ${formatUptime(s.relayUptime.activeMs)}, ${s.relayUptime.restarts} restart(s)${d ? ` (${d.system.relayRestarts})` : ""}`);
  lines.push(`   - Swap: ${s.memoryPressure.swapUsedMB} MB${s.memoryPressure.rssKB > 0 ? `, relay RSS: ${Math.round(s.memoryPressure.rssKB / 1024)} MB` : ""}`);
  if (Object.keys(s.circuitBreakers).length > 0) {
    const breakerSummary = Object.entries(s.circuitBreakers)
      .map(([name, b]) => `${name}:${b.state}`)
      .join(", ");
    lines.push(`   - Breakers: ${breakerSummary}`);
  }
  lines.push("");

  // Elasticsearch
  const esStatus = es.reconciliation.healthy ? "PASS" : "WARN";
  lines.push(`${esStatus === "PASS" ? "  PASS" : "  WARN"} Elasticsearch`);
  if (es.reconciliation.lastRunAt) {
    const ago = Math.round((Date.now() - es.reconciliation.lastRunAt) / 60_000);
    lines.push(`   - Last reconciliation: ${ago}m ago`);
  } else {
    lines.push(`   - Last reconciliation: never`);
  }
  lines.push(`   - Missing records: ${es.reconciliation.totalMissing}${d ? ` (${d.elasticsearch.totalMissing})` : ""}`);
  for (const idx of es.reconciliation.indices) {
    lines.push(`   - ${idx.index}: ${idx.esCount}/${idx.sourceCount} (${idx.missingIds} missing)`);
  }
  lines.push("");

  // Regression flags
  if (r.flags.length === 0) {
    lines.push("  PASS Regression Flags");
    lines.push("   - None detected");
  } else {
    lines.push("  FAIL Regression Flags");
    for (const flag of r.flags) {
      lines.push(`   - ${flag}`);
    }
  }
  lines.push("");

  if (d) {
    lines.push("  Delta from Last Checkpoint");
    const allDeltas = { ...d.creatures, ...d.dataFlow, ...d.system, ...d.elasticsearch };
    const changes = Object.entries(allDeltas).filter(([, v]) => v !== "no change" && v !== "N/A");
    if (changes.length === 0) {
      lines.push("   - No changes detected");
    } else {
      for (const [key, val] of changes) {
        lines.push(`   - ${key}: ${val}`);
      }
    }
  }

  return lines.join("\n");
}

// ── CLI ─────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const sectionIdx = args.indexOf("--section");
  const sections = sectionIdx >= 0 ? [args[sectionIdx + 1]] : undefined;

  console.log("Collecting benchmark data...\n");

  const previous = await loadPrevious();
  const snapshot = await collectSnapshot(sections);
  const filepath = await saveBenchmark(snapshot);

  if (jsonOutput) {
    console.log(JSON.stringify({ snapshot, previous, delta: previous ? computeDelta(snapshot, previous) : null }, null, 2));
  } else {
    console.log(formatSnapshot(snapshot, previous));
    console.log(`\n  Saved to: ${filepath}`);
  }

  // Exit with error code if regressions detected
  if (snapshot.regressions.flags.length > 0) {
    process.exit(1);
  }
}

// Only run main when executed directly (not imported for tests)
if (import.meta.path === Bun.main) {
  main().catch(err => {
    console.error("Benchmark failed:", err);
    process.exit(2);
  });
}
