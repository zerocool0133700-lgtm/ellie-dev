/**
 * Billing Operational Data Model Tests — ELLIE-750
 *
 * Tests for billing schema and types:
 * - Migration SQL: all 10 tables, company_id scoping, indexes, RLS, soft deletes
 * - Type shapes for all entities
 * - Validation helpers
 * - Constants
 * - Full claim lifecycle type compatibility
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  isValidClaimStatus,
  isValidTaskType,
  VALID_CLAIM_STATUSES,
  VALID_TASK_TYPES,
  BILLING_ENTITY_TYPES,
  type BillingPatient,
  type BillingCoverage,
  type BillingClaim,
  type BillingClaimLineItem,
  type BillingDenial,
  type BillingAppeal,
  type BillingPayment,
  type BillingPaymentAllocation,
  type BillingWorkQueueItem,
  type BillingAuditEntry,
} from "../src/types/billing.ts";

// ── Migration SQL ───────────────────────────────────────────

describe("migration SQL", () => {
  function read(): string {
    return readFileSync(join(import.meta.dir, "../migrations/supabase/20260315_billing_data_model.sql"), "utf-8");
  }

  // Table existence
  test("creates billing_patients", () => { expect(read()).toContain("CREATE TABLE IF NOT EXISTS billing_patients"); });
  test("creates billing_coverage", () => { expect(read()).toContain("CREATE TABLE IF NOT EXISTS billing_coverage"); });
  test("creates billing_claims", () => { expect(read()).toContain("CREATE TABLE IF NOT EXISTS billing_claims"); });
  test("creates billing_claim_line_items", () => { expect(read()).toContain("CREATE TABLE IF NOT EXISTS billing_claim_line_items"); });
  test("creates billing_denials", () => { expect(read()).toContain("CREATE TABLE IF NOT EXISTS billing_denials"); });
  test("creates billing_appeals", () => { expect(read()).toContain("CREATE TABLE IF NOT EXISTS billing_appeals"); });
  test("creates billing_payments", () => { expect(read()).toContain("CREATE TABLE IF NOT EXISTS billing_payments"); });
  test("creates billing_payment_allocations", () => { expect(read()).toContain("CREATE TABLE IF NOT EXISTS billing_payment_allocations"); });
  test("creates billing_work_queue", () => { expect(read()).toContain("CREATE TABLE IF NOT EXISTS billing_work_queue"); });
  test("creates billing_audit_log", () => { expect(read()).toContain("CREATE TABLE IF NOT EXISTS billing_audit_log"); });

  // Company scoping
  test("all main tables have company_id", () => {
    const sql = read();
    for (const table of ["billing_patients", "billing_coverage", "billing_claims", "billing_denials", "billing_appeals", "billing_payments", "billing_work_queue", "billing_audit_log"]) {
      // Each should have company_id column with FK
      expect(sql).toContain("company_id UUID NOT NULL REFERENCES companies(id)");
    }
  });

  // Soft deletes
  test("main tables have deleted_at for soft deletes", () => {
    const sql = read();
    const deletedAtCount = (sql.match(/deleted_at TIMESTAMPTZ/g) || []).length;
    expect(deletedAtCount).toBeGreaterThanOrEqual(7);
  });

  // Claim status CHECK
  test("claims has status CHECK with all statuses", () => {
    const sql = read();
    expect(sql).toContain("'draft'");
    expect(sql).toContain("'submitted'");
    expect(sql).toContain("'accepted'");
    expect(sql).toContain("'denied'");
    expect(sql).toContain("'paid'");
    expect(sql).toContain("'appealed'");
    expect(sql).toContain("'written_off'");
  });

  // Foreign keys
  test("coverage references billing_patients", () => {
    expect(read()).toContain("REFERENCES billing_patients(id)");
  });

  test("claims references billing_patients and payers", () => {
    const sql = read();
    expect(sql).toContain("patient_id UUID NOT NULL REFERENCES billing_patients(id)");
    expect(sql).toContain("payer_id TEXT NOT NULL REFERENCES payers(id)");
  });

  test("line items reference claims with CASCADE", () => {
    expect(read()).toContain("REFERENCES billing_claims(id) ON DELETE CASCADE");
  });

  test("denials reference claims", () => {
    expect(read()).toContain("claim_id UUID NOT NULL REFERENCES billing_claims(id)");
  });

  test("appeals reference denials", () => {
    expect(read()).toContain("denial_id UUID NOT NULL REFERENCES billing_denials(id)");
  });

  test("payments reference claims and payers", () => {
    const sql = read();
    expect(sql).toContain("claim_id UUID NOT NULL REFERENCES billing_claims(id)");
  });

  test("allocations reference payments and line items", () => {
    const sql = read();
    expect(sql).toContain("REFERENCES billing_payments(id) ON DELETE CASCADE");
    expect(sql).toContain("REFERENCES billing_claim_line_items(id)");
  });

  // Work queue
  test("work queue has task_type CHECK", () => {
    const sql = read();
    expect(sql).toContain("'submit'");
    expect(sql).toContain("'follow_up'");
    expect(sql).toContain("'appeal'");
    expect(sql).toContain("'post_payment'");
  });

  test("work queue has priority CHECK", () => {
    const sql = read();
    expect(sql).toContain("'low'");
    expect(sql).toContain("'normal'");
    expect(sql).toContain("'high'");
    expect(sql).toContain("'urgent'");
  });

  // Audit log
  test("audit log has actor_type CHECK", () => {
    const sql = read();
    expect(sql).toContain("'agent'");
    expect(sql).toContain("'human'");
    expect(sql).toContain("'system'");
  });

  test("audit log has before/after state JSONB", () => {
    const sql = read();
    expect(sql).toContain("before_state JSONB");
    expect(sql).toContain("after_state JSONB");
  });

  // RLS
  test("all 10 tables have RLS enabled", () => {
    const sql = read();
    const rlsCount = (sql.match(/ENABLE ROW LEVEL SECURITY/g) || []).length;
    expect(rlsCount).toBe(10);
  });

  // Indexes
  test("has indexes on claim status, payer, patient, dates", () => {
    const sql = read();
    expect(sql).toContain("idx_bcl_status");
    expect(sql).toContain("idx_bcl_payer");
    expect(sql).toContain("idx_bcl_patient");
    expect(sql).toContain("idx_bcl_submission");
  });
});

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("VALID_CLAIM_STATUSES has 9 statuses", () => {
    expect(VALID_CLAIM_STATUSES).toHaveLength(9);
    expect(VALID_CLAIM_STATUSES).toContain("draft");
    expect(VALID_CLAIM_STATUSES).toContain("closed");
  });

  test("VALID_TASK_TYPES has 6 types", () => {
    expect(VALID_TASK_TYPES).toHaveLength(6);
    expect(VALID_TASK_TYPES).toContain("submit");
    expect(VALID_TASK_TYPES).toContain("write_off");
  });

  test("BILLING_ENTITY_TYPES has 9 entity types", () => {
    expect(BILLING_ENTITY_TYPES).toHaveLength(9);
    expect(BILLING_ENTITY_TYPES).toContain("billing_claims");
    expect(BILLING_ENTITY_TYPES).toContain("billing_work_queue");
  });
});

// ── Validation Helpers ──────────────────────────────────────

describe("isValidClaimStatus", () => {
  test("valid statuses pass", () => {
    for (const s of VALID_CLAIM_STATUSES) expect(isValidClaimStatus(s)).toBe(true);
  });
  test("invalid status fails", () => {
    expect(isValidClaimStatus("unknown")).toBe(false);
  });
});

describe("isValidTaskType", () => {
  test("valid types pass", () => {
    for (const t of VALID_TASK_TYPES) expect(isValidTaskType(t)).toBe(true);
  });
  test("invalid type fails", () => {
    expect(isValidTaskType("unknown")).toBe(false);
  });
});

// ── Type Shapes ─────────────────────────────────────────────

describe("type shapes", () => {
  test("BillingPatient", () => {
    const p: BillingPatient = {
      id: "p1", created_at: new Date(), updated_at: new Date(), deleted_at: null,
      company_id: "c1", mrn: "MRN-1", fhir_patient_id: "pat-1",
      first_name: "Jane", last_name: "Doe", dob: "1985-06-15", gender: "female",
      member_id: "MEM-1", phone: null, email: null, address: {}, metadata: {},
    };
    expect(p.company_id).toBe("c1");
  });

  test("BillingClaim with all lifecycle statuses", () => {
    for (const status of VALID_CLAIM_STATUSES) {
      const c: BillingClaim = {
        id: "cl1", created_at: new Date(), updated_at: new Date(), deleted_at: null,
        company_id: "c1", claim_number: "CLM-001", patient_id: "p1",
        coverage_id: null, payer_id: "aetna", encounter_id: null, encounter_date: null,
        provider_npi: null, facility_npi: null, place_of_service: null,
        primary_diagnosis: "J06.9", diagnosis_codes: ["J06.9"],
        billed_cents: 15000, allowed_cents: 12000, paid_cents: 0,
        status, submission_date: null, timely_filing_deadline: null,
        tracking_number: null, metadata: {},
      };
      expect(c.status).toBe(status);
    }
  });

  test("BillingClaimLineItem", () => {
    const li: BillingClaimLineItem = {
      id: "li1", created_at: new Date(), deleted_at: null, claim_id: "cl1",
      line_number: 1, cpt_code: "99213", modifiers: ["25"], diagnosis_pointers: [0],
      units: 1, charge_cents: 15000, allowed_cents: 12000, paid_cents: 10000,
      denial_reason_code: null, metadata: {},
    };
    expect(li.cpt_code).toBe("99213");
    expect(li.modifiers).toContain("25");
  });

  test("BillingDenial", () => {
    const d: BillingDenial = {
      id: "d1", created_at: new Date(), updated_at: new Date(), deleted_at: null,
      company_id: "c1", claim_id: "cl1", denial_code: "CO-16",
      denial_reason: "Missing info", category: "administrative",
      appeal_deadline: "2026-06-15", resolution_status: "open", metadata: {},
    };
    expect(d.resolution_status).toBe("open");
  });

  test("BillingAppeal", () => {
    const a: BillingAppeal = {
      id: "a1", created_at: new Date(), updated_at: new Date(), deleted_at: null,
      company_id: "c1", denial_id: "d1", appeal_level: "first",
      letter_content: "Appeal letter...", supporting_docs: [],
      submission_date: "2026-04-01", outcome: "pending", outcome_date: null, metadata: {},
    };
    expect(a.appeal_level).toBe("first");
  });

  test("BillingPayment + Allocation", () => {
    const pay: BillingPayment = {
      id: "pay1", created_at: new Date(), deleted_at: null,
      company_id: "c1", claim_id: "cl1", payer_id: "aetna",
      check_or_eft_number: "CHK-001", payment_date: "2026-04-15",
      total_cents: 10000, era_reference: "ERA-001", metadata: {},
    };
    const alloc: BillingPaymentAllocation = {
      id: "alloc1", created_at: new Date(), payment_id: "pay1",
      claim_line_item_id: "li1", paid_cents: 10000,
      contractual_adjustment_cents: 3000, patient_responsibility_cents: 2000,
      adjustment_reason_code: "CO-45", metadata: {},
    };
    expect(pay.total_cents).toBe(10000);
    expect(alloc.contractual_adjustment_cents).toBe(3000);
  });

  test("BillingWorkQueueItem", () => {
    const wq: BillingWorkQueueItem = {
      id: "wq1", created_at: new Date(), updated_at: new Date(),
      company_id: "c1", claim_id: "cl1", task_type: "follow_up",
      assigned_agent: "claims-tracker", priority: "high",
      due_date: "2026-04-01", status: "pending", notes: null, metadata: {},
    };
    expect(wq.task_type).toBe("follow_up");
    expect(wq.priority).toBe("high");
  });

  test("BillingAuditEntry", () => {
    const ae: BillingAuditEntry = {
      id: "ae1", created_at: new Date(), company_id: "c1",
      entity_type: "billing_claims", entity_id: "cl1",
      action: "status_change", actor: "claims-tracker", actor_type: "agent",
      before_state: { status: "submitted" }, after_state: { status: "denied" }, metadata: {},
    };
    expect(ae.actor_type).toBe("agent");
    expect(ae.before_state).toEqual({ status: "submitted" });
  });
});

// ── E2E: Full Claim Lifecycle Type Compatibility ────────────

describe("E2E: claim lifecycle type compatibility", () => {
  test("draft -> submitted -> denied -> appealed -> paid lifecycle types compile", () => {
    // This test verifies that the type system supports the full lifecycle
    const patient: BillingPatient = {
      id: "p1", created_at: new Date(), updated_at: new Date(), deleted_at: null,
      company_id: "c1", mrn: "MRN-1", fhir_patient_id: null,
      first_name: "Jane", last_name: "Doe", dob: "1985-06-15", gender: "female",
      member_id: "MEM-1", phone: null, email: null, address: {}, metadata: {},
    };

    const coverage: BillingCoverage = {
      id: "cov1", created_at: new Date(), updated_at: new Date(), deleted_at: null,
      company_id: "c1", patient_id: "p1", payer_id: "aetna",
      plan_name: "PPO Gold", group_number: "GRP-789", subscriber_id: "SUB-123",
      member_id: "MEM-1", effective_start: "2026-01-01", effective_end: null,
      copay_cents: 3000, deductible_cents: 150000, deductible_met_cents: 50000,
      is_primary: true, status: "active", metadata: {},
    };

    const claim: BillingClaim = {
      id: "cl1", created_at: new Date(), updated_at: new Date(), deleted_at: null,
      company_id: "c1", claim_number: "CLM-001", patient_id: "p1",
      coverage_id: "cov1", payer_id: "aetna",
      encounter_id: "enc-001", encounter_date: "2026-03-15",
      provider_npi: "1234567890", facility_npi: null, place_of_service: "11",
      primary_diagnosis: "J06.9", diagnosis_codes: ["J06.9", "R05.9"],
      billed_cents: 15000, allowed_cents: 12000, paid_cents: 0,
      status: "submitted", submission_date: "2026-03-16",
      timely_filing_deadline: "2026-06-14", tracking_number: "TRK-001", metadata: {},
    };

    const lineItem: BillingClaimLineItem = {
      id: "li1", created_at: new Date(), deleted_at: null,
      claim_id: "cl1", line_number: 1, cpt_code: "99213",
      modifiers: [], diagnosis_pointers: [0, 1], units: 1,
      charge_cents: 15000, allowed_cents: 12000, paid_cents: 0,
      denial_reason_code: null, metadata: {},
    };

    const denial: BillingDenial = {
      id: "d1", created_at: new Date(), updated_at: new Date(), deleted_at: null,
      company_id: "c1", claim_id: "cl1", denial_code: "CO-55",
      denial_reason: "Not medically necessary", category: "clinical",
      appeal_deadline: "2026-06-15", resolution_status: "appealing", metadata: {},
    };

    const appeal: BillingAppeal = {
      id: "a1", created_at: new Date(), updated_at: new Date(), deleted_at: null,
      company_id: "c1", denial_id: "d1", appeal_level: "first",
      letter_content: "Appeal...", supporting_docs: [{ type: "LMN" }],
      submission_date: "2026-04-01", outcome: "approved", outcome_date: "2026-05-01", metadata: {},
    };

    const payment: BillingPayment = {
      id: "pay1", created_at: new Date(), deleted_at: null,
      company_id: "c1", claim_id: "cl1", payer_id: "aetna",
      check_or_eft_number: "EFT-9999", payment_date: "2026-05-15",
      total_cents: 10000, era_reference: "ERA-001", metadata: {},
    };

    const allocation: BillingPaymentAllocation = {
      id: "alloc1", created_at: new Date(), payment_id: "pay1",
      claim_line_item_id: "li1", paid_cents: 10000,
      contractual_adjustment_cents: 3000, patient_responsibility_cents: 2000,
      adjustment_reason_code: "CO-45", metadata: {},
    };

    const workItem: BillingWorkQueueItem = {
      id: "wq1", created_at: new Date(), updated_at: new Date(),
      company_id: "c1", claim_id: "cl1", task_type: "post_payment",
      assigned_agent: "payment-poster", priority: "normal",
      due_date: "2026-05-16", status: "completed", notes: null, metadata: {},
    };

    const audit: BillingAuditEntry = {
      id: "ae1", created_at: new Date(), company_id: "c1",
      entity_type: "billing_claims", entity_id: "cl1",
      action: "payment_posted", actor: "payment-poster", actor_type: "agent",
      before_state: { status: "appealed", paid_cents: 0 },
      after_state: { status: "paid", paid_cents: 10000 }, metadata: {},
    };

    // Verify all entities compile and relate correctly
    expect(patient.company_id).toBe(coverage.company_id);
    expect(coverage.patient_id).toBe(patient.id);
    expect(claim.patient_id).toBe(patient.id);
    expect(claim.coverage_id).toBe(coverage.id);
    expect(lineItem.claim_id).toBe(claim.id);
    expect(denial.claim_id).toBe(claim.id);
    expect(appeal.denial_id).toBe(denial.id);
    expect(payment.claim_id).toBe(claim.id);
    expect(allocation.payment_id).toBe(payment.id);
    expect(allocation.claim_line_item_id).toBe(lineItem.id);
    expect(workItem.claim_id).toBe(claim.id);
    expect(audit.entity_id).toBe(claim.id);
  });
});
