/**
 * Payer Integration Layer Tests — ELLIE-755
 *
 * Tests for EDI-837/835 + clearinghouse:
 * - Migration SQL
 * - EDI-837P formatter (X12 output validation)
 * - EDI-835 parser (remittance extraction)
 * - Submission router
 * - EDI validation
 * - E2E: claim -> format -> validate -> parse response
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  formatEDI837P, parseEDI835,
  routeSubmission, validateEDI837P, validateEDI835,
  VALID_SUBMISSION_METHODS, VALID_CLEARINGHOUSES,
  type PayerIntegration, type SubmissionRequest,
} from "../src/payer-integration.ts";
import type { ClaimDocument } from "../src/claim-submission.ts";

// ── Helpers ─────────────────────────────────────────────────

function makeClaim(): ClaimDocument {
  return {
    claim_id: "CLM-TEST001",
    encounter_id: "enc-001",
    encounter_date: "2026-03-15",
    patient: {
      id: "pat-1", first_name: "Jane", last_name: "Doe",
      dob: "1985-06-15", gender: "female", member_id: "MEM-123",
    },
    insurance: {
      payer_id: "aetna", payer_name: "Aetna",
      plan_id: "PPO-500", group_number: "GRP-789", subscriber_id: "SUB-123",
    },
    provider: { npi: "1234567890", name: "Dr Smith", taxonomy_code: null },
    facility: null,
    primary_diagnosis: "J06.9",
    diagnoses: ["J06.9", "R05.9"],
    line_items: [
      { line_number: 1, cpt_code: "99213", modifiers: [], diagnosis_pointers: [0, 1], units: 1, charge_cents: 15000, expected_reimbursement_cents: 12000 },
    ],
    total_charge_cents: 15000,
    requires_prior_auth: false,
    prior_auth_flags: [],
    validation_warnings: [],
  };
}

function makeIntegration(overrides: Partial<PayerIntegration> = {}): PayerIntegration {
  return {
    id: "pi-1", payer_id: "aetna", payer_name: "Aetna",
    submission_method: "edi", edi_payer_id: "60054",
    endpoint_url: "https://edi.availity.com/submit", sftp_host: null,
    sftp_credentials_ref: null, clearinghouse: "availity",
    era_format: "835", company_id: "comp-1", active: true, metadata: {},
    ...overrides,
  };
}

// ── Migration SQL ───────────────────────────────────────────

describe("migration SQL", () => {
  function read(): string {
    return readFileSync(join(import.meta.dir, "../migrations/supabase/20260315_payer_integrations.sql"), "utf-8");
  }

  test("creates payer_integrations table", () => {
    expect(read()).toContain("CREATE TABLE IF NOT EXISTS payer_integrations");
  });

  test("has submission_method CHECK", () => {
    const sql = read();
    expect(sql).toContain("'edi'");
    expect(sql).toContain("'api'");
    expect(sql).toContain("'portal'");
    expect(sql).toContain("'sftp'");
  });

  test("has clearinghouse CHECK", () => {
    const sql = read();
    expect(sql).toContain("'availity'");
    expect(sql).toContain("'change_healthcare'");
  });

  test("has company_id FK", () => {
    expect(read()).toContain("REFERENCES companies(id)");
  });

  test("has payer_id FK", () => {
    expect(read()).toContain("REFERENCES payers(id)");
  });

  test("has RLS", () => {
    expect(read()).toContain("ENABLE ROW LEVEL SECURITY");
  });
});

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("VALID_SUBMISSION_METHODS has 4 methods", () => {
    expect(VALID_SUBMISSION_METHODS).toEqual(["edi", "api", "portal", "sftp"]);
  });

  test("VALID_CLEARINGHOUSES has 5 options", () => {
    expect(VALID_CLEARINGHOUSES).toHaveLength(5);
  });
});

// ── formatEDI837P ───────────────────────────────────────────

describe("formatEDI837P", () => {
  test("produces X12 with ISA/GS/ST/SE/GE/IEA envelope", () => {
    const edi = formatEDI837P(makeClaim());
    expect(edi).toContain("ISA*");
    expect(edi).toContain("GS*HC*");
    expect(edi).toContain("ST*837*");
    expect(edi).toContain("SE*");
    expect(edi).toContain("GE*");
    expect(edi).toContain("IEA*");
  });

  test("includes BHT transaction header", () => {
    expect(formatEDI837P(makeClaim())).toContain("BHT*0019*00*");
  });

  test("includes patient name and member ID", () => {
    const edi = formatEDI837P(makeClaim());
    expect(edi).toContain("Doe");
    expect(edi).toContain("Jane");
    expect(edi).toContain("MEM-123");
  });

  test("includes payer name and ID", () => {
    const edi = formatEDI837P(makeClaim());
    expect(edi).toContain("Aetna");
    expect(edi).toContain("aetna");
  });

  test("includes claim ID and charge amount", () => {
    const edi = formatEDI837P(makeClaim());
    expect(edi).toContain("CLM*CLM-TEST001*150.00");
  });

  test("includes diagnosis codes in HI segment", () => {
    const edi = formatEDI837P(makeClaim());
    expect(edi).toContain("HI*ABK:J06.9");
    expect(edi).toContain("ABF:R05.9");
  });

  test("includes service line with CPT code", () => {
    const edi = formatEDI837P(makeClaim());
    expect(edi).toContain("SV1*HC:99213*150.00*UN*1");
  });

  test("includes service date", () => {
    expect(formatEDI837P(makeClaim())).toContain("DTP*472*D8*20260315");
  });

  test("includes provider NPI", () => {
    expect(formatEDI837P(makeClaim())).toContain("1234567890");
  });

  test("handles modifiers", () => {
    const claim = makeClaim();
    claim.line_items[0].modifiers = ["25", "59"];
    const edi = formatEDI837P(claim);
    expect(edi).toContain("HC:99213:25:59");
  });

  test("passes validation", () => {
    const edi = formatEDI837P(makeClaim());
    const result = validateEDI837P(edi);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── parseEDI835 ─────────────────────────────────────────────

describe("parseEDI835", () => {
  const sample835 = [
    "ISA*00*          *00*          *ZZ*PAYER          *ZZ*RECEIVER       *260315*1200*^*00501*000000001*0*P*:~",
    "GS*HP*PAYER*RECEIVER*20260315*1200*1*X*005010X221A1~",
    "ST*835*0001~",
    "CLP*CLM-TEST001*1*150.00*100.00~",
    "NM1*QC*1*Doe*Jane~",
    "SVC*HC:99213*150.00*100.00**1~",
    "CAS*CO*45*30.00~",
    "CAS*PR*2*20.00~",
    "SE*8*0001~",
    "GE*1*1~",
    "IEA*1*000000001~",
  ].join("");

  test("extracts claim ID", () => {
    const lines = parseEDI835(sample835);
    expect(lines).toHaveLength(1);
    expect(lines[0].claim_id).toBe("CLM-TEST001");
  });

  test("extracts payment amounts", () => {
    const lines = parseEDI835(sample835);
    expect(lines[0].billed_cents).toBe(15000);
    expect(lines[0].paid_cents).toBe(10000);
  });

  test("extracts CPT code from SVC segment", () => {
    const lines = parseEDI835(sample835);
    expect(lines[0].cpt_code).toBe("99213");
  });

  test("extracts adjustments (CO + PR)", () => {
    const lines = parseEDI835(sample835);
    expect(lines[0].adjustments).toHaveLength(2);
    expect(lines[0].adjustments[0].group_code).toBe("CO");
    expect(lines[0].adjustments[0].reason_code).toBe("45");
    expect(lines[0].adjustments[0].amount_cents).toBe(3000);
    expect(lines[0].adjustments[1].group_code).toBe("PR");
    expect(lines[0].adjustments[1].amount_cents).toBe(2000);
  });

  test("calculates patient responsibility from PR adjustments", () => {
    const lines = parseEDI835(sample835);
    expect(lines[0].patient_responsibility_cents).toBe(2000);
  });

  test("extracts patient name", () => {
    const lines = parseEDI835(sample835);
    expect(lines[0].patient_name).toBe("Doe, Jane");
  });

  test("handles multiple claims", () => {
    const multi = [
      "CLP*CLM-001*1*100.00*80.00~SVC*HC:99213*100.00*80.00~",
      "CLP*CLM-002*1*200.00*150.00~SVC*HC:99214*200.00*150.00~",
    ].join("");
    const lines = parseEDI835(multi);
    expect(lines).toHaveLength(2);
    expect(lines[0].claim_id).toBe("CLM-001");
    expect(lines[1].claim_id).toBe("CLM-002");
  });

  test("handles empty input", () => {
    expect(parseEDI835("")).toHaveLength(0);
  });
});

// ── routeSubmission ─────────────────────────────────────────

describe("routeSubmission", () => {
  test("EDI route produces x12_837p format", () => {
    const req = routeSubmission(makeClaim(), makeIntegration({ submission_method: "edi" }));
    expect(req.method).toBe("edi");
    expect(req.format).toBe("x12_837p");
    expect(req.payload).toContain("ISA*");
    expect(req.filename).toContain(".edi");
    expect(req.clearinghouse).toBe("availity");
  });

  test("API route produces JSON format", () => {
    const req = routeSubmission(makeClaim(), makeIntegration({ submission_method: "api" }));
    expect(req.method).toBe("api");
    expect(req.format).toBe("json");
    expect(JSON.parse(req.payload).claim_id).toBe("CLM-TEST001");
  });

  test("SFTP route produces EDI file with filename", () => {
    const req = routeSubmission(makeClaim(), makeIntegration({ submission_method: "sftp", sftp_host: "sftp.payer.com" }));
    expect(req.method).toBe("sftp");
    expect(req.endpoint).toBe("sftp.payer.com");
    expect(req.filename).toContain(".edi");
  });

  test("portal route produces JSON", () => {
    const req = routeSubmission(makeClaim(), makeIntegration({ submission_method: "portal", endpoint_url: "https://portal.payer.com" }));
    expect(req.method).toBe("portal");
    expect(req.format).toBe("json");
  });
});

// ── Validation ──────────────────────────────────────────────

describe("validateEDI837P", () => {
  test("valid EDI passes", () => {
    expect(validateEDI837P(formatEDI837P(makeClaim())).valid).toBe(true);
  });

  test("missing segments detected", () => {
    const result = validateEDI837P("ISA*test~GS*test~");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("validateEDI835", () => {
  test("valid 835 passes", () => {
    expect(validateEDI835("CLP*CLM-001*1*100*80~").valid).toBe(true);
  });

  test("missing CLP fails", () => {
    expect(validateEDI835("ISA*test~").valid).toBe(false);
  });
});

// ── E2E: Claim -> Format -> Validate -> Parse Response ──────

describe("E2E: claim EDI round-trip", () => {
  test("format 837P -> validate -> simulate 835 response -> parse", () => {
    // Format claim as EDI-837P
    const claim = makeClaim();
    const edi837 = formatEDI837P(claim);
    expect(validateEDI837P(edi837).valid).toBe(true);

    // Route through clearinghouse
    const req = routeSubmission(claim, makeIntegration());
    expect(req.method).toBe("edi");
    expect(req.clearinghouse).toBe("availity");

    // Simulate 835 response
    const response835 = `CLP*${claim.claim_id}*1*150.00*100.00~NM1*QC*1*Doe*Jane~SVC*HC:99213*150.00*100.00~CAS*CO*45*30.00~CAS*PR*2*20.00~`;
    expect(validateEDI835(response835).valid).toBe(true);

    // Parse remittance
    const remittance = parseEDI835(response835);
    expect(remittance).toHaveLength(1);
    expect(remittance[0].claim_id).toBe(claim.claim_id);
    expect(remittance[0].paid_cents).toBe(10000);
    expect(remittance[0].adjustments).toHaveLength(2);
    expect(remittance[0].patient_responsibility_cents).toBe(2000);
  });
});
