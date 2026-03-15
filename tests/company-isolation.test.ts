/**
 * Company Data Isolation Tests — ELLIE-730
 *
 * Tests for per-company data isolation:
 * - Migration SQL structure (RLS policies, helper function)
 * - Company context set/clear/get
 * - Request middleware (header, JWT, session, default extraction)
 * - UUID validation
 * - Table isolation verification
 * - Isolation audit
 * - Cross-company isolation test helper
 * - Constants
 * - E2E isolation lifecycle
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import type {
  CompanyRequestContext,
  IsolationCheckResult,
  CompanyScopedTable,
} from "../src/company-isolation.ts";

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

// Add sql() as callable for dynamic table names
(mockSql as any).__proto__ = Function.prototype;

mock.module("../../ellie-forest/src/index", () => ({
  sql: mockSql,
}));

const {
  setCompanyContext,
  clearCompanyContext,
  getCompanyContext,
  extractCompanyFromRequest,
  isValidCompanyId,
  verifyTableIsolation,
  auditIsolation,
  _testCrossCompanyIsolation,
  COMPANY_SCOPED_TABLES,
} = await import("../src/company-isolation.ts");

// ── Setup ───────────────────────────────────────────────────

beforeEach(() => {
  resetSqlMock();
});

// ── Migration SQL ───────────────────────────────────────────

describe("migration SQL", () => {
  function readMigration(): string {
    return readFileSync(
      join(import.meta.dir, "../migrations/supabase/20260315_company_rls_policies.sql"),
      "utf-8",
    );
  }

  test("creates current_company_id() helper function", () => {
    const sql = readMigration();
    expect(sql).toContain("CREATE OR REPLACE FUNCTION current_company_id()");
    expect(sql).toContain("app.current_company_id");
  });

  test("adds is_system_agent column to agents", () => {
    expect(readMigration()).toContain("is_system_agent BOOLEAN DEFAULT false");
  });

  test("creates RLS policy for agents (includes system agent check)", () => {
    const sql = readMigration();
    expect(sql).toContain("company_isolation_agents");
    expect(sql).toContain("is_system_agent = true");
  });

  test("creates RLS policy for formation_sessions", () => {
    expect(readMigration()).toContain("company_isolation_formation_sessions");
  });

  test("creates RLS policy for work_sessions", () => {
    expect(readMigration()).toContain("company_isolation_work_sessions");
  });

  test("creates RLS policy for agent_budgets", () => {
    expect(readMigration()).toContain("company_isolation_agent_budgets");
  });

  test("creates RLS policy for agent_audit_log", () => {
    expect(readMigration()).toContain("company_isolation_agent_audit_log");
  });

  test("creates RLS policy for agent_delegations", () => {
    expect(readMigration()).toContain("company_isolation_agent_delegations");
  });

  test("all policies allow service role (NULL context)", () => {
    const sql = readMigration();
    const nullChecks = (sql.match(/current_company_id\(\) IS NULL/g) || []).length;
    expect(nullChecks).toBeGreaterThanOrEqual(6);
  });

  test("drops old blanket policies before creating scoped ones", () => {
    const sql = readMigration();
    const drops = (sql.match(/DROP POLICY IF EXISTS/g) || []).length;
    expect(drops).toBeGreaterThanOrEqual(6);
  });
});

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("COMPANY_SCOPED_TABLES lists all 6 scoped tables", () => {
    expect(COMPANY_SCOPED_TABLES).toHaveLength(6);
    expect(COMPANY_SCOPED_TABLES).toContain("agents");
    expect(COMPANY_SCOPED_TABLES).toContain("formation_sessions");
    expect(COMPANY_SCOPED_TABLES).toContain("work_sessions");
    expect(COMPANY_SCOPED_TABLES).toContain("agent_budgets");
    expect(COMPANY_SCOPED_TABLES).toContain("agent_audit_log");
    expect(COMPANY_SCOPED_TABLES).toContain("agent_delegations");
  });
});

// ── setCompanyContext ───────────────────────────────────────

describe("setCompanyContext", () => {
  test("sets app.current_company_id via set_config", async () => {
    pushSqlResult([]);
    await setCompanyContext("comp-1");

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("set_config");
    expect(sqlText).toContain("app.current_company_id");
    expect(sqlCalls[0].values).toContain("comp-1");
  });
});

// ── clearCompanyContext ─────────────────────────────────────

describe("clearCompanyContext", () => {
  test("clears context by setting empty string", async () => {
    pushSqlResult([]);
    await clearCompanyContext();

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("set_config");
  });
});

// ── getCompanyContext ───────────────────────────────────────

describe("getCompanyContext", () => {
  test("returns company ID when set", async () => {
    pushSqlResult([{ value: "comp-1" }]);

    const ctx = await getCompanyContext();
    expect(ctx).toBe("comp-1");
  });

  test("returns null when not set", async () => {
    pushSqlResult([{ value: null }]);

    const ctx = await getCompanyContext();
    expect(ctx).toBeNull();
  });

  test("returns null when empty", async () => {
    pushSqlResult([]);

    const ctx = await getCompanyContext();
    expect(ctx).toBeNull();
  });
});

// ── extractCompanyFromRequest (Pure) ────────────────────────

describe("extractCompanyFromRequest", () => {
  test("extracts from X-Company-Id header (priority 1)", () => {
    const result = extractCompanyFromRequest(
      { "x-company-id": "comp-from-header" },
      { company_id: "comp-from-jwt" },
      "comp-from-session",
      "comp-default",
    );
    expect(result).not.toBeNull();
    expect(result!.company_id).toBe("comp-from-header");
    expect(result!.source).toBe("header");
  });

  test("falls back to JWT claim (priority 2)", () => {
    const result = extractCompanyFromRequest(
      {},
      { company_id: "comp-from-jwt" },
      "comp-from-session",
    );
    expect(result!.company_id).toBe("comp-from-jwt");
    expect(result!.source).toBe("jwt");
  });

  test("falls back to session (priority 3)", () => {
    const result = extractCompanyFromRequest({}, undefined, "comp-from-session");
    expect(result!.company_id).toBe("comp-from-session");
    expect(result!.source).toBe("session");
  });

  test("falls back to default (priority 4)", () => {
    const result = extractCompanyFromRequest({}, undefined, undefined, "comp-default");
    expect(result!.company_id).toBe("comp-default");
    expect(result!.source).toBe("default");
  });

  test("returns null when no context available", () => {
    const result = extractCompanyFromRequest({});
    expect(result).toBeNull();
  });

  test("ignores empty header", () => {
    const result = extractCompanyFromRequest(
      { "x-company-id": "" },
      undefined,
      undefined,
      "comp-default",
    );
    expect(result!.source).toBe("default");
  });

  test("trims whitespace from header", () => {
    const result = extractCompanyFromRequest({ "x-company-id": "  comp-1  " });
    expect(result!.company_id).toBe("comp-1");
  });
});

// ── isValidCompanyId (Pure) ─────────────────────────────────

describe("isValidCompanyId", () => {
  test("valid UUID passes", () => {
    expect(isValidCompanyId("00000000-0000-0000-0000-000000000001")).toBe(true);
    expect(isValidCompanyId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  test("uppercase UUID passes", () => {
    expect(isValidCompanyId("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  test("invalid formats fail", () => {
    expect(isValidCompanyId("not-a-uuid")).toBe(false);
    expect(isValidCompanyId("")).toBe(false);
    expect(isValidCompanyId("550e8400-e29b-41d4-a716")).toBe(false);
    expect(isValidCompanyId("550e8400e29b41d4a716446655440000")).toBe(false);
  });
});

// ── verifyTableIsolation ────────────────────────────────────

describe("verifyTableIsolation", () => {
  test("returns isolated=true when column and RLS exist", async () => {
    pushSqlResult([{ exists: true }]);   // column check
    pushSqlResult([{ rowsecurity: true }]); // RLS check

    const result = await verifyTableIsolation("agents");
    expect(result.isolated).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("reports missing company_id column", async () => {
    pushSqlResult([{ exists: false }]);
    pushSqlResult([{ rowsecurity: true }]);

    const result = await verifyTableIsolation("agents");
    expect(result.isolated).toBe(false);
    expect(result.errors.some(e => e.includes("company_id"))).toBe(true);
  });

  test("reports missing RLS", async () => {
    pushSqlResult([{ exists: true }]);
    pushSqlResult([{ rowsecurity: false }]);

    const result = await verifyTableIsolation("agents");
    expect(result.isolated).toBe(false);
    expect(result.errors.some(e => e.includes("RLS"))).toBe(true);
  });

  test("reports both issues", async () => {
    pushSqlResult([{ exists: false }]);
    pushSqlResult([{ rowsecurity: false }]);

    const result = await verifyTableIsolation("agents");
    expect(result.isolated).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});

// ── auditIsolation ──────────────────────────────────────────

describe("auditIsolation", () => {
  test("returns all_isolated=true when all tables pass", async () => {
    // 6 tables * 2 queries each = 12
    for (let i = 0; i < 6; i++) {
      pushSqlResult([{ exists: true }]);
      pushSqlResult([{ rowsecurity: true }]);
    }

    const audit = await auditIsolation();
    expect(audit.all_isolated).toBe(true);
    expect(Object.keys(audit.tables)).toHaveLength(6);
  });

  test("returns all_isolated=false when any table fails", async () => {
    // First table fails
    pushSqlResult([{ exists: false }]);
    pushSqlResult([{ rowsecurity: true }]);
    // Rest pass
    for (let i = 0; i < 5; i++) {
      pushSqlResult([{ exists: true }]);
      pushSqlResult([{ rowsecurity: true }]);
    }

    const audit = await auditIsolation();
    expect(audit.all_isolated).toBe(false);
  });

  test("audits all 6 company-scoped tables", async () => {
    for (let i = 0; i < 6; i++) {
      pushSqlResult([{ exists: true }]);
      pushSqlResult([{ rowsecurity: true }]);
    }

    const audit = await auditIsolation();
    for (const table of COMPANY_SCOPED_TABLES) {
      expect(audit.tables[table]).toBeDefined();
    }
  });
});

// ── _testCrossCompanyIsolation ──────────────────────────────

describe("_testCrossCompanyIsolation", () => {
  test("returns isolated=true when no leaked records", async () => {
    pushSqlResult([]); // setCompanyContext
    pushSqlResult([{ count: 0 }]); // cross-company count
    pushSqlResult([]); // clearCompanyContext

    const result = await _testCrossCompanyIsolation("agents", "comp-a", "comp-b");
    expect(result.isolated).toBe(true);
    expect(result.leaked_count).toBe(0);
  });

  test("returns isolated=false with leaked count", async () => {
    pushSqlResult([]);
    pushSqlResult([{ count: 3 }]);
    pushSqlResult([]);

    const result = await _testCrossCompanyIsolation("agents", "comp-a", "comp-b");
    expect(result.isolated).toBe(false);
    expect(result.leaked_count).toBe(3);
  });

  test("sets context, queries, then clears", async () => {
    pushSqlResult([]);
    pushSqlResult([{ count: 0 }]);
    pushSqlResult([]);

    await _testCrossCompanyIsolation("agents", "comp-a", "comp-b");

    // 3 SQL calls: set, query, clear
    expect(sqlCalls).toHaveLength(3);
    expect(sqlCalls[0].strings.join("?")).toContain("set_config");
    expect(sqlCalls[2].strings.join("?")).toContain("set_config");
  });
});

// ── E2E: Isolation Lifecycle ────────────────────────────────

describe("E2E: isolation lifecycle", () => {
  test("extract context → validate → set → query → clear", async () => {
    // Step 1: Extract from request
    const ctx = extractCompanyFromRequest({ "x-company-id": "550e8400-e29b-41d4-a716-446655440000" });
    expect(ctx).not.toBeNull();
    expect(ctx!.source).toBe("header");

    // Step 2: Validate UUID format
    expect(isValidCompanyId(ctx!.company_id)).toBe(true);

    // Step 3: Set context
    pushSqlResult([]);
    await setCompanyContext(ctx!.company_id);

    resetSqlMock();

    // Step 4: Verify context is active
    pushSqlResult([{ value: ctx!.company_id }]);
    const active = await getCompanyContext();
    expect(active).toBe(ctx!.company_id);

    resetSqlMock();

    // Step 5: Clear after request
    pushSqlResult([]);
    await clearCompanyContext();
  });

  test("fallback chain: no header → no JWT → session → works", () => {
    const ctx = extractCompanyFromRequest(
      { "other-header": "val" },
      { unrelated: true },
      "session-company-id",
    );
    expect(ctx!.company_id).toBe("session-company-id");
    expect(ctx!.source).toBe("session");
  });

  test("audit all tables for isolation compliance", async () => {
    for (let i = 0; i < 6; i++) {
      pushSqlResult([{ exists: true }]);
      pushSqlResult([{ rowsecurity: true }]);
    }

    const audit = await auditIsolation();
    expect(audit.all_isolated).toBe(true);

    // Every table should be checked
    for (const table of COMPANY_SCOPED_TABLES) {
      expect(audit.tables[table].isolated).toBe(true);
    }
  });
});

// ── SQL Safety ──────────────────────────────────────────────

describe("SQL safety", () => {
  test("setCompanyContext uses parameterized query", async () => {
    pushSqlResult([]);
    await setCompanyContext("comp-1");

    const rawSql = sqlCalls[0].strings.join("");
    expect(rawSql).not.toContain("comp-1");
    expect(sqlCalls[0].values).toContain("comp-1");
  });

  test("verifyTableIsolation uses parameterized table name", async () => {
    pushSqlResult([{ exists: true }]);
    pushSqlResult([{ rowsecurity: true }]);

    await verifyTableIsolation("agents");

    expect(sqlCalls[0].values).toContain("agents");
  });
});
