/**
 * Outcomes Feedback Loop Tests — ELLIE-748
 *
 * Tests for learning extraction from completed claims:
 * - Successful payment patterns
 * - Denial playbook enrichment
 * - Appeal effectiveness scoring
 * - Payer behavior patterns
 * - Coding insights
 * - Confidence decay
 * - Deduplication
 * - Pipeline orchestration
 * - Batch processing
 * - E2E scenarios
 */

import { describe, test, expect } from "bun:test";
import {
  extractLearnings,
  decayConfidence,
  runFeedbackLoop,
  runBatchFeedback,
  type CompletedClaimLifecycle,
  type LearningEntry,
  type WriteKnowledgeFn,
  type DedupCheckFn,
} from "../src/outcomes-feedback.ts";

// ── Helpers ─────────────────────────────────────────────────

function makeClaim(overrides: Partial<CompletedClaimLifecycle> = {}): CompletedClaimLifecycle {
  return {
    claim_id: "CLM-001",
    payer_id: "aetna",
    payer_name: "Aetna",
    cpt_codes: ["99213"],
    diagnosis_codes: ["J06.9"],
    modifiers: [],
    total_charge_cents: 15000,
    paid_amount_cents: 12000,
    outcome: "paid",
    denial_code: null,
    denial_reason: null,
    appeal_attempted: false,
    appeal_outcome: null,
    appeal_template_used: null,
    days_to_resolution: 28,
    company_id: "comp-1",
    ...overrides,
  };
}

function mockWrite(): { fn: WriteKnowledgeFn; entries: LearningEntry[] } {
  const entries: LearningEntry[] = [];
  return { fn: async (e) => { entries.push(e); }, entries };
}

function mockDedup(dupIndices: Set<number> = new Set()): DedupCheckFn {
  let i = 0;
  return async () => { const isDup = dupIndices.has(i); i++; return isDup; };
}

// ── extractLearnings ────────────────────────────────────────

describe("extractLearnings", () => {
  test("paid claim produces successful_pattern + payer_behavior", () => {
    const learnings = extractLearnings(makeClaim());
    expect(learnings.some(l => l.learning_type === "successful_pattern")).toBe(true);
    expect(learnings.some(l => l.learning_type === "payer_behavior")).toBe(true);
  });

  test("successful_pattern includes CPT codes, payer, payment rate", () => {
    const l = extractLearnings(makeClaim()).find(l => l.learning_type === "successful_pattern")!;
    expect(l.content).toContain("99213");
    expect(l.content).toContain("Aetna");
    expect(l.content).toContain("80%"); // 12000/15000
    expect(l.category).toBe("payer_rules");
    expect(l.source_claim_id).toBe("CLM-001");
  });

  test("successful_pattern includes modifiers when present", () => {
    const l = extractLearnings(makeClaim({ modifiers: ["25", "59"] })).find(l => l.learning_type === "successful_pattern")!;
    expect(l.content).toContain("modifiers 25, 59");
  });

  test("high payment rate gets higher confidence", () => {
    const high = extractLearnings(makeClaim({ paid_amount_cents: 14000 })).find(l => l.learning_type === "successful_pattern")!;
    const low = extractLearnings(makeClaim({ paid_amount_cents: 8000 })).find(l => l.learning_type === "successful_pattern")!;
    expect(high.confidence).toBeGreaterThan(low.confidence);
  });

  test("denied claim produces denial_playbook", () => {
    const learnings = extractLearnings(makeClaim({
      outcome: "denied", denial_code: "CO-16", denial_reason: "Missing info",
      paid_amount_cents: 0,
    }));
    const denial = learnings.find(l => l.learning_type === "denial_playbook")!;
    expect(denial.category).toBe("denial_reasons");
    expect(denial.subcategory).toBe("CO-16");
    expect(denial.content).toContain("CO-16");
    expect(denial.content).toContain("Missing info");
    expect(denial.content).toContain("No appeal attempted");
  });

  test("denied + appealed + won produces appeal_effectiveness", () => {
    const learnings = extractLearnings(makeClaim({
      outcome: "denied", denial_code: "CO-55",
      appeal_attempted: true, appeal_outcome: "won",
      appeal_template_used: "med-nec-v2", paid_amount_cents: 0,
    }));
    const appeal = learnings.find(l => l.learning_type === "appeal_effectiveness")!;
    expect(appeal.category).toBe("appeal_templates");
    expect(appeal.content).toContain("WON");
    expect(appeal.content).toContain("med-nec-v2");
    expect(appeal.confidence).toBe(0.9);
  });

  test("lost appeal gets lower confidence", () => {
    const learnings = extractLearnings(makeClaim({
      outcome: "denied", denial_code: "CO-55",
      appeal_attempted: true, appeal_outcome: "lost", paid_amount_cents: 0,
    }));
    const appeal = learnings.find(l => l.learning_type === "appeal_effectiveness")!;
    expect(appeal.content).toContain("LOST");
    expect(appeal.confidence).toBe(0.6);
  });

  test("payer_behavior tracks resolution time", () => {
    const learnings = extractLearnings(makeClaim({ days_to_resolution: 45 }));
    const behavior = learnings.find(l => l.learning_type === "payer_behavior")!;
    expect(behavior.content).toContain("45 days");
    expect(behavior.content).toContain("paid");
  });

  test("coding insight from denied + won appeal with modifiers", () => {
    const learnings = extractLearnings(makeClaim({
      outcome: "denied", denial_code: "CO-4",
      appeal_attempted: true, appeal_outcome: "won",
      modifiers: ["25"], paid_amount_cents: 0,
    }));
    const coding = learnings.find(l => l.learning_type === "coding_insight")!;
    expect(coding.category).toBe("cpt_codes");
    expect(coding.content).toContain("modifier");
    expect(coding.content).toContain("25");
    expect(coding.content).toContain("approved on appeal");
  });

  test("no coding insight when no modifiers", () => {
    const learnings = extractLearnings(makeClaim({
      outcome: "denied", appeal_attempted: true, appeal_outcome: "won",
      modifiers: [], paid_amount_cents: 0,
    }));
    expect(learnings.some(l => l.learning_type === "coding_insight")).toBe(false);
  });

  test("all entries tagged with source_claim_id", () => {
    const learnings = extractLearnings(makeClaim());
    for (const l of learnings) {
      expect(l.source_claim_id).toBe("CLM-001");
    }
  });

  test("all entries tagged with payer_id and company_id", () => {
    const learnings = extractLearnings(makeClaim());
    for (const l of learnings) {
      expect(l.payer_id).toBe("aetna");
      expect(l.company_id).toBe("comp-1");
    }
  });
});

// ── decayConfidence ─────────────────────────────────────────

describe("decayConfidence", () => {
  test("no decay at day 0", () => {
    expect(decayConfidence(0.9, 0)).toBe(0.9);
  });

  test("halves at half-life", () => {
    expect(decayConfidence(1.0, 180)).toBe(0.5);
  });

  test("quarter at 2x half-life", () => {
    expect(decayConfidence(1.0, 360)).toBe(0.25);
  });

  test("custom half-life", () => {
    expect(decayConfidence(1.0, 90, 90)).toBe(0.5);
  });

  test("decays proportionally", () => {
    const d90 = decayConfidence(0.9, 90);
    const d180 = decayConfidence(0.9, 180);
    expect(d90).toBeGreaterThan(d180);
    expect(d90).toBeLessThan(0.9);
  });
});

// ── runFeedbackLoop ─────────────────────────────────────────

describe("runFeedbackLoop", () => {
  test("writes all learnings when no dedup", async () => {
    const write = mockWrite();
    const result = await runFeedbackLoop(makeClaim(), { writeKnowledge: write.fn });
    expect(result.learnings_extracted.length).toBeGreaterThanOrEqual(2);
    expect(write.entries.length).toBe(result.learnings_extracted.length);
    expect(result.dedup_skipped).toBe(0);
  });

  test("skips duplicates", async () => {
    const write = mockWrite();
    const result = await runFeedbackLoop(makeClaim(), {
      writeKnowledge: write.fn,
      dedupCheck: mockDedup(new Set([0])),
    });
    expect(result.dedup_skipped).toBe(1);
    expect(write.entries.length).toBe(result.learnings_extracted.length - 1);
  });

  test("returns claim_id in result", async () => {
    const write = mockWrite();
    const result = await runFeedbackLoop(makeClaim(), { writeKnowledge: write.fn });
    expect(result.claim_id).toBe("CLM-001");
  });
});

// ── runBatchFeedback ────────────────────────────────────────

describe("runBatchFeedback", () => {
  test("processes multiple claims", async () => {
    const write = mockWrite();
    const claims = [makeClaim({ claim_id: "A" }), makeClaim({ claim_id: "B" })];
    const batch = await runBatchFeedback(claims, { writeKnowledge: write.fn });
    expect(batch.results).toHaveLength(2);
    expect(batch.total_learnings).toBeGreaterThanOrEqual(4);
    expect(batch.total_written).toBe(batch.total_learnings);
  });

  test("tracks dedup across batch", async () => {
    const write = mockWrite();
    const batch = await runBatchFeedback(
      [makeClaim()],
      { writeKnowledge: write.fn, dedupCheck: mockDedup(new Set([0, 1])) },
    );
    expect(batch.total_dedup_skipped).toBe(2);
    expect(batch.total_written).toBe(batch.total_learnings - 2);
  });

  test("handles empty batch", async () => {
    const write = mockWrite();
    const batch = await runBatchFeedback([], { writeKnowledge: write.fn });
    expect(batch.total_learnings).toBe(0);
  });
});

// ── E2E: Claim Lifecycle Feedback ───────────────────────────

describe("E2E: claim lifecycle feedback", () => {
  test("paid claim -> successful pattern + payer behavior", async () => {
    const write = mockWrite();
    const result = await runFeedbackLoop(
      makeClaim({ paid_amount_cents: 14500, days_to_resolution: 21 }),
      { writeKnowledge: write.fn },
    );
    const types = write.entries.map(e => e.learning_type);
    expect(types).toContain("successful_pattern");
    expect(types).toContain("payer_behavior");
    expect(write.entries.find(e => e.learning_type === "successful_pattern")!.content).toContain("97%");
  });

  test("denied + appealed + won -> denial playbook + appeal effectiveness + coding insight", async () => {
    const write = mockWrite();
    await runFeedbackLoop(
      makeClaim({
        outcome: "denied", denial_code: "CO-4", denial_reason: "Modifier missing",
        appeal_attempted: true, appeal_outcome: "won",
        appeal_template_used: "modifier-fix-v1", modifiers: ["25"],
        paid_amount_cents: 0,
      }),
      { writeKnowledge: write.fn },
    );
    const types = write.entries.map(e => e.learning_type);
    expect(types).toContain("denial_playbook");
    expect(types).toContain("appeal_effectiveness");
    expect(types).toContain("coding_insight");

    const coding = write.entries.find(e => e.learning_type === "coding_insight")!;
    expect(coding.content).toContain("modifier");
    expect(coding.content).toContain("25");
    expect(coding.content).toContain("avoid denial");
  });

  test("denied without appeal -> denial playbook only (no appeal or coding)", async () => {
    const write = mockWrite();
    await runFeedbackLoop(
      makeClaim({
        outcome: "denied", denial_code: "CO-16",
        appeal_attempted: false, paid_amount_cents: 0,
      }),
      { writeKnowledge: write.fn },
    );
    const types = write.entries.map(e => e.learning_type);
    expect(types).toContain("denial_playbook");
    expect(types).not.toContain("appeal_effectiveness");
    expect(types).not.toContain("coding_insight");
  });
});
