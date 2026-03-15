/**
 * Claim Submission Agent Tests — ELLIE-740
 *
 * Tests for the first agent in the billing pipeline:
 * - Encounter input validation
 * - Claim building (line items, diagnosis pointers, prior auth flags)
 * - Outcome building
 * - Claim ID generation
 * - RAG query building
 * - E2E: sample encounter -> validated claim -> outcome
 */

import { describe, test, expect } from "bun:test";
import {
  validateEncounterInput,
  buildClaim,
  buildOutcome,
  generateClaimId,
  buildRAGQueries,
  type EncounterInput,
  type ClaimDocument,
  type ClaimSubmissionOutcome,
  type CheckPriorAuthFn,
  type GetFeeScheduleFn,
} from "../src/claim-submission.ts";

// ── Helpers ─────────────────────────────────────────────────

function makeEncounter(overrides: Partial<EncounterInput> = {}): EncounterInput {
  return {
    encounter_id: "enc-001",
    encounter_date: "2026-03-15",
    patient: {
      id: "pat-001", first_name: "Jane", last_name: "Doe",
      dob: "1985-06-15", gender: "female", member_id: "MEM-12345",
    },
    insurance: {
      payer_id: "aetna", payer_name: "Aetna",
      plan_id: "PPO-500", group_number: "GRP-789",
      subscriber_id: "SUB-12345",
    },
    diagnoses: [
      { code: "J06.9", description: "Acute upper respiratory infection", is_primary: true },
      { code: "R05.9", description: "Cough, unspecified", is_primary: false },
    ],
    procedures: [
      { cpt_code: "99213", description: "Office visit, low complexity", modifiers: [], units: 1, charge_cents: 15000 },
    ],
    provider: { npi: "1234567890", name: "Dr. Smith", taxonomy_code: "207Q00000X" },
    company_id: "comp-1",
    ...overrides,
  };
}

function mockPriorAuth(rules: Record<string, boolean> = {}): CheckPriorAuthFn {
  return async (_payerId, cptCode) => ({
    requires_prior_auth: rules[cptCode] ?? false,
    auth_phone: rules[cptCode] ? "1-800-AUTH" : null,
    notes: rules[cptCode] ? "Prior auth required" : null,
  });
}

function mockFeeSchedule(fees: Record<string, number> = {}): GetFeeScheduleFn {
  return async (_payerId, cptCode) => fees[cptCode] ?? null;
}

// ── validateEncounterInput ──────────────────────────────────

describe("validateEncounterInput", () => {
  test("valid encounter passes", () => {
    expect(validateEncounterInput(makeEncounter())).toHaveLength(0);
  });

  test("missing encounter_id fails", () => {
    const e = makeEncounter();
    (e as any).encounter_id = "";
    expect(validateEncounterInput(e).some(e => e.includes("encounter_id"))).toBe(true);
  });

  test("missing patient fields fail", () => {
    const e = makeEncounter();
    e.patient.first_name = "";
    e.patient.member_id = "";
    const errors = validateEncounterInput(e);
    expect(errors.some(e => e.includes("first_name"))).toBe(true);
    expect(errors.some(e => e.includes("member_id"))).toBe(true);
  });

  test("missing payer_id fails", () => {
    const e = makeEncounter();
    e.insurance.payer_id = "";
    expect(validateEncounterInput(e).some(e => e.includes("payer_id"))).toBe(true);
  });

  test("no diagnoses fails", () => {
    const e = makeEncounter();
    e.diagnoses = [];
    expect(validateEncounterInput(e).some(e => e.includes("diagnosis"))).toBe(true);
  });

  test("no primary diagnosis fails", () => {
    const e = makeEncounter();
    e.diagnoses = [{ code: "J06.9", description: "URI", is_primary: false }];
    expect(validateEncounterInput(e).some(e => e.includes("primary"))).toBe(true);
  });

  test("multiple primary diagnoses fail", () => {
    const e = makeEncounter();
    e.diagnoses = [
      { code: "J06.9", description: "URI", is_primary: true },
      { code: "R05.9", description: "Cough", is_primary: true },
    ];
    expect(validateEncounterInput(e).some(e => e.includes("only one primary"))).toBe(true);
  });

  test("no procedures fails", () => {
    const e = makeEncounter();
    e.procedures = [];
    expect(validateEncounterInput(e).some(e => e.includes("procedure"))).toBe(true);
  });

  test("procedure with units < 1 fails", () => {
    const e = makeEncounter();
    e.procedures[0].units = 0;
    expect(validateEncounterInput(e).some(e => e.includes("units"))).toBe(true);
  });

  test("procedure with negative charge fails", () => {
    const e = makeEncounter();
    e.procedures[0].charge_cents = -100;
    expect(validateEncounterInput(e).some(e => e.includes("negative"))).toBe(true);
  });

  test("missing provider NPI fails", () => {
    const e = makeEncounter();
    e.provider.npi = "";
    expect(validateEncounterInput(e).some(e => e.includes("npi"))).toBe(true);
  });
});

// ── buildClaim ──────────────────────────────────────────────

describe("buildClaim", () => {
  test("builds claim from valid encounter", async () => {
    const { claim, errors } = await buildClaim(makeEncounter(), {
      checkPriorAuth: mockPriorAuth(),
    });
    expect(errors).toHaveLength(0);
    expect(claim).not.toBeNull();
    expect(claim!.encounter_id).toBe("enc-001");
    expect(claim!.primary_diagnosis).toBe("J06.9");
    expect(claim!.line_items).toHaveLength(1);
    expect(claim!.total_charge_cents).toBe(15000);
    expect(claim!.requires_prior_auth).toBe(false);
  });

  test("returns errors for invalid input", async () => {
    const e = makeEncounter();
    e.diagnoses = [];
    const { claim, errors } = await buildClaim(e, { checkPriorAuth: mockPriorAuth() });
    expect(claim).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  test("flags prior auth when required", async () => {
    const { claim } = await buildClaim(makeEncounter(), {
      checkPriorAuth: mockPriorAuth({ "99213": true }),
    });
    expect(claim!.requires_prior_auth).toBe(true);
    expect(claim!.prior_auth_flags).toHaveLength(1);
    expect(claim!.prior_auth_flags[0].cpt_code).toBe("99213");
    expect(claim!.prior_auth_flags[0].auth_phone).toBe("1-800-AUTH");
  });

  test("includes expected reimbursement from fee schedule", async () => {
    const { claim } = await buildClaim(makeEncounter(), {
      checkPriorAuth: mockPriorAuth(),
      getFeeSchedule: mockFeeSchedule({ "99213": 12000 }),
    });
    expect(claim!.line_items[0].expected_reimbursement_cents).toBe(12000);
  });

  test("handles null fee schedule gracefully", async () => {
    const { claim } = await buildClaim(makeEncounter(), {
      checkPriorAuth: mockPriorAuth(),
      getFeeSchedule: mockFeeSchedule({}),
    });
    expect(claim!.line_items[0].expected_reimbursement_cents).toBeNull();
  });

  test("multiplies charge by units", async () => {
    const enc = makeEncounter();
    enc.procedures = [
      { cpt_code: "99213", description: "Office visit", modifiers: [], units: 3, charge_cents: 5000 },
    ];
    const { claim } = await buildClaim(enc, { checkPriorAuth: mockPriorAuth() });
    expect(claim!.line_items[0].charge_cents).toBe(15000);
    expect(claim!.total_charge_cents).toBe(15000);
  });

  test("handles multiple procedures", async () => {
    const enc = makeEncounter();
    enc.procedures = [
      { cpt_code: "99213", description: "Office visit", modifiers: [], units: 1, charge_cents: 15000 },
      { cpt_code: "87081", description: "Strep test", modifiers: [], units: 1, charge_cents: 2500 },
    ];
    const { claim } = await buildClaim(enc, { checkPriorAuth: mockPriorAuth() });
    expect(claim!.line_items).toHaveLength(2);
    expect(claim!.total_charge_cents).toBe(17500);
    expect(claim!.line_items[0].line_number).toBe(1);
    expect(claim!.line_items[1].line_number).toBe(2);
  });

  test("limits diagnosis pointers to 4 per CMS-1500", async () => {
    const enc = makeEncounter();
    enc.diagnoses = [
      { code: "J06.9", description: "URI", is_primary: true },
      { code: "R05.9", description: "Cough", is_primary: false },
      { code: "J20.9", description: "Bronchitis", is_primary: false },
      { code: "J02.9", description: "Pharyngitis", is_primary: false },
      { code: "R50.9", description: "Fever", is_primary: false },
    ];
    const { claim } = await buildClaim(enc, { checkPriorAuth: mockPriorAuth() });
    expect(claim!.line_items[0].diagnosis_pointers.length).toBeLessThanOrEqual(4);
  });

  test("generates deterministic claim ID", async () => {
    const { claim: c1 } = await buildClaim(makeEncounter(), { checkPriorAuth: mockPriorAuth() });
    const { claim: c2 } = await buildClaim(makeEncounter(), { checkPriorAuth: mockPriorAuth() });
    expect(c1!.claim_id).toBe(c2!.claim_id);
    expect(c1!.claim_id).toMatch(/^CLM-/);
  });
});

// ── buildOutcome ────────────────────────────────────────────

describe("buildOutcome", () => {
  test("builds outcome from claim", async () => {
    const { claim } = await buildClaim(makeEncounter(), {
      checkPriorAuth: mockPriorAuth(),
      getFeeSchedule: mockFeeSchedule({ "99213": 12000 }),
    });

    const outcome = buildOutcome(claim!, { status: "submitted", tracking_number: "TRK-001" });
    expect(outcome.status).toBe("submitted");
    expect(outcome.tracking_number).toBe("TRK-001");
    expect(outcome.total_charge_cents).toBe(15000);
    expect(outcome.expected_reimbursement_cents).toBe(12000);
    expect(outcome.line_item_count).toBe(1);
    expect(outcome.prior_auth_required).toBe(false);
  });

  test("defaults to validated status", async () => {
    const { claim } = await buildClaim(makeEncounter(), { checkPriorAuth: mockPriorAuth() });
    expect(buildOutcome(claim!).status).toBe("validated");
  });
});

// ── generateClaimId ─────────────────────────────────────────

describe("generateClaimId", () => {
  test("produces CLM- prefixed ID", () => {
    expect(generateClaimId(makeEncounter())).toMatch(/^CLM-[A-Z0-9]{8}$/);
  });

  test("deterministic for same input", () => {
    const enc = makeEncounter();
    expect(generateClaimId(enc)).toBe(generateClaimId(enc));
  });

  test("different for different encounters", () => {
    const a = generateClaimId(makeEncounter({ encounter_id: "enc-A" }));
    const b = generateClaimId(makeEncounter({ encounter_id: "enc-B" }));
    expect(a).not.toBe(b);
  });
});

// ── buildRAGQueries ─────────────────────────────────────────

describe("buildRAGQueries", () => {
  test("generates queries for each procedure", () => {
    const queries = buildRAGQueries(makeEncounter());
    const cptQueries = queries.filter(q => q.categories.includes("cpt_codes"));
    expect(cptQueries.length).toBe(1);
    expect(cptQueries[0].query).toContain("99213");
  });

  test("generates payer rules query", () => {
    const queries = buildRAGQueries(makeEncounter());
    const payerQueries = queries.filter(q => q.categories.includes("payer_rules"));
    expect(payerQueries.length).toBeGreaterThanOrEqual(1);
    expect(payerQueries[0].query).toContain("Aetna");
  });

  test("generates diagnosis queries", () => {
    const queries = buildRAGQueries(makeEncounter());
    const icdQueries = queries.filter(q => q.categories.includes("icd10_codes"));
    expect(icdQueries.length).toBe(2);
    expect(icdQueries[0].query).toContain("J06.9");
  });

  test("generates fee schedule queries", () => {
    const queries = buildRAGQueries(makeEncounter());
    const feeQueries = queries.filter(q => q.categories.includes("fee_schedules"));
    expect(feeQueries.length).toBe(1);
    expect(feeQueries[0].query).toContain("99213");
  });
});

// ── E2E: Sample Encounter ───────────────────────────────────

describe("E2E: office visit encounter -> claim -> outcome", () => {
  test("complete billing pipeline for URI office visit", async () => {
    const encounter = makeEncounter();

    // Step 1: Validate
    expect(validateEncounterInput(encounter)).toHaveLength(0);

    // Step 2: Build RAG queries
    const ragQueries = buildRAGQueries(encounter);
    expect(ragQueries.length).toBeGreaterThanOrEqual(4);

    // Step 3: Build claim (with prior auth check + fee schedule)
    const { claim, errors } = await buildClaim(encounter, {
      checkPriorAuth: mockPriorAuth(), // No auth needed for 99213
      getFeeSchedule: mockFeeSchedule({ "99213": 12000 }),
    });
    expect(errors).toHaveLength(0);
    expect(claim).not.toBeNull();
    expect(claim!.primary_diagnosis).toBe("J06.9");
    expect(claim!.line_items).toHaveLength(1);
    expect(claim!.requires_prior_auth).toBe(false);

    // Step 4: Build outcome
    const outcome = buildOutcome(claim!, {
      status: "submitted",
      tracking_number: "TRK-20260315-001",
      submission_cost_cents: 2, // < $0.02 target
    });
    expect(outcome.status).toBe("submitted");
    expect(outcome.tracking_number).toBe("TRK-20260315-001");
    expect(outcome.submission_cost_cents).toBe(2);
    expect(outcome.expected_reimbursement_cents).toBe(12000);
    expect(outcome.total_charge_cents).toBe(15000);
    expect(outcome.prior_auth_required).toBe(false);
  });

  test("MRI encounter requiring prior auth", async () => {
    const encounter = makeEncounter({
      procedures: [
        { cpt_code: "72148", description: "MRI lumbar spine", modifiers: [], units: 1, charge_cents: 250000 },
      ],
    });

    const { claim } = await buildClaim(encounter, {
      checkPriorAuth: mockPriorAuth({ "72148": true }),
      getFeeSchedule: mockFeeSchedule({ "72148": 180000 }),
    });

    expect(claim!.requires_prior_auth).toBe(true);
    expect(claim!.prior_auth_flags[0].cpt_code).toBe("72148");
    expect(claim!.prior_auth_flags[0].auth_phone).toBe("1-800-AUTH");

    const outcome = buildOutcome(claim!, { status: "validated" });
    expect(outcome.prior_auth_required).toBe(true);
    expect(outcome.expected_reimbursement_cents).toBe(180000);
  });
});
