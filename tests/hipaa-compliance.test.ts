/**
 * HIPAA Compliance & Security Layer Tests — ELLIE-751
 *
 * Tests for PHI handling infrastructure:
 * - PHI field identification
 * - AES-256-GCM encryption/decryption
 * - Bulk PHI field encryption
 * - Agent access control matrix
 * - PHI audit entry building
 * - Data retention policies
 * - BAA checklist
 * - PHI flow analysis
 * - E2E scenarios
 */

import { describe, test, expect } from "bun:test";
import {
  isPHIField,
  identifyPHI,
  encryptPHI,
  decryptPHI,
  deriveKey,
  encryptPHIFields,
  decryptPHIFields,
  canAccess,
  getAccessibleTables,
  buildPHIAuditEntry,
  isRetentionExpired,
  getRetentionPolicy,
  getPendingBAAs,
  isBAAReady,
  getUncoveredPHIPoints,
  PHI_FIELDS,
  AGENT_ACCESS_MATRIX,
  RETENTION_POLICIES,
  BAA_CHECKLIST,
  PHI_FLOW,
  type AgentRole,
} from "../src/hipaa-compliance.ts";

// ── PHI Field Classification ────────────────────────────────

describe("PHI field classification", () => {
  test("PHI_FIELDS includes all 14 identifiers", () => {
    expect(PHI_FIELDS).toHaveLength(14);
    expect(PHI_FIELDS).toContain("first_name");
    expect(PHI_FIELDS).toContain("ssn");
    expect(PHI_FIELDS).toContain("dob");
    expect(PHI_FIELDS).toContain("diagnosis_codes");
  });

  test("isPHIField returns true for PHI fields", () => {
    expect(isPHIField("first_name")).toBe(true);
    expect(isPHIField("ssn")).toBe(true);
    expect(isPHIField("mrn")).toBe(true);
  });

  test("isPHIField returns false for non-PHI fields", () => {
    expect(isPHIField("claim_number")).toBe(false);
    expect(isPHIField("status")).toBe(false);
    expect(isPHIField("company_id")).toBe(false);
  });

  test("identifyPHI finds PHI fields in an object", () => {
    const obj = { first_name: "Jane", last_name: "Doe", status: "active", dob: "1985-06-15" };
    const phi = identifyPHI(obj);
    expect(phi).toContain("first_name");
    expect(phi).toContain("last_name");
    expect(phi).toContain("dob");
    expect(phi).not.toContain("status");
  });
});

// ── Encryption ──────────────────────────────────────────────

describe("AES-256-GCM encryption", () => {
  const key = deriveKey("test-passphrase-for-unit-tests");

  test("encrypt then decrypt returns original", () => {
    const plaintext = "Jane Doe";
    const encrypted = encryptPHI(plaintext, key);
    const decrypted = decryptPHI(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  test("encrypted value differs from plaintext", () => {
    const encrypted = encryptPHI("sensitive data", key);
    expect(encrypted.ciphertext).not.toBe("sensitive data");
  });

  test("encrypted value has iv and tag", () => {
    const encrypted = encryptPHI("test", key);
    expect(encrypted.iv).toBeTruthy();
    expect(encrypted.tag).toBeTruthy();
    expect(encrypted.ciphertext).toBeTruthy();
  });

  test("different encryptions produce different ciphertexts (random IV)", () => {
    const a = encryptPHI("same text", key);
    const b = encryptPHI("same text", key);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });

  test("wrong key fails to decrypt", () => {
    const encrypted = encryptPHI("secret", key);
    const wrongKey = deriveKey("wrong-passphrase");
    expect(() => decryptPHI(encrypted, wrongKey)).toThrow();
  });

  test("handles empty string", () => {
    const encrypted = encryptPHI("", key);
    expect(decryptPHI(encrypted, key)).toBe("");
  });

  test("handles unicode", () => {
    const plaintext = "Wincy 温茜";
    expect(decryptPHI(encryptPHI(plaintext, key), key)).toBe(plaintext);
  });
});

describe("encryptPHIFields / decryptPHIFields", () => {
  const key = deriveKey("test-key");

  test("encrypts only PHI fields, passes others through", () => {
    const obj = { first_name: "Jane", last_name: "Doe", status: "active", claim_number: "CLM-001" };
    const encrypted = encryptPHIFields(obj, key);

    expect(typeof encrypted.first_name).toBe("object"); // encrypted
    expect(typeof encrypted.last_name).toBe("object");
    expect(encrypted.status).toBe("active"); // unchanged
    expect(encrypted.claim_number).toBe("CLM-001"); // unchanged
  });

  test("round-trips correctly", () => {
    const obj = { first_name: "Jane", dob: "1985-06-15", mrn: "MRN-001", billed_cents: 15000 };
    const encrypted = encryptPHIFields(obj, key);
    const decrypted = decryptPHIFields(encrypted, key);

    expect(decrypted.first_name).toBe("Jane");
    expect(decrypted.dob).toBe("1985-06-15");
    expect(decrypted.mrn).toBe("MRN-001");
    expect(decrypted.billed_cents).toBe(15000);
  });

  test("skips null and non-string PHI fields", () => {
    const obj = { first_name: null, dob: 123 };
    const encrypted = encryptPHIFields(obj as any, key);
    expect(encrypted.first_name).toBeNull();
    expect(encrypted.dob).toBe(123);
  });
});

// ── Access Control ──────────────────────────────────────────

describe("access control", () => {
  test("claim_submission can access patients and claims", () => {
    expect(canAccess("claim_submission", "billing_patients")).toBe(true);
    expect(canAccess("claim_submission", "billing_claims")).toBe(true);
  });

  test("claim_submission cannot access appeals", () => {
    expect(canAccess("claim_submission", "billing_appeals")).toBe(false);
  });

  test("analytics cannot access patients (PHI minimization)", () => {
    expect(canAccess("analytics", "billing_patients")).toBe(false);
  });

  test("admin can access everything", () => {
    const tables = getAccessibleTables("admin");
    expect(tables).toContain("billing_patients");
    expect(tables).toContain("billing_audit_log");
    expect(tables.length).toBeGreaterThanOrEqual(10);
  });

  test("getAccessibleTables returns correct list", () => {
    const tables = getAccessibleTables("payment_posting");
    expect(tables).toContain("billing_payments");
    expect(tables).toContain("billing_payment_allocations");
    expect(tables).not.toContain("billing_patients");
  });

  test("all roles have at least one accessible table", () => {
    for (const role of Object.keys(AGENT_ACCESS_MATRIX)) {
      expect(getAccessibleTables(role as AgentRole).length).toBeGreaterThan(0);
    }
  });
});

// ── PHI Audit Entry ─────────────────────────────────────────

describe("buildPHIAuditEntry", () => {
  test("builds complete audit entry", () => {
    const entry = buildPHIAuditEntry({
      actor: "claims-tracker",
      actor_type: "agent",
      action: "read",
      resource_type: "billing_claims",
      resource_id: "cl-001",
      company_id: "comp-1",
      phi_fields_accessed: ["first_name", "dob"],
      ip_address: "127.0.0.1",
    });

    expect(entry.actor).toBe("claims-tracker");
    expect(entry.action).toBe("read");
    expect(entry.phi_fields_accessed).toEqual(["first_name", "dob"]);
    expect(entry.timestamp).toBeTruthy();
  });

  test("defaults optional fields to null", () => {
    const entry = buildPHIAuditEntry({
      actor: "system", actor_type: "system", action: "write",
      resource_type: "billing_patients", resource_id: "p1", company_id: "c1",
    });
    expect(entry.ip_address).toBeNull();
    expect(entry.session_id).toBeNull();
    expect(entry.phi_fields_accessed).toEqual([]);
  });
});

// ── Data Retention ──────────────────────────────────────────

describe("data retention", () => {
  test("RETENTION_POLICIES covers all key data types", () => {
    expect(RETENTION_POLICIES.length).toBeGreaterThanOrEqual(7);
    const types = RETENTION_POLICIES.map(p => p.data_type);
    expect(types).toContain("billing_claims");
    expect(types).toContain("billing_audit_log");
    expect(types).toContain("billing_patients");
  });

  test("claims retention is 7 years", () => {
    const p = getRetentionPolicy("billing_claims");
    expect(p).not.toBeNull();
    expect(p!.retention_years).toBe(7);
    expect(p!.purge_strategy).toBe("anonymize");
  });

  test("audit log retention is 6 years", () => {
    expect(getRetentionPolicy("billing_audit_log")!.retention_years).toBe(6);
  });

  test("isRetentionExpired returns true after period", () => {
    const eightYearsAgo = new Date();
    eightYearsAgo.setFullYear(eightYearsAgo.getFullYear() - 8);
    expect(isRetentionExpired(eightYearsAgo, 7)).toBe(true);
  });

  test("isRetentionExpired returns false within period", () => {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    expect(isRetentionExpired(oneYearAgo, 7)).toBe(false);
  });

  test("getRetentionPolicy returns null for unknown type", () => {
    expect(getRetentionPolicy("unknown_table")).toBeNull();
  });
});

// ── BAA Checklist ───────────────────────────────────────────

describe("BAA checklist", () => {
  test("BAA_CHECKLIST has entries for key vendors", () => {
    const vendors = BAA_CHECKLIST.map(b => b.vendor);
    expect(vendors).toContain("Supabase");
    expect(vendors).toContain("OpenAI");
    expect(vendors).toContain("Payer APIs");
    expect(vendors).toContain("Local Server");
  });

  test("getPendingBAAs returns vendors needing BAAs", () => {
    const pending = getPendingBAAs();
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every(b => b.baa_required)).toBe(true);
    expect(pending.every(b => b.baa_status !== "signed")).toBe(true);
  });

  test("isBAAReady returns false when BAAs are pending", () => {
    const result = isBAAReady();
    expect(result.ready).toBe(false);
    expect(result.pending.length).toBeGreaterThan(0);
  });

  test("local server does not need BAA", () => {
    const local = BAA_CHECKLIST.find(b => b.vendor === "Local Server");
    expect(local!.baa_required).toBe(false);
  });
});

// ── PHI Flow Analysis ───────────────────────────────────────

describe("PHI flow analysis", () => {
  test("PHI_FLOW maps the full pipeline", () => {
    expect(PHI_FLOW.length).toBeGreaterThanOrEqual(7);
  });

  test("getUncoveredPHIPoints identifies gaps", () => {
    const uncovered = getUncoveredPHIPoints();
    expect(uncovered.length).toBeGreaterThan(0);
    // Cloud embedding and LLM prompts are not BAA-covered
    expect(uncovered.some(p => p.stage.includes("Cloud"))).toBe(true);
    expect(uncovered.some(p => p.stage.includes("LLM"))).toBe(true);
  });

  test("local embedding is BAA-covered", () => {
    const local = PHI_FLOW.find(p => p.stage.includes("Local"));
    expect(local!.baa_covered).toBe(true);
    expect(local!.external_api).toBe(false);
  });
});

// ── E2E: HIPAA Compliance Scenarios ─────────────────────────

describe("E2E: HIPAA compliance scenarios", () => {
  test("encrypt patient record -> audit read -> decrypt for authorized agent", () => {
    const key = deriveKey("production-key");
    const patient = { first_name: "Jane", last_name: "Doe", dob: "1985-06-15", status: "active", mrn: "MRN-001" };

    // Encrypt PHI before storage
    const encrypted = encryptPHIFields(patient, key);
    expect(typeof encrypted.first_name).toBe("object");
    expect(encrypted.status).toBe("active"); // Not encrypted

    // Verify agent has access
    expect(canAccess("claim_submission", "billing_patients")).toBe(true);

    // Build audit entry
    const audit = buildPHIAuditEntry({
      actor: "claim-submission-agent", actor_type: "agent", action: "read",
      resource_type: "billing_patients", resource_id: "p-001", company_id: "comp-1",
      phi_fields_accessed: identifyPHI(patient),
    });
    expect(audit.phi_fields_accessed).toContain("first_name");

    // Decrypt for authorized access
    const decrypted = decryptPHIFields(encrypted, key);
    expect(decrypted.first_name).toBe("Jane");
    expect(decrypted.mrn).toBe("MRN-001");
  });

  test("analytics agent cannot access patient PHI (minimum necessary)", () => {
    expect(canAccess("analytics", "billing_patients")).toBe(false);
    expect(canAccess("analytics", "billing_claims")).toBe(true); // Can see claims
  });

  test("retention check: 8-year-old claim is expired", () => {
    const oldDate = new Date();
    oldDate.setFullYear(oldDate.getFullYear() - 8);
    const policy = getRetentionPolicy("billing_claims")!;
    expect(isRetentionExpired(oldDate, policy.retention_years)).toBe(true);
    expect(policy.purge_strategy).toBe("anonymize"); // Don't hard-delete, anonymize
  });
});
