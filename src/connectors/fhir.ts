/**
 * FHIR R4 Connector — ELLIE-746
 *
 * Pulls patient demographics, encounters, diagnoses, procedures,
 * and coverage data from EHR systems via FHIR R4 API.
 *
 * Normalizes FHIR JSON into billing-ready data structures.
 * Company-scoped: each clinic has its own FHIR endpoint config.
 *
 * HTTP fetch is injected for testability — no side effects in core logic.
 */

// ── Config ──────────────────────────────────────────────────

export interface FHIRConfig {
  base_url: string;
  client_id: string;
  client_secret?: string;
  token_url: string;
  company_id: string;
  scopes?: string[];
}

// ── FHIR Resource Types (minimal R4 shapes) ─────────────────

export interface FHIRPatient {
  resourceType: "Patient";
  id: string;
  name?: { family: string; given: string[] }[];
  birthDate?: string;
  gender?: string;
  identifier?: { system?: string; value: string }[];
}

export interface FHIREncounter {
  resourceType: "Encounter";
  id: string;
  status: string;
  class?: { code: string };
  period?: { start: string; end?: string };
  subject?: { reference: string };
  participant?: { individual?: { reference: string; display?: string } }[];
  serviceProvider?: { reference?: string; display?: string };
}

export interface FHIRCondition {
  resourceType: "Condition";
  id: string;
  code?: { coding?: { system?: string; code: string; display?: string }[] };
  subject?: { reference: string };
  encounter?: { reference: string };
  clinicalStatus?: { coding?: { code: string }[] };
}

export interface FHIRProcedure {
  resourceType: "Procedure";
  id: string;
  code?: { coding?: { system?: string; code: string; display?: string }[] };
  subject?: { reference: string };
  encounter?: { reference: string };
  performedDateTime?: string;
}

export interface FHIRCoverage {
  resourceType: "Coverage";
  id: string;
  status: string;
  subscriber?: { reference: string };
  subscriberId?: string;
  beneficiary?: { reference: string };
  payor?: { reference?: string; display?: string }[];
  class?: { type?: { coding?: { code: string }[] }; value?: string; name?: string }[];
}

export interface FHIRBundle {
  resourceType: "Bundle";
  total?: number;
  entry?: { resource: any }[];
}

// ── Normalized Billing Types ────────────────────────────────

export interface NormalizedPatient {
  fhir_id: string;
  first_name: string;
  last_name: string;
  dob: string | null;
  gender: string | null;
  member_id: string | null;
}

export interface NormalizedEncounter {
  fhir_id: string;
  status: string;
  class_code: string | null;
  start_date: string | null;
  end_date: string | null;
  patient_ref: string | null;
  provider_name: string | null;
}

export interface NormalizedDiagnosis {
  fhir_id: string;
  code: string;
  system: string | null;
  display: string | null;
  encounter_ref: string | null;
  is_active: boolean;
}

export interface NormalizedProcedure {
  fhir_id: string;
  code: string;
  system: string | null;
  display: string | null;
  encounter_ref: string | null;
  performed_date: string | null;
}

export interface NormalizedCoverage {
  fhir_id: string;
  status: string;
  subscriber_id: string | null;
  payer_name: string | null;
  payer_ref: string | null;
  group_number: string | null;
  plan_name: string | null;
}

// ── Normalizers (Pure) ──────────────────────────────────────

export function normalizePatient(patient: FHIRPatient): NormalizedPatient {
  const name = patient.name?.[0];
  const memberId = patient.identifier?.find(
    i => i.system?.includes("member") || i.system?.includes("insurance"),
  )?.value ?? patient.identifier?.[0]?.value ?? null;

  return {
    fhir_id: patient.id,
    first_name: name?.given?.[0] ?? "",
    last_name: name?.family ?? "",
    dob: patient.birthDate ?? null,
    gender: patient.gender ?? null,
    member_id: memberId,
  };
}

export function normalizeEncounter(encounter: FHIREncounter): NormalizedEncounter {
  const providerName = encounter.participant?.[0]?.individual?.display ?? null;

  return {
    fhir_id: encounter.id,
    status: encounter.status,
    class_code: encounter.class?.code ?? null,
    start_date: encounter.period?.start ?? null,
    end_date: encounter.period?.end ?? null,
    patient_ref: encounter.subject?.reference ?? null,
    provider_name: providerName,
  };
}

export function normalizeCondition(condition: FHIRCondition): NormalizedDiagnosis {
  const coding = condition.code?.coding?.[0];
  const isActive = condition.clinicalStatus?.coding?.[0]?.code === "active";

  return {
    fhir_id: condition.id,
    code: coding?.code ?? "",
    system: coding?.system ?? null,
    display: coding?.display ?? null,
    encounter_ref: condition.encounter?.reference ?? null,
    is_active: isActive,
  };
}

export function normalizeProcedure(procedure: FHIRProcedure): NormalizedProcedure {
  const coding = procedure.code?.coding?.[0];

  return {
    fhir_id: procedure.id,
    code: coding?.code ?? "",
    system: coding?.system ?? null,
    display: coding?.display ?? null,
    encounter_ref: procedure.encounter?.reference ?? null,
    performed_date: procedure.performedDateTime ?? null,
  };
}

export function normalizeCoverage(coverage: FHIRCoverage): NormalizedCoverage {
  const payer = coverage.payor?.[0];
  const groupClass = coverage.class?.find(
    c => c.type?.coding?.[0]?.code === "group",
  );
  const planClass = coverage.class?.find(
    c => c.type?.coding?.[0]?.code === "plan",
  );

  return {
    fhir_id: coverage.id,
    status: coverage.status,
    subscriber_id: coverage.subscriberId ?? null,
    payer_name: payer?.display ?? null,
    payer_ref: payer?.reference ?? null,
    group_number: groupClass?.value ?? null,
    plan_name: planClass?.name ?? planClass?.value ?? null,
  };
}

// ── Bundle Extraction ───────────────────────────────────────

/**
 * Extract resources of a given type from a FHIR Bundle.
 * Pure function.
 */
export function extractFromBundle<T>(
  bundle: FHIRBundle,
  resourceType: string,
): T[] {
  if (!bundle.entry) return [];
  return bundle.entry
    .map(e => e.resource)
    .filter(r => r?.resourceType === resourceType) as T[];
}

// ── OAuth2 Token Request Builder ────────────────────────────

export interface TokenRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/**
 * Build an OAuth2 client credentials token request.
 * Pure function — caller performs the actual HTTP call.
 */
export function buildTokenRequest(config: FHIRConfig): TokenRequest {
  const scopes = config.scopes ?? [
    "patient/*.read",
    "encounter/*.read",
    "condition/*.read",
    "procedure/*.read",
    "coverage/*.read",
  ];

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.client_id,
    ...(config.client_secret ? { client_secret: config.client_secret } : {}),
    scope: scopes.join(" "),
  }).toString();

  return {
    url: config.token_url,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  };
}

// ── FHIR Request Builder ────────────────────────────────────

export interface FHIRRequest {
  url: string;
  method: "GET";
  headers: Record<string, string>;
}

/**
 * Build a FHIR API request for fetching resources.
 * Pure function.
 */
export function buildFHIRRequest(
  config: FHIRConfig,
  resourceType: string,
  accessToken: string,
  params?: Record<string, string>,
): FHIRRequest {
  const url = new URL(`${config.base_url}/${resourceType}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  return {
    url: url.toString(),
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/fhir+json",
    },
  };
}

/**
 * Build requests for a full encounter pull (all resources for a patient).
 */
export function buildEncounterPullRequests(
  config: FHIRConfig,
  patientId: string,
  accessToken: string,
): FHIRRequest[] {
  return [
    buildFHIRRequest(config, "Patient", accessToken, { _id: patientId }),
    buildFHIRRequest(config, "Encounter", accessToken, { patient: patientId, _sort: "-date", _count: "10" }),
    buildFHIRRequest(config, "Condition", accessToken, { patient: patientId, "clinical-status": "active" }),
    buildFHIRRequest(config, "Procedure", accessToken, { patient: patientId, _sort: "-date", _count: "20" }),
    buildFHIRRequest(config, "Coverage", accessToken, { patient: patientId, status: "active" }),
  ];
}

// ── Validation ──────────────────────────────────────────────

/**
 * Validate a FHIR config.
 */
export function validateFHIRConfig(config: FHIRConfig): string[] {
  const errors: string[] = [];
  if (!config.base_url?.trim()) errors.push("base_url is required");
  if (!config.client_id?.trim()) errors.push("client_id is required");
  if (!config.token_url?.trim()) errors.push("token_url is required");
  if (!config.company_id?.trim()) errors.push("company_id is required");
  if (config.base_url && !config.base_url.startsWith("http")) {
    errors.push("base_url must start with http:// or https://");
  }
  return errors;
}
