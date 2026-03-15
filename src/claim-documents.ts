/**
 * Claim Documents — ELLIE-747
 *
 * Pipeline: FHIR resources -> normalized text -> embedded documents
 * stored in claim_documents for RAG retrieval. Dedup by fhir_id.
 *
 * Builds on ELLIE-746 (FHIR connector normalizers).
 * Pure pipeline logic — DB writes and embedding injected as deps.
 */

import type {
  NormalizedPatient,
  NormalizedEncounter,
  NormalizedDiagnosis,
  NormalizedProcedure,
  NormalizedCoverage,
} from "./connectors/fhir";

// ── Types ────────────────────────────────────────────────────

export interface ClaimDocument {
  id: string;
  created_at: Date;
  fhir_resource_type: string;
  fhir_id: string | null;
  fhir_last_updated: Date | null;
  patient_id: string | null;
  encounter_id: string | null;
  company_id: string | null;
  payer_id: string | null;
  content: string;
  embedding: number[] | null;
  status: string;
  metadata: Record<string, unknown>;
}

/** Input for creating/upserting a claim document. */
export interface ClaimDocumentInput {
  fhir_resource_type: string;
  fhir_id?: string;
  fhir_last_updated?: string;
  patient_id?: string;
  encounter_id?: string;
  company_id?: string;
  payer_id?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/** Result from the FHIR-to-document pipeline. */
export interface DocumentPipelineResult {
  documents_created: number;
  documents_updated: number;
  errors: { resource_type: string; fhir_id: string | null; error: string }[];
}

/** Injected dependency: upsert document (dedup by fhir_id). */
export type UpsertDocFn = (input: ClaimDocumentInput) => Promise<{ created: boolean }>;

/** Injected dependency: embed text. */
export type EmbedFn = (text: string) => Promise<number[]>;

// ── FHIR-to-Text Renderers (Pure) ───────────────────────────

/**
 * Render a normalized patient as searchable text.
 */
export function renderPatientDocument(p: NormalizedPatient): string {
  const lines = [
    `Patient: ${p.first_name} ${p.last_name}`,
    p.dob ? `Date of Birth: ${p.dob}` : null,
    p.gender ? `Gender: ${p.gender}` : null,
    p.member_id ? `Member ID: ${p.member_id}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * Render a normalized encounter as searchable text.
 */
export function renderEncounterDocument(e: NormalizedEncounter): string {
  const lines = [
    `Encounter: ${e.fhir_id}`,
    `Status: ${e.status}`,
    e.class_code ? `Class: ${e.class_code}` : null,
    e.start_date ? `Date: ${e.start_date}` : null,
    e.provider_name ? `Provider: ${e.provider_name}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * Render a normalized diagnosis as searchable text.
 */
export function renderDiagnosisDocument(d: NormalizedDiagnosis): string {
  const lines = [
    `Diagnosis: ${d.code}`,
    d.display ? `Description: ${d.display}` : null,
    d.system ? `System: ${d.system}` : null,
    `Active: ${d.is_active}`,
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * Render a normalized procedure as searchable text.
 */
export function renderProcedureDocument(p: NormalizedProcedure): string {
  const lines = [
    `Procedure: ${p.code}`,
    p.display ? `Description: ${p.display}` : null,
    p.system ? `System: ${p.system}` : null,
    p.performed_date ? `Date: ${p.performed_date}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * Render a normalized coverage as searchable text.
 */
export function renderCoverageDocument(c: NormalizedCoverage): string {
  const lines = [
    `Coverage: ${c.fhir_id}`,
    `Status: ${c.status}`,
    c.payer_name ? `Payer: ${c.payer_name}` : null,
    c.subscriber_id ? `Subscriber: ${c.subscriber_id}` : null,
    c.group_number ? `Group: ${c.group_number}` : null,
    c.plan_name ? `Plan: ${c.plan_name}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

// ── Document Input Builders (Pure) ──────────────────────────

export function buildPatientDocInput(
  p: NormalizedPatient,
  opts: { company_id?: string } = {},
): ClaimDocumentInput {
  return {
    fhir_resource_type: "Patient",
    fhir_id: p.fhir_id,
    patient_id: p.fhir_id,
    company_id: opts.company_id,
    content: renderPatientDocument(p),
    metadata: { first_name: p.first_name, last_name: p.last_name },
  };
}

export function buildEncounterDocInput(
  e: NormalizedEncounter,
  opts: { company_id?: string } = {},
): ClaimDocumentInput {
  const patientId = e.patient_ref?.replace("Patient/", "") ?? undefined;
  return {
    fhir_resource_type: "Encounter",
    fhir_id: e.fhir_id,
    patient_id: patientId,
    encounter_id: e.fhir_id,
    company_id: opts.company_id,
    content: renderEncounterDocument(e),
    metadata: { status: e.status, class_code: e.class_code },
  };
}

export function buildDiagnosisDocInput(
  d: NormalizedDiagnosis,
  opts: { patient_id?: string; company_id?: string } = {},
): ClaimDocumentInput {
  const encounterId = d.encounter_ref?.replace("Encounter/", "") ?? undefined;
  return {
    fhir_resource_type: "Condition",
    fhir_id: d.fhir_id,
    patient_id: opts.patient_id,
    encounter_id: encounterId,
    company_id: opts.company_id,
    content: renderDiagnosisDocument(d),
    metadata: { code: d.code, is_active: d.is_active },
  };
}

export function buildProcedureDocInput(
  p: NormalizedProcedure,
  opts: { patient_id?: string; company_id?: string } = {},
): ClaimDocumentInput {
  const encounterId = p.encounter_ref?.replace("Encounter/", "") ?? undefined;
  return {
    fhir_resource_type: "Procedure",
    fhir_id: p.fhir_id,
    patient_id: opts.patient_id,
    encounter_id: encounterId,
    company_id: opts.company_id,
    content: renderProcedureDocument(p),
    metadata: { code: p.code },
  };
}

export function buildCoverageDocInput(
  c: NormalizedCoverage,
  opts: { patient_id?: string; company_id?: string; payer_id?: string } = {},
): ClaimDocumentInput {
  return {
    fhir_resource_type: "Coverage",
    fhir_id: c.fhir_id,
    patient_id: opts.patient_id,
    company_id: opts.company_id,
    payer_id: opts.payer_id ?? c.payer_name ?? undefined,
    content: renderCoverageDocument(c),
    metadata: { payer_name: c.payer_name, subscriber_id: c.subscriber_id },
  };
}

// ── Pipeline ────────────────────────────────────────────────

/**
 * Run the FHIR-to-document pipeline for a set of normalized resources.
 * Upserts documents (dedup by fhir_id) and embeds content.
 *
 * deps.upsert handles the ON CONFLICT logic at the DB level.
 */
export async function runDocumentPipeline(
  resources: {
    patients?: NormalizedPatient[];
    encounters?: NormalizedEncounter[];
    diagnoses?: NormalizedDiagnosis[];
    procedures?: NormalizedProcedure[];
    coverages?: NormalizedCoverage[];
  },
  opts: { company_id?: string; patient_id?: string; payer_id?: string },
  deps: { upsert: UpsertDocFn },
): Promise<DocumentPipelineResult> {
  let created = 0;
  let updated = 0;
  const errors: DocumentPipelineResult["errors"] = [];

  const allInputs: ClaimDocumentInput[] = [];

  for (const p of resources.patients ?? []) {
    allInputs.push(buildPatientDocInput(p, opts));
  }
  for (const e of resources.encounters ?? []) {
    allInputs.push(buildEncounterDocInput(e, opts));
  }
  for (const d of resources.diagnoses ?? []) {
    allInputs.push(buildDiagnosisDocInput(d, { patient_id: opts.patient_id, company_id: opts.company_id }));
  }
  for (const p of resources.procedures ?? []) {
    allInputs.push(buildProcedureDocInput(p, { patient_id: opts.patient_id, company_id: opts.company_id }));
  }
  for (const c of resources.coverages ?? []) {
    allInputs.push(buildCoverageDocInput(c, { patient_id: opts.patient_id, company_id: opts.company_id, payer_id: opts.payer_id }));
  }

  for (const input of allInputs) {
    try {
      const result = await deps.upsert(input);
      if (result.created) created++;
      else updated++;
    } catch (err) {
      errors.push({
        resource_type: input.fhir_resource_type,
        fhir_id: input.fhir_id ?? null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { documents_created: created, documents_updated: updated, errors };
}
