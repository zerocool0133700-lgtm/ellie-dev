/**
 * FHIR R4 Connector Tests — ELLIE-746
 *
 * Tests for FHIR resource normalization and request building:
 * - Patient normalizer
 * - Encounter normalizer
 * - Condition (diagnosis) normalizer
 * - Procedure normalizer
 * - Coverage normalizer
 * - Bundle extraction
 * - OAuth2 token request builder
 * - FHIR request builder
 * - Encounter pull request builder
 * - Config validation
 * - E2E: full encounter pull normalization
 */

import { describe, test, expect } from "bun:test";
import {
  normalizePatient,
  normalizeEncounter,
  normalizeCondition,
  normalizeProcedure,
  normalizeCoverage,
  extractFromBundle,
  buildTokenRequest,
  buildFHIRRequest,
  buildEncounterPullRequests,
  validateFHIRConfig,
  type FHIRConfig,
  type FHIRPatient,
  type FHIREncounter,
  type FHIRCondition,
  type FHIRProcedure,
  type FHIRCoverage,
  type FHIRBundle,
} from "../src/connectors/fhir.ts";

// ── Helpers ─────────────────────────────────────────────────

function makeConfig(overrides: Partial<FHIRConfig> = {}): FHIRConfig {
  return {
    base_url: "https://fhir.example.com/r4",
    client_id: "ellie-billing",
    client_secret: "secret123",
    token_url: "https://auth.example.com/token",
    company_id: "comp-1",
    ...overrides,
  };
}

// ── normalizePatient ────────────────────────────────────────

describe("normalizePatient", () => {
  test("normalizes full patient", () => {
    const p = normalizePatient({
      resourceType: "Patient",
      id: "pat-001",
      name: [{ family: "Doe", given: ["Jane", "Marie"] }],
      birthDate: "1985-06-15",
      gender: "female",
      identifier: [{ system: "http://insurance/member", value: "MEM-12345" }],
    });
    expect(p.fhir_id).toBe("pat-001");
    expect(p.first_name).toBe("Jane");
    expect(p.last_name).toBe("Doe");
    expect(p.dob).toBe("1985-06-15");
    expect(p.gender).toBe("female");
    expect(p.member_id).toBe("MEM-12345");
  });

  test("handles missing name", () => {
    const p = normalizePatient({ resourceType: "Patient", id: "p1" });
    expect(p.first_name).toBe("");
    expect(p.last_name).toBe("");
  });

  test("handles missing identifiers", () => {
    const p = normalizePatient({ resourceType: "Patient", id: "p1" });
    expect(p.member_id).toBeNull();
  });

  test("falls back to first identifier if no member system", () => {
    const p = normalizePatient({
      resourceType: "Patient",
      id: "p1",
      identifier: [{ system: "http://mrn", value: "MRN-999" }],
    });
    expect(p.member_id).toBe("MRN-999");
  });
});

// ── normalizeEncounter ──────────────────────────────────────

describe("normalizeEncounter", () => {
  test("normalizes full encounter", () => {
    const e = normalizeEncounter({
      resourceType: "Encounter",
      id: "enc-001",
      status: "finished",
      class: { code: "AMB" },
      period: { start: "2026-03-15T09:00:00Z", end: "2026-03-15T09:30:00Z" },
      subject: { reference: "Patient/pat-001" },
      participant: [{ individual: { reference: "Practitioner/dr-1", display: "Dr. Smith" } }],
    });
    expect(e.fhir_id).toBe("enc-001");
    expect(e.status).toBe("finished");
    expect(e.class_code).toBe("AMB");
    expect(e.start_date).toBe("2026-03-15T09:00:00Z");
    expect(e.provider_name).toBe("Dr. Smith");
  });

  test("handles minimal encounter", () => {
    const e = normalizeEncounter({ resourceType: "Encounter", id: "e1", status: "planned" });
    expect(e.class_code).toBeNull();
    expect(e.start_date).toBeNull();
    expect(e.provider_name).toBeNull();
  });
});

// ── normalizeCondition ──────────────────────────────────────

describe("normalizeCondition", () => {
  test("normalizes ICD-10 condition", () => {
    const c = normalizeCondition({
      resourceType: "Condition",
      id: "cond-001",
      code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "J06.9", display: "Acute URI" }] },
      encounter: { reference: "Encounter/enc-001" },
      clinicalStatus: { coding: [{ code: "active" }] },
    });
    expect(c.code).toBe("J06.9");
    expect(c.display).toBe("Acute URI");
    expect(c.is_active).toBe(true);
    expect(c.encounter_ref).toBe("Encounter/enc-001");
  });

  test("inactive condition", () => {
    const c = normalizeCondition({
      resourceType: "Condition",
      id: "c1",
      clinicalStatus: { coding: [{ code: "resolved" }] },
    });
    expect(c.is_active).toBe(false);
  });

  test("handles missing code", () => {
    const c = normalizeCondition({ resourceType: "Condition", id: "c1" });
    expect(c.code).toBe("");
  });
});

// ── normalizeProcedure ──────────────────────────────────────

describe("normalizeProcedure", () => {
  test("normalizes CPT procedure", () => {
    const p = normalizeProcedure({
      resourceType: "Procedure",
      id: "proc-001",
      code: { coding: [{ system: "http://www.ama-assn.org/go/cpt", code: "99213", display: "Office visit" }] },
      encounter: { reference: "Encounter/enc-001" },
      performedDateTime: "2026-03-15",
    });
    expect(p.code).toBe("99213");
    expect(p.display).toBe("Office visit");
    expect(p.performed_date).toBe("2026-03-15");
  });

  test("handles missing code", () => {
    const p = normalizeProcedure({ resourceType: "Procedure", id: "p1" });
    expect(p.code).toBe("");
    expect(p.performed_date).toBeNull();
  });
});

// ── normalizeCoverage ───────────────────────────────────────

describe("normalizeCoverage", () => {
  test("normalizes full coverage", () => {
    const c = normalizeCoverage({
      resourceType: "Coverage",
      id: "cov-001",
      status: "active",
      subscriberId: "SUB-12345",
      payor: [{ display: "Aetna", reference: "Organization/aetna" }],
      class: [
        { type: { coding: [{ code: "group" }] }, value: "GRP-789" },
        { type: { coding: [{ code: "plan" }] }, value: "PPO-500", name: "PPO Gold" },
      ],
    });
    expect(c.status).toBe("active");
    expect(c.subscriber_id).toBe("SUB-12345");
    expect(c.payer_name).toBe("Aetna");
    expect(c.payer_ref).toBe("Organization/aetna");
    expect(c.group_number).toBe("GRP-789");
    expect(c.plan_name).toBe("PPO Gold");
  });

  test("handles minimal coverage", () => {
    const c = normalizeCoverage({ resourceType: "Coverage", id: "c1", status: "active" });
    expect(c.subscriber_id).toBeNull();
    expect(c.payer_name).toBeNull();
    expect(c.group_number).toBeNull();
  });
});

// ── extractFromBundle ───────────────────────────────────────

describe("extractFromBundle", () => {
  test("extracts resources by type", () => {
    const bundle: FHIRBundle = {
      resourceType: "Bundle",
      total: 3,
      entry: [
        { resource: { resourceType: "Patient", id: "p1" } },
        { resource: { resourceType: "Encounter", id: "e1", status: "finished" } },
        { resource: { resourceType: "Patient", id: "p2" } },
      ],
    };
    const patients = extractFromBundle<FHIRPatient>(bundle, "Patient");
    expect(patients).toHaveLength(2);
    expect(patients[0].id).toBe("p1");
  });

  test("returns empty for no matches", () => {
    const bundle: FHIRBundle = { resourceType: "Bundle", entry: [{ resource: { resourceType: "Patient", id: "p1" } }] };
    expect(extractFromBundle(bundle, "Encounter")).toHaveLength(0);
  });

  test("handles empty bundle", () => {
    expect(extractFromBundle({ resourceType: "Bundle" }, "Patient")).toHaveLength(0);
  });
});

// ── buildTokenRequest ───────────────────────────────────────

describe("buildTokenRequest", () => {
  test("builds OAuth2 client credentials request", () => {
    const req = buildTokenRequest(makeConfig());
    expect(req.url).toBe("https://auth.example.com/token");
    expect(req.method).toBe("POST");
    expect(req.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(req.body).toContain("grant_type=client_credentials");
    expect(req.body).toContain("client_id=ellie-billing");
    expect(req.body).toContain("client_secret=secret123");
  });

  test("includes default scopes", () => {
    const req = buildTokenRequest(makeConfig());
    expect(req.body).toContain("patient");
    expect(req.body).toContain("encounter");
  });

  test("uses custom scopes when provided", () => {
    const req = buildTokenRequest(makeConfig({ scopes: ["patient/*.read"] }));
    expect(req.body).toContain("patient");
    expect(req.body).not.toContain("encounter");
  });

  test("omits client_secret when not provided", () => {
    const req = buildTokenRequest(makeConfig({ client_secret: undefined }));
    expect(req.body).not.toContain("client_secret");
  });
});

// ── buildFHIRRequest ────────────────────────────────────────

describe("buildFHIRRequest", () => {
  test("builds GET request with auth header", () => {
    const req = buildFHIRRequest(makeConfig(), "Patient", "tok-123", { _id: "p1" });
    expect(req.method).toBe("GET");
    expect(req.url).toContain("/Patient");
    expect(req.url).toContain("_id=p1");
    expect(req.headers.Authorization).toBe("Bearer tok-123");
    expect(req.headers.Accept).toBe("application/fhir+json");
  });

  test("no params produces clean URL", () => {
    const req = buildFHIRRequest(makeConfig(), "Encounter", "tok-123");
    expect(req.url).toBe("https://fhir.example.com/r4/Encounter");
  });
});

// ── buildEncounterPullRequests ───────────────────────────────

describe("buildEncounterPullRequests", () => {
  test("builds 5 requests for full encounter pull", () => {
    const requests = buildEncounterPullRequests(makeConfig(), "pat-001", "tok-123");
    expect(requests).toHaveLength(5);

    const types = requests.map(r => {
      const url = new URL(r.url);
      return url.pathname.split("/").pop();
    });
    expect(types).toContain("Patient");
    expect(types).toContain("Encounter");
    expect(types).toContain("Condition");
    expect(types).toContain("Procedure");
    expect(types).toContain("Coverage");
  });

  test("all requests use the same auth token", () => {
    const requests = buildEncounterPullRequests(makeConfig(), "pat-001", "tok-123");
    for (const req of requests) {
      expect(req.headers.Authorization).toBe("Bearer tok-123");
    }
  });

  test("patient-scoped requests include patient param", () => {
    const requests = buildEncounterPullRequests(makeConfig(), "pat-001", "tok-123");
    const encounterReq = requests.find(r => r.url.includes("/Encounter"));
    expect(encounterReq!.url).toContain("patient=pat-001");
  });
});

// ── validateFHIRConfig ──────────────────────────────────────

describe("validateFHIRConfig", () => {
  test("valid config passes", () => {
    expect(validateFHIRConfig(makeConfig())).toHaveLength(0);
  });

  test("missing base_url fails", () => {
    expect(validateFHIRConfig(makeConfig({ base_url: "" })).some(e => e.includes("base_url"))).toBe(true);
  });

  test("missing client_id fails", () => {
    expect(validateFHIRConfig(makeConfig({ client_id: "" })).some(e => e.includes("client_id"))).toBe(true);
  });

  test("missing token_url fails", () => {
    expect(validateFHIRConfig(makeConfig({ token_url: "" })).some(e => e.includes("token_url"))).toBe(true);
  });

  test("missing company_id fails", () => {
    expect(validateFHIRConfig(makeConfig({ company_id: "" })).some(e => e.includes("company_id"))).toBe(true);
  });

  test("non-http base_url fails", () => {
    expect(validateFHIRConfig(makeConfig({ base_url: "ftp://bad" })).some(e => e.includes("http"))).toBe(true);
  });
});

// ── E2E: Full Encounter Normalization ───────────────────────

describe("E2E: normalize full encounter data", () => {
  test("normalize patient + encounter + conditions + procedures + coverage", () => {
    // Simulate FHIR responses
    const patient = normalizePatient({
      resourceType: "Patient", id: "pat-001",
      name: [{ family: "Doe", given: ["Jane"] }],
      birthDate: "1985-06-15", gender: "female",
      identifier: [{ system: "http://member", value: "MEM-123" }],
    });

    const encounter = normalizeEncounter({
      resourceType: "Encounter", id: "enc-001", status: "finished",
      class: { code: "AMB" },
      period: { start: "2026-03-15T09:00:00Z" },
      subject: { reference: "Patient/pat-001" },
      participant: [{ individual: { display: "Dr. Smith" } }],
    });

    const diagnoses = [
      normalizeCondition({
        resourceType: "Condition", id: "cond-1",
        code: { coding: [{ system: "icd-10", code: "J06.9", display: "Acute URI" }] },
        clinicalStatus: { coding: [{ code: "active" }] },
        encounter: { reference: "Encounter/enc-001" },
      }),
    ];

    const procedures = [
      normalizeProcedure({
        resourceType: "Procedure", id: "proc-1",
        code: { coding: [{ system: "cpt", code: "99213", display: "Office visit" }] },
        encounter: { reference: "Encounter/enc-001" },
        performedDateTime: "2026-03-15",
      }),
    ];

    const coverage = normalizeCoverage({
      resourceType: "Coverage", id: "cov-1", status: "active",
      subscriberId: "SUB-456",
      payor: [{ display: "Aetna" }],
      class: [{ type: { coding: [{ code: "group" }] }, value: "GRP-789" }],
    });

    // Verify complete billing-ready data
    expect(patient.first_name).toBe("Jane");
    expect(patient.member_id).toBe("MEM-123");
    expect(encounter.start_date).toBe("2026-03-15T09:00:00Z");
    expect(encounter.provider_name).toBe("Dr. Smith");
    expect(diagnoses[0].code).toBe("J06.9");
    expect(diagnoses[0].is_active).toBe(true);
    expect(procedures[0].code).toBe("99213");
    expect(coverage.payer_name).toBe("Aetna");
    expect(coverage.subscriber_id).toBe("SUB-456");
    expect(coverage.group_number).toBe("GRP-789");
  });
});
