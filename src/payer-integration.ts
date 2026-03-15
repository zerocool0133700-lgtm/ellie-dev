/**
 * Payer Integration Layer — ELLIE-755
 *
 * EDI-837 claim formatter, EDI-835 remittance parser,
 * submission routing, clearinghouse connector patterns.
 *
 * Pure module — no actual HTTP/SFTP calls. Generates formatted
 * data and request structures for callers to execute.
 */

import type { ClaimDocument, ClaimLineItem } from "./claim-submission";
import type { RemittanceLine, AdjustmentEntry } from "./payment-posting";

// ── Types ────────────────────────────────────────────────────

export type SubmissionMethod = "edi" | "api" | "portal" | "sftp";
export type Clearinghouse = "availity" | "change_healthcare" | "trizetto" | "office_ally" | "other";
export type ERAFormat = "835" | "pdf" | "api";

export const VALID_SUBMISSION_METHODS: SubmissionMethod[] = ["edi", "api", "portal", "sftp"];
export const VALID_CLEARINGHOUSES: Clearinghouse[] = ["availity", "change_healthcare", "trizetto", "office_ally", "other"];

export interface PayerIntegration {
  id: string;
  payer_id: string;
  payer_name: string;
  submission_method: SubmissionMethod;
  edi_payer_id: string | null;
  endpoint_url: string | null;
  sftp_host: string | null;
  sftp_credentials_ref: string | null;
  clearinghouse: Clearinghouse | null;
  era_format: ERAFormat;
  company_id: string;
  active: boolean;
  metadata: Record<string, unknown>;
}

/** A submission request ready for execution by the caller. */
export interface SubmissionRequest {
  method: SubmissionMethod;
  payer_id: string;
  clearinghouse: Clearinghouse | null;
  endpoint: string | null;
  payload: string;
  format: "x12_837p" | "json" | "file";
  filename: string | null;
}

// ── EDI-837P Formatter (X12) ────────────────────────────────

/** X12 segment separator. */
const SEG = "~\n";
/** X12 element separator. */
const EL = "*";

/**
 * Format a claim into EDI-837P (Professional) X12 format.
 * Simplified — covers the core segments for a valid 837P.
 * Pure function.
 */
export function formatEDI837P(claim: ClaimDocument): string {
  const segments: string[] = [];
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 15).replace(":", "");
  const controlNum = claim.claim_id.replace(/[^A-Z0-9]/gi, "").slice(0, 9).padEnd(9, "0");

  // ISA - Interchange Control Header
  segments.push(`ISA${EL}00${EL}          ${EL}00${EL}          ${EL}ZZ${EL}SENDER         ${EL}ZZ${EL}RECEIVER       ${EL}${date.slice(2)}${EL}${time}${EL}^${EL}00501${EL}${controlNum}${EL}0${EL}P${EL}:`);

  // GS - Functional Group Header
  segments.push(`GS${EL}HC${EL}SENDER${EL}RECEIVER${EL}${date}${EL}${time}${EL}1${EL}X${EL}005010X222A1`);

  // ST - Transaction Set Header
  segments.push(`ST${EL}837${EL}0001${EL}005010X222A1`);

  // BHT - Beginning of Hierarchical Transaction
  segments.push(`BHT${EL}0019${EL}00${EL}${controlNum}${EL}${date}${EL}${time}${EL}CH`);

  // Submitter (1000A)
  segments.push(`NM1${EL}41${EL}2${EL}${claim.provider.name}${EL}${EL}${EL}${EL}${EL}46${EL}${claim.provider.npi}`);

  // Receiver (1000B)
  segments.push(`NM1${EL}40${EL}2${EL}${claim.insurance.payer_name}${EL}${EL}${EL}${EL}${EL}46${EL}${claim.insurance.payer_id}`);

  // Subscriber (2000B/2010BA)
  segments.push(`HL${EL}1${EL}${EL}20${EL}1`);
  segments.push(`SBR${EL}P${EL}18${EL}${claim.insurance.plan_id}${EL}${EL}${EL}${EL}${EL}${EL}CI`);
  segments.push(`NM1${EL}IL${EL}1${EL}${claim.patient.last_name}${EL}${claim.patient.first_name}${EL}${EL}${EL}${EL}MI${EL}${claim.patient.member_id}`);
  segments.push(`DMG${EL}D8${EL}${claim.patient.dob.replace(/-/g, "")}${EL}${claim.patient.gender === "female" ? "F" : "M"}`);

  // Payer (2010BB)
  segments.push(`NM1${EL}PR${EL}2${EL}${claim.insurance.payer_name}${EL}${EL}${EL}${EL}${EL}PI${EL}${claim.insurance.payer_id}`);

  // Claim (2300)
  segments.push(`CLM${EL}${claim.claim_id}${EL}${(claim.total_charge_cents / 100).toFixed(2)}${EL}${EL}${EL}${claim.facility ? claim.facility.place_of_service : "11"}:B:1${EL}Y${EL}A${EL}Y${EL}Y`);

  // Diagnosis (2300 - HI segment)
  const diagPointers = claim.diagnoses.map((d, i) =>
    `${i === 0 ? "ABK" : "ABF"}:${d}`,
  );
  segments.push(`HI${EL}${diagPointers.join(EL)}`);

  // Service Lines (2400)
  for (const li of claim.line_items) {
    const modStr = li.modifiers.length > 0 ? `:${li.modifiers.join(":")}` : "";
    segments.push(`LX${EL}${li.line_number}`);
    segments.push(`SV1${EL}HC:${li.cpt_code}${modStr}${EL}${(li.charge_cents / 100).toFixed(2)}${EL}UN${EL}${li.units}${EL}${EL}${EL}${li.diagnosis_pointers.map(p => p + 1).join(":")}`);
    segments.push(`DTP${EL}472${EL}D8${EL}${claim.encounter_date.replace(/-/g, "")}`);
  }

  // SE - Transaction Set Trailer
  segments.push(`SE${EL}${segments.length + 1}${EL}0001`);

  // GE - Functional Group Trailer
  segments.push(`GE${EL}1${EL}1`);

  // IEA - Interchange Control Trailer
  segments.push(`IEA${EL}1${EL}${controlNum}`);

  return segments.join(SEG) + SEG;
}

// ── EDI-835 Parser ──────────────────────────────────────────

/**
 * Parse an EDI-835 (ERA) string into structured remittance lines.
 * Simplified parser — handles CLP (claim payment) and SVC (service) segments.
 * Pure function.
 */
export function parseEDI835(raw: string): RemittanceLine[] {
  const lines: RemittanceLine[] = [];
  const segments = raw.split("~").map(s => s.trim()).filter(Boolean);

  let currentClaim: Partial<RemittanceLine> | null = null;
  let currentAdjustments: AdjustmentEntry[] = [];

  for (const seg of segments) {
    const elements = seg.split("*");
    const id = elements[0];

    if (id === "CLP") {
      // Save previous claim
      if (currentClaim?.claim_id) {
        lines.push(finalizeLine(currentClaim, currentAdjustments));
      }
      currentClaim = {
        claim_id: elements[1] ?? "",
        patient_name: null,
        cpt_code: "",
        billed_cents: parseCents(elements[3]),
        paid_cents: parseCents(elements[4]),
        allowed_cents: 0,
        adjustments: [],
        patient_responsibility_cents: 0,
      };
      currentAdjustments = [];
    }

    if (id === "SVC" && currentClaim) {
      const codeInfo = elements[1]?.split(":") ?? [];
      currentClaim.cpt_code = codeInfo[1] ?? "";
      currentClaim.billed_cents = parseCents(elements[2]);
      currentClaim.paid_cents = parseCents(elements[3]);
      if (elements[5]) currentClaim.allowed_cents = parseCents(elements[5]);
    }

    if (id === "CAS" && currentClaim) {
      const groupCode = elements[1] ?? "";
      for (let i = 2; i < elements.length; i += 3) {
        const reasonCode = elements[i];
        const amount = parseCents(elements[i + 1]);
        if (reasonCode && amount > 0) {
          currentAdjustments.push({ group_code: groupCode, reason_code: reasonCode, amount_cents: amount });
        }
      }
    }

    if (id === "NM1" && elements[1] === "QC" && currentClaim) {
      currentClaim.patient_name = [elements[3], elements[4]].filter(Boolean).join(", ");
    }
  }

  // Save last claim
  if (currentClaim?.claim_id) {
    lines.push(finalizeLine(currentClaim, currentAdjustments));
  }

  return lines;
}

function parseCents(val: string | undefined): number {
  if (!val) return 0;
  const num = parseFloat(val);
  return isNaN(num) ? 0 : Math.round(num * 100);
}

function finalizeLine(partial: Partial<RemittanceLine>, adjustments: AdjustmentEntry[]): RemittanceLine {
  const patientResp = adjustments
    .filter(a => a.group_code === "PR")
    .reduce((s, a) => s + a.amount_cents, 0);

  return {
    claim_id: partial.claim_id ?? "",
    patient_name: partial.patient_name ?? null,
    cpt_code: partial.cpt_code ?? "",
    billed_cents: partial.billed_cents ?? 0,
    allowed_cents: partial.allowed_cents ?? partial.billed_cents ?? 0,
    paid_cents: partial.paid_cents ?? 0,
    adjustments,
    patient_responsibility_cents: patientResp,
  };
}

// ── Submission Router ───────────────────────────────────────

/**
 * Route a claim to the correct submission method based on payer integration config.
 * Pure function.
 */
export function routeSubmission(
  claim: ClaimDocument,
  integration: PayerIntegration,
): SubmissionRequest {
  switch (integration.submission_method) {
    case "edi": {
      const payload = formatEDI837P(claim);
      return {
        method: "edi",
        payer_id: integration.payer_id,
        clearinghouse: integration.clearinghouse,
        endpoint: integration.endpoint_url,
        payload,
        format: "x12_837p",
        filename: `837P_${claim.claim_id}_${Date.now()}.edi`,
      };
    }
    case "api":
      return {
        method: "api",
        payer_id: integration.payer_id,
        clearinghouse: integration.clearinghouse,
        endpoint: integration.endpoint_url,
        payload: JSON.stringify(claim),
        format: "json",
        filename: null,
      };
    case "sftp": {
      const payload = formatEDI837P(claim);
      return {
        method: "sftp",
        payer_id: integration.payer_id,
        clearinghouse: null,
        endpoint: integration.sftp_host,
        payload,
        format: "x12_837p",
        filename: `837P_${claim.claim_id}_${Date.now()}.edi`,
      };
    }
    case "portal":
      return {
        method: "portal",
        payer_id: integration.payer_id,
        clearinghouse: null,
        endpoint: integration.endpoint_url,
        payload: JSON.stringify(claim),
        format: "json",
        filename: null,
      };
  }
}

// ── Validation ──────────────────────────────────────────────

/**
 * Validate an EDI-837P output has required segments.
 * Pure function.
 */
export function validateEDI837P(edi: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const required = ["ISA", "GS", "ST", "BHT", "NM1", "CLM", "HI", "SV1", "SE", "GE", "IEA"];

  for (const seg of required) {
    if (!edi.includes(`${seg}*`)) {
      errors.push(`Missing required segment: ${seg}`);
    }
  }

  if (!edi.includes("837")) errors.push("Missing transaction set identifier 837");

  return { valid: errors.length === 0, errors };
}

/**
 * Validate an EDI-835 has basic structure.
 */
export function validateEDI835(edi: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!edi.includes("CLP*")) errors.push("Missing CLP (claim payment) segment");
  return { valid: errors.length === 0, errors };
}
