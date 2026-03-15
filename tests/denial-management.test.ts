/**
 * Denial Management Agent Tests — ELLIE-742
 *
 * Tests for denial analysis pipeline:
 * - Denial classification (code patterns, reason text, unknown)
 * - Recommendation engine (all categories -> actions)
 * - RAG query building
 * - Full pipeline (analyzeDenial)
 * - Batch analysis with summary
 * - E2E scenarios
 */

import { describe, test, expect } from "bun:test";
import {
  classifyDenial,
  recommendAction,
  buildDenialRAGQueries,
  analyzeDenial,
  analyzeDenialBatch,
  VALID_DENIAL_CATEGORIES,
  type DeniedClaim,
  type DenialClassification,
  type DenialManagementOutcome,
} from "../src/denial-management.ts";

// ── Helpers ─────────────────────────────────────────────────

function makeDeniedClaim(overrides: Partial<DeniedClaim> = {}): DeniedClaim {
  return {
    claim_id: "CLM-001",
    payer_id: "aetna",
    payer_name: "Aetna",
    denial_code: "CO-16",
    denial_reason: "Claim lacks information needed for adjudication",
    total_charge_cents: 15000,
    cpt_codes: ["99213"],
    diagnosis_codes: ["J06.9"],
    submitted_at: "2026-01-15",
    denied_at: "2026-02-15",
    company_id: "comp-1",
    ...overrides,
  };
}

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("VALID_DENIAL_CATEGORIES has 9 categories", () => {
    expect(VALID_DENIAL_CATEGORIES).toHaveLength(9);
    expect(VALID_DENIAL_CATEGORIES).toContain("billing_error");
    expect(VALID_DENIAL_CATEGORIES).toContain("missing_documentation");
    expect(VALID_DENIAL_CATEGORIES).toContain("medical_necessity");
    expect(VALID_DENIAL_CATEGORIES).toContain("unknown");
  });
});

// ── classifyDenial ──────────────────────────────────────────

describe("classifyDenial", () => {
  test("CO-16 classified as billing_error", () => {
    const c = classifyDenial("CO-16", null);
    expect(c.category).toBe("billing_error");
    expect(c.confidence).toBeGreaterThanOrEqual(0.7);
    expect(c.is_avoidable).toBe(true);
  });

  test("CO-50 classified as coverage_issue", () => {
    const c = classifyDenial("CO-50", null);
    expect(c.category).toBe("coverage_issue");
    expect(c.is_avoidable).toBe(false);
  });

  test("CO-55 classified as medical_necessity", () => {
    const c = classifyDenial("CO-55", null);
    expect(c.category).toBe("medical_necessity");
  });

  test("CO-18 classified as duplicate_claim", () => {
    expect(classifyDenial("CO-18", null).category).toBe("duplicate_claim");
  });

  test("CO-29 classified as timely_filing", () => {
    expect(classifyDenial("CO-29", null).category).toBe("timely_filing");
  });

  test("CO-197 classified as authorization", () => {
    expect(classifyDenial("CO-197", null).category).toBe("authorization");
  });

  test("CO-5 classified as code_issue", () => {
    expect(classifyDenial("CO-5", null).category).toBe("code_issue");
  });

  test("falls back to reason text when code unknown", () => {
    const c = classifyDenial("XX-99", "Missing clinical documentation");
    expect(c.category).toBe("missing_documentation");
    expect(c.confidence).toBeLessThan(0.8);
  });

  test("reason text: duplicate", () => {
    expect(classifyDenial("XX-99", "Duplicate claim submission").category).toBe("duplicate_claim");
  });

  test("reason text: authorization", () => {
    expect(classifyDenial("XX-99", "Prior auth not obtained").category).toBe("authorization");
  });

  test("reason text: medical necessity", () => {
    expect(classifyDenial("XX-99", "Not medically necessary").category).toBe("medical_necessity");
  });

  test("reason text: coverage", () => {
    expect(classifyDenial("XX-99", "Service not covered under plan").category).toBe("coverage_issue");
  });

  test("reason text: timely filing", () => {
    expect(classifyDenial("XX-99", "Claim filed too late, timely filing exceeded").category).toBe("timely_filing");
  });

  test("unknown code + no reason = unknown", () => {
    const c = classifyDenial("XX-99", null);
    expect(c.category).toBe("unknown");
    expect(c.confidence).toBeLessThanOrEqual(0.3);
  });
});

// ── recommendAction ─────────────────────────────────────────

describe("recommendAction", () => {
  const claim = makeDeniedClaim();

  test("billing_error -> resubmit to claim_submission", () => {
    const r = recommendAction({ category: "billing_error", confidence: 0.8, reasoning: "", is_avoidable: true }, claim);
    expect(r.action).toBe("resubmit");
    expect(r.route_to).toBe("claim_submission");
    expect(r.estimated_recovery_cents).toBe(15000);
  });

  test("code_issue -> resubmit to claim_submission", () => {
    const r = recommendAction({ category: "code_issue", confidence: 0.8, reasoning: "", is_avoidable: true }, claim);
    expect(r.action).toBe("resubmit");
    expect(r.evidence_needed).toContain("Updated procedure/diagnosis codes");
  });

  test("missing_documentation -> request_documentation to manual_review", () => {
    const r = recommendAction({ category: "missing_documentation", confidence: 0.6, reasoning: "", is_avoidable: true }, claim);
    expect(r.action).toBe("request_documentation");
    expect(r.route_to).toBe("manual_review");
  });

  test("medical_necessity -> appeal to appeals", () => {
    const r = recommendAction({ category: "medical_necessity", confidence: 0.7, reasoning: "", is_avoidable: false }, claim);
    expect(r.action).toBe("appeal");
    expect(r.route_to).toBe("appeals");
    expect(r.evidence_needed).toContain("Letter of medical necessity");
  });

  test("coverage_issue -> appeal to appeals", () => {
    const r = recommendAction({ category: "coverage_issue", confidence: 0.6, reasoning: "", is_avoidable: false }, claim);
    expect(r.action).toBe("appeal");
    expect(r.route_to).toBe("appeals");
  });

  test("authorization -> appeal to appeals", () => {
    const r = recommendAction({ category: "authorization", confidence: 0.7, reasoning: "", is_avoidable: true }, claim);
    expect(r.action).toBe("appeal");
    expect(r.evidence_needed).toContain("Retroactive authorization request");
  });

  test("duplicate_claim -> adjust to manual_review", () => {
    const r = recommendAction({ category: "duplicate_claim", confidence: 0.7, reasoning: "", is_avoidable: true }, claim);
    expect(r.action).toBe("adjust");
    expect(r.route_to).toBe("manual_review");
    expect(r.estimated_recovery_cents).toBe(0);
  });

  test("timely_filing -> appeal", () => {
    const r = recommendAction({ category: "timely_filing", confidence: 0.7, reasoning: "", is_avoidable: true }, claim);
    expect(r.action).toBe("appeal");
    expect(r.evidence_needed).toContain("Proof of timely filing");
  });

  test("unknown -> write_off to manual_review", () => {
    const r = recommendAction({ category: "unknown", confidence: 0.3, reasoning: "", is_avoidable: false }, claim);
    expect(r.action).toBe("write_off");
    expect(r.route_to).toBe("manual_review");
  });

  test("estimated_recovery is proportional to charge", () => {
    const bigClaim = makeDeniedClaim({ total_charge_cents: 100000 });
    const r = recommendAction({ category: "medical_necessity", confidence: 0.7, reasoning: "", is_avoidable: false }, bigClaim);
    expect(r.estimated_recovery_cents).toBe(60000); // 60% for appeals
  });
});

// ── buildDenialRAGQueries ───────────────────────────────────

describe("buildDenialRAGQueries", () => {
  test("generates denial code query", () => {
    const queries = buildDenialRAGQueries(makeDeniedClaim());
    expect(queries.some(q => q.query.includes("CO-16") && q.categories.includes("denial_reasons"))).toBe(true);
  });

  test("generates payer-specific appeal query", () => {
    const queries = buildDenialRAGQueries(makeDeniedClaim());
    expect(queries.some(q => q.query.includes("Aetna") && q.categories.includes("appeal_templates"))).toBe(true);
  });

  test("generates coding query when CPT codes present", () => {
    const queries = buildDenialRAGQueries(makeDeniedClaim({ cpt_codes: ["99213", "87081"] }));
    expect(queries.some(q => q.query.includes("99213") && q.categories.includes("cpt_codes"))).toBe(true);
  });

  test("no coding query when no CPT codes", () => {
    const queries = buildDenialRAGQueries(makeDeniedClaim({ cpt_codes: [] }));
    expect(queries.filter(q => q.categories.includes("cpt_codes"))).toHaveLength(0);
  });
});

// ── analyzeDenial ───────────────────────────────────────────

describe("analyzeDenial", () => {
  test("full pipeline produces complete outcome", () => {
    const outcome = analyzeDenial(makeDeniedClaim());
    expect(outcome.claim_id).toBe("CLM-001");
    expect(outcome.denial_code).toBe("CO-16");
    expect(outcome.classification.category).toBe("billing_error");
    expect(outcome.recommendation.action).toBe("resubmit");
    expect(outcome.recommendation.route_to).toBe("claim_submission");
    expect(outcome.rag_queries_used.length).toBeGreaterThanOrEqual(2);
  });

  test("medical necessity denial routes to appeals", () => {
    const outcome = analyzeDenial(makeDeniedClaim({
      denial_code: "CO-55",
      denial_reason: "Not medically necessary",
    }));
    expect(outcome.classification.category).toBe("medical_necessity");
    expect(outcome.recommendation.action).toBe("appeal");
    expect(outcome.recommendation.route_to).toBe("appeals");
  });
});

// ── analyzeDenialBatch ──────────────────────────────────────

describe("analyzeDenialBatch", () => {
  test("processes batch and produces summary", () => {
    const claims = [
      makeDeniedClaim({ claim_id: "A", denial_code: "CO-16", total_charge_cents: 10000 }),
      makeDeniedClaim({ claim_id: "B", denial_code: "CO-55", total_charge_cents: 20000 }),
      makeDeniedClaim({ claim_id: "C", denial_code: "CO-18", total_charge_cents: 5000 }),
    ];
    const { outcomes, summary } = analyzeDenialBatch(claims);

    expect(outcomes).toHaveLength(3);
    expect(summary.total).toBe(3);
    expect(summary.by_category.billing_error).toBe(1);
    expect(summary.by_category.medical_necessity).toBe(1);
    expect(summary.by_category.duplicate_claim).toBe(1);
    expect(summary.avoidable_count).toBe(2); // billing_error + duplicate
    expect(summary.total_estimated_recovery_cents).toBeGreaterThan(0);
  });

  test("handles empty batch", () => {
    const { outcomes, summary } = analyzeDenialBatch([]);
    expect(outcomes).toHaveLength(0);
    expect(summary.total).toBe(0);
  });

  test("counts actions correctly", () => {
    const claims = [
      makeDeniedClaim({ claim_id: "A", denial_code: "CO-16" }), // resubmit
      makeDeniedClaim({ claim_id: "B", denial_code: "CO-4" }),   // resubmit
      makeDeniedClaim({ claim_id: "C", denial_code: "CO-55" }),  // appeal
    ];
    const { summary } = analyzeDenialBatch(claims);
    expect(summary.by_action.resubmit).toBe(2);
    expect(summary.by_action.appeal).toBe(1);
  });
});

// ── E2E: Denial Scenarios ───────────────────────────────────

describe("E2E: denial scenarios", () => {
  test("billing error: CO-16 -> classify -> resubmit", () => {
    const outcome = analyzeDenial(makeDeniedClaim({
      denial_code: "CO-16",
      denial_reason: "Claim lacks information",
      cpt_codes: ["99213"],
    }));
    expect(outcome.classification.category).toBe("billing_error");
    expect(outcome.classification.is_avoidable).toBe(true);
    expect(outcome.recommendation.action).toBe("resubmit");
    expect(outcome.recommendation.route_to).toBe("claim_submission");
    expect(outcome.recommendation.correction_details).toContain("CO-16");
  });

  test("medical necessity: CO-55 -> classify -> appeal with evidence", () => {
    const outcome = analyzeDenial(makeDeniedClaim({
      denial_code: "CO-55",
      denial_reason: "Procedure not medically necessary",
      total_charge_cents: 250000,
    }));
    expect(outcome.classification.category).toBe("medical_necessity");
    expect(outcome.classification.is_avoidable).toBe(false);
    expect(outcome.recommendation.action).toBe("appeal");
    expect(outcome.recommendation.evidence_needed).toContain("Letter of medical necessity");
    expect(outcome.recommendation.estimated_recovery_cents).toBe(150000); // 60%
  });

  test("unknown denial: manual review with low confidence", () => {
    const outcome = analyzeDenial(makeDeniedClaim({
      denial_code: "XX-999",
      denial_reason: null,
    }));
    expect(outcome.classification.category).toBe("unknown");
    expect(outcome.classification.confidence).toBeLessThanOrEqual(0.3);
    expect(outcome.recommendation.action).toBe("write_off");
    expect(outcome.recommendation.route_to).toBe("manual_review");
  });
});
