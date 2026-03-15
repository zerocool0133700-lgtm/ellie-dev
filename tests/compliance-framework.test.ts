/**
 * HIPAA Security & Compliance Framework Tests — ELLIE-753
 *
 * Tests for state rules, BAA tracking, security audit:
 * - Migration SQL (state_billing_rules, BAAs, immutable audit trigger)
 * - State rules CRUD + timely filing lookup
 * - BAA CRUD + expired BAAs
 * - Timely filing enforcement (pure)
 * - Patient balance limit check (pure)
 * - Security audit report generation (pure)
 * - E2E scenarios
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import type { StateBillingRule, BAA } from "../src/compliance-framework.ts";

// ── Mock SQL Layer ──────────────────────────────────────────

type SqlRow = Record<string, unknown>;
type SqlResult = SqlRow[];
let sqlMockResults: SqlResult[] = [];
let sqlCallIndex = 0;
let sqlCalls: { strings: TemplateStringsArray; values: unknown[] }[] = [];

function resetSqlMock() { sqlMockResults = []; sqlCallIndex = 0; sqlCalls = []; }
function pushSqlResult(rows: SqlResult) { sqlMockResults.push(rows); }

const mockSql = Object.assign(
  function sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlResult> {
    sqlCalls.push({ strings, values });
    const result = sqlMockResults[sqlCallIndex] ?? [];
    sqlCallIndex++;
    return Promise.resolve(result);
  },
  { json: (v: unknown) => v, array: (v: unknown) => v },
);

mock.module("../../ellie-forest/src/index", () => ({ sql: mockSql }));

const {
  createStateRule, getStateRules, getTimelyFilingRule,
  createBAA, getCompanyBAAs, updateBAAStatus, getExpiredBAAs,
  isWithinTimelyFiling, isWithinPatientBalanceLimit,
  generateSecurityAuditReport,
  VALID_RULE_TYPES, VALID_BAA_STATUSES,
} = await import("../src/compliance-framework.ts");

beforeEach(() => { resetSqlMock(); });

// ── Migration SQL ───────────────────────────────────────────

describe("migration SQL", () => {
  function read(): string {
    return readFileSync(join(import.meta.dir, "../migrations/supabase/20260315_hipaa_compliance_tables.sql"), "utf-8");
  }

  test("creates state_billing_rules table", () => {
    expect(read()).toContain("CREATE TABLE IF NOT EXISTS state_billing_rules");
  });

  test("state rules has rule_type CHECK with all types", () => {
    const sql = read();
    for (const t of VALID_RULE_TYPES) expect(sql).toContain(`'${t}'`);
  });

  test("creates business_associate_agreements table", () => {
    expect(read()).toContain("CREATE TABLE IF NOT EXISTS business_associate_agreements");
  });

  test("BAA has status CHECK with all statuses", () => {
    const sql = read();
    for (const s of VALID_BAA_STATUSES) expect(sql).toContain(`'${s}'`);
  });

  test("creates immutable audit triggers (prevent UPDATE + DELETE)", () => {
    const sql = read();
    expect(sql).toContain("prevent_audit_modification");
    expect(sql).toContain("BEFORE UPDATE ON billing_audit_log");
    expect(sql).toContain("BEFORE DELETE ON billing_audit_log");
    expect(sql).toContain("immutable");
  });

  test("has indexes on state_code, rule_type, company", () => {
    const sql = read();
    expect(sql).toContain("idx_sbr_state");
    expect(sql).toContain("idx_sbr_type");
    expect(sql).toContain("idx_sbr_state_type");
  });

  test("has indexes on BAA company, status, vendor", () => {
    const sql = read();
    expect(sql).toContain("idx_baa_company");
    expect(sql).toContain("idx_baa_status");
    expect(sql).toContain("idx_baa_vendor");
  });

  test("has RLS on both tables", () => {
    const sql = read();
    const rls = (sql.match(/ENABLE ROW LEVEL SECURITY/g) || []).length;
    expect(rls).toBeGreaterThanOrEqual(2);
  });
});

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("VALID_RULE_TYPES has 6 types", () => { expect(VALID_RULE_TYPES).toHaveLength(6); });
  test("VALID_BAA_STATUSES has 5 statuses", () => { expect(VALID_BAA_STATUSES).toHaveLength(5); });
});

// ── State Rules ─────────────────────────────────────────────

describe("createStateRule", () => {
  test("inserts and returns rule", async () => {
    pushSqlResult([{ id: "r1", state_code: "TX", rule_type: "timely_filing", description: "90 days", value_days: 90 }]);
    const r = await createStateRule({
      state_code: "TX", rule_type: "timely_filing", payer_type: "commercial",
      description: "90 days for commercial", value_days: 90, value_cents: null,
      value_text: null, effective_date: null, expiration_date: null,
      source_reference: null, company_id: null, metadata: {},
    });
    expect(r.state_code).toBe("TX");
  });
});

describe("getStateRules", () => {
  test("returns rules by state", async () => {
    pushSqlResult([{ id: "r1", state_code: "TX", rule_type: "timely_filing" }]);
    const rules = await getStateRules("TX");
    expect(rules).toHaveLength(1);
  });

  test("filters by rule_type", async () => {
    pushSqlResult([]);
    await getStateRules("TX", "prior_authorization");
    expect(sqlCalls[0].strings.join("?")).toContain("rule_type =");
  });
});

describe("getTimelyFilingRule", () => {
  test("returns timely filing rule for state+payer", async () => {
    pushSqlResult([{ id: "r1", state_code: "TX", rule_type: "timely_filing", value_days: 90, payer_type: "commercial" }]);
    const r = await getTimelyFilingRule("TX", "commercial");
    expect(r).not.toBeNull();
    expect(r!.value_days).toBe(90);
  });

  test("returns null when no rule exists", async () => {
    pushSqlResult([]);
    expect(await getTimelyFilingRule("ZZ")).toBeNull();
  });
});

// ── BAA CRUD ────────────────────────────────────────────────

describe("createBAA", () => {
  test("inserts and returns BAA", async () => {
    pushSqlResult([{
      id: "b1", company_id: "c1", vendor_name: "Supabase",
      service_description: "Database", stores_phi: true, processes_phi: false,
      baa_status: "not_started",
    }]);
    const b = await createBAA({
      company_id: "c1", vendor_name: "Supabase", service_description: "Database",
      stores_phi: true, processes_phi: false, baa_status: "not_started",
      signed_date: null, expiration_date: null, document_url: null,
      contact_email: null, notes: null, metadata: {},
    });
    expect(b.vendor_name).toBe("Supabase");
  });
});

describe("updateBAAStatus", () => {
  test("updates status to signed", async () => {
    pushSqlResult([{ id: "b1", baa_status: "signed", signed_date: "2026-03-15" }]);
    const b = await updateBAAStatus("b1", "signed", "2026-03-15");
    expect(b!.baa_status).toBe("signed");
  });

  test("returns null for nonexistent", async () => {
    pushSqlResult([]);
    expect(await updateBAAStatus("nonexistent", "signed")).toBeNull();
  });
});

describe("getExpiredBAAs", () => {
  test("returns expired BAAs", async () => {
    pushSqlResult([{ id: "b1", vendor_name: "Old Vendor", baa_status: "signed", expiration_date: "2025-01-01" }]);
    const expired = await getExpiredBAAs("c1");
    expect(expired).toHaveLength(1);

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("expiration_date");
    expect(sqlText).toContain("CURRENT_DATE");
  });
});

// ── isWithinTimelyFiling (Pure) ─────────────────────────────

describe("isWithinTimelyFiling", () => {
  test("within filing window", () => {
    const result = isWithinTimelyFiling("2026-03-01", 90, new Date("2026-04-01"));
    expect(result.within).toBe(true);
    expect(result.days_remaining).toBeGreaterThan(0);
  });

  test("past filing deadline", () => {
    const result = isWithinTimelyFiling("2026-01-01", 30, new Date("2026-03-01"));
    expect(result.within).toBe(false);
    expect(result.days_remaining).toBe(0);
  });

  test("calculates deadline correctly", () => {
    const result = isWithinTimelyFiling("2026-01-01", 90, new Date("2026-01-01"));
    // Jan 1 + 90 days = March 31 (31 Jan + 28 Feb + 31 Mar = 90)
    expect(result.deadline).toBe("2026-03-31");
    expect(result.days_remaining).toBeGreaterThanOrEqual(89);
    expect(result.days_remaining).toBeLessThanOrEqual(90);
  });
});

// ── isWithinPatientBalanceLimit (Pure) ───────────────────────

describe("isWithinPatientBalanceLimit", () => {
  test("within limit", () => {
    const r = isWithinPatientBalanceLimit(5000, 10000);
    expect(r.within).toBe(true);
    expect(r.over_by_cents).toBe(0);
  });

  test("over limit", () => {
    const r = isWithinPatientBalanceLimit(15000, 10000);
    expect(r.within).toBe(false);
    expect(r.over_by_cents).toBe(5000);
  });

  test("null limit means no cap", () => {
    const r = isWithinPatientBalanceLimit(999999, null);
    expect(r.within).toBe(true);
  });
});

// ── generateSecurityAuditReport (Pure) ──────────────────────

describe("generateSecurityAuditReport", () => {
  test("perfect score for fully compliant system", () => {
    const report = generateSecurityAuditReport({
      company_id: "c1", phi_encrypted: true, tls_enforced: true,
      rls_enabled: true, agent_roles_configured: true,
      audit_immutable: true, audit_coverage_percent: 100,
      baas: [
        { baa_status: "signed" } as BAA,
        { baa_status: "not_applicable" } as BAA,
      ],
      retention_policy_defined: true, automated_purge: true,
      state_rules: [{ state_code: "TX" } as StateBillingRule],
    });

    expect(report.overall_score).toBe(100);
    expect(report.issues).toHaveLength(0);
  });

  test("low score for non-compliant system", () => {
    const report = generateSecurityAuditReport({
      company_id: "c1", phi_encrypted: false, tls_enforced: false,
      rls_enabled: false, agent_roles_configured: false,
      audit_immutable: false, audit_coverage_percent: 50,
      baas: [{ baa_status: "not_started" } as BAA],
      retention_policy_defined: false, automated_purge: false,
      state_rules: [],
    });

    expect(report.overall_score).toBeLessThan(30);
    expect(report.issues.length).toBeGreaterThan(5);
  });

  test("flags pending and expired BAAs", () => {
    const report = generateSecurityAuditReport({
      company_id: "c1", phi_encrypted: true, tls_enforced: true,
      rls_enabled: true, agent_roles_configured: true,
      audit_immutable: true, audit_coverage_percent: 100,
      baas: [
        { baa_status: "not_started" } as BAA,
        { baa_status: "expired" } as BAA,
      ],
      retention_policy_defined: true, automated_purge: true,
      state_rules: [{ state_code: "TX" } as StateBillingRule],
    });

    expect(report.baa_status.pending).toBe(1);
    expect(report.baa_status.expired).toBe(1);
    expect(report.issues.some(i => i.includes("pending"))).toBe(true);
    expect(report.issues.some(i => i.includes("expired"))).toBe(true);
  });

  test("counts state rules correctly", () => {
    const report = generateSecurityAuditReport({
      company_id: "c1", phi_encrypted: true, tls_enforced: true,
      rls_enabled: true, agent_roles_configured: true,
      audit_immutable: true, audit_coverage_percent: 100,
      baas: [], retention_policy_defined: true, automated_purge: true,
      state_rules: [
        { state_code: "TX" } as StateBillingRule,
        { state_code: "TX" } as StateBillingRule,
        { state_code: "CA" } as StateBillingRule,
      ],
    });

    expect(report.state_rules.states_configured).toBe(2);
    expect(report.state_rules.rules_count).toBe(3);
  });
});

// ── E2E: Compliance Scenarios ───────────────────────────────

describe("E2E: compliance scenarios", () => {
  test("TX timely filing: 95 days for commercial -> check claim within window", () => {
    const filing = isWithinTimelyFiling("2026-03-01", 95, new Date("2026-05-01"));
    expect(filing.within).toBe(true);
    expect(filing.days_remaining).toBeGreaterThan(0);
  });

  test("CA patient balance: $1000 cap, patient owes $1200 -> over limit", () => {
    const balance = isWithinPatientBalanceLimit(120000, 100000);
    expect(balance.within).toBe(false);
    expect(balance.over_by_cents).toBe(20000);
  });

  test("full audit: compliant system with all BAAs signed", () => {
    const report = generateSecurityAuditReport({
      company_id: "c1", phi_encrypted: true, tls_enforced: true,
      rls_enabled: true, agent_roles_configured: true,
      audit_immutable: true, audit_coverage_percent: 100,
      baas: [
        { baa_status: "signed", vendor_name: "Supabase" } as BAA,
        { baa_status: "signed", vendor_name: "Payer API" } as BAA,
      ],
      retention_policy_defined: true, automated_purge: true,
      state_rules: [
        { state_code: "TX", rule_type: "timely_filing" } as StateBillingRule,
        { state_code: "CA", rule_type: "patient_balance_limit" } as StateBillingRule,
      ],
    });
    expect(report.overall_score).toBe(100);
    expect(report.issues).toHaveLength(0);
    expect(report.baa_status.signed).toBe(2);
    expect(report.state_rules.states_configured).toBe(2);
  });
});
