/**
 * Appeals Agent — ELLIE-743
 *
 * Drafts appeal letters grounded in successful templates and
 * regulations. Compiles evidence, generates documentation checklist,
 * supports approval gate before submission.
 *
 * Pure pipeline logic — no side effects.
 */

// ── Types ────────────────────────────────────────────────────

export type AppealLevel = "first" | "second" | "external_review";
export type AppealStatus = "drafting" | "pending_review" | "submitted" | "approved" | "denied" | "withdrawn";

export const VALID_APPEAL_LEVELS: AppealLevel[] = ["first", "second", "external_review"];
export const VALID_APPEAL_STATUSES: AppealStatus[] = ["drafting", "pending_review", "submitted", "approved", "denied", "withdrawn"];

/** Input from the Denial Management agent (ELLIE-742). */
export interface AppealInput {
  claim_id: string;
  payer_id: string;
  payer_name: string;
  denial_code: string;
  denial_reason: string | null;
  denial_category: string;
  total_charge_cents: number;
  cpt_codes: string[];
  diagnosis_codes: string[];
  patient_name: string;
  provider_name: string;
  encounter_date: string;
  appeal_level: AppealLevel;
  company_id: string | null;
}

/** A documentation item in the appeal checklist. */
export interface ChecklistItem {
  label: string;
  category: "clinical" | "regulatory" | "billing" | "correspondence";
  required: boolean;
  obtained: boolean;
}

/** A generated appeal letter. */
export interface AppealLetter {
  subject: string;
  body: string;
  sections: AppealLetterSection[];
  word_count: number;
}

export interface AppealLetterSection {
  heading: string;
  content: string;
}

/** Complete appeal package ready for review. */
export interface AppealPackage {
  claim_id: string;
  appeal_level: AppealLevel;
  letter: AppealLetter;
  checklist: ChecklistItem[];
  checklist_complete: boolean;
  estimated_cost_cents: number;
  requires_approval: boolean;
}

/** Typed outcome from the appeals agent. */
export interface AppealOutcome {
  claim_id: string;
  appeal_level: AppealLevel;
  status: AppealStatus;
  letter_word_count: number;
  checklist_items: number;
  checklist_complete: boolean;
  estimated_cost_cents: number;
  estimated_recovery_cents: number;
  requires_approval: boolean;
  rag_queries_used: string[];
}

// ── Documentation Checklist ─────────────────────────────────

/**
 * Generate a documentation checklist based on denial category.
 * Pure function.
 */
export function generateChecklist(
  denialCategory: string,
  appealLevel: AppealLevel,
): ChecklistItem[] {
  const items: ChecklistItem[] = [
    { label: "Original claim copy", category: "billing", required: true, obtained: false },
    { label: "Denial notice / EOB", category: "correspondence", required: true, obtained: false },
    { label: "Provider cover letter", category: "correspondence", required: true, obtained: false },
  ];

  if (denialCategory === "medical_necessity" || denialCategory === "coverage_issue") {
    items.push(
      { label: "Letter of medical necessity", category: "clinical", required: true, obtained: false },
      { label: "Clinical notes from encounter", category: "clinical", required: true, obtained: false },
      { label: "Peer-reviewed literature supporting treatment", category: "clinical", required: false, obtained: false },
    );
  }

  if (denialCategory === "authorization") {
    items.push(
      { label: "Retroactive authorization request", category: "billing", required: true, obtained: false },
      { label: "Emergency documentation (if applicable)", category: "clinical", required: false, obtained: false },
    );
  }

  if (denialCategory === "timely_filing") {
    items.push(
      { label: "Proof of original submission date", category: "billing", required: true, obtained: false },
      { label: "Tracking/confirmation numbers", category: "billing", required: true, obtained: false },
    );
  }

  if (denialCategory === "code_issue") {
    items.push(
      { label: "Corrected coding documentation", category: "billing", required: true, obtained: false },
      { label: "Operative/procedure report", category: "clinical", required: true, obtained: false },
    );
  }

  if (appealLevel === "second" || appealLevel === "external_review") {
    items.push(
      { label: "First-level appeal denial letter", category: "correspondence", required: true, obtained: false },
      { label: "Additional supporting evidence", category: "clinical", required: false, obtained: false },
    );
  }

  if (appealLevel === "external_review") {
    items.push(
      { label: "External review request form", category: "regulatory", required: true, obtained: false },
      { label: "State regulatory filing (if applicable)", category: "regulatory", required: false, obtained: false },
    );
  }

  return items;
}

// ── Appeal Letter Generation ────────────────────────────────

/**
 * Generate an appeal letter structure from input data.
 * Pure function — produces the letter framework.
 * In production, an LLM would refine the prose using RAG context.
 */
export function generateAppealLetter(input: AppealInput): AppealLetter {
  const sections: AppealLetterSection[] = [];

  // Opening
  sections.push({
    heading: "Purpose of Appeal",
    content: `This letter constitutes a formal ${input.appeal_level}-level appeal of the denial of claim ${input.claim_id}, denied under code ${input.denial_code}${input.denial_reason ? ` ("${input.denial_reason}")` : ""}. We respectfully request reconsideration of this decision.`,
  });

  // Patient and claim details
  sections.push({
    heading: "Claim Details",
    content: [
      `Patient: ${input.patient_name}`,
      `Date of Service: ${input.encounter_date}`,
      `Provider: ${input.provider_name}`,
      `Payer: ${input.payer_name}`,
      `CPT Codes: ${input.cpt_codes.join(", ")}`,
      `Diagnosis Codes: ${input.diagnosis_codes.join(", ")}`,
      `Denied Amount: $${(input.total_charge_cents / 100).toFixed(2)}`,
    ].join("\n"),
  });

  // Clinical justification
  if (input.denial_category === "medical_necessity" || input.denial_category === "coverage_issue") {
    sections.push({
      heading: "Clinical Justification",
      content: `The procedures performed (${input.cpt_codes.join(", ")}) were medically necessary for the treatment of ${input.diagnosis_codes.join(", ")}. Clinical documentation supporting this determination is enclosed. [RAG: Insert relevant clinical evidence and peer-reviewed literature here.]`,
    });
  }

  // Regulatory basis
  sections.push({
    heading: "Regulatory Basis",
    content: `[RAG: Insert applicable state and federal regulations supporting this appeal. Include payer contract terms and CMS guidelines as relevant.]`,
  });

  // Prior successful appeals
  sections.push({
    heading: "Supporting Precedent",
    content: `[RAG: Insert references to successful appeals for similar denial codes with this payer.]`,
  });

  // Closing
  sections.push({
    heading: "Requested Action",
    content: `We respectfully request that ${input.payer_name} reverse the denial of claim ${input.claim_id} and process the claim for payment of $${(input.total_charge_cents / 100).toFixed(2)}. Supporting documentation is enclosed as indicated in the attached checklist.`,
  });

  const body = sections.map(s => `## ${s.heading}\n\n${s.content}`).join("\n\n");
  const subject = `Appeal: Claim ${input.claim_id} - Denial Code ${input.denial_code} - ${input.patient_name}`;

  return {
    subject,
    body,
    sections,
    word_count: body.split(/\s+/).length,
  };
}

// ── RAG Queries ─────────────────────────────────────────────

/**
 * Build RAG queries for appeal context.
 */
export function buildAppealRAGQueries(
  input: AppealInput,
): { query: string; categories: string[] }[] {
  const queries: { query: string; categories: string[] }[] = [];

  queries.push({
    query: `Successful appeal template for ${input.payer_name} denial code ${input.denial_code}`,
    categories: ["appeal_templates"],
  });

  queries.push({
    query: `State and federal regulations supporting appeal for ${input.denial_category} denial`,
    categories: ["compliance"],
  });

  if (input.denial_category === "medical_necessity") {
    queries.push({
      query: `Medical necessity documentation requirements for ${input.cpt_codes.join(" ")} ${input.diagnosis_codes.join(" ")}`,
      categories: ["payer_rules", "compliance"],
    });
  }

  queries.push({
    query: `${input.payer_name} appeal submission requirements deadlines format`,
    categories: ["payer_rules"],
  });

  return queries;
}

// ── Cost Estimation ─────────────────────────────────────────

/**
 * Estimate the cost of preparing and submitting an appeal.
 * Based on appeal level and complexity.
 */
export function estimateAppealCost(
  appealLevel: AppealLevel,
  totalChargeCents: number,
): number {
  const baseCosts: Record<AppealLevel, number> = {
    first: 5000,        // $50 base
    second: 10000,      // $100 base
    external_review: 25000,  // $250 base
  };

  return baseCosts[appealLevel] ?? 5000;
}

/**
 * Determine if an appeal is cost-effective.
 * Appeal cost should be < 20% of claim value (per performance target).
 */
export function isAppealCostEffective(
  appealCostCents: number,
  claimValueCents: number,
  maxCostPercent: number = 20,
): boolean {
  if (claimValueCents === 0) return false;
  const costPercent = (appealCostCents / claimValueCents) * 100;
  return costPercent < maxCostPercent;
}

// ── Full Pipeline ───────────────────────────────────────────

/**
 * Build a complete appeal package from input.
 * Pure function.
 */
export function buildAppealPackage(input: AppealInput): AppealPackage {
  const letter = generateAppealLetter(input);
  const checklist = generateChecklist(input.denial_category, input.appeal_level);
  const cost = estimateAppealCost(input.appeal_level, input.total_charge_cents);

  return {
    claim_id: input.claim_id,
    appeal_level: input.appeal_level,
    letter,
    checklist,
    checklist_complete: checklist.filter(i => i.required).every(i => i.obtained),
    estimated_cost_cents: cost,
    requires_approval: true, // Always require human approval for appeals
  };
}

/**
 * Build a typed AppealOutcome from a package.
 */
export function buildAppealOutcome(
  pkg: AppealPackage,
  input: AppealInput,
): AppealOutcome {
  const ragQueries = buildAppealRAGQueries(input);

  return {
    claim_id: pkg.claim_id,
    appeal_level: pkg.appeal_level,
    status: "pending_review",
    letter_word_count: pkg.letter.word_count,
    checklist_items: pkg.checklist.length,
    checklist_complete: pkg.checklist_complete,
    estimated_cost_cents: pkg.estimated_cost_cents,
    estimated_recovery_cents: Math.round(input.total_charge_cents * 0.6),
    requires_approval: pkg.requires_approval,
    rag_queries_used: ragQueries.map(q => q.query),
  };
}
