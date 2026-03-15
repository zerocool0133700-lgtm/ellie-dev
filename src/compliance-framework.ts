/**
 * HIPAA Security & Compliance Framework — ELLIE-753
 *
 * State-specific billing rules engine, BAA tracking,
 * security audit report generation, timely filing enforcement.
 *
 * Builds on ELLIE-751 (HIPAA compliance layer) with DB-backed
 * state rules and BAA tracking.
 *
 * Pure logic — DB writes injected as deps where needed.
 */

import { sql } from "../../ellie-forest/src/index";

// ── Types ────────────────────────────────────────────────────

export type StateRuleType = "timely_filing" | "prior_authorization" | "billing_format" | "patient_balance_limit" | "appeal_deadline" | "other";
export type PayerTypeFilter = "commercial" | "medicare" | "medicaid" | "workers_comp" | "all";
export type BAAStatus = "not_started" | "in_progress" | "signed" | "expired" | "not_applicable";

export const VALID_RULE_TYPES: StateRuleType[] = [
  "timely_filing", "prior_authorization", "billing_format", "patient_balance_limit", "appeal_deadline", "other",
];

export const VALID_BAA_STATUSES: BAAStatus[] = [
  "not_started", "in_progress", "signed", "expired", "not_applicable",
];

export interface StateBillingRule {
  id: string;
  created_at: Date;
  updated_at: Date;
  state_code: string;
  rule_type: StateRuleType;
  payer_type: PayerTypeFilter | null;
  description: string;
  value_days: number | null;
  value_cents: number | null;
  value_text: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  source_reference: string | null;
  company_id: string | null;
  metadata: Record<string, unknown>;
}

export interface BAA {
  id: string;
  created_at: Date;
  updated_at: Date;
  company_id: string;
  vendor_name: string;
  service_description: string;
  stores_phi: boolean;
  processes_phi: boolean;
  baa_status: BAAStatus;
  signed_date: string | null;
  expiration_date: string | null;
  document_url: string | null;
  contact_email: string | null;
  notes: string | null;
  metadata: Record<string, unknown>;
}

/** Security audit report summary. */
export interface SecurityAuditReport {
  generated_at: string;
  company_id: string;
  encryption: { phi_fields_encrypted: boolean; tls_enforced: boolean };
  access_control: { rls_enabled: boolean; agent_roles_configured: boolean };
  audit_logging: { immutable: boolean; coverage_percent: number };
  baa_status: { total: number; signed: number; pending: number; expired: number };
  data_retention: { policy_defined: boolean; automated_purge: boolean };
  state_rules: { states_configured: number; rules_count: number };
  overall_score: number;
  issues: string[];
}

// ── State Rules CRUD ────────────────────────────────────────

export async function createStateRule(rule: Omit<StateBillingRule, "id" | "created_at" | "updated_at">): Promise<StateBillingRule> {
  const [r] = await sql<StateBillingRule[]>`
    INSERT INTO state_billing_rules (
      state_code, rule_type, payer_type, description,
      value_days, value_cents, value_text,
      effective_date, expiration_date, source_reference,
      company_id, metadata
    ) VALUES (
      ${rule.state_code}, ${rule.rule_type}, ${rule.payer_type ?? null},
      ${rule.description}, ${rule.value_days ?? null}, ${rule.value_cents ?? null},
      ${rule.value_text ?? null}, ${rule.effective_date ?? null},
      ${rule.expiration_date ?? null}, ${rule.source_reference ?? null},
      ${rule.company_id ?? null}::uuid, ${sql.json(rule.metadata ?? {})}
    ) RETURNING *
  `;
  return r;
}

export async function getStateRules(stateCode: string, ruleType?: StateRuleType): Promise<StateBillingRule[]> {
  if (ruleType) {
    return sql<StateBillingRule[]>`
      SELECT * FROM state_billing_rules
      WHERE state_code = ${stateCode} AND rule_type = ${ruleType}
      ORDER BY effective_date DESC NULLS LAST
    `;
  }
  return sql<StateBillingRule[]>`
    SELECT * FROM state_billing_rules
    WHERE state_code = ${stateCode}
    ORDER BY rule_type, effective_date DESC NULLS LAST
  `;
}

export async function getTimelyFilingRule(stateCode: string, payerType?: PayerTypeFilter): Promise<StateBillingRule | null> {
  const [rule] = await sql<StateBillingRule[]>`
    SELECT * FROM state_billing_rules
    WHERE state_code = ${stateCode}
      AND rule_type = 'timely_filing'
      AND (payer_type = ${payerType ?? "all"} OR payer_type = 'all')
    ORDER BY effective_date DESC NULLS LAST
    LIMIT 1
  `;
  return rule ?? null;
}

// ── BAA CRUD ────────────────────────────────────────────────

export async function createBAA(baa: Omit<BAA, "id" | "created_at" | "updated_at">): Promise<BAA> {
  const [b] = await sql<BAA[]>`
    INSERT INTO business_associate_agreements (
      company_id, vendor_name, service_description,
      stores_phi, processes_phi, baa_status,
      signed_date, expiration_date, document_url,
      contact_email, notes, metadata
    ) VALUES (
      ${baa.company_id}::uuid, ${baa.vendor_name}, ${baa.service_description},
      ${baa.stores_phi}, ${baa.processes_phi}, ${baa.baa_status},
      ${baa.signed_date ?? null}, ${baa.expiration_date ?? null},
      ${baa.document_url ?? null}, ${baa.contact_email ?? null},
      ${baa.notes ?? null}, ${sql.json(baa.metadata ?? {})}
    ) RETURNING *
  `;
  return b;
}

export async function getCompanyBAAs(companyId: string): Promise<BAA[]> {
  return sql<BAA[]>`
    SELECT * FROM business_associate_agreements
    WHERE company_id = ${companyId}::uuid
    ORDER BY vendor_name
  `;
}

export async function updateBAAStatus(baaId: string, status: BAAStatus, signedDate?: string): Promise<BAA | null> {
  const [b] = await sql<BAA[]>`
    UPDATE business_associate_agreements
    SET baa_status = ${status},
        signed_date = ${signedDate ?? null},
        updated_at = NOW()
    WHERE id = ${baaId}::uuid
    RETURNING *
  `;
  return b ?? null;
}

export async function getExpiredBAAs(companyId: string): Promise<BAA[]> {
  return sql<BAA[]>`
    SELECT * FROM business_associate_agreements
    WHERE company_id = ${companyId}::uuid
      AND expiration_date IS NOT NULL
      AND expiration_date < CURRENT_DATE
      AND baa_status = 'signed'
    ORDER BY expiration_date
  `;
}

// ── Timely Filing Enforcement (Pure) ────────────────────────

/**
 * Check if a claim is within its timely filing window.
 * Pure function.
 */
export function isWithinTimelyFiling(
  encounterDate: string,
  filingDeadlineDays: number,
  now?: Date,
): { within: boolean; days_remaining: number; deadline: string } {
  const encounter = new Date(encounterDate);
  const deadline = new Date(encounter);
  deadline.setDate(deadline.getDate() + filingDeadlineDays);

  const today = now ?? new Date();
  const remaining = Math.ceil((deadline.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  return {
    within: remaining > 0,
    days_remaining: Math.max(0, remaining),
    deadline: deadline.toISOString().split("T")[0],
  };
}

/**
 * Check patient balance against state cap.
 * Pure function.
 */
export function isWithinPatientBalanceLimit(
  balanceCents: number,
  limitCents: number | null,
): { within: boolean; limit_cents: number | null; over_by_cents: number } {
  if (limitCents === null) return { within: true, limit_cents: null, over_by_cents: 0 };
  const over = Math.max(0, balanceCents - limitCents);
  return { within: over === 0, limit_cents: limitCents, over_by_cents: over };
}

// ── Security Audit Report (Pure) ────────────────────────────

/**
 * Generate a security audit report from system state.
 * Pure function — all inputs provided by caller.
 */
export function generateSecurityAuditReport(opts: {
  company_id: string;
  phi_encrypted: boolean;
  tls_enforced: boolean;
  rls_enabled: boolean;
  agent_roles_configured: boolean;
  audit_immutable: boolean;
  audit_coverage_percent: number;
  baas: BAA[];
  retention_policy_defined: boolean;
  automated_purge: boolean;
  state_rules: StateBillingRule[];
}): SecurityAuditReport {
  const issues: string[] = [];
  let score = 0;
  const maxScore = 10;

  // Encryption (2 points)
  if (opts.phi_encrypted) score += 1; else issues.push("PHI fields not encrypted at rest");
  if (opts.tls_enforced) score += 1; else issues.push("TLS not enforced for external APIs");

  // Access control (2 points)
  if (opts.rls_enabled) score += 1; else issues.push("RLS not enabled on billing tables");
  if (opts.agent_roles_configured) score += 1; else issues.push("Agent role-based access not configured");

  // Audit (2 points)
  if (opts.audit_immutable) score += 1; else issues.push("Audit log is not immutable (append-only)");
  if (opts.audit_coverage_percent >= 100) score += 1; else issues.push(`Audit coverage ${opts.audit_coverage_percent}% — must be 100%`);

  // BAA (2 points)
  const signedBaas = opts.baas.filter(b => b.baa_status === "signed").length;
  const pendingBaas = opts.baas.filter(b => b.baa_status === "not_started" || b.baa_status === "in_progress").length;
  const expiredBaas = opts.baas.filter(b => b.baa_status === "expired").length;
  if (pendingBaas === 0 && expiredBaas === 0) score += 2;
  else {
    if (pendingBaas > 0) issues.push(`${pendingBaas} BAA(s) still pending`);
    if (expiredBaas > 0) issues.push(`${expiredBaas} BAA(s) expired — renewal needed`);
  }

  // Retention (1 point)
  if (opts.retention_policy_defined && opts.automated_purge) score += 1;
  else issues.push("Data retention policy not fully implemented");

  // State rules (1 point)
  const statesConfigured = new Set(opts.state_rules.map(r => r.state_code)).size;
  if (statesConfigured > 0) score += 1; else issues.push("No state-specific billing rules configured");

  return {
    generated_at: new Date().toISOString(),
    company_id: opts.company_id,
    encryption: { phi_fields_encrypted: opts.phi_encrypted, tls_enforced: opts.tls_enforced },
    access_control: { rls_enabled: opts.rls_enabled, agent_roles_configured: opts.agent_roles_configured },
    audit_logging: { immutable: opts.audit_immutable, coverage_percent: opts.audit_coverage_percent },
    baa_status: { total: opts.baas.length, signed: signedBaas, pending: pendingBaas, expired: expiredBaas },
    data_retention: { policy_defined: opts.retention_policy_defined, automated_purge: opts.automated_purge },
    state_rules: { states_configured: statesConfigured, rules_count: opts.state_rules.length },
    overall_score: Math.round((score / maxScore) * 100),
    issues,
  };
}
