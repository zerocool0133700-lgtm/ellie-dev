/**
 * Outcomes Feedback Loop — ELLIE-748
 *
 * Extracts learnings from completed claim lifecycles and feeds
 * them back into medical_knowledge. Reinforces successful patterns,
 * enriches denial playbooks, scores appeal templates.
 *
 * Pure pipeline logic — knowledge writes injected as deps.
 */

import type { MedicalKnowledgeCategory } from "./medical-knowledge";

// ── Types ────────────────────────────────────────────────────

/** A completed claim lifecycle for learning extraction. */
export interface CompletedClaimLifecycle {
  claim_id: string;
  payer_id: string;
  payer_name: string;
  cpt_codes: string[];
  diagnosis_codes: string[];
  modifiers: string[];
  total_charge_cents: number;
  paid_amount_cents: number;
  outcome: "paid" | "denied" | "partially_paid" | "written_off";
  denial_code: string | null;
  denial_reason: string | null;
  appeal_attempted: boolean;
  appeal_outcome: "won" | "lost" | null;
  appeal_template_used: string | null;
  days_to_resolution: number;
  company_id: string | null;
}

/** A knowledge entry to be created from a learning. */
export interface LearningEntry {
  category: MedicalKnowledgeCategory;
  subcategory: string | null;
  content: string;
  source_claim_id: string;
  payer_id: string | null;
  company_id: string | null;
  confidence: number;
  learning_type: LearningType;
}

export type LearningType =
  | "successful_pattern"
  | "denial_playbook"
  | "appeal_effectiveness"
  | "payer_behavior"
  | "coding_insight";

/** Result of the feedback loop for one claim. */
export interface FeedbackResult {
  claim_id: string;
  learnings_extracted: LearningEntry[];
  dedup_skipped: number;
}

/** Injected dependency: check if similar knowledge already exists. */
export type DedupCheckFn = (content: string, category: MedicalKnowledgeCategory, payerId?: string) => Promise<boolean>;

/** Injected dependency: write a knowledge entry. */
export type WriteKnowledgeFn = (entry: LearningEntry) => Promise<void>;

// ── Learning Extraction (Pure) ──────────────────────────────

/**
 * Extract learnings from a completed claim lifecycle.
 * Pure function — returns entries to be written.
 */
export function extractLearnings(claim: CompletedClaimLifecycle): LearningEntry[] {
  const entries: LearningEntry[] = [];

  // Successful payment pattern
  if (claim.outcome === "paid" || claim.outcome === "partially_paid") {
    const cptList = claim.cpt_codes.join(", ");
    const modList = claim.modifiers.length > 0 ? ` with modifiers ${claim.modifiers.join(", ")}` : "";
    const payRate = claim.total_charge_cents > 0
      ? Math.round((claim.paid_amount_cents / claim.total_charge_cents) * 100)
      : 0;

    entries.push({
      category: "payer_rules",
      subcategory: claim.payer_id,
      content: `${claim.payer_name} approved CPT ${cptList}${modList} for diagnoses ${claim.diagnosis_codes.join(", ")}. Payment rate: ${payRate}%. Resolved in ${claim.days_to_resolution} days.`,
      source_claim_id: claim.claim_id,
      payer_id: claim.payer_id,
      company_id: claim.company_id,
      confidence: payRate >= 90 ? 0.9 : 0.7,
      learning_type: "successful_pattern",
    });
  }

  // Denial playbook enrichment
  if (claim.outcome === "denied" && claim.denial_code) {
    const resolution = claim.appeal_attempted
      ? (claim.appeal_outcome === "won" ? "Successfully appealed" : "Appeal unsuccessful")
      : "No appeal attempted";

    entries.push({
      category: "denial_reasons",
      subcategory: claim.denial_code,
      content: `${claim.payer_name} denial ${claim.denial_code}: ${claim.denial_reason ?? "No reason provided"}. CPT: ${claim.cpt_codes.join(", ")}. ${resolution}.`,
      source_claim_id: claim.claim_id,
      payer_id: claim.payer_id,
      company_id: claim.company_id,
      confidence: 0.8,
      learning_type: "denial_playbook",
    });
  }

  // Appeal effectiveness
  if (claim.appeal_attempted && claim.appeal_outcome) {
    const won = claim.appeal_outcome === "won";
    entries.push({
      category: "appeal_templates",
      subcategory: claim.denial_code,
      content: `Appeal for ${claim.payer_name} denial ${claim.denial_code ?? "unknown"}: ${won ? "WON" : "LOST"}. CPT: ${claim.cpt_codes.join(", ")}. Template used: ${claim.appeal_template_used ?? "none"}.`,
      source_claim_id: claim.claim_id,
      payer_id: claim.payer_id,
      company_id: claim.company_id,
      confidence: won ? 0.9 : 0.6,
      learning_type: "appeal_effectiveness",
    });
  }

  // Payer behavior patterns
  if (claim.days_to_resolution > 0) {
    entries.push({
      category: "payer_rules",
      subcategory: claim.payer_id,
      content: `${claim.payer_name} resolved claim in ${claim.days_to_resolution} days. Outcome: ${claim.outcome}. CPT: ${claim.cpt_codes.join(", ")}.`,
      source_claim_id: claim.claim_id,
      payer_id: claim.payer_id,
      company_id: claim.company_id,
      confidence: 0.7,
      learning_type: "payer_behavior",
    });
  }

  // Coding insight from denied + appealed + won
  if (claim.outcome === "denied" && claim.appeal_outcome === "won" && claim.modifiers.length > 0) {
    entries.push({
      category: "cpt_codes",
      subcategory: claim.cpt_codes[0] ?? null,
      content: `Coding insight: ${claim.payer_name} initially denied CPT ${claim.cpt_codes.join(", ")} but approved on appeal with modifiers ${claim.modifiers.join(", ")}. Include these modifiers to avoid denial.`,
      source_claim_id: claim.claim_id,
      payer_id: claim.payer_id,
      company_id: claim.company_id,
      confidence: 0.85,
      learning_type: "coding_insight",
    });
  }

  return entries;
}

// ── Confidence Decay ────────────────────────────────────────

/**
 * Apply time-based confidence decay to a learning entry.
 * Older patterns become less reliable as payer rules change.
 *
 * Half-life: 180 days (6 months).
 */
export function decayConfidence(
  originalConfidence: number,
  ageInDays: number,
  halfLifeDays: number = 180,
): number {
  const decayFactor = Math.pow(0.5, ageInDays / halfLifeDays);
  return Math.round(originalConfidence * decayFactor * 100) / 100;
}

// ── Pipeline ────────────────────────────────────────────────

/**
 * Run the feedback loop for a completed claim.
 * Extracts learnings, deduplicates, and writes to knowledge base.
 */
export async function runFeedbackLoop(
  claim: CompletedClaimLifecycle,
  deps: {
    dedupCheck?: DedupCheckFn;
    writeKnowledge: WriteKnowledgeFn;
  },
): Promise<FeedbackResult> {
  const learnings = extractLearnings(claim);
  let dedupSkipped = 0;

  for (const entry of learnings) {
    if (deps.dedupCheck) {
      const isDup = await deps.dedupCheck(entry.content, entry.category, entry.payer_id ?? undefined);
      if (isDup) {
        dedupSkipped++;
        continue;
      }
    }
    await deps.writeKnowledge(entry);
  }

  return {
    claim_id: claim.claim_id,
    learnings_extracted: learnings,
    dedup_skipped: dedupSkipped,
  };
}

/**
 * Run feedback loop for a batch of completed claims.
 */
export async function runBatchFeedback(
  claims: CompletedClaimLifecycle[],
  deps: {
    dedupCheck?: DedupCheckFn;
    writeKnowledge: WriteKnowledgeFn;
  },
): Promise<{
  results: FeedbackResult[];
  total_learnings: number;
  total_dedup_skipped: number;
  total_written: number;
}> {
  const results: FeedbackResult[] = [];
  let totalLearnings = 0;
  let totalDedupSkipped = 0;

  for (const claim of claims) {
    const result = await runFeedbackLoop(claim, deps);
    results.push(result);
    totalLearnings += result.learnings_extracted.length;
    totalDedupSkipped += result.dedup_skipped;
  }

  return {
    results,
    total_learnings: totalLearnings,
    total_dedup_skipped: totalDedupSkipped,
    total_written: totalLearnings - totalDedupSkipped,
  };
}
