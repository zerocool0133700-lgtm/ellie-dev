/**
 * Claim Submission Agent — ELLIE-740
 *
 * First agent in the billing pipeline. Receives encounter input,
 * retrieves domain knowledge via RAG, validates, and produces
 * structured claim output.
 *
 * Pure pipeline logic — RAG retrieval, payer lookup, and submission
 * are injected as dependencies for testability.
 */

// ── Types ────────────────────────────────────────────────────

/** FHIR-derived encounter input for claim submission. */
export interface EncounterInput {
  encounter_id: string;
  encounter_date: string;
  patient: PatientInfo;
  insurance: InsuranceInfo;
  diagnoses: DiagnosisCode[];
  procedures: ProcedureCode[];
  provider: ProviderInfo;
  facility?: FacilityInfo;
  company_id?: string;
}

export interface PatientInfo {
  id: string;
  first_name: string;
  last_name: string;
  dob: string;
  gender: string;
  member_id: string;
}

export interface InsuranceInfo {
  payer_id: string;
  payer_name: string;
  plan_id: string;
  group_number: string | null;
  subscriber_id: string;
}

export interface DiagnosisCode {
  code: string;
  description: string;
  is_primary: boolean;
}

export interface ProcedureCode {
  cpt_code: string;
  description: string;
  modifiers: string[];
  units: number;
  charge_cents: number;
}

export interface ProviderInfo {
  npi: string;
  name: string;
  taxonomy_code: string | null;
}

export interface FacilityInfo {
  npi: string;
  name: string;
  place_of_service: string;
}

/** A validated claim line item ready for submission. */
export interface ClaimLineItem {
  line_number: number;
  cpt_code: string;
  modifiers: string[];
  diagnosis_pointers: number[];
  units: number;
  charge_cents: number;
  expected_reimbursement_cents: number | null;
}

/** Structured claim ready for EDI/CMS-1500 generation. */
export interface ClaimDocument {
  claim_id: string;
  encounter_id: string;
  encounter_date: string;
  patient: PatientInfo;
  insurance: InsuranceInfo;
  provider: ProviderInfo;
  facility: FacilityInfo | null;
  primary_diagnosis: string;
  diagnoses: string[];
  line_items: ClaimLineItem[];
  total_charge_cents: number;
  requires_prior_auth: boolean;
  prior_auth_flags: PriorAuthFlag[];
  validation_warnings: string[];
}

export interface PriorAuthFlag {
  cpt_code: string;
  payer_id: string;
  auth_phone: string | null;
  notes: string | null;
}

/** Final typed output from the claim submission agent. */
export interface ClaimSubmissionOutcome {
  status: "submitted" | "validated" | "failed";
  claim_id: string;
  encounter_id: string;
  tracking_number: string | null;
  submission_cost_cents: number;
  expected_reimbursement_cents: number;
  total_charge_cents: number;
  line_item_count: number;
  prior_auth_required: boolean;
  validation_errors: string[];
  validation_warnings: string[];
}

// ── Validation ──────────────────────────────────────────────

/**
 * Validate encounter input has all required fields.
 * Returns errors (empty = valid).
 */
export function validateEncounterInput(input: EncounterInput): string[] {
  const errors: string[] = [];

  if (!input.encounter_id) errors.push("encounter_id is required");
  if (!input.encounter_date) errors.push("encounter_date is required");

  if (!input.patient?.id) errors.push("patient.id is required");
  if (!input.patient?.first_name) errors.push("patient.first_name is required");
  if (!input.patient?.last_name) errors.push("patient.last_name is required");
  if (!input.patient?.dob) errors.push("patient.dob is required");
  if (!input.patient?.member_id) errors.push("patient.member_id is required");

  if (!input.insurance?.payer_id) errors.push("insurance.payer_id is required");
  if (!input.insurance?.subscriber_id) errors.push("insurance.subscriber_id is required");

  if (!input.diagnoses?.length) errors.push("at least one diagnosis is required");
  else {
    const primary = input.diagnoses.filter(d => d.is_primary);
    if (primary.length === 0) errors.push("a primary diagnosis is required");
    if (primary.length > 1) errors.push("only one primary diagnosis allowed");
    for (const d of input.diagnoses) {
      if (!d.code) errors.push("diagnosis code is required");
    }
  }

  if (!input.procedures?.length) errors.push("at least one procedure is required");
  else {
    for (const p of input.procedures) {
      if (!p.cpt_code) errors.push("procedure cpt_code is required");
      if (p.units < 1) errors.push(`procedure ${p.cpt_code}: units must be >= 1`);
      if (p.charge_cents < 0) errors.push(`procedure ${p.cpt_code}: charge cannot be negative`);
    }
  }

  if (!input.provider?.npi) errors.push("provider.npi is required");

  return errors;
}

// ── Claim Building ──────────────────────────────────────────

/** Injected dependency: check prior auth for a payer + CPT code. */
export type CheckPriorAuthFn = (payerId: string, cptCode: string) => Promise<{
  requires_prior_auth: boolean;
  auth_phone: string | null;
  notes: string | null;
}>;

/** Injected dependency: get expected reimbursement from fee schedule. */
export type GetFeeScheduleFn = (payerId: string, cptCode: string) => Promise<number | null>;

/**
 * Build a claim document from encounter input.
 * Checks prior auth requirements and fee schedules via injected deps.
 *
 * Returns validated claim document or errors.
 */
export async function buildClaim(
  input: EncounterInput,
  deps: {
    checkPriorAuth: CheckPriorAuthFn;
    getFeeSchedule?: GetFeeScheduleFn;
  },
): Promise<{ claim: ClaimDocument | null; errors: string[] }> {
  const errors = validateEncounterInput(input);
  if (errors.length > 0) return { claim: null, errors };

  const primaryDiag = input.diagnoses.find(d => d.is_primary)!;
  const diagCodes = input.diagnoses.map(d => d.code);
  const warnings: string[] = [];
  const priorAuthFlags: PriorAuthFlag[] = [];

  // Build line items with prior auth checks
  const lineItems: ClaimLineItem[] = [];
  for (let i = 0; i < input.procedures.length; i++) {
    const proc = input.procedures[i];

    // Check prior auth
    const auth = await deps.checkPriorAuth(input.insurance.payer_id, proc.cpt_code);
    if (auth.requires_prior_auth) {
      priorAuthFlags.push({
        cpt_code: proc.cpt_code,
        payer_id: input.insurance.payer_id,
        auth_phone: auth.auth_phone,
        notes: auth.notes,
      });
    }

    // Get expected reimbursement
    let expectedReimbursement: number | null = null;
    if (deps.getFeeSchedule) {
      expectedReimbursement = await deps.getFeeSchedule(input.insurance.payer_id, proc.cpt_code);
    }

    // Diagnosis pointers: primary first, then others
    const pointers = [0]; // Always point to primary
    for (let j = 0; j < input.diagnoses.length; j++) {
      if (j !== input.diagnoses.indexOf(primaryDiag) && !pointers.includes(j)) {
        pointers.push(j);
      }
    }

    lineItems.push({
      line_number: i + 1,
      cpt_code: proc.cpt_code,
      modifiers: proc.modifiers,
      diagnosis_pointers: pointers.slice(0, 4), // Max 4 pointers per CMS-1500
      units: proc.units,
      charge_cents: proc.charge_cents * proc.units,
      expected_reimbursement_cents: expectedReimbursement
        ? expectedReimbursement * proc.units
        : null,
    });
  }

  const totalCharge = lineItems.reduce((sum, li) => sum + li.charge_cents, 0);

  const claim: ClaimDocument = {
    claim_id: generateClaimId(input),
    encounter_id: input.encounter_id,
    encounter_date: input.encounter_date,
    patient: input.patient,
    insurance: input.insurance,
    provider: input.provider,
    facility: input.facility ?? null,
    primary_diagnosis: primaryDiag.code,
    diagnoses: diagCodes,
    line_items: lineItems,
    total_charge_cents: totalCharge,
    requires_prior_auth: priorAuthFlags.length > 0,
    prior_auth_flags: priorAuthFlags,
    validation_warnings: warnings,
  };

  return { claim, errors: [] };
}

/**
 * Build a ClaimSubmissionOutcome from a claim document.
 */
export function buildOutcome(
  claim: ClaimDocument,
  opts: {
    status?: "submitted" | "validated" | "failed";
    tracking_number?: string;
    submission_cost_cents?: number;
  } = {},
): ClaimSubmissionOutcome {
  const expectedReimbursement = claim.line_items.reduce(
    (sum, li) => sum + (li.expected_reimbursement_cents ?? 0),
    0,
  );

  return {
    status: opts.status ?? "validated",
    claim_id: claim.claim_id,
    encounter_id: claim.encounter_id,
    tracking_number: opts.tracking_number ?? null,
    submission_cost_cents: opts.submission_cost_cents ?? 0,
    expected_reimbursement_cents: expectedReimbursement,
    total_charge_cents: claim.total_charge_cents,
    line_item_count: claim.line_items.length,
    prior_auth_required: claim.requires_prior_auth,
    validation_errors: [],
    validation_warnings: claim.validation_warnings,
  };
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Generate a deterministic claim ID from encounter data.
 */
export function generateClaimId(input: EncounterInput): string {
  const base = `${input.encounter_id}-${input.insurance.payer_id}-${input.encounter_date}`;
  let hash = 0;
  for (let i = 0; i < base.length; i++) {
    const char = base.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit int
  }
  return `CLM-${Math.abs(hash).toString(36).toUpperCase().padStart(8, "0")}`;
}

/**
 * Build RAG queries for a given encounter (what to search for).
 * Pure function — returns query strings for the medical context source.
 */
export function buildRAGQueries(input: EncounterInput): { query: string; categories: string[] }[] {
  const queries: { query: string; categories: string[] }[] = [];

  // CPT code validation for each procedure
  for (const proc of input.procedures) {
    queries.push({
      query: `CPT code ${proc.cpt_code} ${proc.description}`,
      categories: ["cpt_codes"],
    });
  }

  // Payer-specific requirements
  queries.push({
    query: `${input.insurance.payer_name} billing requirements and payer rules`,
    categories: ["payer_rules"],
  });

  // Diagnosis validation
  for (const diag of input.diagnoses) {
    queries.push({
      query: `ICD-10 ${diag.code} ${diag.description}`,
      categories: ["icd10_codes"],
    });
  }

  // Fee schedule lookup
  for (const proc of input.procedures) {
    queries.push({
      query: `Fee schedule ${input.insurance.payer_name} CPT ${proc.cpt_code}`,
      categories: ["fee_schedules"],
    });
  }

  return queries;
}
