/**
 * Payer Registry Tests — ELLIE-739
 *
 * Tests for payer-specific knowledge filtering:
 * - Migration SQL (payers, prior auth, denial mappings)
 * - Payer CRUD
 * - Timely filing lookup with fallback
 * - Prior auth check with fallback
 * - Denial code mappings
 * - Payer context prompt builder
 * - E2E: payer-specific billing scenarios
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import type { Payer, PriorAuthRule, DenialMapping } from "../src/payer-registry.ts";

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

mock.module("../../ellie-forest/src/index", () => ({ sql: mockSql }));

const {
  createPayer,
  getPayer,
  listPayers,
  getTimelyFiling,
  addPriorAuthRule,
  checkPriorAuth,
  getPriorAuthRules,
  addDenialMapping,
  getDenialMapping,
  getDenialMappings,
  buildPayerContextPrompt,
  VALID_PAYER_TYPES,
  DEFAULT_TIMELY_FILING_DAYS,
  DEFAULT_APPEAL_DEADLINE_DAYS,
} = await import("../src/payer-registry.ts");

beforeEach(() => { resetSqlMock(); });

// ── Helpers ─────────────────────────────────────────────────

function makePayer(overrides: Partial<Payer> = {}): Payer {
  return {
    id: "aetna", created_at: new Date(), updated_at: new Date(),
    name: "Aetna", type: "commercial", status: "active",
    timely_filing_days: 90, appeal_deadline_days: 60,
    phone: "1-800-AETNA", website: "https://aetna.com",
    portal_url: "https://portal.aetna.com", claims_address: "PO Box 123",
    company_id: null, metadata: {},
    ...overrides,
  };
}

// ── Migration SQL ───────────────────────────────────────────

describe("migration SQL", () => {
  function read(): string {
    return readFileSync(join(import.meta.dir, "../migrations/supabase/20260315_payers.sql"), "utf-8");
  }

  test("creates payers table", () => {
    expect(read()).toContain("CREATE TABLE IF NOT EXISTS payers");
  });

  test("payers has type CHECK with all payer types", () => {
    const sql = read();
    for (const t of VALID_PAYER_TYPES) expect(sql).toContain(`'${t}'`);
  });

  test("payers has timely_filing_days and appeal_deadline_days", () => {
    const sql = read();
    expect(sql).toContain("timely_filing_days INTEGER");
    expect(sql).toContain("appeal_deadline_days INTEGER");
  });

  test("creates payer_prior_auth_rules table", () => {
    expect(read()).toContain("CREATE TABLE IF NOT EXISTS payer_prior_auth_rules");
  });

  test("prior auth has payer_id + cpt_code composite index", () => {
    expect(read()).toContain("idx_prior_auth_payer_cpt");
  });

  test("creates payer_denial_mappings table", () => {
    expect(read()).toContain("CREATE TABLE IF NOT EXISTS payer_denial_mappings");
  });

  test("denial mappings has payer_id + denial_code composite index", () => {
    expect(read()).toContain("idx_denial_map_payer_code");
  });

  test("has RLS on all 3 tables", () => {
    const sql = read();
    const rls = (sql.match(/ENABLE ROW LEVEL SECURITY/g) || []).length;
    expect(rls).toBeGreaterThanOrEqual(3);
  });
});

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("VALID_PAYER_TYPES has 6 types", () => {
    expect(VALID_PAYER_TYPES).toHaveLength(6);
    expect(VALID_PAYER_TYPES).toContain("commercial");
    expect(VALID_PAYER_TYPES).toContain("medicare");
    expect(VALID_PAYER_TYPES).toContain("medicaid");
  });

  test("DEFAULT_TIMELY_FILING_DAYS is 365", () => {
    expect(DEFAULT_TIMELY_FILING_DAYS).toBe(365);
  });

  test("DEFAULT_APPEAL_DEADLINE_DAYS is 180", () => {
    expect(DEFAULT_APPEAL_DEADLINE_DAYS).toBe(180);
  });
});

// ── Payer CRUD ──────────────────────────────────────────────

describe("createPayer", () => {
  test("creates and returns payer", async () => {
    pushSqlResult([makePayer()]);
    const p = await createPayer({ id: "aetna", name: "Aetna", type: "commercial", timely_filing_days: 90 });
    expect(p.name).toBe("Aetna");
  });
});

describe("getPayer", () => {
  test("returns payer when found", async () => {
    pushSqlResult([makePayer()]);
    expect((await getPayer("aetna"))!.name).toBe("Aetna");
  });

  test("returns null when not found", async () => {
    pushSqlResult([]);
    expect(await getPayer("nonexistent")).toBeNull();
  });
});

describe("listPayers", () => {
  test("returns all payers", async () => {
    pushSqlResult([makePayer(), makePayer({ id: "uhc", name: "UnitedHealthcare" })]);
    expect(await listPayers()).toHaveLength(2);
  });

  test("filters by type", async () => {
    pushSqlResult([]);
    await listPayers({ type: "medicare" });
    expect(sqlCalls[0].strings.join("?")).toContain("type =");
  });

  test("filters by company_id", async () => {
    pushSqlResult([]);
    await listPayers({ company_id: "comp-1" });
    expect(sqlCalls[0].strings.join("?")).toContain("company_id =");
  });

  test("filters by both", async () => {
    pushSqlResult([]);
    await listPayers({ type: "commercial", company_id: "comp-1" });
    const s = sqlCalls[0].strings.join("?");
    expect(s).toContain("type =");
    expect(s).toContain("company_id =");
  });
});

// ── Timely Filing ───────────────────────────────────────────

describe("getTimelyFiling", () => {
  test("returns payer-specific filing days", async () => {
    pushSqlResult([makePayer({ timely_filing_days: 90 })]);
    const result = await getTimelyFiling("aetna");
    expect(result.timely_filing_days).toBe(90);
    expect(result.source).toBe("payer_specific");
    expect(result.payer_name).toBe("Aetna");
  });

  test("falls back to default when payer has no filing days", async () => {
    pushSqlResult([makePayer({ timely_filing_days: null })]);
    const result = await getTimelyFiling("aetna");
    expect(result.timely_filing_days).toBe(DEFAULT_TIMELY_FILING_DAYS);
    expect(result.source).toBe("general_default");
  });

  test("falls back to default when payer not found", async () => {
    pushSqlResult([]);
    const result = await getTimelyFiling("nonexistent");
    expect(result.timely_filing_days).toBe(DEFAULT_TIMELY_FILING_DAYS);
    expect(result.source).toBe("general_default");
    expect(result.payer_name).toBe("Unknown");
  });
});

// ── Prior Auth ──────────────────────────────────────────────

describe("addPriorAuthRule", () => {
  test("inserts and returns rule", async () => {
    pushSqlResult([{
      id: "rule-1", payer_id: "aetna", cpt_code: "72148",
      requires_prior_auth: true, auth_phone: "1-800-AUTH",
      auth_portal_url: null, notes: "MRI spine", effective_date: null, metadata: {},
    }]);
    const r = await addPriorAuthRule({
      payer_id: "aetna", cpt_code: "72148", requires_prior_auth: true,
      auth_phone: "1-800-AUTH", auth_portal_url: null, notes: "MRI spine",
      effective_date: null, metadata: {},
    });
    expect(r.cpt_code).toBe("72148");
    expect(r.requires_prior_auth).toBe(true);
  });
});

describe("checkPriorAuth", () => {
  test("returns payer-specific rule when found", async () => {
    pushSqlResult([{
      id: "r1", payer_id: "uhc", cpt_code: "72148",
      requires_prior_auth: true, auth_phone: "1-800-UHC-AUTH",
      auth_portal_url: "https://uhc.com/auth", notes: "Required for all MRI",
      effective_date: "2026-01-01", metadata: {},
    }]);
    const result = await checkPriorAuth("uhc", "72148");
    expect(result.requires_prior_auth).toBe(true);
    expect(result.source).toBe("payer_specific");
    expect(result.auth_phone).toBe("1-800-UHC-AUTH");
  });

  test("returns not_found when no rule exists (assume no auth)", async () => {
    pushSqlResult([]);
    const result = await checkPriorAuth("aetna", "99213");
    expect(result.requires_prior_auth).toBe(false);
    expect(result.source).toBe("not_found");
  });
});

describe("getPriorAuthRules", () => {
  test("returns all rules for a payer", async () => {
    pushSqlResult([
      { id: "r1", payer_id: "aetna", cpt_code: "72148", requires_prior_auth: true },
      { id: "r2", payer_id: "aetna", cpt_code: "70553", requires_prior_auth: true },
    ]);
    expect(await getPriorAuthRules("aetna")).toHaveLength(2);
  });
});

// ── Denial Mappings ─────────────────────────────────────────

describe("addDenialMapping", () => {
  test("inserts and returns mapping", async () => {
    pushSqlResult([{
      id: "m1", payer_id: "aetna", denial_code: "CO-16",
      payer_description: "Missing info per Aetna policy",
      standard_description: "Claim lacks information",
      recommended_action: "Resubmit with modifier", appeal_template_id: null, metadata: {},
    }]);
    const m = await addDenialMapping({
      payer_id: "aetna", denial_code: "CO-16",
      payer_description: "Missing info per Aetna policy",
      standard_description: "Claim lacks information",
      recommended_action: "Resubmit with modifier",
      appeal_template_id: null, metadata: {},
    });
    expect(m.denial_code).toBe("CO-16");
  });
});

describe("getDenialMapping", () => {
  test("returns mapping when found", async () => {
    pushSqlResult([{
      id: "m1", payer_id: "aetna", denial_code: "CO-16",
      payer_description: "Missing info", standard_description: null,
      recommended_action: "Resubmit", appeal_template_id: null, metadata: {},
    }]);
    const m = await getDenialMapping("aetna", "CO-16");
    expect(m).not.toBeNull();
    expect(m!.recommended_action).toBe("Resubmit");
  });

  test("returns null when not found", async () => {
    pushSqlResult([]);
    expect(await getDenialMapping("aetna", "XX-99")).toBeNull();
  });
});

describe("getDenialMappings", () => {
  test("returns all mappings for a payer", async () => {
    pushSqlResult([
      { id: "m1", denial_code: "CO-16" },
      { id: "m2", denial_code: "PR-1" },
    ]);
    expect(await getDenialMappings("aetna")).toHaveLength(2);
  });
});

// ── buildPayerContextPrompt (Pure) ──────────────────────────

describe("buildPayerContextPrompt", () => {
  test("builds formatted prompt with payer details", () => {
    const prompt = buildPayerContextPrompt(makePayer());
    expect(prompt).toContain("### Payer: Aetna (commercial)");
    expect(prompt).toContain("Timely filing deadline: 90 days");
    expect(prompt).toContain("Appeal deadline: 60 days");
    expect(prompt).toContain("Phone: 1-800-AETNA");
    expect(prompt).toContain("Portal: https://portal.aetna.com");
  });

  test("omits null fields", () => {
    const prompt = buildPayerContextPrompt(makePayer({
      phone: null, portal_url: null, claims_address: null,
      timely_filing_days: null, appeal_deadline_days: null,
    }));
    expect(prompt).not.toContain("Phone:");
    expect(prompt).not.toContain("Portal:");
    expect(prompt).not.toContain("Claims address:");
    expect(prompt).not.toContain("Timely filing");
  });
});

// ── E2E: Payer-Specific Billing Scenarios ───────────────────

describe("E2E: payer-specific scenarios", () => {
  test("UHC prior auth for MRI: create payer -> add rule -> check", async () => {
    // Create payer
    pushSqlResult([makePayer({ id: "uhc", name: "UnitedHealthcare", timely_filing_days: 180 })]);
    await createPayer({ id: "uhc", name: "UnitedHealthcare", type: "commercial", timely_filing_days: 180 });
    resetSqlMock();

    // Add prior auth rule
    pushSqlResult([{
      id: "r1", payer_id: "uhc", cpt_code: "72148", requires_prior_auth: true,
      auth_phone: "1-800-UHC", auth_portal_url: null, notes: "MRI spine requires auth",
      effective_date: null, metadata: {},
    }]);
    await addPriorAuthRule({
      payer_id: "uhc", cpt_code: "72148", requires_prior_auth: true,
      auth_phone: "1-800-UHC", auth_portal_url: null, notes: "MRI spine requires auth",
      effective_date: null, metadata: {},
    });
    resetSqlMock();

    // Check prior auth
    pushSqlResult([{
      id: "r1", payer_id: "uhc", cpt_code: "72148", requires_prior_auth: true,
      auth_phone: "1-800-UHC", auth_portal_url: null, notes: "MRI spine requires auth",
      effective_date: null, metadata: {},
    }]);
    const auth = await checkPriorAuth("uhc", "72148");
    expect(auth.requires_prior_auth).toBe(true);
    expect(auth.source).toBe("payer_specific");
    expect(auth.auth_phone).toBe("1-800-UHC");
  });

  test("timely filing fallback: payer without deadline uses default", async () => {
    pushSqlResult([makePayer({ id: "small-payer", name: "Small Payer", timely_filing_days: null })]);
    const result = await getTimelyFiling("small-payer");
    expect(result.timely_filing_days).toBe(365);
    expect(result.source).toBe("general_default");
  });

  test("denial lookup: payer-specific then fallback", async () => {
    // Payer-specific mapping exists
    pushSqlResult([{
      id: "m1", payer_id: "aetna", denial_code: "CO-16",
      payer_description: "Aetna-specific: missing modifier",
      standard_description: "Claim lacks information",
      recommended_action: "Add modifier -25", appeal_template_id: null, metadata: {},
    }]);
    const specific = await getDenialMapping("aetna", "CO-16");
    expect(specific).not.toBeNull();
    expect(specific!.payer_description).toContain("Aetna-specific");

    resetSqlMock();

    // No payer-specific mapping
    pushSqlResult([]);
    const fallback = await getDenialMapping("unknown-payer", "CO-16");
    expect(fallback).toBeNull(); // Caller would use general denial_reasons from medical_knowledge
  });
});

// ── SQL Safety ──────────────────────────────────────────────

describe("SQL safety", () => {
  test("createPayer uses parameterized queries", async () => {
    pushSqlResult([makePayer()]);
    await createPayer({ id: "test", name: "Test", type: "commercial" });
    const raw = sqlCalls[0].strings.join("");
    expect(raw).not.toContain("test");
  });

  test("checkPriorAuth uses parameterized queries", async () => {
    pushSqlResult([]);
    await checkPriorAuth("aetna", "72148");
    expect(sqlCalls[0].values).toContain("aetna");
    expect(sqlCalls[0].values).toContain("72148");
  });
});
