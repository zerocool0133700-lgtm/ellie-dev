/**
 * Formation Heartbeat Scheduler Tests — ELLIE-723
 *
 * Tests for cron-based formation scheduling:
 * - Migration SQL structure
 * - Cron expression parsing
 * - Next-run calculation
 * - Cron matching
 * - Type shapes
 * - Heartbeat CRUD
 * - Scheduler tick (with overlap prevention)
 * - Audit trail queries
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  parseCron,
  parseCronField,
  nextCronRun,
  cronMatches,
  VALID_HEARTBEAT_RUN_STATUSES,
  type FormationHeartbeat,
  type HeartbeatRun,
  type HeartbeatRunStatus,
  type ParsedCron,
  type SchedulerTickResult,
} from "../src/types/formation-heartbeats.ts";

// ── Mock SQL Layer ──────────────────────────────────────────

type SqlRow = Record<string, unknown>;
type SqlResult = SqlRow[];

let sqlMockResults: SqlResult[] = [];
let sqlCallIndex = 0;
let sqlCalls: { strings: TemplateStringsArray; values: unknown[] }[] = [];

function resetSqlMock() {
  sqlMockResults = [];
  sqlCallIndex = 0;
  sqlCalls = [];
}

function pushSqlResult(rows: SqlResult) {
  sqlMockResults.push(rows);
}

const mockSql = Object.assign(
  function sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlResult> {
    sqlCalls.push({ strings, values });
    const result = sqlMockResults[sqlCallIndex] ?? [];
    sqlCallIndex++;
    return Promise.resolve(result);
  },
  { json: (v: unknown) => v, array: (v: unknown) => v },
);

mock.module("../../ellie-forest/src/index", () => ({
  sql: mockSql,
}));

const {
  upsertHeartbeat,
  getHeartbeat,
  listHeartbeats,
  setHeartbeatEnabled,
  deleteHeartbeat,
  getDueHeartbeats,
  schedulerTick,
  getHeartbeatRuns,
  getLastRun,
  getRunsByStatus,
} = await import("../src/formation-heartbeats.ts");

// ── Setup ───────────────────────────────────────────────────

beforeEach(() => {
  resetSqlMock();
});

// ── Migration SQL ───────────────────────────────────────────

describe("migration SQL", () => {
  function readMigration(): string {
    return readFileSync(
      join(import.meta.dir, "../migrations/supabase/20260315_formation_heartbeats.sql"),
      "utf-8",
    );
  }

  test("creates formation_heartbeats table", () => {
    const sql = readMigration();
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS formation_heartbeats");
  });

  test("formation_slug is PK", () => {
    const sql = readMigration();
    expect(sql).toContain("formation_slug TEXT PRIMARY KEY");
  });

  test("has schedule column", () => {
    const sql = readMigration();
    expect(sql).toContain("schedule TEXT NOT NULL");
  });

  test("has facilitator_agent_id FK to agents", () => {
    const sql = readMigration();
    expect(sql).toContain("facilitator_agent_id UUID NOT NULL REFERENCES agents(id)");
  });

  test("has last_run_at and next_run_at", () => {
    const sql = readMigration();
    expect(sql).toContain("last_run_at TIMESTAMPTZ");
    expect(sql).toContain("next_run_at TIMESTAMPTZ");
  });

  test("has enabled boolean", () => {
    const sql = readMigration();
    expect(sql).toContain("enabled BOOLEAN NOT NULL DEFAULT true");
  });

  test("creates heartbeat_runs table", () => {
    const sql = readMigration();
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS heartbeat_runs");
  });

  test("heartbeat_runs has status CHECK constraint", () => {
    const sql = readMigration();
    expect(sql).toContain("'started'");
    expect(sql).toContain("'completed'");
    expect(sql).toContain("'failed'");
    expect(sql).toContain("'skipped'");
  });

  test("heartbeat_runs has FK to formation_heartbeats", () => {
    const sql = readMigration();
    expect(sql).toContain("REFERENCES formation_heartbeats(formation_slug)");
  });

  test("heartbeat_runs has FK to formation_sessions", () => {
    const sql = readMigration();
    expect(sql).toContain("REFERENCES formation_sessions(id)");
  });

  test("has indexes for enabled and next_run lookups", () => {
    const sql = readMigration();
    expect(sql).toContain("idx_formation_heartbeats_enabled");
    expect(sql).toContain("idx_formation_heartbeats_next_run");
  });

  test("has indexes for run queries", () => {
    const sql = readMigration();
    expect(sql).toContain("idx_heartbeat_runs_slug");
    expect(sql).toContain("idx_heartbeat_runs_status");
    expect(sql).toContain("idx_heartbeat_runs_started");
  });

  test("has RLS enabled", () => {
    const sql = readMigration();
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
  });
});

// ── parseCron ───────────────────────────────────────────────

describe("parseCron", () => {
  test("parses every-minute cron (* * * * *)", () => {
    const c = parseCron("* * * * *");
    expect(c.minutes).toHaveLength(60);
    expect(c.hours).toHaveLength(24);
    expect(c.daysOfMonth).toHaveLength(31);
    expect(c.months).toHaveLength(12);
    expect(c.daysOfWeek).toHaveLength(7);
  });

  test("parses daily at 9am (0 9 * * *)", () => {
    const c = parseCron("0 9 * * *");
    expect(c.minutes).toEqual([0]);
    expect(c.hours).toEqual([9]);
    expect(c.daysOfMonth).toHaveLength(31);
    expect(c.months).toHaveLength(12);
    expect(c.daysOfWeek).toHaveLength(7);
  });

  test("parses every 6 hours (0 */6 * * *)", () => {
    const c = parseCron("0 */6 * * *");
    expect(c.minutes).toEqual([0]);
    expect(c.hours).toEqual([0, 6, 12, 18]);
  });

  test("parses weekly Monday at 10:30 (30 10 * * 1)", () => {
    const c = parseCron("30 10 * * 1");
    expect(c.minutes).toEqual([30]);
    expect(c.hours).toEqual([10]);
    expect(c.daysOfWeek).toEqual([1]);
  });

  test("parses ranges (1-5)", () => {
    const c = parseCron("0 9 * * 1-5");
    expect(c.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  test("parses lists (1,15)", () => {
    const c = parseCron("0 0 1,15 * *");
    expect(c.daysOfMonth).toEqual([1, 15]);
  });

  test("parses step with range (1-10/2)", () => {
    const c = parseCron("1-10/2 * * * *");
    expect(c.minutes).toEqual([1, 3, 5, 7, 9]);
  });

  test("parses combined list and range (1,5-8,15)", () => {
    const c = parseCron("1,5-8,15 * * * *");
    expect(c.minutes).toEqual([1, 5, 6, 7, 8, 15]);
  });

  test("throws on wrong number of fields", () => {
    expect(() => parseCron("* * *")).toThrow("expected 5 fields");
    expect(() => parseCron("* * * * * *")).toThrow("expected 5 fields");
  });

  test("throws on out-of-range values", () => {
    expect(() => parseCron("60 * * * *")).toThrow("Invalid cron value");
    expect(() => parseCron("* 25 * * *")).toThrow("Invalid cron value");
    expect(() => parseCron("* * 0 * *")).toThrow("Invalid cron value");
    expect(() => parseCron("* * * 13 *")).toThrow("Invalid cron value");
    expect(() => parseCron("* * * * 7")).toThrow("Invalid cron value");
  });

  test("throws on invalid range", () => {
    expect(() => parseCron("5-2 * * * *")).toThrow("Invalid cron range");
  });
});

// ── parseCronField ──────────────────────────────────────────

describe("parseCronField", () => {
  test("wildcard returns all values", () => {
    const values = parseCronField("*", 0, 5);
    expect(values).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("single value", () => {
    expect(parseCronField("3", 0, 10)).toEqual([3]);
  });

  test("range", () => {
    expect(parseCronField("2-5", 0, 10)).toEqual([2, 3, 4, 5]);
  });

  test("step", () => {
    expect(parseCronField("*/3", 0, 9)).toEqual([0, 3, 6, 9]);
  });

  test("range with step", () => {
    expect(parseCronField("0-10/3", 0, 59)).toEqual([0, 3, 6, 9]);
  });

  test("list", () => {
    expect(parseCronField("1,3,5", 0, 10)).toEqual([1, 3, 5]);
  });

  test("complex list with ranges and steps", () => {
    expect(parseCronField("1,5-8,20-30/5", 0, 59)).toEqual([1, 5, 6, 7, 8, 20, 25, 30]);
  });
});

// ── nextCronRun ─────────────────────────────────────────────

describe("nextCronRun", () => {
  test("finds next minute for every-minute cron", () => {
    const cron = parseCron("* * * * *");
    const now = new Date("2026-03-15T10:30:00Z");
    const next = nextCronRun(cron, now);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBe(new Date("2026-03-15T10:31:00Z").getTime());
  });

  test("finds next 9am for daily cron", () => {
    const cron = parseCron("0 9 * * *");
    const now = new Date("2026-03-15T10:00:00Z");
    const next = nextCronRun(cron, now);
    expect(next).not.toBeNull();
    expect(next!.getUTCHours()).toBe(9);
    expect(next!.getUTCMinutes()).toBe(0);
    // Should be next day since we're past 9am
    expect(next!.getUTCDate()).toBe(16);
  });

  test("finds same day if before scheduled time", () => {
    const cron = parseCron("0 15 * * *");
    const now = new Date("2026-03-15T10:00:00Z");
    const next = nextCronRun(cron, now);
    expect(next!.getUTCDate()).toBe(15);
    expect(next!.getUTCHours()).toBe(15);
  });

  test("finds next Monday for weekly cron", () => {
    const cron = parseCron("0 10 * * 1");
    // March 15, 2026 is a Sunday
    const now = new Date("2026-03-15T10:00:00Z");
    const next = nextCronRun(cron, now);
    expect(next).not.toBeNull();
    expect(next!.getUTCDay()).toBe(1); // Monday
    expect(next!.getUTCHours()).toBe(10);
  });

  test("handles every-6-hours cron", () => {
    const cron = parseCron("0 */6 * * *");
    const now = new Date("2026-03-15T07:00:00Z");
    const next = nextCronRun(cron, now);
    expect(next!.getUTCHours()).toBe(12);
    expect(next!.getUTCMinutes()).toBe(0);
  });

  test("returns time after the given time (never same minute)", () => {
    const cron = parseCron("30 10 * * *");
    const now = new Date("2026-03-15T10:30:00Z");
    const next = nextCronRun(cron, now);
    // Should be next day's 10:30, not today's
    expect(next!.getUTCDate()).toBe(16);
  });
});

// ── cronMatches ─────────────────────────────────────────────

describe("cronMatches", () => {
  test("matches every minute", () => {
    const cron = parseCron("* * * * *");
    expect(cronMatches(cron, new Date("2026-03-15T10:30:00Z"))).toBe(true);
  });

  test("matches specific time", () => {
    const cron = parseCron("30 10 15 3 *");
    expect(cronMatches(cron, new Date("2026-03-15T10:30:00Z"))).toBe(true);
  });

  test("does not match wrong minute", () => {
    const cron = parseCron("0 10 * * *");
    expect(cronMatches(cron, new Date("2026-03-15T10:30:00Z"))).toBe(false);
  });

  test("does not match wrong day of week", () => {
    const cron = parseCron("0 10 * * 1"); // Monday only
    // March 15 2026 is Sunday
    expect(cronMatches(cron, new Date("2026-03-15T10:00:00Z"))).toBe(false);
  });

  test("matches day-of-week correctly", () => {
    const cron = parseCron("0 10 * * 0"); // Sunday
    expect(cronMatches(cron, new Date("2026-03-15T10:00:00Z"))).toBe(true);
  });
});

// ── Type Shapes ─────────────────────────────────────────────

describe("type shapes", () => {
  test("FormationHeartbeat has all expected fields", () => {
    const hb: FormationHeartbeat = {
      formation_slug: "boardroom",
      created_at: new Date(),
      updated_at: new Date(),
      schedule: "0 9 * * *",
      facilitator_agent_id: "agent-uuid",
      last_run_at: null,
      next_run_at: new Date(),
      enabled: true,
      run_context: {},
    };
    expect(hb.formation_slug).toBe("boardroom");
    expect(hb.enabled).toBe(true);
  });

  test("HeartbeatRun has all expected fields", () => {
    const run: HeartbeatRun = {
      id: "run-id",
      created_at: new Date(),
      formation_slug: "boardroom",
      status: "completed",
      started_at: new Date(),
      completed_at: new Date(),
      duration_ms: 5000,
      formation_session_id: "session-id",
      skip_reason: null,
      error: null,
      metadata: {},
    };
    expect(run.status).toBe("completed");
    expect(run.duration_ms).toBe(5000);
  });

  test("VALID_HEARTBEAT_RUN_STATUSES has all values", () => {
    expect(VALID_HEARTBEAT_RUN_STATUSES).toContain("started");
    expect(VALID_HEARTBEAT_RUN_STATUSES).toContain("completed");
    expect(VALID_HEARTBEAT_RUN_STATUSES).toContain("failed");
    expect(VALID_HEARTBEAT_RUN_STATUSES).toContain("skipped");
    expect(VALID_HEARTBEAT_RUN_STATUSES).toHaveLength(4);
  });

  test("all run statuses are assignable to HeartbeatRunStatus", () => {
    const statuses: HeartbeatRunStatus[] = ["started", "completed", "failed", "skipped"];
    for (const s of statuses) {
      expect(VALID_HEARTBEAT_RUN_STATUSES).toContain(s);
    }
  });
});

// ── upsertHeartbeat ─────────────────────────────────────────

describe("upsertHeartbeat", () => {
  test("creates heartbeat with computed next_run_at", async () => {
    const now = new Date();
    pushSqlResult([{
      formation_slug: "boardroom",
      created_at: now,
      updated_at: now,
      schedule: "0 9 * * *",
      facilitator_agent_id: "agent-1",
      last_run_at: null,
      next_run_at: new Date("2026-03-16T09:00:00Z"),
      enabled: true,
      run_context: {},
    }]);

    const hb = await upsertHeartbeat({
      formation_slug: "boardroom",
      schedule: "0 9 * * *",
      facilitator_agent_id: "agent-1",
    });
    expect(hb.formation_slug).toBe("boardroom");
    expect(hb.enabled).toBe(true);
  });

  test("uses ON CONFLICT for upsert", async () => {
    pushSqlResult([{
      formation_slug: "boardroom",
      created_at: new Date(),
      updated_at: new Date(),
      schedule: "0 9 * * *",
      facilitator_agent_id: "agent-1",
      last_run_at: null,
      next_run_at: null,
      enabled: true,
      run_context: {},
    }]);

    await upsertHeartbeat({
      formation_slug: "boardroom",
      schedule: "0 9 * * *",
      facilitator_agent_id: "agent-1",
    });

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("ON CONFLICT");
    expect(sqlText).toContain("DO UPDATE SET");
  });

  test("throws on invalid cron expression", async () => {
    await expect(
      upsertHeartbeat({
        formation_slug: "bad",
        schedule: "invalid",
        facilitator_agent_id: "agent-1",
      }),
    ).rejects.toThrow("expected 5 fields");
  });
});

// ── getHeartbeat ────────────────────────────────────────────

describe("getHeartbeat", () => {
  test("returns heartbeat when found", async () => {
    pushSqlResult([{
      formation_slug: "boardroom",
      created_at: new Date(),
      updated_at: new Date(),
      schedule: "0 9 * * *",
      facilitator_agent_id: "agent-1",
      last_run_at: null,
      next_run_at: null,
      enabled: true,
      run_context: {},
    }]);

    const hb = await getHeartbeat("boardroom");
    expect(hb).not.toBeNull();
    expect(hb!.formation_slug).toBe("boardroom");
  });

  test("returns null when not found", async () => {
    pushSqlResult([]);
    const hb = await getHeartbeat("nonexistent");
    expect(hb).toBeNull();
  });
});

// ── listHeartbeats ──────────────────────────────────────────

describe("listHeartbeats", () => {
  test("returns all heartbeats", async () => {
    pushSqlResult([
      { formation_slug: "boardroom", schedule: "0 9 * * *", enabled: true },
      { formation_slug: "think-tank", schedule: "0 10 * * 1", enabled: false },
    ]);

    const list = await listHeartbeats();
    expect(list).toHaveLength(2);
  });

  test("filters enabled only", async () => {
    pushSqlResult([
      { formation_slug: "boardroom", schedule: "0 9 * * *", enabled: true },
    ]);

    await listHeartbeats({ enabledOnly: true });

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("enabled = true");
  });
});

// ── setHeartbeatEnabled ─────────────────────────────────────

describe("setHeartbeatEnabled", () => {
  test("disables a heartbeat", async () => {
    pushSqlResult([{
      formation_slug: "boardroom",
      enabled: false,
    }]);

    const hb = await setHeartbeatEnabled("boardroom", false);
    expect(hb).not.toBeNull();
    expect(hb!.enabled).toBe(false);
  });

  test("enables a heartbeat", async () => {
    pushSqlResult([{
      formation_slug: "boardroom",
      enabled: true,
    }]);

    const hb = await setHeartbeatEnabled("boardroom", true);
    expect(hb!.enabled).toBe(true);
  });

  test("returns null for nonexistent slug", async () => {
    pushSqlResult([]);
    const hb = await setHeartbeatEnabled("nonexistent", true);
    expect(hb).toBeNull();
  });
});

// ── deleteHeartbeat ─────────────────────────────────────────

describe("deleteHeartbeat", () => {
  test("returns true when deleted", async () => {
    pushSqlResult([{ formation_slug: "boardroom" }]);
    const deleted = await deleteHeartbeat("boardroom");
    expect(deleted).toBe(true);
  });

  test("returns false when not found", async () => {
    pushSqlResult([]);
    const deleted = await deleteHeartbeat("nonexistent");
    expect(deleted).toBe(false);
  });
});

// ── getDueHeartbeats ────────────────────────────────────────

describe("getDueHeartbeats", () => {
  test("returns heartbeats where next_run_at <= now", async () => {
    pushSqlResult([
      { formation_slug: "boardroom", next_run_at: new Date("2026-03-15T09:00:00Z"), enabled: true },
    ]);

    const due = await getDueHeartbeats(new Date("2026-03-15T09:01:00Z"));
    expect(due).toHaveLength(1);
  });

  test("filters for enabled and non-null next_run_at", async () => {
    pushSqlResult([]);

    await getDueHeartbeats(new Date());

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("enabled = true");
    expect(sqlText).toContain("next_run_at IS NOT NULL");
    expect(sqlText).toContain("next_run_at <=");
  });
});

// ── schedulerTick ───────────────────────────────────────────

describe("schedulerTick", () => {
  const now = new Date("2026-03-15T09:01:00Z");

  function makeHeartbeat(slug: string): FormationHeartbeat {
    return {
      formation_slug: slug,
      created_at: new Date(),
      updated_at: new Date(),
      schedule: "0 9 * * *",
      facilitator_agent_id: "agent-1",
      last_run_at: null,
      next_run_at: new Date("2026-03-15T09:00:00Z"),
      enabled: true,
      run_context: {},
    };
  }

  test("triggers due heartbeats and returns result", async () => {
    // getDueHeartbeats
    pushSqlResult([makeHeartbeat("boardroom")]);
    // INSERT heartbeat_runs
    pushSqlResult([{ id: "run-1", formation_slug: "boardroom", status: "started", started_at: now }]);
    // completeRun UPDATE
    pushSqlResult([]);
    // advanceNextRun UPDATE
    pushSqlResult([]);

    const triggerFn = async () => "session-123";
    const result = await schedulerTick(triggerFn, now);

    expect(result.evaluated).toBe(1);
    expect(result.triggered).toEqual(["boardroom"]);
    expect(result.skipped).toHaveLength(0);
  });

  test("skips when trigger returns null (overlapping run)", async () => {
    pushSqlResult([makeHeartbeat("boardroom")]);
    pushSqlResult([{ id: "run-1", formation_slug: "boardroom", status: "started", started_at: now }]);
    // completeRun (skipped)
    pushSqlResult([]);

    const triggerFn = async () => null;
    const result = await schedulerTick(triggerFn, now);

    expect(result.evaluated).toBe(1);
    expect(result.triggered).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain("overlapping");
  });

  test("handles trigger error gracefully", async () => {
    pushSqlResult([makeHeartbeat("boardroom")]);
    pushSqlResult([{ id: "run-1", formation_slug: "boardroom", status: "started", started_at: now }]);
    // completeRun (failed)
    pushSqlResult([]);
    // advanceNextRun
    pushSqlResult([]);

    const triggerFn = async () => { throw new Error("checkout failed"); };
    const result = await schedulerTick(triggerFn, now);

    expect(result.evaluated).toBe(1);
    expect(result.triggered).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain("checkout failed");
  });

  test("processes multiple due heartbeats", async () => {
    pushSqlResult([
      makeHeartbeat("boardroom"),
      makeHeartbeat("think-tank"),
    ]);
    // boardroom: run INSERT, completeRun, advanceNextRun
    pushSqlResult([{ id: "run-1", formation_slug: "boardroom", status: "started", started_at: now }]);
    pushSqlResult([]);
    pushSqlResult([]);
    // think-tank: run INSERT, completeRun, advanceNextRun
    pushSqlResult([{ id: "run-2", formation_slug: "think-tank", status: "started", started_at: now }]);
    pushSqlResult([]);
    pushSqlResult([]);

    const triggerFn = async (hb: FormationHeartbeat) => `session-${hb.formation_slug}`;
    const result = await schedulerTick(triggerFn, now);

    expect(result.evaluated).toBe(2);
    expect(result.triggered).toEqual(["boardroom", "think-tank"]);
  });

  test("no-op when nothing is due", async () => {
    pushSqlResult([]);

    const triggerFn = async () => "should-not-be-called";
    const result = await schedulerTick(triggerFn, now);

    expect(result.evaluated).toBe(0);
    expect(result.triggered).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  test("failed trigger still advances next_run_at to avoid retry loops", async () => {
    pushSqlResult([makeHeartbeat("boardroom")]);
    pushSqlResult([{ id: "run-1", formation_slug: "boardroom", status: "started", started_at: now }]);
    pushSqlResult([]); // completeRun
    pushSqlResult([]); // advanceNextRun

    const triggerFn = async () => { throw new Error("boom"); };
    await schedulerTick(triggerFn, now);

    // Should have 4 SQL calls: getDue, insertRun, completeRun(failed), advanceNextRun
    expect(sqlCalls).toHaveLength(4);
    const advanceSql = sqlCalls[3].strings.join("?");
    expect(advanceSql).toContain("UPDATE formation_heartbeats");
    expect(advanceSql).toContain("next_run_at");
  });

  test("skipped (overlap) does NOT advance next_run_at", async () => {
    pushSqlResult([makeHeartbeat("boardroom")]);
    pushSqlResult([{ id: "run-1", formation_slug: "boardroom", status: "started", started_at: now }]);
    pushSqlResult([]); // completeRun(skipped)

    const triggerFn = async () => null;
    await schedulerTick(triggerFn, now);

    // Should have 3 SQL calls: getDue, insertRun, completeRun — NO advanceNextRun
    expect(sqlCalls).toHaveLength(3);
  });
});

// ── Audit Trail ─────────────────────────────────────────────

describe("audit trail", () => {
  test("getHeartbeatRuns returns recent runs", async () => {
    pushSqlResult([
      { id: "r1", formation_slug: "boardroom", status: "completed", started_at: new Date() },
      { id: "r2", formation_slug: "boardroom", status: "failed", started_at: new Date() },
    ]);

    const runs = await getHeartbeatRuns("boardroom");
    expect(runs).toHaveLength(2);
  });

  test("getHeartbeatRuns orders by started_at DESC", async () => {
    pushSqlResult([]);
    await getHeartbeatRuns("boardroom");
    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("ORDER BY started_at DESC");
  });

  test("getHeartbeatRuns respects limit", async () => {
    pushSqlResult([]);
    await getHeartbeatRuns("boardroom", 5);
    expect(sqlCalls[0].values).toContain(5);
  });

  test("getLastRun returns most recent run", async () => {
    pushSqlResult([{
      id: "r1", formation_slug: "boardroom", status: "completed",
      started_at: new Date(), completed_at: new Date(),
    }]);

    const run = await getLastRun("boardroom");
    expect(run).not.toBeNull();
    expect(run!.status).toBe("completed");
  });

  test("getLastRun returns null when no runs", async () => {
    pushSqlResult([]);
    const run = await getLastRun("boardroom");
    expect(run).toBeNull();
  });

  test("getRunsByStatus filters correctly", async () => {
    pushSqlResult([
      { id: "r1", formation_slug: "boardroom", status: "failed" },
    ]);

    await getRunsByStatus("failed", 10);

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("status =");
    expect(sqlCalls[0].values).toContain("failed");
  });
});

// ── E2E: Heartbeat Lifecycle ────────────────────────────────

describe("E2E: heartbeat lifecycle", () => {
  test("create → tick → audit → disable → tick skips", async () => {
    const now = new Date("2026-03-15T09:01:00Z");

    // Step 1: Create heartbeat
    pushSqlResult([{
      formation_slug: "boardroom",
      created_at: new Date(),
      updated_at: new Date(),
      schedule: "0 9 * * *",
      facilitator_agent_id: "agent-1",
      last_run_at: null,
      next_run_at: new Date("2026-03-15T09:00:00Z"),
      enabled: true,
      run_context: {},
    }]);
    const hb = await upsertHeartbeat({
      formation_slug: "boardroom",
      schedule: "0 9 * * *",
      facilitator_agent_id: "agent-1",
    });
    expect(hb.formation_slug).toBe("boardroom");

    resetSqlMock();

    // Step 2: Tick (triggers the formation)
    pushSqlResult([{
      formation_slug: "boardroom",
      schedule: "0 9 * * *",
      facilitator_agent_id: "agent-1",
      last_run_at: null,
      next_run_at: new Date("2026-03-15T09:00:00Z"),
      enabled: true,
      run_context: {},
    }]);
    pushSqlResult([{ id: "run-1", formation_slug: "boardroom", status: "started", started_at: now }]);
    pushSqlResult([]); // completeRun
    pushSqlResult([]); // advanceNextRun

    const tick1 = await schedulerTick(async () => "session-1", now);
    expect(tick1.triggered).toEqual(["boardroom"]);

    resetSqlMock();

    // Step 3: Query audit trail
    pushSqlResult([{
      id: "run-1", formation_slug: "boardroom", status: "completed",
      started_at: now, completed_at: now,
    }]);
    const lastRun = await getLastRun("boardroom");
    expect(lastRun!.status).toBe("completed");

    resetSqlMock();

    // Step 4: Disable
    pushSqlResult([{ formation_slug: "boardroom", enabled: false }]);
    const disabled = await setHeartbeatEnabled("boardroom", false);
    expect(disabled!.enabled).toBe(false);

    resetSqlMock();

    // Step 5: Tick returns nothing (disabled heartbeat won't show in getDueHeartbeats)
    pushSqlResult([]);
    const tick2 = await schedulerTick(async () => "should-not-trigger", now);
    expect(tick2.evaluated).toBe(0);
    expect(tick2.triggered).toHaveLength(0);
  });
});
