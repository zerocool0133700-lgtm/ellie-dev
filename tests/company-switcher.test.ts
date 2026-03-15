/**
 * Company Switcher Tests — ELLIE-729
 *
 * Tests for company context management and switcher API:
 * - Context state manager (pure functions)
 * - Validation and serialization
 * - Switcher company list
 * - Dashboard summary aggregation
 * - Company access validation
 * - E2E switcher lifecycle
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import type {
  CompanySwitcherItem,
  CompanyDashboardSummary,
  CompanyContextState,
} from "../src/company-context.ts";
import { DEFAULT_COMPANY_ID } from "../src/types/company.ts";

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
  createCompanyContext,
  switchCompany,
  validateCompanyContext,
  serializeContext,
  deserializeContext,
  listSwitcherCompanies,
  getCompanyDashboardSummary,
  validateCompanyAccess,
} = await import("../src/company-context.ts");

// ── Setup ───────────────────────────────────────────────────

beforeEach(() => {
  resetSqlMock();
});

// ── createCompanyContext (Pure) ──────────────────────────────

describe("createCompanyContext", () => {
  test("defaults to DEFAULT_COMPANY_ID", () => {
    const ctx = createCompanyContext();
    expect(ctx.selected_company_id).toBe(DEFAULT_COMPANY_ID);
    expect(ctx.selected_at).toBeTruthy();
  });

  test("accepts custom company ID", () => {
    const ctx = createCompanyContext("custom-id");
    expect(ctx.selected_company_id).toBe("custom-id");
  });

  test("sets selected_at to a valid ISO timestamp", () => {
    const ctx = createCompanyContext();
    const d = new Date(ctx.selected_at);
    expect(isNaN(d.getTime())).toBe(false);
  });
});

// ── switchCompany (Pure) ────────────────────────────────────

describe("switchCompany", () => {
  test("returns new context with updated company", () => {
    const ctx = createCompanyContext("comp-1");
    const switched = switchCompany(ctx, "comp-2");
    expect(switched.selected_company_id).toBe("comp-2");
    expect(switched).not.toBe(ctx); // New object
  });

  test("no-op when switching to same company", () => {
    const ctx = createCompanyContext("comp-1");
    const switched = switchCompany(ctx, "comp-1");
    expect(switched).toBe(ctx); // Same reference
  });

  test("updates selected_at on switch", () => {
    const ctx = createCompanyContext("comp-1");
    // Force a different timestamp by creating context with old date
    const oldCtx: CompanyContextState = {
      selected_company_id: "comp-1",
      selected_at: "2026-01-01T00:00:00Z",
    };
    const switched = switchCompany(oldCtx, "comp-2");
    expect(switched.selected_at).not.toBe("2026-01-01T00:00:00Z");
  });

  test("preserves immutability (doesn't mutate original)", () => {
    const ctx: CompanyContextState = {
      selected_company_id: "comp-1",
      selected_at: "2026-03-15T10:00:00Z",
    };
    const switched = switchCompany(ctx, "comp-2");
    expect(ctx.selected_company_id).toBe("comp-1"); // Original unchanged
    expect(switched.selected_company_id).toBe("comp-2");
  });
});

// ── validateCompanyContext (Pure) ────────────────────────────

describe("validateCompanyContext", () => {
  test("valid context returns empty errors", () => {
    const errors = validateCompanyContext({
      selected_company_id: "comp-1",
      selected_at: new Date().toISOString(),
    });
    expect(errors).toHaveLength(0);
  });

  test("null input returns error", () => {
    const errors = validateCompanyContext(null);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("non-object input returns error", () => {
    const errors = validateCompanyContext("not-an-object");
    expect(errors.length).toBeGreaterThan(0);
  });

  test("missing selected_company_id returns error", () => {
    const errors = validateCompanyContext({ selected_at: new Date().toISOString() });
    expect(errors.some(e => e.includes("selected_company_id"))).toBe(true);
  });

  test("empty selected_company_id returns error", () => {
    const errors = validateCompanyContext({ selected_company_id: "", selected_at: new Date().toISOString() });
    expect(errors.some(e => e.includes("selected_company_id"))).toBe(true);
  });

  test("missing selected_at returns error", () => {
    const errors = validateCompanyContext({ selected_company_id: "comp-1" });
    expect(errors.some(e => e.includes("selected_at"))).toBe(true);
  });

  test("invalid selected_at returns error", () => {
    const errors = validateCompanyContext({ selected_company_id: "comp-1", selected_at: "not-a-date" });
    expect(errors.some(e => e.includes("valid ISO timestamp"))).toBe(true);
  });
});

// ── serializeContext / deserializeContext (Pure) ─────────────

describe("serializeContext", () => {
  test("serializes to JSON string", () => {
    const ctx = createCompanyContext("comp-1");
    const json = serializeContext(ctx);
    expect(typeof json).toBe("string");
    expect(JSON.parse(json).selected_company_id).toBe("comp-1");
  });
});

describe("deserializeContext", () => {
  test("deserializes valid JSON", () => {
    const ctx = createCompanyContext("comp-1");
    const json = serializeContext(ctx);
    const restored = deserializeContext(json);
    expect(restored).not.toBeNull();
    expect(restored!.selected_company_id).toBe("comp-1");
  });

  test("returns null for invalid JSON", () => {
    expect(deserializeContext("not json")).toBeNull();
  });

  test("returns null for valid JSON with invalid structure", () => {
    expect(deserializeContext('{"foo": "bar"}')).toBeNull();
  });

  test("round-trips correctly", () => {
    const original = createCompanyContext("my-company");
    const roundTripped = deserializeContext(serializeContext(original));
    expect(roundTripped).toEqual(original);
  });
});

// ── listSwitcherCompanies ───────────────────────────────────

describe("listSwitcherCompanies", () => {
  test("returns active and paused companies", async () => {
    pushSqlResult([
      { id: "c1", name: "Ellie Labs", slug: "ellie-labs", status: "active" },
      { id: "c2", name: "Client Co", slug: "client-co", status: "paused" },
    ]);

    const companies = await listSwitcherCompanies();
    expect(companies).toHaveLength(2);
    expect(companies[0].name).toBe("Ellie Labs");
  });

  test("excludes archived companies in SQL", async () => {
    pushSqlResult([]);
    await listSwitcherCompanies();

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("IN ('active', 'paused')");
    expect(sqlText).toContain("ORDER BY name ASC");
  });
});

// ── getCompanyDashboardSummary ──────────────────────────────

describe("getCompanyDashboardSummary", () => {
  test("aggregates all metrics", async () => {
    pushSqlResult([{ count: 5 }]);   // agents
    pushSqlResult([{ count: 3 }]);   // active formations
    pushSqlResult([{ count: 2 }]);   // pending approvals
    pushSqlResult([{ total: 4500 }]); // monthly spend

    const summary = await getCompanyDashboardSummary("comp-1");
    expect(summary.company_id).toBe("comp-1");
    expect(summary.agent_count).toBe(5);
    expect(summary.active_formations).toBe(3);
    expect(summary.pending_approvals).toBe(2);
    expect(summary.monthly_spend_cents).toBe(4500);
  });

  test("handles zero metrics gracefully", async () => {
    pushSqlResult([{ count: 0 }]);
    pushSqlResult([{ count: 0 }]);
    pushSqlResult([{ count: 0 }]);
    pushSqlResult([{ total: 0 }]);

    const summary = await getCompanyDashboardSummary("comp-1");
    expect(summary.agent_count).toBe(0);
    expect(summary.active_formations).toBe(0);
    expect(summary.pending_approvals).toBe(0);
    expect(summary.monthly_spend_cents).toBe(0);
  });

  test("issues 4 separate queries", async () => {
    pushSqlResult([{ count: 0 }]);
    pushSqlResult([{ count: 0 }]);
    pushSqlResult([{ count: 0 }]);
    pushSqlResult([{ total: 0 }]);

    await getCompanyDashboardSummary("comp-1");
    expect(sqlCalls).toHaveLength(4);
  });

  test("scopes all queries to company_id", async () => {
    pushSqlResult([{ count: 0 }]);
    pushSqlResult([{ count: 0 }]);
    pushSqlResult([{ count: 0 }]);
    pushSqlResult([{ total: 0 }]);

    await getCompanyDashboardSummary("comp-1");

    for (const call of sqlCalls) {
      expect(call.values).toContain("comp-1");
    }
  });
});

// ── validateCompanyAccess ───────────────────────────────────

describe("validateCompanyAccess", () => {
  test("returns valid for active company", async () => {
    pushSqlResult([{ id: "comp-1", status: "active" }]);

    const result = await validateCompanyAccess("comp-1");
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("returns valid for paused company", async () => {
    pushSqlResult([{ id: "comp-1", status: "paused" }]);

    const result = await validateCompanyAccess("comp-1");
    expect(result.valid).toBe(true);
  });

  test("returns invalid for archived company", async () => {
    pushSqlResult([{ id: "comp-1", status: "archived" }]);

    const result = await validateCompanyAccess("comp-1");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("archived");
  });

  test("returns invalid for nonexistent company", async () => {
    pushSqlResult([]);

    const result = await validateCompanyAccess("nonexistent");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("not found");
  });
});

// ── E2E: Switcher Lifecycle ─────────────────────────────────

describe("E2E: company switcher lifecycle", () => {
  test("create context → list companies → switch → validate → summary", async () => {
    // Step 1: Create default context
    const ctx = createCompanyContext();
    expect(ctx.selected_company_id).toBe(DEFAULT_COMPANY_ID);

    // Step 2: List companies
    pushSqlResult([
      { id: DEFAULT_COMPANY_ID, name: "Ellie Labs", slug: "ellie-labs", status: "active" },
      { id: "comp-2", name: "Client Co", slug: "client-co", status: "active" },
    ]);
    const companies = await listSwitcherCompanies();
    expect(companies).toHaveLength(2);

    resetSqlMock();

    // Step 3: Validate target company
    pushSqlResult([{ id: "comp-2", status: "active" }]);
    const access = await validateCompanyAccess("comp-2");
    expect(access.valid).toBe(true);

    // Step 4: Switch
    const switched = switchCompany(ctx, "comp-2");
    expect(switched.selected_company_id).toBe("comp-2");

    resetSqlMock();

    // Step 5: Get summary for new company
    pushSqlResult([{ count: 3 }]);
    pushSqlResult([{ count: 1 }]);
    pushSqlResult([{ count: 0 }]);
    pushSqlResult([{ total: 1200 }]);
    const summary = await getCompanyDashboardSummary("comp-2");
    expect(summary.agent_count).toBe(3);
    expect(summary.monthly_spend_cents).toBe(1200);
  });

  test("persist → restore context across page loads", () => {
    const ctx = createCompanyContext("comp-2");
    const serialized = serializeContext(ctx);

    // Simulate page reload — deserialize from localStorage
    const restored = deserializeContext(serialized);
    expect(restored).not.toBeNull();
    expect(restored!.selected_company_id).toBe("comp-2");
    expect(restored!.selected_at).toBe(ctx.selected_at);
  });

  test("reject switch to archived company", async () => {
    const ctx = createCompanyContext();

    pushSqlResult([{ id: "archived-co", status: "archived" }]);
    const access = await validateCompanyAccess("archived-co");
    expect(access.valid).toBe(false);

    // Context should NOT be switched
    expect(ctx.selected_company_id).toBe(DEFAULT_COMPANY_ID);
  });

  test("handle corrupted localStorage gracefully", () => {
    expect(deserializeContext("")).toBeNull();
    expect(deserializeContext("null")).toBeNull();
    expect(deserializeContext("undefined")).toBeNull();
    expect(deserializeContext("{invalid json")).toBeNull();
    expect(deserializeContext('{"selected_company_id": ""}')).toBeNull();
  });
});

// ── SQL Safety ──────────────────────────────────────────────

describe("SQL safety", () => {
  test("getCompanyDashboardSummary uses parameterized queries", async () => {
    pushSqlResult([{ count: 0 }]);
    pushSqlResult([{ count: 0 }]);
    pushSqlResult([{ count: 0 }]);
    pushSqlResult([{ total: 0 }]);

    await getCompanyDashboardSummary("comp-1");

    for (const call of sqlCalls) {
      const rawSql = call.strings.join("");
      expect(rawSql).not.toContain("comp-1");
    }
  });

  test("validateCompanyAccess uses parameterized queries", async () => {
    pushSqlResult([]);
    await validateCompanyAccess("comp-1");

    expect(sqlCalls[0].values).toContain("comp-1");
    expect(sqlCalls[0].strings.join("")).not.toContain("comp-1");
  });
});
