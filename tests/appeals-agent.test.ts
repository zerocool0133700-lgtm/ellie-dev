/**
 * Appeals Agent Tests — ELLIE-743
 *
 * Tests for appeal letter generation and package assembly:
 * - Documentation checklist (by denial category + appeal level)
 * - Appeal letter generation (sections, subject, word count)
 * - RAG query building
 * - Cost estimation and cost-effectiveness
 * - Full appeal package
 * - Appeal outcome
 * - E2E scenarios
 */

import { describe, test, expect } from "bun:test";
import {
  generateChecklist,
  generateAppealLetter,
  buildAppealRAGQueries,
  estimateAppealCost,
  isAppealCostEffective,
  buildAppealPackage,
  buildAppealOutcome,
  VALID_APPEAL_LEVELS,
  VALID_APPEAL_STATUSES,
  type AppealInput,
  type AppealPackage,
  type AppealOutcome,
} from "../src/appeals-agent.ts";

// ── Helpers ─────────────────────────────────────────────────

function makeAppealInput(overrides: Partial<AppealInput> = {}): AppealInput {
  return {
    claim_id: "CLM-001",
    payer_id: "aetna",
    payer_name: "Aetna",
    denial_code: "CO-55",
    denial_reason: "Not medically necessary",
    denial_category: "medical_necessity",
    total_charge_cents: 250000,
    cpt_codes: ["72148"],
    diagnosis_codes: ["M54.5"],
    patient_name: "Jane Doe",
    provider_name: "Dr. Smith",
    encounter_date: "2026-02-15",
    appeal_level: "first",
    company_id: "comp-1",
    ...overrides,
  };
}

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("VALID_APPEAL_LEVELS has 3 levels", () => {
    expect(VALID_APPEAL_LEVELS).toEqual(["first", "second", "external_review"]);
  });

  test("VALID_APPEAL_STATUSES has 6 statuses", () => {
    expect(VALID_APPEAL_STATUSES).toHaveLength(6);
    expect(VALID_APPEAL_STATUSES).toContain("drafting");
    expect(VALID_APPEAL_STATUSES).toContain("pending_review");
    expect(VALID_APPEAL_STATUSES).toContain("submitted");
  });
});

// ── generateChecklist ───────────────────────────────────────

describe("generateChecklist", () => {
  test("always includes base items (claim copy, EOB, cover letter)", () => {
    const items = generateChecklist("billing_error", "first");
    expect(items.some(i => i.label.includes("Original claim"))).toBe(true);
    expect(items.some(i => i.label.includes("Denial notice"))).toBe(true);
    expect(items.some(i => i.label.includes("cover letter"))).toBe(true);
  });

  test("medical_necessity adds clinical items", () => {
    const items = generateChecklist("medical_necessity", "first");
    expect(items.some(i => i.label.includes("Letter of medical necessity"))).toBe(true);
    expect(items.some(i => i.label.includes("Clinical notes"))).toBe(true);
    expect(items.some(i => i.label.includes("Peer-reviewed"))).toBe(true);
  });

  test("authorization adds retro auth items", () => {
    const items = generateChecklist("authorization", "first");
    expect(items.some(i => i.label.includes("Retroactive authorization"))).toBe(true);
  });

  test("timely_filing adds proof of submission", () => {
    const items = generateChecklist("timely_filing", "first");
    expect(items.some(i => i.label.includes("Proof of original submission"))).toBe(true);
    expect(items.some(i => i.label.includes("Tracking/confirmation"))).toBe(true);
  });

  test("code_issue adds corrected coding docs", () => {
    const items = generateChecklist("code_issue", "first");
    expect(items.some(i => i.label.includes("Corrected coding"))).toBe(true);
    expect(items.some(i => i.label.includes("Operative/procedure report"))).toBe(true);
  });

  test("second level adds first-level denial letter", () => {
    const items = generateChecklist("medical_necessity", "second");
    expect(items.some(i => i.label.includes("First-level appeal denial"))).toBe(true);
  });

  test("external_review adds regulatory filing items", () => {
    const items = generateChecklist("coverage_issue", "external_review");
    expect(items.some(i => i.label.includes("External review request"))).toBe(true);
    expect(items.some(i => i.label.includes("State regulatory"))).toBe(true);
  });

  test("all required items start as obtained=false", () => {
    const items = generateChecklist("medical_necessity", "first");
    for (const item of items) {
      expect(item.obtained).toBe(false);
    }
  });
});

// ── generateAppealLetter ────────────────────────────────────

describe("generateAppealLetter", () => {
  test("generates letter with all required sections", () => {
    const letter = generateAppealLetter(makeAppealInput());
    expect(letter.sections.length).toBeGreaterThanOrEqual(4);
    const headings = letter.sections.map(s => s.heading);
    expect(headings).toContain("Purpose of Appeal");
    expect(headings).toContain("Claim Details");
    expect(headings).toContain("Regulatory Basis");
    expect(headings).toContain("Requested Action");
  });

  test("includes clinical justification for medical_necessity", () => {
    const letter = generateAppealLetter(makeAppealInput({ denial_category: "medical_necessity" }));
    expect(letter.sections.some(s => s.heading === "Clinical Justification")).toBe(true);
  });

  test("includes clinical justification for coverage_issue", () => {
    const letter = generateAppealLetter(makeAppealInput({ denial_category: "coverage_issue" }));
    expect(letter.sections.some(s => s.heading === "Clinical Justification")).toBe(true);
  });

  test("no clinical justification for billing_error", () => {
    const letter = generateAppealLetter(makeAppealInput({ denial_category: "billing_error" }));
    expect(letter.sections.some(s => s.heading === "Clinical Justification")).toBe(false);
  });

  test("subject includes claim ID, denial code, patient name", () => {
    const letter = generateAppealLetter(makeAppealInput());
    expect(letter.subject).toContain("CLM-001");
    expect(letter.subject).toContain("CO-55");
    expect(letter.subject).toContain("Jane Doe");
  });

  test("body contains claim details", () => {
    const letter = generateAppealLetter(makeAppealInput());
    expect(letter.body).toContain("72148");
    expect(letter.body).toContain("M54.5");
    expect(letter.body).toContain("Aetna");
    expect(letter.body).toContain("$2500.00");
  });

  test("word_count is computed", () => {
    const letter = generateAppealLetter(makeAppealInput());
    expect(letter.word_count).toBeGreaterThan(50);
  });

  test("includes RAG placeholders for evidence injection", () => {
    const letter = generateAppealLetter(makeAppealInput());
    expect(letter.body).toContain("[RAG:");
  });
});

// ── buildAppealRAGQueries ───────────────────────────────────

describe("buildAppealRAGQueries", () => {
  test("generates appeal template query", () => {
    const queries = buildAppealRAGQueries(makeAppealInput());
    expect(queries.some(q => q.categories.includes("appeal_templates") && q.query.includes("Aetna"))).toBe(true);
  });

  test("generates compliance/regulation query", () => {
    const queries = buildAppealRAGQueries(makeAppealInput());
    expect(queries.some(q => q.categories.includes("compliance"))).toBe(true);
  });

  test("generates medical necessity docs query for med nec denials", () => {
    const queries = buildAppealRAGQueries(makeAppealInput({ denial_category: "medical_necessity" }));
    expect(queries.some(q => q.query.includes("Medical necessity documentation"))).toBe(true);
  });

  test("no medical necessity query for non-med-nec denials", () => {
    const queries = buildAppealRAGQueries(makeAppealInput({ denial_category: "billing_error" }));
    expect(queries.some(q => q.query.includes("Medical necessity documentation"))).toBe(false);
  });

  test("generates payer submission requirements query", () => {
    const queries = buildAppealRAGQueries(makeAppealInput());
    expect(queries.some(q => q.query.includes("appeal submission requirements"))).toBe(true);
  });
});

// ── estimateAppealCost ──────────────────────────────────────

describe("estimateAppealCost", () => {
  test("first level costs $50", () => {
    expect(estimateAppealCost("first", 250000)).toBe(5000);
  });

  test("second level costs $100", () => {
    expect(estimateAppealCost("second", 250000)).toBe(10000);
  });

  test("external review costs $250", () => {
    expect(estimateAppealCost("external_review", 250000)).toBe(25000);
  });
});

// ── isAppealCostEffective ───────────────────────────────────

describe("isAppealCostEffective", () => {
  test("$50 appeal on $2500 claim is cost effective (2%)", () => {
    expect(isAppealCostEffective(5000, 250000)).toBe(true);
  });

  test("$250 appeal on $500 claim is NOT cost effective (50%)", () => {
    expect(isAppealCostEffective(25000, 50000)).toBe(false);
  });

  test("exactly at threshold is NOT cost effective", () => {
    expect(isAppealCostEffective(2000, 10000)).toBe(false); // 20% exactly
  });

  test("zero claim value is not cost effective", () => {
    expect(isAppealCostEffective(5000, 0)).toBe(false);
  });

  test("accepts custom max percent", () => {
    expect(isAppealCostEffective(5000, 10000, 60)).toBe(true); // 50% < 60%
  });
});

// ── buildAppealPackage ──────────────────────────────────────

describe("buildAppealPackage", () => {
  test("produces complete package", () => {
    const pkg = buildAppealPackage(makeAppealInput());
    expect(pkg.claim_id).toBe("CLM-001");
    expect(pkg.appeal_level).toBe("first");
    expect(pkg.letter.sections.length).toBeGreaterThanOrEqual(4);
    expect(pkg.checklist.length).toBeGreaterThanOrEqual(3);
    expect(pkg.checklist_complete).toBe(false); // Nothing obtained yet
    expect(pkg.estimated_cost_cents).toBe(5000);
    expect(pkg.requires_approval).toBe(true);
  });

  test("checklist_complete is false when required items not obtained", () => {
    const pkg = buildAppealPackage(makeAppealInput());
    expect(pkg.checklist_complete).toBe(false);
  });
});

// ── buildAppealOutcome ──────────────────────────────────────

describe("buildAppealOutcome", () => {
  test("produces outcome with all fields", () => {
    const pkg = buildAppealPackage(makeAppealInput());
    const outcome = buildAppealOutcome(pkg, makeAppealInput());
    expect(outcome.claim_id).toBe("CLM-001");
    expect(outcome.status).toBe("pending_review");
    expect(outcome.letter_word_count).toBeGreaterThan(0);
    expect(outcome.checklist_items).toBeGreaterThan(0);
    expect(outcome.estimated_recovery_cents).toBe(150000); // 60% of 250000
    expect(outcome.requires_approval).toBe(true);
    expect(outcome.rag_queries_used.length).toBeGreaterThanOrEqual(3);
  });
});

// ── E2E: Appeal Scenarios ───────────────────────────────────

describe("E2E: appeal scenarios", () => {
  test("medical necessity first-level appeal", () => {
    const input = makeAppealInput();
    const pkg = buildAppealPackage(input);
    const outcome = buildAppealOutcome(pkg, input);

    // Checklist should include clinical evidence
    expect(pkg.checklist.some(i => i.label.includes("Letter of medical necessity"))).toBe(true);
    expect(pkg.checklist.some(i => i.label.includes("Clinical notes"))).toBe(true);

    // Letter should include clinical justification
    expect(pkg.letter.sections.some(s => s.heading === "Clinical Justification")).toBe(true);

    // Cost effective ($50 on $2500)
    expect(isAppealCostEffective(pkg.estimated_cost_cents, input.total_charge_cents)).toBe(true);

    // Outcome
    expect(outcome.status).toBe("pending_review");
    expect(outcome.requires_approval).toBe(true);
  });

  test("timely filing second-level appeal", () => {
    const input = makeAppealInput({
      denial_category: "timely_filing",
      denial_code: "CO-29",
      denial_reason: "Claim filed after timely filing limit",
      appeal_level: "second",
    });
    const pkg = buildAppealPackage(input);

    // Should have timely filing proof items
    expect(pkg.checklist.some(i => i.label.includes("Proof of original submission"))).toBe(true);

    // Should have first-level denial letter (second appeal)
    expect(pkg.checklist.some(i => i.label.includes("First-level appeal denial"))).toBe(true);

    // Higher cost for second level
    expect(pkg.estimated_cost_cents).toBe(10000);
  });

  test("external review for coverage denial", () => {
    const input = makeAppealInput({
      denial_category: "coverage_issue",
      appeal_level: "external_review",
      total_charge_cents: 500000,
    });
    const pkg = buildAppealPackage(input);

    // External review items
    expect(pkg.checklist.some(i => i.label.includes("External review request"))).toBe(true);

    // First-level denial letter required
    expect(pkg.checklist.some(i => i.label.includes("First-level appeal denial"))).toBe(true);

    // Highest cost
    expect(pkg.estimated_cost_cents).toBe(25000);

    // Still cost effective ($250 on $5000)
    expect(isAppealCostEffective(pkg.estimated_cost_cents, input.total_charge_cents)).toBe(true);
  });
});
