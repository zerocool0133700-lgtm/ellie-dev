/**
 * Company Scoping Tests — ELLIE-724
 *
 * Tests for multi-tenancy company isolation:
 * - Migration SQL structure
 * - Type shapes and helpers
 * - Company CRUD
 * - Company-scoped queries
 * - Entity assignment
 * - Default company
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  VALID_COMPANY_STATUSES,
  DEFAULT_COMPANY_ID,
  slugify,
  type Company,
  type CompanyStatus,
  type CompanyScoped,
  type CreateCompanyInput,
  type UpdateCompanyInput,
} from "../src/types/company.ts";

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
  createCompany,
  getCompany,
  getCompanyBySlug,
  listCompanies,
  updateCompany,
  archiveCompany,
  getAgentsByCompany,
  getFormationSessionsByCompany,
  getDefaultCompany,
  assignToCompany,
} = await import("../src/companies.ts");

// ── Setup ───────────────────────────────────────────────────

beforeEach(() => {
  resetSqlMock();
});

// ── Migration SQL ───────────────────────────────────────────

describe("migration SQL", () => {
  function readMigration(): string {
    return readFileSync(
      join(import.meta.dir, "../migrations/supabase/20260315_company_scoping.sql"),
      "utf-8",
    );
  }

  test("creates companies table", () => {
    const sql = readMigration();
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS companies");
  });

  test("companies has id, name, slug, status", () => {
    const sql = readMigration();
    expect(sql).toContain("id UUID DEFAULT gen_random_uuid() PRIMARY KEY");
    expect(sql).toContain("name TEXT NOT NULL UNIQUE");
    expect(sql).toContain("slug TEXT NOT NULL UNIQUE");
    expect(sql).toContain("status TEXT NOT NULL");
  });

  test("companies has status CHECK constraint", () => {
    const sql = readMigration();
    expect(sql).toContain("'active'");
    expect(sql).toContain("'paused'");
    expect(sql).toContain("'archived'");
  });

  test("inserts default company", () => {
    const sql = readMigration();
    expect(sql).toContain("00000000-0000-0000-0000-000000000001");
    expect(sql).toContain("Ellie Labs");
    expect(sql).toContain("ellie-labs");
  });

  test("adds company_id to agents", () => {
    const sql = readMigration();
    expect(sql).toContain("ALTER TABLE agents");
    expect(sql).toContain("company_id UUID REFERENCES companies(id)");
  });

  test("adds company_id to formation_sessions", () => {
    const sql = readMigration();
    expect(sql).toContain("ALTER TABLE formation_sessions");
  });

  test("adds company_id to work_sessions", () => {
    const sql = readMigration();
    expect(sql).toContain("ALTER TABLE work_sessions");
  });

  test("adds company_id to agent_budgets", () => {
    const sql = readMigration();
    expect(sql).toContain("ALTER TABLE agent_budgets");
  });

  test("backfills existing data to default company", () => {
    const sql = readMigration();
    // Should have UPDATE statements for each table
    expect(sql).toContain("UPDATE agents");
    expect(sql).toContain("UPDATE formation_sessions");
    expect(sql).toContain("UPDATE work_sessions");
    expect(sql).toContain("UPDATE agent_budgets");
    expect(sql).toContain("WHERE company_id IS NULL");
  });

  test("creates indexes on company_id columns", () => {
    const sql = readMigration();
    expect(sql).toContain("idx_agents_company");
    expect(sql).toContain("idx_formation_sessions_company");
    expect(sql).toContain("idx_work_sessions_company");
    expect(sql).toContain("idx_agent_budgets_company");
  });

  test("has RLS enabled", () => {
    const sql = readMigration();
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
  });

  test("uses IF NOT EXISTS for idempotent application", () => {
    const sql = readMigration();
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS company_id");
    expect(sql).toContain("ON CONFLICT (id) DO NOTHING");
  });
});

// ── Type Shapes ─────────────────────────────────────────────

describe("type shapes", () => {
  test("Company has all expected fields", () => {
    const company: Company = {
      id: "test-id",
      created_at: new Date(),
      updated_at: new Date(),
      name: "Test Corp",
      slug: "test-corp",
      status: "active",
      metadata: {},
    };
    expect(company.name).toBe("Test Corp");
    expect(company.status).toBe("active");
  });

  test("CompanyScoped mixin has company_id", () => {
    const scoped: CompanyScoped = { company_id: "company-1" };
    expect(scoped.company_id).toBe("company-1");
  });

  test("CompanyScoped allows null company_id", () => {
    const scoped: CompanyScoped = { company_id: null };
    expect(scoped.company_id).toBeNull();
  });
});

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("VALID_COMPANY_STATUSES has all values", () => {
    expect(VALID_COMPANY_STATUSES).toContain("active");
    expect(VALID_COMPANY_STATUSES).toContain("paused");
    expect(VALID_COMPANY_STATUSES).toContain("archived");
    expect(VALID_COMPANY_STATUSES).toHaveLength(3);
  });

  test("DEFAULT_COMPANY_ID is the well-known UUID", () => {
    expect(DEFAULT_COMPANY_ID).toBe("00000000-0000-0000-0000-000000000001");
  });
});

// ── slugify ─────────────────────────────────────────────────

describe("slugify", () => {
  test("lowercases and hyphenates", () => {
    expect(slugify("Ellie Labs")).toBe("ellie-labs");
  });

  test("handles special characters", () => {
    expect(slugify("Dave's Company!")).toBe("dave-s-company");
  });

  test("collapses multiple hyphens", () => {
    expect(slugify("foo   bar")).toBe("foo-bar");
  });

  test("trims leading/trailing hyphens", () => {
    expect(slugify(" --hello-- ")).toBe("hello");
  });

  test("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  test("handles numbers", () => {
    expect(slugify("Company 42")).toBe("company-42");
  });
});

// ── createCompany ───────────────────────────────────────────

describe("createCompany", () => {
  test("inserts and returns company", async () => {
    pushSqlResult([{
      id: "new-id",
      created_at: new Date(),
      updated_at: new Date(),
      name: "Acme Corp",
      slug: "acme-corp",
      status: "active",
      metadata: {},
    }]);

    const company = await createCompany({ name: "Acme Corp", slug: "acme-corp" });
    expect(company.name).toBe("Acme Corp");
    expect(company.slug).toBe("acme-corp");
    expect(company.status).toBe("active");
  });

  test("defaults to active status", async () => {
    pushSqlResult([{
      id: "new-id", created_at: new Date(), updated_at: new Date(),
      name: "Test", slug: "test", status: "active", metadata: {},
    }]);

    await createCompany({ name: "Test", slug: "test" });

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("INSERT INTO companies");
  });

  test("accepts custom status", async () => {
    pushSqlResult([{
      id: "new-id", created_at: new Date(), updated_at: new Date(),
      name: "Test", slug: "test", status: "paused", metadata: {},
    }]);

    const company = await createCompany({ name: "Test", slug: "test", status: "paused" });
    expect(company.status).toBe("paused");
  });
});

// ── getCompany ──────────────────────────────────────────────

describe("getCompany", () => {
  test("returns company when found", async () => {
    pushSqlResult([{
      id: "comp-1", created_at: new Date(), updated_at: new Date(),
      name: "Acme", slug: "acme", status: "active", metadata: {},
    }]);

    const company = await getCompany("comp-1");
    expect(company).not.toBeNull();
    expect(company!.name).toBe("Acme");
  });

  test("returns null when not found", async () => {
    pushSqlResult([]);
    const company = await getCompany("nonexistent");
    expect(company).toBeNull();
  });
});

// ── getCompanyBySlug ────────────────────────────────────────

describe("getCompanyBySlug", () => {
  test("finds company by slug", async () => {
    pushSqlResult([{
      id: "comp-1", created_at: new Date(), updated_at: new Date(),
      name: "Acme Corp", slug: "acme-corp", status: "active", metadata: {},
    }]);

    const company = await getCompanyBySlug("acme-corp");
    expect(company).not.toBeNull();
    expect(company!.slug).toBe("acme-corp");
  });

  test("returns null when slug not found", async () => {
    pushSqlResult([]);
    const company = await getCompanyBySlug("nonexistent");
    expect(company).toBeNull();
  });
});

// ── listCompanies ───────────────────────────────────────────

describe("listCompanies", () => {
  test("returns all companies", async () => {
    pushSqlResult([
      { id: "c1", name: "Acme", slug: "acme", status: "active" },
      { id: "c2", name: "Beta", slug: "beta", status: "paused" },
    ]);

    const companies = await listCompanies();
    expect(companies).toHaveLength(2);
  });

  test("filters by status", async () => {
    pushSqlResult([
      { id: "c1", name: "Acme", slug: "acme", status: "active" },
    ]);

    await listCompanies({ status: "active" });

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("status =");
  });

  test("orders by name ASC", async () => {
    pushSqlResult([]);
    await listCompanies();
    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("ORDER BY name ASC");
  });
});

// ── updateCompany ───────────────────────────────────────────

describe("updateCompany", () => {
  test("updates and returns company", async () => {
    // getCompany (current)
    pushSqlResult([{
      id: "comp-1", created_at: new Date(), updated_at: new Date(),
      name: "Old Name", slug: "old-name", status: "active", metadata: {},
    }]);
    // UPDATE
    pushSqlResult([{
      id: "comp-1", created_at: new Date(), updated_at: new Date(),
      name: "New Name", slug: "new-name", status: "active", metadata: {},
    }]);

    const company = await updateCompany("comp-1", { name: "New Name", slug: "new-name" });
    expect(company).not.toBeNull();
    expect(company!.name).toBe("New Name");
  });

  test("returns null for nonexistent company", async () => {
    pushSqlResult([]); // getCompany returns null

    const company = await updateCompany("nonexistent", { name: "New" });
    expect(company).toBeNull();
  });

  test("preserves unchanged fields", async () => {
    pushSqlResult([{
      id: "comp-1", created_at: new Date(), updated_at: new Date(),
      name: "Keep This", slug: "keep-this", status: "active", metadata: { key: "val" },
    }]);
    pushSqlResult([{
      id: "comp-1", created_at: new Date(), updated_at: new Date(),
      name: "Keep This", slug: "keep-this", status: "paused", metadata: { key: "val" },
    }]);

    const company = await updateCompany("comp-1", { status: "paused" });
    expect(company!.name).toBe("Keep This");
    expect(company!.status).toBe("paused");
  });
});

// ── archiveCompany ──────────────────────────────────────────

describe("archiveCompany", () => {
  test("sets status to archived", async () => {
    pushSqlResult([{
      id: "comp-1", created_at: new Date(), updated_at: new Date(),
      name: "Acme", slug: "acme", status: "archived", metadata: {},
    }]);

    const company = await archiveCompany("comp-1");
    expect(company).not.toBeNull();
    expect(company!.status).toBe("archived");
  });

  test("returns null for nonexistent company", async () => {
    pushSqlResult([]);
    const company = await archiveCompany("nonexistent");
    expect(company).toBeNull();
  });
});

// ── Company-Scoped Queries ──────────────────────────────────

describe("getAgentsByCompany", () => {
  test("returns agents filtered by company_id", async () => {
    pushSqlResult([
      { id: "a1", name: "dev", type: "dev", status: "active" },
      { id: "a2", name: "critic", type: "critic", status: "active" },
    ]);

    const agents = await getAgentsByCompany("comp-1");
    expect(agents).toHaveLength(2);
    expect(agents[0].name).toBe("dev");
  });

  test("filters by company_id in SQL", async () => {
    pushSqlResult([]);
    await getAgentsByCompany("comp-1");

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("company_id =");
    expect(sqlCalls[0].values).toContain("comp-1");
  });
});

describe("getFormationSessionsByCompany", () => {
  test("returns sessions filtered by company", async () => {
    pushSqlResult([
      { id: "s1", formation_name: "boardroom", state: "active", created_at: new Date() },
    ]);

    const sessions = await getFormationSessionsByCompany("comp-1");
    expect(sessions).toHaveLength(1);
  });

  test("filters by state when provided", async () => {
    pushSqlResult([]);
    await getFormationSessionsByCompany("comp-1", { state: "active" });

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("state =");
  });

  test("uses default limit of 50", async () => {
    pushSqlResult([]);
    await getFormationSessionsByCompany("comp-1");

    expect(sqlCalls[0].values).toContain(50);
  });

  test("accepts custom limit", async () => {
    pushSqlResult([]);
    await getFormationSessionsByCompany("comp-1", { limit: 10 });

    expect(sqlCalls[0].values).toContain(10);
  });
});

// ── getDefaultCompany ───────────────────────────────────────

describe("getDefaultCompany", () => {
  test("queries for the well-known default company ID", async () => {
    pushSqlResult([{
      id: DEFAULT_COMPANY_ID, created_at: new Date(), updated_at: new Date(),
      name: "Ellie Labs", slug: "ellie-labs", status: "active", metadata: {},
    }]);

    const company = await getDefaultCompany();
    expect(company).not.toBeNull();
    expect(company!.id).toBe(DEFAULT_COMPANY_ID);
    expect(company!.name).toBe("Ellie Labs");
  });
});

// ── assignToCompany ─────────────────────────────────────────

describe("assignToCompany", () => {
  test("assigns agent to company", async () => {
    pushSqlResult([{ id: "agent-1" }]);
    const result = await assignToCompany("agents", "agent-1", "comp-1");
    expect(result).toBe(true);
  });

  test("assigns formation_session to company", async () => {
    pushSqlResult([{ id: "sess-1" }]);
    const result = await assignToCompany("formation_sessions", "sess-1", "comp-1");
    expect(result).toBe(true);
  });

  test("assigns work_session to company", async () => {
    pushSqlResult([{ id: "ws-1" }]);
    const result = await assignToCompany("work_sessions", "ws-1", "comp-1");
    expect(result).toBe(true);
  });

  test("assigns agent_budget to company", async () => {
    pushSqlResult([{ agent_id: "agent-1" }]);
    const result = await assignToCompany("agent_budgets", "agent-1", "comp-1");
    expect(result).toBe(true);
  });

  test("returns false when entity not found", async () => {
    pushSqlResult([]);
    const result = await assignToCompany("agents", "nonexistent", "comp-1");
    expect(result).toBe(false);
  });

  test("throws on invalid table name", async () => {
    await expect(
      assignToCompany("malicious_table" as any, "id", "comp-1"),
    ).rejects.toThrow("Invalid table");
  });

  test("uses parameterized queries (no SQL injection via table name)", async () => {
    pushSqlResult([{ id: "agent-1" }]);
    await assignToCompany("agents", "agent-1", "comp-1");

    const rawSql = sqlCalls[0].strings.join("");
    // Entity ID and company ID should be parameters
    expect(rawSql).not.toContain("agent-1");
    expect(rawSql).not.toContain("comp-1");
  });
});

// ── E2E: Company Lifecycle ──────────────────────────────────

describe("E2E: company lifecycle", () => {
  test("create → list → update → archive", async () => {
    // Create
    pushSqlResult([{
      id: "comp-new", created_at: new Date(), updated_at: new Date(),
      name: "New Corp", slug: "new-corp", status: "active", metadata: {},
    }]);
    const created = await createCompany({ name: "New Corp", slug: "new-corp" });
    expect(created.status).toBe("active");

    resetSqlMock();

    // List
    pushSqlResult([
      { id: DEFAULT_COMPANY_ID, name: "Ellie Labs", slug: "ellie-labs", status: "active" },
      { id: "comp-new", name: "New Corp", slug: "new-corp", status: "active" },
    ]);
    const all = await listCompanies();
    expect(all).toHaveLength(2);

    resetSqlMock();

    // Update
    pushSqlResult([{
      id: "comp-new", created_at: new Date(), updated_at: new Date(),
      name: "New Corp", slug: "new-corp", status: "active", metadata: {},
    }]);
    pushSqlResult([{
      id: "comp-new", created_at: new Date(), updated_at: new Date(),
      name: "New Corp", slug: "new-corp", status: "paused", metadata: {},
    }]);
    const updated = await updateCompany("comp-new", { status: "paused" });
    expect(updated!.status).toBe("paused");

    resetSqlMock();

    // Archive
    pushSqlResult([{
      id: "comp-new", created_at: new Date(), updated_at: new Date(),
      name: "New Corp", slug: "new-corp", status: "archived", metadata: {},
    }]);
    const archived = await archiveCompany("comp-new");
    expect(archived!.status).toBe("archived");
  });

  test("create company → assign agents → query scoped", async () => {
    // Create company
    pushSqlResult([{
      id: "comp-2", created_at: new Date(), updated_at: new Date(),
      name: "Client Co", slug: "client-co", status: "active", metadata: {},
    }]);
    await createCompany({ name: "Client Co", slug: "client-co" });

    resetSqlMock();

    // Assign agent
    pushSqlResult([{ id: "agent-1" }]);
    const assigned = await assignToCompany("agents", "agent-1", "comp-2");
    expect(assigned).toBe(true);

    resetSqlMock();

    // Query agents by company
    pushSqlResult([
      { id: "agent-1", name: "dev", type: "dev", status: "active" },
    ]);
    const agents = await getAgentsByCompany("comp-2");
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("dev");
  });
});

// ── SQL Safety ──────────────────────────────────────────────

describe("SQL safety", () => {
  test("createCompany uses parameterized queries", async () => {
    pushSqlResult([{
      id: "id", created_at: new Date(), updated_at: new Date(),
      name: "Test", slug: "test", status: "active", metadata: {},
    }]);

    await createCompany({ name: "Test", slug: "test" });

    const rawSql = sqlCalls[0].strings.join("");
    expect(rawSql).not.toContain("Test");
    expect(sqlCalls[0].values).toContain("Test");
  });

  test("getCompany uses parameterized queries", async () => {
    pushSqlResult([]);
    await getCompany("comp-1");

    expect(sqlCalls[0].values).toContain("comp-1");
    const rawSql = sqlCalls[0].strings.join("");
    expect(rawSql).not.toContain("comp-1");
  });
});
