/**
 * HIPAA Compliance & Security Layer — ELLIE-751
 *
 * PHI encryption helpers, access control, immutable audit logging,
 * data retention policies, BAA checklist, PHI flow analysis.
 *
 * Pure module — crypto operations use Node.js built-in crypto.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

// ── PHI Field Classification ────────────────────────────────

/** HIPAA-defined PHI identifiers (18 Safe Harbor categories). */
export const PHI_FIELDS = [
  "first_name", "last_name", "dob", "ssn", "mrn", "member_id",
  "phone", "email", "address", "diagnosis_codes", "procedure_codes",
  "account_number", "subscriber_id", "fhir_patient_id",
] as const;

export type PHIField = typeof PHI_FIELDS[number];

/**
 * Check if a field name is PHI.
 */
export function isPHIField(field: string): boolean {
  return PHI_FIELDS.includes(field as PHIField);
}

/**
 * Identify PHI fields in an object's keys.
 */
export function identifyPHI(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).filter(isPHIField);
}

// ── Encryption (AES-256-GCM) ────────────────────────────────

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
  tag: string;
}

/**
 * Encrypt a string value using AES-256-GCM.
 * Returns base64-encoded ciphertext + iv + auth tag.
 */
export function encryptPHI(plaintext: string, key: Buffer): EncryptedValue {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");
  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/**
 * Decrypt an AES-256-GCM encrypted value.
 */
export function decryptPHI(encrypted: EncryptedValue, key: Buffer): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(encrypted.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  let decrypted = decipher.update(encrypted.ciphertext, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * Generate an encryption key from a passphrase.
 * In production, use a proper KMS (AWS KMS, HashiCorp Vault).
 */
export function deriveKey(passphrase: string): Buffer {
  return createHash("sha256").update(passphrase).digest();
}

/**
 * Encrypt all PHI fields in an object. Non-PHI fields pass through.
 */
export function encryptPHIFields(
  obj: Record<string, unknown>,
  key: Buffer,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isPHIField(k) && typeof v === "string" && v.length > 0) {
      result[k] = encryptPHI(v, key);
    } else {
      result[k] = v;
    }
  }
  return result;
}

/**
 * Decrypt all PHI fields in an object.
 */
export function decryptPHIFields(
  obj: Record<string, unknown>,
  key: Buffer,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isPHIField(k) && v && typeof v === "object" && "ciphertext" in v) {
      result[k] = decryptPHI(v as EncryptedValue, key);
    } else {
      result[k] = v;
    }
  }
  return result;
}

// ── Access Control ──────────────────────────────────────────

export type AgentRole = "claim_submission" | "claims_tracking" | "denial_management" | "appeals" | "payment_posting" | "analytics" | "admin";

/** Which billing tables each agent role can access. */
export const AGENT_ACCESS_MATRIX: Record<AgentRole, string[]> = {
  claim_submission: ["billing_patients", "billing_coverage", "billing_claims", "billing_claim_line_items"],
  claims_tracking: ["billing_claims", "billing_claim_line_items", "billing_denials"],
  denial_management: ["billing_claims", "billing_denials", "billing_claim_line_items"],
  appeals: ["billing_claims", "billing_denials", "billing_appeals"],
  payment_posting: ["billing_claims", "billing_payments", "billing_payment_allocations", "billing_claim_line_items"],
  analytics: ["billing_claims", "billing_denials", "billing_appeals", "billing_payments"],
  admin: ["billing_patients", "billing_coverage", "billing_claims", "billing_claim_line_items", "billing_denials", "billing_appeals", "billing_payments", "billing_payment_allocations", "billing_work_queue", "billing_audit_log"],
};

/**
 * Check if an agent role can access a given table.
 */
export function canAccess(role: AgentRole, table: string): boolean {
  return AGENT_ACCESS_MATRIX[role]?.includes(table) ?? false;
}

/**
 * Get all tables an agent role can access.
 */
export function getAccessibleTables(role: AgentRole): string[] {
  return AGENT_ACCESS_MATRIX[role] ?? [];
}

// ── Immutable Audit Log ─────────────────────────────────────

export interface PHIAuditEntry {
  timestamp: string;
  actor: string;
  actor_type: "agent" | "human" | "system";
  action: "read" | "write" | "delete" | "export";
  resource_type: string;
  resource_id: string;
  company_id: string;
  ip_address: string | null;
  session_id: string | null;
  phi_fields_accessed: string[];
  detail: string | null;
}

/**
 * Build a PHI audit entry.
 */
export function buildPHIAuditEntry(opts: {
  actor: string;
  actor_type: "agent" | "human" | "system";
  action: "read" | "write" | "delete" | "export";
  resource_type: string;
  resource_id: string;
  company_id: string;
  phi_fields_accessed?: string[];
  ip_address?: string;
  session_id?: string;
  detail?: string;
}): PHIAuditEntry {
  return {
    timestamp: new Date().toISOString(),
    actor: opts.actor,
    actor_type: opts.actor_type,
    action: opts.action,
    resource_type: opts.resource_type,
    resource_id: opts.resource_id,
    company_id: opts.company_id,
    ip_address: opts.ip_address ?? null,
    session_id: opts.session_id ?? null,
    phi_fields_accessed: opts.phi_fields_accessed ?? [],
    detail: opts.detail ?? null,
  };
}

// ── Data Retention ──────────────────────────────────────────

export interface RetentionPolicy {
  data_type: string;
  retention_years: number;
  purge_strategy: "soft_delete" | "hard_delete" | "anonymize";
}

/** HIPAA-compliant retention policies. */
export const RETENTION_POLICIES: RetentionPolicy[] = [
  { data_type: "billing_claims", retention_years: 7, purge_strategy: "anonymize" },
  { data_type: "billing_denials", retention_years: 7, purge_strategy: "anonymize" },
  { data_type: "billing_appeals", retention_years: 7, purge_strategy: "anonymize" },
  { data_type: "billing_payments", retention_years: 7, purge_strategy: "anonymize" },
  { data_type: "billing_audit_log", retention_years: 6, purge_strategy: "hard_delete" },
  { data_type: "billing_patients", retention_years: 7, purge_strategy: "anonymize" },
  { data_type: "session_data", retention_years: 0, purge_strategy: "hard_delete" },
];

/**
 * Check if a record has exceeded its retention period.
 */
export function isRetentionExpired(
  createdAt: Date,
  retentionYears: number,
  now?: Date,
): boolean {
  const expiry = new Date(createdAt);
  expiry.setFullYear(expiry.getFullYear() + retentionYears);
  return (now ?? new Date()) > expiry;
}

/**
 * Get the retention policy for a data type.
 */
export function getRetentionPolicy(dataType: string): RetentionPolicy | null {
  return RETENTION_POLICIES.find(p => p.data_type === dataType) ?? null;
}

// ── BAA Checklist ───────────────────────────────────────────

export interface BAARequirement {
  vendor: string;
  service: string;
  stores_phi: boolean;
  processes_phi: boolean;
  baa_required: boolean;
  baa_status: "not_started" | "in_progress" | "signed" | "not_applicable";
  mitigation: string | null;
}

/** BAA requirements for known service dependencies. */
export const BAA_CHECKLIST: BAARequirement[] = [
  { vendor: "Supabase", service: "Database (cloud)", stores_phi: true, processes_phi: false, baa_required: true, baa_status: "not_started", mitigation: "Supabase offers BAA on Pro/Enterprise plans" },
  { vendor: "OpenAI", service: "Embeddings API", stores_phi: false, processes_phi: true, baa_required: true, baa_status: "not_started", mitigation: "Use local embeddings (ELLIE-749) to avoid sending PHI" },
  { vendor: "Payer APIs", service: "Claim submission/status", stores_phi: false, processes_phi: true, baa_required: true, baa_status: "not_started", mitigation: "Payer BAAs typically covered by provider enrollment" },
  { vendor: "Cloudflare", service: "Tunnel/CDN", stores_phi: false, processes_phi: false, baa_required: false, baa_status: "not_applicable", mitigation: null },
  { vendor: "Local Server", service: "Ellie OS runtime", stores_phi: true, processes_phi: true, baa_required: false, baa_status: "not_applicable", mitigation: "Self-hosted — no BAA needed, must meet HIPAA physical safeguards" },
];

/**
 * Get vendors that need BAAs but don't have them yet.
 */
export function getPendingBAAs(): BAARequirement[] {
  return BAA_CHECKLIST.filter(b => b.baa_required && b.baa_status !== "signed" && b.baa_status !== "not_applicable");
}

/**
 * Check if the system is BAA-ready for production.
 */
export function isBAAReady(): { ready: boolean; pending: string[] } {
  const pending = getPendingBAAs().map(b => b.vendor);
  return { ready: pending.length === 0, pending };
}

// ── PHI Flow Analysis ───────────────────────────────────────

export interface PHIFlowPoint {
  stage: string;
  phi_present: boolean;
  encrypted: boolean;
  external_api: boolean;
  baa_covered: boolean;
}

/** Map of PHI touchpoints in the billing pipeline. */
export const PHI_FLOW: PHIFlowPoint[] = [
  { stage: "FHIR EHR Fetch", phi_present: true, encrypted: true, external_api: true, baa_covered: true },
  { stage: "FHIR Normalization", phi_present: true, encrypted: false, external_api: false, baa_covered: true },
  { stage: "Claim Document Storage", phi_present: true, encrypted: true, external_api: false, baa_covered: true },
  { stage: "Embedding (Local)", phi_present: true, encrypted: false, external_api: false, baa_covered: true },
  { stage: "Embedding (Cloud/OpenAI)", phi_present: true, encrypted: false, external_api: true, baa_covered: false },
  { stage: "RAG Retrieval", phi_present: false, encrypted: false, external_api: false, baa_covered: true },
  { stage: "Claim Submission to Payer", phi_present: true, encrypted: true, external_api: true, baa_covered: true },
  { stage: "Agent Prompt (LLM)", phi_present: true, encrypted: false, external_api: true, baa_covered: false },
];

/**
 * Identify PHI flow points that are not BAA-covered.
 */
export function getUncoveredPHIPoints(): PHIFlowPoint[] {
  return PHI_FLOW.filter(p => p.phi_present && !p.baa_covered);
}
