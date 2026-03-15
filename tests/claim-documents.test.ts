/**
 * Claim Documents Tests — ELLIE-747
 *
 * Tests for FHIR-to-document pipeline:
 * - Migration SQL structure
 * - Text renderers (patient, encounter, diagnosis, procedure, coverage)
 * - Document input builders
 * - Pipeline orchestration (upsert, dedup, errors)
 * - E2E: full FHIR encounter -> documents
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  renderPatientDocument,
  renderEncounterDocument,
  renderDiagnosisDocument,
  renderProcedureDocument,
  renderCoverageDocument,
  buildPatientDocInput,
  buildEncounterDocInput,
  buildDiagnosisDocInput,
  buildProcedureDocInput,
  buildCoverageDocInput,
  runDocumentPipeline,
  type ClaimDocumentInput,
  type UpsertDocFn,
} from "../src/claim-documents.ts";
import type {
  NormalizedPatient,
  NormalizedEncounter,
  NormalizedDiagnosis,
  NormalizedProcedure,
  NormalizedCoverage,
} from "../src/connectors/fhir.ts";

// ── Helpers ─────────────────────────────────────────────────

const patient: NormalizedPatient = {
  fhir_id: "pat-001", first_name: "Jane", last_name: "Doe",
  dob: "1985-06-15", gender: "female", member_id: "MEM-123",
};

const encounter: NormalizedEncounter = {
  fhir_id: "enc-001", status: "finished", class_code: "AMB",
  start_date: "2026-03-15", end_date: null,
  patient_ref: "Patient/pat-001", provider_name: "Dr. Smith",
};

const diagnosis: NormalizedDiagnosis = {
  fhir_id: "cond-001", code: "J06.9", system: "icd-10",
  display: "Acute URI", encounter_ref: "Encounter/enc-001", is_active: true,
};

const procedure: NormalizedProcedure = {
  fhir_id: "proc-001", code: "99213", system: "cpt",
  display: "Office visit", encounter_ref: "Encounter/enc-001",
  performed_date: "2026-03-15",
};

const coverage: NormalizedCoverage = {
  fhir_id: "cov-001", status: "active", subscriber_id: "SUB-456",
  payer_name: "Aetna", payer_ref: "Organization/aetna",
  group_number: "GRP-789", plan_name: "PPO Gold",
};

function mockUpsert(): { fn: UpsertDocFn; calls: ClaimDocumentInput[] } {
  const calls: ClaimDocumentInput[] = [];
  return {
    fn: async (input) => { calls.push(input); return { created: true }; },
    calls,
  };
}

// ── Migration SQL ───────────────────────────────────────────

describe("migration SQL", () => {
  function read(): string {
    return readFileSync(join(import.meta.dir, "../migrations/supabase/20260315_claim_documents.sql"), "utf-8");
  }

  test("creates claim_documents table", () => {
    expect(read()).toContain("CREATE TABLE IF NOT EXISTS claim_documents");
  });

  test("has fhir_resource_type, fhir_id, patient_id, encounter_id", () => {
    const sql = read();
    expect(sql).toContain("fhir_resource_type TEXT NOT NULL");
    expect(sql).toContain("fhir_id TEXT");
    expect(sql).toContain("patient_id TEXT");
    expect(sql).toContain("encounter_id TEXT");
  });

  test("has embedding vector(1536)", () => {
    expect(read()).toContain("embedding vector(1536)");
  });

  test("has unique dedup index on fhir_id + resource_type", () => {
    expect(read()).toContain("idx_claim_docs_fhir_dedup");
    expect(read()).toContain("UNIQUE INDEX");
  });

  test("has IVFFlat embedding index", () => {
    const sql = read();
    expect(sql).toContain("ivfflat");
    expect(sql).toContain("vector_cosine_ops");
  });

  test("has indexes on resource_type, patient, company, payer", () => {
    const sql = read();
    expect(sql).toContain("idx_claim_docs_resource_type");
    expect(sql).toContain("idx_claim_docs_patient");
    expect(sql).toContain("idx_claim_docs_company");
    expect(sql).toContain("idx_claim_docs_payer");
  });

  test("has RLS", () => {
    expect(read()).toContain("ENABLE ROW LEVEL SECURITY");
  });
});

// ── Text Renderers ──────────────────────────────────────────

describe("renderPatientDocument", () => {
  test("renders full patient", () => {
    const text = renderPatientDocument(patient);
    expect(text).toContain("Jane Doe");
    expect(text).toContain("1985-06-15");
    expect(text).toContain("female");
    expect(text).toContain("MEM-123");
  });

  test("omits null fields", () => {
    const text = renderPatientDocument({ ...patient, dob: null, gender: null, member_id: null });
    expect(text).not.toContain("Date of Birth");
    expect(text).not.toContain("Gender");
    expect(text).not.toContain("Member ID");
  });
});

describe("renderEncounterDocument", () => {
  test("renders full encounter", () => {
    const text = renderEncounterDocument(encounter);
    expect(text).toContain("enc-001");
    expect(text).toContain("finished");
    expect(text).toContain("AMB");
    expect(text).toContain("Dr. Smith");
  });
});

describe("renderDiagnosisDocument", () => {
  test("renders diagnosis with code and display", () => {
    const text = renderDiagnosisDocument(diagnosis);
    expect(text).toContain("J06.9");
    expect(text).toContain("Acute URI");
    expect(text).toContain("Active: true");
  });
});

describe("renderProcedureDocument", () => {
  test("renders procedure with code and date", () => {
    const text = renderProcedureDocument(procedure);
    expect(text).toContain("99213");
    expect(text).toContain("Office visit");
    expect(text).toContain("2026-03-15");
  });
});

describe("renderCoverageDocument", () => {
  test("renders full coverage", () => {
    const text = renderCoverageDocument(coverage);
    expect(text).toContain("Aetna");
    expect(text).toContain("SUB-456");
    expect(text).toContain("GRP-789");
    expect(text).toContain("PPO Gold");
  });
});

// ── Document Input Builders ─────────────────────────────────

describe("buildPatientDocInput", () => {
  test("builds input with correct resource type", () => {
    const input = buildPatientDocInput(patient, { company_id: "comp-1" });
    expect(input.fhir_resource_type).toBe("Patient");
    expect(input.fhir_id).toBe("pat-001");
    expect(input.patient_id).toBe("pat-001");
    expect(input.company_id).toBe("comp-1");
    expect(input.content).toContain("Jane");
  });
});

describe("buildEncounterDocInput", () => {
  test("extracts patient_id from reference", () => {
    const input = buildEncounterDocInput(encounter);
    expect(input.patient_id).toBe("pat-001");
    expect(input.encounter_id).toBe("enc-001");
    expect(input.fhir_resource_type).toBe("Encounter");
  });
});

describe("buildDiagnosisDocInput", () => {
  test("extracts encounter_id from reference", () => {
    const input = buildDiagnosisDocInput(diagnosis, { patient_id: "pat-001" });
    expect(input.encounter_id).toBe("enc-001");
    expect(input.patient_id).toBe("pat-001");
    expect(input.fhir_resource_type).toBe("Condition");
  });
});

describe("buildProcedureDocInput", () => {
  test("builds with correct metadata", () => {
    const input = buildProcedureDocInput(procedure);
    expect(input.fhir_resource_type).toBe("Procedure");
    expect(input.metadata?.code).toBe("99213");
  });
});

describe("buildCoverageDocInput", () => {
  test("includes payer_id", () => {
    const input = buildCoverageDocInput(coverage, { payer_id: "aetna" });
    expect(input.payer_id).toBe("aetna");
    expect(input.fhir_resource_type).toBe("Coverage");
  });

  test("falls back to payer_name when no payer_id", () => {
    const input = buildCoverageDocInput(coverage);
    expect(input.payer_id).toBe("Aetna");
  });
});

// ── runDocumentPipeline ─────────────────────────────────────

describe("runDocumentPipeline", () => {
  test("creates documents for all resource types", async () => {
    const upsert = mockUpsert();
    const result = await runDocumentPipeline(
      { patients: [patient], encounters: [encounter], diagnoses: [diagnosis], procedures: [procedure], coverages: [coverage] },
      { company_id: "comp-1", patient_id: "pat-001" },
      { upsert: upsert.fn },
    );
    expect(result.documents_created).toBe(5);
    expect(result.documents_updated).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(upsert.calls).toHaveLength(5);
  });

  test("counts updates when upsert returns created=false", async () => {
    const fn: UpsertDocFn = async () => ({ created: false });
    const result = await runDocumentPipeline(
      { patients: [patient] },
      {},
      { upsert: fn },
    );
    expect(result.documents_created).toBe(0);
    expect(result.documents_updated).toBe(1);
  });

  test("captures errors per resource", async () => {
    let callCount = 0;
    const fn: UpsertDocFn = async () => {
      callCount++;
      if (callCount === 2) throw new Error("DB conflict");
      return { created: true };
    };
    const result = await runDocumentPipeline(
      { patients: [patient], encounters: [encounter] },
      {},
      { upsert: fn },
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain("DB conflict");
    expect(result.documents_created).toBe(1);
  });

  test("handles empty resources", async () => {
    const upsert = mockUpsert();
    const result = await runDocumentPipeline({}, {}, { upsert: upsert.fn });
    expect(result.documents_created).toBe(0);
    expect(upsert.calls).toHaveLength(0);
  });

  test("passes company_id and patient_id through", async () => {
    const upsert = mockUpsert();
    await runDocumentPipeline(
      { diagnoses: [diagnosis] },
      { company_id: "comp-1", patient_id: "pat-001" },
      { upsert: upsert.fn },
    );
    expect(upsert.calls[0].company_id).toBe("comp-1");
    expect(upsert.calls[0].patient_id).toBe("pat-001");
  });
});

// ── E2E: Full Encounter Pipeline ────────────────────────────

describe("E2E: full FHIR encounter -> claim documents", () => {
  test("normalizes and stores complete encounter data", async () => {
    const upsert = mockUpsert();

    const result = await runDocumentPipeline(
      {
        patients: [patient],
        encounters: [encounter],
        diagnoses: [diagnosis, { ...diagnosis, fhir_id: "cond-002", code: "R05.9", display: "Cough" }],
        procedures: [procedure],
        coverages: [coverage],
      },
      { company_id: "comp-1", patient_id: "pat-001", payer_id: "aetna" },
      { upsert: upsert.fn },
    );

    expect(result.documents_created).toBe(6); // 1+1+2+1+1
    expect(result.errors).toHaveLength(0);

    // Verify resource types
    const types = upsert.calls.map(c => c.fhir_resource_type);
    expect(types.filter(t => t === "Patient")).toHaveLength(1);
    expect(types.filter(t => t === "Encounter")).toHaveLength(1);
    expect(types.filter(t => t === "Condition")).toHaveLength(2);
    expect(types.filter(t => t === "Procedure")).toHaveLength(1);
    expect(types.filter(t => t === "Coverage")).toHaveLength(1);

    // Verify content is searchable text
    const patientDoc = upsert.calls.find(c => c.fhir_resource_type === "Patient");
    expect(patientDoc!.content).toContain("Jane Doe");

    const procDoc = upsert.calls.find(c => c.fhir_resource_type === "Procedure");
    expect(procDoc!.content).toContain("99213");

    // All have company_id
    for (const call of upsert.calls) {
      expect(call.company_id).toBe("comp-1");
    }
  });
});
