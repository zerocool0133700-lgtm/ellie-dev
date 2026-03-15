/**
 * Billing Operational Data Model Types — ELLIE-750
 *
 * TypeScript interfaces matching the billing_* SQL tables.
 * Full claim lifecycle: submission -> tracking -> denial -> appeal -> payment -> posting.
 */

// ── Patients ────────────────────────────────────────────────

export interface BillingPatient {
  id: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  company_id: string;
  mrn: string | null;
  fhir_patient_id: string | null;
  first_name: string;
  last_name: string;
  dob: string | null;
  gender: string | null;
  member_id: string | null;
  phone: string | null;
  email: string | null;
  address: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

// ── Coverage ────────────────────────────────────────────────

export type CoverageStatus = "active" | "inactive" | "terminated";

export interface BillingCoverage {
  id: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  company_id: string;
  patient_id: string;
  payer_id: string;
  plan_name: string | null;
  group_number: string | null;
  subscriber_id: string | null;
  member_id: string | null;
  effective_start: string | null;
  effective_end: string | null;
  copay_cents: number | null;
  deductible_cents: number | null;
  deductible_met_cents: number;
  is_primary: boolean;
  status: CoverageStatus;
  metadata: Record<string, unknown>;
}

// ── Claims ──────────────────────────────────────────────────

export type BillingClaimStatus =
  | "draft" | "submitted" | "accepted" | "denied"
  | "partially_paid" | "paid" | "appealed" | "written_off" | "closed";

export const VALID_CLAIM_STATUSES: BillingClaimStatus[] = [
  "draft", "submitted", "accepted", "denied",
  "partially_paid", "paid", "appealed", "written_off", "closed",
];

export interface BillingClaim {
  id: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  company_id: string;
  claim_number: string;
  patient_id: string;
  coverage_id: string | null;
  payer_id: string;
  encounter_id: string | null;
  encounter_date: string | null;
  provider_npi: string | null;
  facility_npi: string | null;
  place_of_service: string | null;
  primary_diagnosis: string;
  diagnosis_codes: string[];
  billed_cents: number;
  allowed_cents: number;
  paid_cents: number;
  status: BillingClaimStatus;
  submission_date: string | null;
  timely_filing_deadline: string | null;
  tracking_number: string | null;
  metadata: Record<string, unknown>;
}

// ── Claim Line Items ────────────────────────────────────────

export interface BillingClaimLineItem {
  id: string;
  created_at: Date;
  deleted_at: Date | null;
  claim_id: string;
  line_number: number;
  cpt_code: string;
  modifiers: string[];
  diagnosis_pointers: number[];
  units: number;
  charge_cents: number;
  allowed_cents: number;
  paid_cents: number;
  denial_reason_code: string | null;
  metadata: Record<string, unknown>;
}

// ── Denials ─────────────────────────────────────────────────

export type DenialCategory = "clinical" | "administrative" | "coverage" | "coding" | "timely_filing" | "authorization" | "other";
export type DenialResolutionStatus = "open" | "appealing" | "resolved" | "written_off";

export interface BillingDenial {
  id: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  company_id: string;
  claim_id: string;
  denial_code: string;
  denial_reason: string | null;
  category: DenialCategory | null;
  appeal_deadline: string | null;
  resolution_status: DenialResolutionStatus;
  metadata: Record<string, unknown>;
}

// ── Appeals ─────────────────────────────────────────────────

export type AppealLevel = "first" | "second" | "external_review";
export type AppealOutcomeStatus = "pending" | "approved" | "denied" | "partial";

export interface BillingAppeal {
  id: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  company_id: string;
  denial_id: string;
  appeal_level: AppealLevel;
  letter_content: string | null;
  supporting_docs: unknown[];
  submission_date: string | null;
  outcome: AppealOutcomeStatus | null;
  outcome_date: string | null;
  metadata: Record<string, unknown>;
}

// ── Payments ────────────────────────────────────────────────

export interface BillingPayment {
  id: string;
  created_at: Date;
  deleted_at: Date | null;
  company_id: string;
  claim_id: string;
  payer_id: string;
  check_or_eft_number: string | null;
  payment_date: string;
  total_cents: number;
  era_reference: string | null;
  metadata: Record<string, unknown>;
}

// ── Payment Allocations ─────────────────────────────────────

export interface BillingPaymentAllocation {
  id: string;
  created_at: Date;
  payment_id: string;
  claim_line_item_id: string;
  paid_cents: number;
  contractual_adjustment_cents: number;
  patient_responsibility_cents: number;
  adjustment_reason_code: string | null;
  metadata: Record<string, unknown>;
}

// ── Work Queue ──────────────────────────────────────────────

export type WorkQueueTaskType = "submit" | "follow_up" | "appeal" | "post_payment" | "review" | "write_off";
export type WorkQueuePriority = "low" | "normal" | "high" | "urgent";
export type WorkQueueStatus = "pending" | "in_progress" | "completed" | "cancelled";

export const VALID_TASK_TYPES: WorkQueueTaskType[] = [
  "submit", "follow_up", "appeal", "post_payment", "review", "write_off",
];

export interface BillingWorkQueueItem {
  id: string;
  created_at: Date;
  updated_at: Date;
  company_id: string;
  claim_id: string | null;
  task_type: WorkQueueTaskType;
  assigned_agent: string | null;
  priority: WorkQueuePriority;
  due_date: string | null;
  status: WorkQueueStatus;
  notes: string | null;
  metadata: Record<string, unknown>;
}

// ── Audit Log ───────────────────────────────────────────────

export type AuditActorType = "agent" | "human" | "system";

export interface BillingAuditEntry {
  id: string;
  created_at: Date;
  company_id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor: string;
  actor_type: AuditActorType;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
}

// ── Validation Helpers (Pure) ───────────────────────────────

export function isValidClaimStatus(s: string): s is BillingClaimStatus {
  return VALID_CLAIM_STATUSES.includes(s as BillingClaimStatus);
}

export function isValidTaskType(s: string): s is WorkQueueTaskType {
  return VALID_TASK_TYPES.includes(s as WorkQueueTaskType);
}

/** All billing entity types (for audit log entity_type field). */
export const BILLING_ENTITY_TYPES = [
  "billing_patients", "billing_coverage", "billing_claims",
  "billing_claim_line_items", "billing_denials", "billing_appeals",
  "billing_payments", "billing_payment_allocations", "billing_work_queue",
] as const;
