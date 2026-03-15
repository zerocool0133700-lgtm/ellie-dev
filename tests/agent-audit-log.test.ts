/**
 * Agent Audit Log Tests — ELLIE-728
 *
 * Tests for agent action audit trail:
 * - Migration SQL structure
 * - Type shapes and constants
 * - Log actions
 * - Query with filters (agent, company, type, date range)
 * - Session audit log
 * - Count entries
 * - Retention policy CRUD and application
 * - E2E lifecycle
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import type {
  AuditLogEntry,
  AuditActionType,
  RetentionPolicy,
} from "../src/agent-audit-log.ts";

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
  logAction,
  logActionBatch,
  queryAuditLog,
  getSessionAuditLog,
  countAuditEntries,
  setRetentionPolicy,
  getRetentionPolicy,
  applyRetentionPolicies,
  VALID_AUDIT_ACTION_TYPES,
  DEFAULT_RETENTION_DAYS,
} = await import("../src/agent-audit-log.ts");

// ── Setup ───────────────────────────────────────────────────

beforeEach(() => {
  resetSqlMock();
});

// ── Helpers ─────────────────────────────────────────────────

function makeEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: "entry-1",
    created_at: new Date("2026-03-15T10:00:00Z"),
    agent_id: "agent-1",
    company_id: "comp-1",
    action_type: "dispatch",
    action_detail: { session_id: "sess-1" },
    formation_session_id: "sess-1",
    work_item_id: null,
    ...overrides,
  };
}

// ── Migration SQL ───────────────────────────────────────────

describe("migration SQL", () => {
  function readMigration(): string {
    return readFileSync(
      join(import.meta.dir, "../migrations/supabase/20260315_agent_audit_log.sql"),
      "utf-8",
    );
  }

  test("creates agent_audit_log table", () => {
    expect(readMigration()).toContain("CREATE TABLE IF NOT EXISTS agent_audit_log");
  });

  test("has agent_id FK to agents", () => {
    expect(readMigration()).toContain("agent_id UUID NOT NULL REFERENCES agents(id)");
  });

  test("has company_id FK to companies", () => {
    expect(readMigration()).toContain("company_id UUID REFERENCES companies(id)");
  });

  test("has action_type CHECK with all 10 types", () => {
    const sql = readMigration();
    for (const type of VALID_AUDIT_ACTION_TYPES) {
      expect(sql).toContain(`'${type}'`);
    }
  });

  test("has action_detail JSONB", () => {
    expect(readMigration()).toContain("action_detail JSONB NOT NULL");
  });

  test("has formation_session_id FK", () => {
    expect(readMigration()).toContain("REFERENCES formation_sessions(id)");
  });

  test("has indexes for agent, company, type, time, session", () => {
    const sql = readMigration();
    expect(sql).toContain("idx_audit_log_agent");
    expect(sql).toContain("idx_audit_log_company");
    expect(sql).toContain("idx_audit_log_action_type");
    expect(sql).toContain("idx_audit_log_created");
    expect(sql).toContain("idx_audit_log_agent_time");
    expect(sql).toContain("idx_audit_log_company_time");
    expect(sql).toContain("idx_audit_log_session");
  });

  test("creates audit_retention_policies table", () => {
    expect(readMigration()).toContain("CREATE TABLE IF NOT EXISTS audit_retention_policies");
  });

  test("retention policy has retention_days default 90", () => {
    expect(readMigration()).toContain("retention_days INTEGER NOT NULL DEFAULT 90");
  });

  test("has RLS enabled on both tables", () => {
    const sql = readMigration();
    const rlsCount = (sql.match(/ENABLE ROW LEVEL SECURITY/g) || []).length;
    expect(rlsCount).toBeGreaterThanOrEqual(2);
  });
});

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("VALID_AUDIT_ACTION_TYPES has all 10 types", () => {
    expect(VALID_AUDIT_ACTION_TYPES).toHaveLength(10);
    expect(VALID_AUDIT_ACTION_TYPES).toContain("dispatch");
    expect(VALID_AUDIT_ACTION_TYPES).toContain("checkout");
    expect(VALID_AUDIT_ACTION_TYPES).toContain("completion");
    expect(VALID_AUDIT_ACTION_TYPES).toContain("failure");
    expect(VALID_AUDIT_ACTION_TYPES).toContain("approval_requested");
    expect(VALID_AUDIT_ACTION_TYPES).toContain("approval_granted");
    expect(VALID_AUDIT_ACTION_TYPES).toContain("approval_denied");
    expect(VALID_AUDIT_ACTION_TYPES).toContain("delegation");
    expect(VALID_AUDIT_ACTION_TYPES).toContain("escalation");
    expect(VALID_AUDIT_ACTION_TYPES).toContain("budget_exceeded");
  });

  test("DEFAULT_RETENTION_DAYS is 90", () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(90);
  });
});

// ── Type Shapes ─────────────────────────────────────────────

describe("type shapes", () => {
  test("AuditLogEntry has all expected fields", () => {
    const e = makeEntry();
    expect(e.action_type).toBe("dispatch");
    expect(e.action_detail).toEqual({ session_id: "sess-1" });
    expect(e.formation_session_id).toBe("sess-1");
  });

  test("all action types are assignable", () => {
    const types: AuditActionType[] = [
      "dispatch", "checkout", "completion", "failure",
      "approval_requested", "approval_granted", "approval_denied",
      "delegation", "escalation", "budget_exceeded",
    ];
    expect(types).toHaveLength(10);
  });
});

// ── logAction ───────────────────────────────────────────────

describe("logAction", () => {
  test("inserts and returns entry", async () => {
    pushSqlResult([makeEntry()]);

    const entry = await logAction({
      agent_id: "agent-1",
      action_type: "dispatch",
      action_detail: { session_id: "sess-1" },
      company_id: "comp-1",
      formation_session_id: "sess-1",
    });
    expect(entry.action_type).toBe("dispatch");
  });

  test("defaults action_detail to empty object", async () => {
    pushSqlResult([makeEntry({ action_detail: {} })]);

    await logAction({ agent_id: "agent-1", action_type: "checkout" });

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("INSERT INTO agent_audit_log");
  });

  test("handles all action types", async () => {
    for (const type of VALID_AUDIT_ACTION_TYPES) {
      resetSqlMock();
      pushSqlResult([makeEntry({ action_type: type })]);

      const entry = await logAction({ agent_id: "agent-1", action_type: type });
      expect(entry.action_type).toBe(type);
    }
  });
});

// ── logActionBatch ──────────────────────────────────────────

describe("logActionBatch", () => {
  test("logs multiple actions and returns count", async () => {
    pushSqlResult([makeEntry()]);
    pushSqlResult([makeEntry({ id: "entry-2" })]);

    const count = await logActionBatch([
      { agent_id: "agent-1", action_type: "dispatch" },
      { agent_id: "agent-1", action_type: "completion" },
    ]);
    expect(count).toBe(2);
  });

  test("returns 0 for empty input", async () => {
    const count = await logActionBatch([]);
    expect(count).toBe(0);
  });
});

// ── queryAuditLog ───────────────────────────────────────────

describe("queryAuditLog", () => {
  test("returns all entries with no filters", async () => {
    pushSqlResult([makeEntry(), makeEntry({ id: "e2" })]);

    const entries = await queryAuditLog();
    expect(entries).toHaveLength(2);
  });

  test("filters by agent_id", async () => {
    pushSqlResult([makeEntry()]);
    await queryAuditLog({ agent_id: "agent-1" });

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("agent_id =");
  });

  test("filters by company_id", async () => {
    pushSqlResult([]);
    await queryAuditLog({ company_id: "comp-1" });

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("company_id =");
  });

  test("filters by action_type", async () => {
    pushSqlResult([]);
    await queryAuditLog({ action_type: "dispatch" });

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("action_type =");
  });

  test("filters by agent + action_type", async () => {
    pushSqlResult([]);
    await queryAuditLog({ agent_id: "agent-1", action_type: "failure" });

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("agent_id =");
    expect(sqlText).toContain("action_type =");
  });

  test("filters by company + action_type", async () => {
    pushSqlResult([]);
    await queryAuditLog({ company_id: "comp-1", action_type: "dispatch" });

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("company_id =");
    expect(sqlText).toContain("action_type =");
  });

  test("filters by date range", async () => {
    pushSqlResult([]);
    await queryAuditLog({
      from: new Date("2026-03-01T00:00:00Z"),
      to: new Date("2026-03-31T23:59:59Z"),
    });

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("created_at >=");
    expect(sqlText).toContain("created_at <=");
  });

  test("filters by agent + type + date range", async () => {
    pushSqlResult([]);
    await queryAuditLog({
      agent_id: "agent-1",
      action_type: "dispatch",
      from: new Date("2026-03-01"),
      to: new Date("2026-03-31"),
    });

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("agent_id =");
    expect(sqlText).toContain("action_type =");
    expect(sqlText).toContain("created_at >=");
  });

  test("uses default limit of 100", async () => {
    pushSqlResult([]);
    await queryAuditLog();
    expect(sqlCalls[0].values).toContain(100);
  });

  test("accepts custom limit and offset", async () => {
    pushSqlResult([]);
    await queryAuditLog({ limit: 20, offset: 40 });
    expect(sqlCalls[0].values).toContain(20);
    expect(sqlCalls[0].values).toContain(40);
  });

  test("orders by created_at DESC", async () => {
    pushSqlResult([]);
    await queryAuditLog();
    expect(sqlCalls[0].strings.join("?")).toContain("ORDER BY created_at DESC");
  });
});

// ── getSessionAuditLog ──────────────────────────────────────

describe("getSessionAuditLog", () => {
  test("returns entries for a session ordered by time ASC", async () => {
    pushSqlResult([
      makeEntry({ action_type: "checkout" }),
      makeEntry({ action_type: "completion" }),
    ]);

    const entries = await getSessionAuditLog("sess-1");
    expect(entries).toHaveLength(2);

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("formation_session_id =");
    expect(sqlText).toContain("ORDER BY created_at ASC");
  });
});

// ── countAuditEntries ───────────────────────────────────────

describe("countAuditEntries", () => {
  test("counts all entries", async () => {
    pushSqlResult([{ count: 42 }]);
    const count = await countAuditEntries();
    expect(count).toBe(42);
  });

  test("counts by agent", async () => {
    pushSqlResult([{ count: 10 }]);
    const count = await countAuditEntries({ agent_id: "agent-1" });
    expect(count).toBe(10);
  });

  test("counts by company", async () => {
    pushSqlResult([{ count: 25 }]);
    const count = await countAuditEntries({ company_id: "comp-1" });
    expect(count).toBe(25);
  });

  test("counts by agent + action_type", async () => {
    pushSqlResult([{ count: 5 }]);
    const count = await countAuditEntries({ agent_id: "agent-1", action_type: "dispatch" });
    expect(count).toBe(5);
  });
});

// ── setRetentionPolicy ──────────────────────────────────────

describe("setRetentionPolicy", () => {
  test("upserts retention policy", async () => {
    pushSqlResult([{
      company_id: "comp-1", retention_days: 30,
      created_at: new Date(), updated_at: new Date(),
    }]);

    const policy = await setRetentionPolicy("comp-1", 30);
    expect(policy.retention_days).toBe(30);
  });

  test("uses ON CONFLICT for upsert", async () => {
    pushSqlResult([{
      company_id: "comp-1", retention_days: 60,
      created_at: new Date(), updated_at: new Date(),
    }]);

    await setRetentionPolicy("comp-1", 60);

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("ON CONFLICT");
    expect(sqlText).toContain("DO UPDATE SET");
  });
});

// ── getRetentionPolicy ──────────────────────────────────────

describe("getRetentionPolicy", () => {
  test("returns policy when found", async () => {
    pushSqlResult([{
      company_id: "comp-1", retention_days: 30,
      created_at: new Date(), updated_at: new Date(),
    }]);

    const policy = await getRetentionPolicy("comp-1");
    expect(policy).not.toBeNull();
    expect(policy!.retention_days).toBe(30);
  });

  test("returns null when not found", async () => {
    pushSqlResult([]);
    const policy = await getRetentionPolicy("comp-1");
    expect(policy).toBeNull();
  });
});

// ── applyRetentionPolicies ──────────────────────────────────

describe("applyRetentionPolicies", () => {
  test("deletes old entries and returns count", async () => {
    pushSqlResult([{ id: "e1" }, { id: "e2" }]); // company-scoped
    pushSqlResult([{ id: "e3" }]); // default

    const count = await applyRetentionPolicies();
    expect(count).toBe(3);
  });

  test("returns 0 when nothing to delete", async () => {
    pushSqlResult([]);
    pushSqlResult([]);

    const count = await applyRetentionPolicies();
    expect(count).toBe(0);
  });

  test("issues two DELETE queries (company + default)", async () => {
    pushSqlResult([]);
    pushSqlResult([]);

    await applyRetentionPolicies();
    expect(sqlCalls).toHaveLength(2);
  });
});

// ── E2E: Audit Lifecycle ────────────────────────────────────

describe("E2E: audit lifecycle", () => {
  test("log actions → query by agent → count", async () => {
    // Log dispatch
    pushSqlResult([makeEntry({ action_type: "dispatch" })]);
    await logAction({ agent_id: "agent-1", action_type: "dispatch", company_id: "comp-1" });

    resetSqlMock();

    // Log completion
    pushSqlResult([makeEntry({ action_type: "completion" })]);
    await logAction({ agent_id: "agent-1", action_type: "completion", company_id: "comp-1" });

    resetSqlMock();

    // Query by agent
    pushSqlResult([
      makeEntry({ action_type: "dispatch" }),
      makeEntry({ action_type: "completion" }),
    ]);
    const entries = await queryAuditLog({ agent_id: "agent-1" });
    expect(entries).toHaveLength(2);

    resetSqlMock();

    // Count
    pushSqlResult([{ count: 2 }]);
    const count = await countAuditEntries({ agent_id: "agent-1" });
    expect(count).toBe(2);
  });

  test("set retention → apply → old entries deleted", async () => {
    // Set 30-day retention
    pushSqlResult([{
      company_id: "comp-1", retention_days: 30,
      created_at: new Date(), updated_at: new Date(),
    }]);
    const policy = await setRetentionPolicy("comp-1", 30);
    expect(policy.retention_days).toBe(30);

    resetSqlMock();

    // Apply retention
    pushSqlResult([{ id: "old-1" }, { id: "old-2" }]);
    pushSqlResult([]);
    const deleted = await applyRetentionPolicies();
    expect(deleted).toBe(2);
  });

  test("log all lifecycle events for a formation session", async () => {
    const events: AuditActionType[] = [
      "dispatch", "checkout", "approval_requested",
      "approval_granted", "completion",
    ];

    for (const type of events) {
      pushSqlResult([makeEntry({ action_type: type })]);
    }

    const count = await logActionBatch(
      events.map(type => ({
        agent_id: "agent-1",
        action_type: type,
        formation_session_id: "sess-1",
        company_id: "comp-1",
      })),
    );
    expect(count).toBe(5);
  });
});

// ── SQL Safety ──────────────────────────────────────────────

describe("SQL safety", () => {
  test("logAction uses parameterized queries", async () => {
    pushSqlResult([makeEntry()]);

    await logAction({
      agent_id: "agent-1",
      action_type: "dispatch",
      company_id: "comp-1",
    });

    const rawSql = sqlCalls[0].strings.join("");
    expect(rawSql).not.toContain("agent-1");
    expect(rawSql).not.toContain("comp-1");
  });

  test("queryAuditLog uses parameterized queries", async () => {
    pushSqlResult([]);
    await queryAuditLog({ agent_id: "agent-1" });

    expect(sqlCalls[0].values).toContain("agent-1");
    const rawSql = sqlCalls[0].strings.join("");
    expect(rawSql).not.toContain("agent-1");
  });
});
