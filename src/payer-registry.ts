/**
 * Payer Registry — ELLIE-739
 *
 * Per-payer knowledge filtering for medical billing.
 * CRUD, timely filing lookup, prior auth requirements,
 * denial code mappings, and fallback to general rules.
 */

import { sql } from "../../ellie-forest/src/index";

// ── Types ────────────────────────────────────────────────────

export type PayerType = "commercial" | "medicare" | "medicaid" | "tricare" | "workers_comp" | "other";

export const VALID_PAYER_TYPES: PayerType[] = [
  "commercial", "medicare", "medicaid", "tricare", "workers_comp", "other",
];

export interface Payer {
  id: string;
  created_at: Date;
  updated_at: Date;
  name: string;
  type: PayerType;
  status: string;
  timely_filing_days: number | null;
  appeal_deadline_days: number | null;
  phone: string | null;
  website: string | null;
  portal_url: string | null;
  claims_address: string | null;
  company_id: string | null;
  metadata: Record<string, unknown>;
}

export interface PriorAuthRule {
  id: string;
  payer_id: string;
  cpt_code: string;
  requires_prior_auth: boolean;
  auth_phone: string | null;
  auth_portal_url: string | null;
  notes: string | null;
  effective_date: string | null;
  metadata: Record<string, unknown>;
}

export interface DenialMapping {
  id: string;
  payer_id: string;
  denial_code: string;
  payer_description: string;
  standard_description: string | null;
  recommended_action: string | null;
  appeal_template_id: string | null;
  metadata: Record<string, unknown>;
}

export interface CreatePayerInput {
  id: string;
  name: string;
  type: PayerType;
  timely_filing_days?: number;
  appeal_deadline_days?: number;
  phone?: string;
  website?: string;
  portal_url?: string;
  claims_address?: string;
  company_id?: string;
  metadata?: Record<string, unknown>;
}

/** Result of a timely filing lookup with fallback info. */
export interface TimelyFilingResult {
  payer_id: string;
  payer_name: string;
  timely_filing_days: number;
  source: "payer_specific" | "general_default";
}

/** Result of a prior auth check. */
export interface PriorAuthCheckResult {
  payer_id: string;
  cpt_code: string;
  requires_prior_auth: boolean;
  auth_phone: string | null;
  auth_portal_url: string | null;
  notes: string | null;
  source: "payer_specific" | "not_found";
}

/** Default timely filing when no payer-specific data. */
export const DEFAULT_TIMELY_FILING_DAYS = 365;

/** Default appeal deadline when no payer-specific data. */
export const DEFAULT_APPEAL_DEADLINE_DAYS = 180;

// ── Payer CRUD ──────────────────────────────────────────────

export async function createPayer(input: CreatePayerInput): Promise<Payer> {
  const [payer] = await sql<Payer[]>`
    INSERT INTO payers (id, name, type, timely_filing_days, appeal_deadline_days,
      phone, website, portal_url, claims_address, company_id, metadata)
    VALUES (
      ${input.id}, ${input.name}, ${input.type},
      ${input.timely_filing_days ?? null}, ${input.appeal_deadline_days ?? null},
      ${input.phone ?? null}, ${input.website ?? null},
      ${input.portal_url ?? null}, ${input.claims_address ?? null},
      ${input.company_id ?? null}::uuid, ${sql.json(input.metadata ?? {})}
    )
    RETURNING *
  `;
  return payer;
}

export async function getPayer(id: string): Promise<Payer | null> {
  const [payer] = await sql<Payer[]>`SELECT * FROM payers WHERE id = ${id}`;
  return payer ?? null;
}

export async function listPayers(opts: { type?: PayerType; company_id?: string } = {}): Promise<Payer[]> {
  if (opts.type && opts.company_id) {
    return sql<Payer[]>`SELECT * FROM payers WHERE type = ${opts.type} AND company_id = ${opts.company_id}::uuid ORDER BY name`;
  }
  if (opts.type) {
    return sql<Payer[]>`SELECT * FROM payers WHERE type = ${opts.type} ORDER BY name`;
  }
  if (opts.company_id) {
    return sql<Payer[]>`SELECT * FROM payers WHERE company_id = ${opts.company_id}::uuid ORDER BY name`;
  }
  return sql<Payer[]>`SELECT * FROM payers ORDER BY name`;
}

// ── Timely Filing Lookup ────────────────────────────────────

/**
 * Get timely filing deadline for a payer.
 * Falls back to DEFAULT_TIMELY_FILING_DAYS if not set.
 */
export async function getTimelyFiling(payerId: string): Promise<TimelyFilingResult> {
  const payer = await getPayer(payerId);

  if (payer?.timely_filing_days) {
    return {
      payer_id: payerId,
      payer_name: payer.name,
      timely_filing_days: payer.timely_filing_days,
      source: "payer_specific",
    };
  }

  return {
    payer_id: payerId,
    payer_name: payer?.name ?? "Unknown",
    timely_filing_days: DEFAULT_TIMELY_FILING_DAYS,
    source: "general_default",
  };
}

// ── Prior Auth ──────────────────────────────────────────────

export async function addPriorAuthRule(rule: Omit<PriorAuthRule, "id">): Promise<PriorAuthRule> {
  const [r] = await sql<PriorAuthRule[]>`
    INSERT INTO payer_prior_auth_rules (payer_id, cpt_code, requires_prior_auth,
      auth_phone, auth_portal_url, notes, effective_date, metadata)
    VALUES (${rule.payer_id}, ${rule.cpt_code}, ${rule.requires_prior_auth},
      ${rule.auth_phone ?? null}, ${rule.auth_portal_url ?? null},
      ${rule.notes ?? null}, ${rule.effective_date ?? null},
      ${sql.json(rule.metadata ?? {})})
    RETURNING *
  `;
  return r;
}

/**
 * Check if a procedure requires prior auth for a payer.
 * Returns source: "not_found" if no rule exists (assume no auth needed).
 */
export async function checkPriorAuth(
  payerId: string,
  cptCode: string,
): Promise<PriorAuthCheckResult> {
  const [rule] = await sql<PriorAuthRule[]>`
    SELECT * FROM payer_prior_auth_rules
    WHERE payer_id = ${payerId} AND cpt_code = ${cptCode}
    ORDER BY effective_date DESC NULLS LAST
    LIMIT 1
  `;

  if (!rule) {
    return {
      payer_id: payerId,
      cpt_code: cptCode,
      requires_prior_auth: false,
      auth_phone: null,
      auth_portal_url: null,
      notes: null,
      source: "not_found",
    };
  }

  return {
    payer_id: payerId,
    cpt_code: cptCode,
    requires_prior_auth: rule.requires_prior_auth,
    auth_phone: rule.auth_phone,
    auth_portal_url: rule.auth_portal_url,
    notes: rule.notes,
    source: "payer_specific",
  };
}

/**
 * Get all prior auth rules for a payer.
 */
export async function getPriorAuthRules(payerId: string): Promise<PriorAuthRule[]> {
  return sql<PriorAuthRule[]>`
    SELECT * FROM payer_prior_auth_rules
    WHERE payer_id = ${payerId}
    ORDER BY cpt_code
  `;
}

// ── Denial Code Mappings ────────────────────────────────────

export async function addDenialMapping(mapping: Omit<DenialMapping, "id">): Promise<DenialMapping> {
  const [m] = await sql<DenialMapping[]>`
    INSERT INTO payer_denial_mappings (payer_id, denial_code, payer_description,
      standard_description, recommended_action, appeal_template_id, metadata)
    VALUES (${mapping.payer_id}, ${mapping.denial_code}, ${mapping.payer_description},
      ${mapping.standard_description ?? null}, ${mapping.recommended_action ?? null},
      ${mapping.appeal_template_id ?? null}::uuid, ${sql.json(mapping.metadata ?? {})})
    RETURNING *
  `;
  return m;
}

/**
 * Look up a denial code for a specific payer.
 * Returns null if no payer-specific mapping exists.
 */
export async function getDenialMapping(
  payerId: string,
  denialCode: string,
): Promise<DenialMapping | null> {
  const [m] = await sql<DenialMapping[]>`
    SELECT * FROM payer_denial_mappings
    WHERE payer_id = ${payerId} AND denial_code = ${denialCode}
    LIMIT 1
  `;
  return m ?? null;
}

/**
 * Get all denial mappings for a payer.
 */
export async function getDenialMappings(payerId: string): Promise<DenialMapping[]> {
  return sql<DenialMapping[]>`
    SELECT * FROM payer_denial_mappings
    WHERE payer_id = ${payerId}
    ORDER BY denial_code
  `;
}

// ── Payer Context Builder (Pure) ────────────────────────────

/**
 * Build a payer context summary for injection into agent prompts.
 * Pure function.
 */
export function buildPayerContextPrompt(payer: Payer): string {
  const lines: string[] = [
    `### Payer: ${payer.name} (${payer.type})`,
    "",
  ];

  if (payer.timely_filing_days) {
    lines.push(`- Timely filing deadline: ${payer.timely_filing_days} days`);
  }
  if (payer.appeal_deadline_days) {
    lines.push(`- Appeal deadline: ${payer.appeal_deadline_days} days`);
  }
  if (payer.phone) lines.push(`- Phone: ${payer.phone}`);
  if (payer.portal_url) lines.push(`- Portal: ${payer.portal_url}`);
  if (payer.claims_address) lines.push(`- Claims address: ${payer.claims_address}`);

  return lines.join("\n");
}
