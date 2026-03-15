/**
 * Payment Posting Agent Tests — ELLIE-744
 *
 * Tests for payment reconciliation pipeline:
 * - Adjustment classification (contractual, patient responsibility, other)
 * - Payment-to-claim matching
 * - Journal entry generation
 * - Underpayment detection
 * - Reconciliation summary
 * - RAG queries
 * - Full pipeline
 * - E2E scenarios
 */

import { describe, test, expect } from "bun:test";
import {
  classifyAdjustment,
  matchPayments,
  generateJournalEntries,
  detectUnderpayments,
  computeReconciliation,
  buildPaymentRAGQueries,
  runPaymentPostingPipeline,
  VALID_ADJUSTMENT_TYPES,
  type RemittanceLine,
  type SubmittedClaim,
  type AdjustmentEntry,
  type PaymentMatch,
} from "../src/payment-posting.ts";

// ── Helpers ─────────────────────────────────────────────────

function makeRemittanceLine(overrides: Partial<RemittanceLine> = {}): RemittanceLine {
  return {
    claim_id: "CLM-001",
    patient_name: "Jane Doe",
    cpt_code: "99213",
    billed_cents: 15000,
    allowed_cents: 12000,
    paid_cents: 10000,
    adjustments: [
      { group_code: "CO", reason_code: "45", amount_cents: 3000 },
      { group_code: "PR", reason_code: "2", amount_cents: 2000 },
    ],
    patient_responsibility_cents: 2000,
    ...overrides,
  };
}

function makeSubmittedClaim(overrides: Partial<SubmittedClaim> = {}): SubmittedClaim {
  return {
    claim_id: "CLM-001",
    patient_name: "Jane Doe",
    total_charge_cents: 15000,
    expected_reimbursement_cents: 12000,
    line_items: [{ cpt_code: "99213", charge_cents: 15000 }],
    ...overrides,
  };
}

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("VALID_ADJUSTMENT_TYPES has 4 types", () => {
    expect(VALID_ADJUSTMENT_TYPES).toHaveLength(4);
    expect(VALID_ADJUSTMENT_TYPES).toContain("contractual");
    expect(VALID_ADJUSTMENT_TYPES).toContain("non_contractual");
    expect(VALID_ADJUSTMENT_TYPES).toContain("patient_responsibility");
    expect(VALID_ADJUSTMENT_TYPES).toContain("other");
  });
});

// ── classifyAdjustment ──────────────────────────────────────

describe("classifyAdjustment", () => {
  test("CO-45 classified as contractual", () => {
    const c = classifyAdjustment({ group_code: "CO", reason_code: "45", amount_cents: 3000 });
    expect(c.type).toBe("contractual");
    expect(c.description).toContain("Contractual");
  });

  test("CO-42 classified as contractual", () => {
    expect(classifyAdjustment({ group_code: "CO", reason_code: "42", amount_cents: 1000 }).type).toBe("contractual");
  });

  test("CO-16 classified as non_contractual", () => {
    const c = classifyAdjustment({ group_code: "CO", reason_code: "16", amount_cents: 5000 });
    expect(c.type).toBe("non_contractual");
  });

  test("PR-1 classified as patient_responsibility (Deductible)", () => {
    const c = classifyAdjustment({ group_code: "PR", reason_code: "1", amount_cents: 2000 });
    expect(c.type).toBe("patient_responsibility");
    expect(c.description).toContain("Deductible");
  });

  test("PR-2 classified as patient_responsibility (Coinsurance)", () => {
    const c = classifyAdjustment({ group_code: "PR", reason_code: "2", amount_cents: 1500 });
    expect(c.description).toContain("Coinsurance");
  });

  test("PR-3 classified as patient_responsibility (Copayment)", () => {
    expect(classifyAdjustment({ group_code: "PR", reason_code: "3", amount_cents: 3000 }).description).toContain("Copayment");
  });

  test("OA codes classified as other", () => {
    expect(classifyAdjustment({ group_code: "OA", reason_code: "23", amount_cents: 500 }).type).toBe("other");
  });

  test("unknown group classified as other", () => {
    expect(classifyAdjustment({ group_code: "PI", reason_code: "1", amount_cents: 100 }).type).toBe("other");
  });
});

// ── matchPayments ───────────────────────────────────────────

describe("matchPayments", () => {
  test("matches remittance to claim", () => {
    const matches = matchPayments([makeRemittanceLine()], [makeSubmittedClaim()]);
    expect(matches).toHaveLength(1);
    expect(matches[0].match_status).toBe("matched");
    expect(matches[0].paid_cents).toBe(10000);
    expect(matches[0].expected_cents).toBe(12000);
  });

  test("detects underpayment (paid < expected)", () => {
    const matches = matchPayments([makeRemittanceLine({ paid_cents: 8000 })], [makeSubmittedClaim()]);
    expect(matches[0].is_underpaid).toBe(true);
    expect(matches[0].variance_cents).toBe(-4000);
  });

  test("no underpayment when paid >= expected", () => {
    const matches = matchPayments([makeRemittanceLine({ paid_cents: 12000 })], [makeSubmittedClaim()]);
    expect(matches[0].is_underpaid).toBe(false);
  });

  test("unmatched when claim not found", () => {
    const matches = matchPayments([makeRemittanceLine({ claim_id: "UNKNOWN" })], [makeSubmittedClaim()]);
    expect(matches[0].match_status).toBe("unmatched");
    expect(matches[0].expected_cents).toBeNull();
    expect(matches[0].is_underpaid).toBe(false);
  });

  test("classifies adjustments on match", () => {
    const matches = matchPayments([makeRemittanceLine()], [makeSubmittedClaim()]);
    expect(matches[0].adjustments_classified).toHaveLength(2);
    expect(matches[0].adjustments_classified[0].type).toBe("contractual");
    expect(matches[0].adjustments_classified[1].type).toBe("patient_responsibility");
  });

  test("handles multiple lines", () => {
    const lines = [
      makeRemittanceLine({ claim_id: "A" }),
      makeRemittanceLine({ claim_id: "B", paid_cents: 5000 }),
    ];
    const claims = [
      makeSubmittedClaim({ claim_id: "A" }),
      makeSubmittedClaim({ claim_id: "B", expected_reimbursement_cents: 8000 }),
    ];
    const matches = matchPayments(lines, claims);
    expect(matches).toHaveLength(2);
    expect(matches[0].match_status).toBe("matched");
    expect(matches[1].is_underpaid).toBe(true);
  });

  test("null expected = no variance", () => {
    const matches = matchPayments(
      [makeRemittanceLine()],
      [makeSubmittedClaim({ expected_reimbursement_cents: null })],
    );
    expect(matches[0].variance_cents).toBeNull();
    expect(matches[0].is_underpaid).toBe(false);
  });
});

// ── generateJournalEntries ──────────────────────────────────

describe("generateJournalEntries", () => {
  test("generates cash receipt entry", () => {
    const matches = matchPayments([makeRemittanceLine()], [makeSubmittedClaim()]);
    const entries = generateJournalEntries(matches);
    const cash = entries.find(e => e.debit_account === "Cash");
    expect(cash).toBeDefined();
    expect(cash!.amount_cents).toBe(10000);
    expect(cash!.credit_account).toBe("Accounts Receivable");
  });

  test("generates contractual adjustment entry", () => {
    const matches = matchPayments([makeRemittanceLine()], [makeSubmittedClaim()]);
    const entries = generateJournalEntries(matches);
    const contractual = entries.find(e => e.debit_account === "Contractual Adjustments");
    expect(contractual).toBeDefined();
    expect(contractual!.amount_cents).toBe(3000);
  });

  test("generates patient responsibility entry", () => {
    const matches = matchPayments([makeRemittanceLine()], [makeSubmittedClaim()]);
    const entries = generateJournalEntries(matches);
    const patient = entries.find(e => e.debit_account === "Patient Accounts Receivable");
    expect(patient).toBeDefined();
    expect(patient!.amount_cents).toBe(2000);
  });

  test("skips unmatched claims", () => {
    const matches = matchPayments([makeRemittanceLine({ claim_id: "UNKNOWN" })], []);
    const entries = generateJournalEntries(matches);
    expect(entries).toHaveLength(0);
  });

  test("skips zero-amount entries", () => {
    const matches = matchPayments(
      [makeRemittanceLine({ paid_cents: 0, adjustments: [], patient_responsibility_cents: 0 })],
      [makeSubmittedClaim()],
    );
    const entries = generateJournalEntries(matches);
    expect(entries).toHaveLength(0);
  });
});

// ── detectUnderpayments ─────────────────────────────────────

describe("detectUnderpayments", () => {
  test("detects underpayment with variance", () => {
    const matches = matchPayments([makeRemittanceLine({ paid_cents: 8000 })], [makeSubmittedClaim()]);
    const alerts = detectUnderpayments(matches, "aetna");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].variance_cents).toBe(4000);
    expect(alerts[0].variance_percent).toBe(33); // 4000/12000 * 100
    expect(alerts[0].payer_id).toBe("aetna");
  });

  test("no alerts when fully paid", () => {
    const matches = matchPayments([makeRemittanceLine({ paid_cents: 12000 })], [makeSubmittedClaim()]);
    expect(detectUnderpayments(matches)).toHaveLength(0);
  });

  test("no alerts for unmatched claims", () => {
    const matches = matchPayments([makeRemittanceLine({ claim_id: "UNKNOWN" })], []);
    expect(detectUnderpayments(matches)).toHaveLength(0);
  });
});

// ── computeReconciliation ───────────────────────────────────

describe("computeReconciliation", () => {
  test("computes full reconciliation", () => {
    const matches = matchPayments(
      [
        makeRemittanceLine({ claim_id: "A", billed_cents: 15000, allowed_cents: 12000, paid_cents: 10000 }),
        makeRemittanceLine({ claim_id: "B", billed_cents: 20000, allowed_cents: 18000, paid_cents: 15000 }),
      ],
      [
        makeSubmittedClaim({ claim_id: "A", expected_reimbursement_cents: 12000 }),
        makeSubmittedClaim({ claim_id: "B", expected_reimbursement_cents: 18000 }),
      ],
    );
    const r = computeReconciliation(matches);
    expect(r.total_remittance_lines).toBe(2);
    expect(r.matched).toBe(2);
    expect(r.unmatched).toBe(0);
    expect(r.total_billed_cents).toBe(35000);
    expect(r.total_paid_cents).toBe(25000);
    expect(r.underpayment_count).toBe(2);
  });

  test("handles empty matches", () => {
    const r = computeReconciliation([]);
    expect(r.total_remittance_lines).toBe(0);
    expect(r.total_paid_cents).toBe(0);
  });
});

// ── buildPaymentRAGQueries ──────────────────────────────────

describe("buildPaymentRAGQueries", () => {
  test("generates ERA parsing query", () => {
    const queries = buildPaymentRAGQueries("Aetna");
    expect(queries.some(q => q.query.includes("ERA") && q.query.includes("Aetna"))).toBe(true);
  });

  test("generates fee schedule query", () => {
    const queries = buildPaymentRAGQueries("Aetna");
    expect(queries.some(q => q.categories.includes("fee_schedules"))).toBe(true);
  });

  test("generates adjustment code query", () => {
    const queries = buildPaymentRAGQueries("Aetna");
    expect(queries.some(q => q.query.includes("adjustment reason codes"))).toBe(true);
  });
});

// ── runPaymentPostingPipeline ───────────────────────────────

describe("runPaymentPostingPipeline", () => {
  test("produces complete outcome", () => {
    const outcome = runPaymentPostingPipeline(
      [makeRemittanceLine()],
      [makeSubmittedClaim()],
      "Aetna",
      "aetna",
    );
    expect(outcome.matches).toHaveLength(1);
    expect(outcome.journal_entries.length).toBeGreaterThan(0);
    expect(outcome.reconciliation.matched).toBe(1);
    expect(outcome.rag_queries_used.length).toBe(3);
  });
});

// ── E2E: Payment Scenarios ──────────────────────────────────

describe("E2E: payment posting scenarios", () => {
  test("full payment with contractual adjustment + patient coinsurance", () => {
    const remittance = [makeRemittanceLine({
      billed_cents: 15000,
      allowed_cents: 12000,
      paid_cents: 10000,
      adjustments: [
        { group_code: "CO", reason_code: "45", amount_cents: 3000 },
        { group_code: "PR", reason_code: "2", amount_cents: 2000 },
      ],
      patient_responsibility_cents: 2000,
    })];
    const claims = [makeSubmittedClaim({ expected_reimbursement_cents: 10000 })];

    const outcome = runPaymentPostingPipeline(remittance, claims, "Aetna");

    // Match should show no underpayment (paid == expected)
    expect(outcome.matches[0].is_underpaid).toBe(false);

    // Journal entries: cash + contractual + patient
    expect(outcome.journal_entries.length).toBe(3);

    // Reconciliation
    expect(outcome.reconciliation.total_paid_cents).toBe(10000);
    expect(outcome.reconciliation.total_patient_responsibility_cents).toBe(2000);
  });

  test("underpayment detected and alerted", () => {
    const remittance = [makeRemittanceLine({ paid_cents: 8000 })];
    const claims = [makeSubmittedClaim({ expected_reimbursement_cents: 12000 })];

    const outcome = runPaymentPostingPipeline(remittance, claims, "UHC", "uhc");

    expect(outcome.underpayment_alerts).toHaveLength(1);
    expect(outcome.underpayment_alerts[0].variance_cents).toBe(4000);
    expect(outcome.underpayment_alerts[0].payer_id).toBe("uhc");
  });

  test("mixed batch: matched + unmatched", () => {
    const remittance = [
      makeRemittanceLine({ claim_id: "A" }),
      makeRemittanceLine({ claim_id: "ORPHAN" }),
    ];
    const claims = [makeSubmittedClaim({ claim_id: "A" })];

    const outcome = runPaymentPostingPipeline(remittance, claims, "Aetna");

    expect(outcome.reconciliation.matched).toBe(1);
    expect(outcome.reconciliation.unmatched).toBe(1);
  });
});
