/**
 * Denial Management Agent — ELLIE-742
 *
 * Analyzes denied claims, classifies denial type, recommends
 * resolution paths (resubmit/appeal/adjust/write-off), and
 * routes to the appropriate downstream agent.
 *
 * Pure pipeline logic — all functions are testable without DB.
 */

// ── Types ────────────────────────────────────────────────────

export type DenialCategory =
  | "billing_error"
  | "missing_documentation"
  | "coverage_issue"
  | "code_issue"
  | "medical_necessity"
  | "duplicate_claim"
  | "timely_filing"
  | "authorization"
  | "unknown";

export const VALID_DENIAL_CATEGORIES: DenialCategory[] = [
  "billing_error", "missing_documentation", "coverage_issue",
  "code_issue", "medical_necessity", "duplicate_claim",
  "timely_filing", "authorization", "unknown",
];

export type RecommendedAction = "resubmit" | "appeal" | "adjust" | "write_off" | "request_documentation";

export type RouteTarget = "claim_submission" | "appeals" | "manual_review" | "write_off";

/** A denied claim for analysis. */
export interface DeniedClaim {
  claim_id: string;
  payer_id: string;
  payer_name: string;
  denial_code: string;
  denial_reason: string | null;
  total_charge_cents: number;
  cpt_codes: string[];
  diagnosis_codes: string[];
  submitted_at: string;
  denied_at: string;
  company_id: string | null;
}

/** Classification result for a denial. */
export interface DenialClassification {
  category: DenialCategory;
  confidence: number;
  reasoning: string;
  is_avoidable: boolean;
}

/** Full recommendation for how to handle a denial. */
export interface DenialRecommendation {
  action: RecommendedAction;
  route_to: RouteTarget;
  confidence: number;
  reasoning: string;
  evidence_needed: string[];
  correction_details: string | null;
  estimated_recovery_cents: number | null;
}

/** Typed output from the denial management agent. */
export interface DenialManagementOutcome {
  claim_id: string;
  denial_code: string;
  classification: DenialClassification;
  recommendation: DenialRecommendation;
  rag_queries_used: string[];
}

// ── Denial Code Classification ──────────────────────────────

/**
 * Known denial code prefixes and their typical categories.
 * Used as a first-pass heuristic before RAG refinement.
 */
const DENIAL_CODE_PATTERNS: { pattern: RegExp; category: DenialCategory; avoidable: boolean }[] = [
  { pattern: /^CO-18$/, category: "duplicate_claim", avoidable: true },
  { pattern: /^CO-(?:4|11|15|16|252)$/, category: "billing_error", avoidable: true },
  { pattern: /^CO-(?:29|119|167)$/, category: "timely_filing", avoidable: true },
  { pattern: /^CO-(?:50|96|97|150|151)$/, category: "coverage_issue", avoidable: false },
  { pattern: /^CO-(?:5|6|9|10)$/, category: "code_issue", avoidable: true },
  { pattern: /^CO-(?:55|56|57|58)$/, category: "medical_necessity", avoidable: false },
  { pattern: /^PR-(?:1|2|3)$/, category: "coverage_issue", avoidable: false },
  { pattern: /^CO-(?:197|198)$/, category: "authorization", avoidable: true },
  { pattern: /^OA-/, category: "billing_error", avoidable: true },
  { pattern: /^PI-/, category: "coverage_issue", avoidable: false },
];

/**
 * Classify a denial based on its code and reason.
 * Pure heuristic — can be refined by RAG-retrieved playbooks.
 */
export function classifyDenial(
  denialCode: string,
  denialReason: string | null,
): DenialClassification {
  // Try code pattern match first
  for (const { pattern, category, avoidable } of DENIAL_CODE_PATTERNS) {
    if (pattern.test(denialCode)) {
      return {
        category,
        confidence: 0.8,
        reasoning: `Denial code ${denialCode} matches known pattern for ${category}`,
        is_avoidable: avoidable,
      };
    }
  }

  // Fall back to reason text analysis
  if (denialReason) {
    const lower = denialReason.toLowerCase();
    if (lower.includes("missing") || lower.includes("documentation") || lower.includes("records")) {
      return { category: "missing_documentation", confidence: 0.6, reasoning: `Denial reason mentions missing documentation: "${denialReason}"`, is_avoidable: true };
    }
    if (lower.includes("duplicate")) {
      return { category: "duplicate_claim", confidence: 0.7, reasoning: `Denial reason indicates duplicate: "${denialReason}"`, is_avoidable: true };
    }
    if (lower.includes("authorization") || lower.includes("prior auth")) {
      return { category: "authorization", confidence: 0.7, reasoning: `Denial reason mentions authorization: "${denialReason}"`, is_avoidable: true };
    }
    if (lower.includes("medical necessity") || lower.includes("not medically necessary")) {
      return { category: "medical_necessity", confidence: 0.7, reasoning: `Denial reason mentions medical necessity: "${denialReason}"`, is_avoidable: false };
    }
    if (lower.includes("coverage") || lower.includes("not covered") || lower.includes("benefit")) {
      return { category: "coverage_issue", confidence: 0.6, reasoning: `Denial reason mentions coverage: "${denialReason}"`, is_avoidable: false };
    }
    if (lower.includes("timely") || lower.includes("filing limit") || lower.includes("too late")) {
      return { category: "timely_filing", confidence: 0.7, reasoning: `Denial reason mentions timely filing: "${denialReason}"`, is_avoidable: true };
    }
  }

  return {
    category: "unknown",
    confidence: 0.3,
    reasoning: `Could not classify denial code ${denialCode}. Manual review recommended.`,
    is_avoidable: false,
  };
}

// ── Recommendation Engine ───────────────────────────────────

/**
 * Generate a recommendation based on denial classification.
 * Pure function.
 */
export function recommendAction(
  classification: DenialClassification,
  claim: DeniedClaim,
): DenialRecommendation {
  switch (classification.category) {
    case "billing_error":
      return {
        action: "resubmit",
        route_to: "claim_submission",
        confidence: classification.confidence,
        reasoning: "Billing error can be corrected and resubmitted",
        evidence_needed: ["Corrected claim form"],
        correction_details: `Fix billing error indicated by ${claim.denial_code}`,
        estimated_recovery_cents: claim.total_charge_cents,
      };

    case "code_issue":
      return {
        action: "resubmit",
        route_to: "claim_submission",
        confidence: classification.confidence,
        reasoning: "Code issue can be corrected with proper CPT/ICD mapping",
        evidence_needed: ["Updated procedure/diagnosis codes", "Coding documentation"],
        correction_details: `Review and correct coding for ${claim.cpt_codes.join(", ")}`,
        estimated_recovery_cents: claim.total_charge_cents,
      };

    case "missing_documentation":
      return {
        action: "request_documentation",
        route_to: "manual_review",
        confidence: classification.confidence,
        reasoning: "Missing documentation needs to be obtained before resubmission",
        evidence_needed: ["Clinical documentation from EHR", "Supporting medical records"],
        correction_details: null,
        estimated_recovery_cents: Math.round(claim.total_charge_cents * 0.8),
      };

    case "medical_necessity":
    case "coverage_issue":
      return {
        action: "appeal",
        route_to: "appeals",
        confidence: classification.confidence,
        reasoning: `${classification.category === "medical_necessity" ? "Medical necessity" : "Coverage"} denial requires formal appeal with clinical evidence`,
        evidence_needed: ["Letter of medical necessity", "Clinical documentation", "Peer-reviewed literature"],
        correction_details: null,
        estimated_recovery_cents: Math.round(claim.total_charge_cents * 0.6),
      };

    case "authorization":
      return {
        action: "appeal",
        route_to: "appeals",
        confidence: classification.confidence,
        reasoning: "Authorization denial may be appealed with retroactive auth or proof of emergent care",
        evidence_needed: ["Retroactive authorization request", "Emergency documentation if applicable"],
        correction_details: null,
        estimated_recovery_cents: Math.round(claim.total_charge_cents * 0.5),
      };

    case "duplicate_claim":
      return {
        action: "adjust",
        route_to: "manual_review",
        confidence: classification.confidence,
        reasoning: "Duplicate claim — verify original was processed correctly",
        evidence_needed: ["Original claim reference number"],
        correction_details: "Verify original claim status; if unpaid, resubmit as corrected",
        estimated_recovery_cents: 0,
      };

    case "timely_filing":
      return {
        action: "appeal",
        route_to: "appeals",
        confidence: classification.confidence,
        reasoning: "Timely filing denial — appeal with proof of original submission or exception",
        evidence_needed: ["Original submission confirmation", "Proof of timely filing"],
        correction_details: null,
        estimated_recovery_cents: Math.round(claim.total_charge_cents * 0.4),
      };

    default:
      return {
        action: "write_off",
        route_to: "manual_review",
        confidence: 0.3,
        reasoning: "Unable to classify denial. Recommend manual review.",
        evidence_needed: [],
        correction_details: null,
        estimated_recovery_cents: 0,
      };
  }
}

// ── RAG Queries ─────────────────────────────────────────────

/**
 * Build RAG queries for denial analysis context.
 */
export function buildDenialRAGQueries(
  claim: DeniedClaim,
): { query: string; categories: string[] }[] {
  const queries: { query: string; categories: string[] }[] = [];

  queries.push({
    query: `Denial code ${claim.denial_code} meaning resolution steps playbook`,
    categories: ["denial_reasons"],
  });

  queries.push({
    query: `${claim.payer_name} denial ${claim.denial_code} appeal requirements`,
    categories: ["payer_rules", "appeal_templates"],
  });

  if (claim.cpt_codes.length > 0) {
    queries.push({
      query: `Coding requirements for CPT ${claim.cpt_codes.join(" ")} common denial causes`,
      categories: ["cpt_codes", "payer_rules"],
    });
  }

  return queries;
}

// ── Full Pipeline ───────────────────────────────────────────

/**
 * Run the full denial management pipeline on a denied claim.
 * Pure function.
 */
export function analyzeDenial(claim: DeniedClaim): DenialManagementOutcome {
  const classification = classifyDenial(claim.denial_code, claim.denial_reason);
  const recommendation = recommendAction(classification, claim);
  const ragQueries = buildDenialRAGQueries(claim);

  return {
    claim_id: claim.claim_id,
    denial_code: claim.denial_code,
    classification,
    recommendation,
    rag_queries_used: ragQueries.map(q => q.query),
  };
}

/**
 * Analyze a batch of denied claims and summarize.
 */
export function analyzeDenialBatch(claims: DeniedClaim[]): {
  outcomes: DenialManagementOutcome[];
  summary: {
    total: number;
    by_category: Record<DenialCategory, number>;
    by_action: Record<RecommendedAction, number>;
    avoidable_count: number;
    total_estimated_recovery_cents: number;
  };
} {
  const outcomes = claims.map(analyzeDenial);

  const byCategory: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  let avoidable = 0;
  let recovery = 0;

  for (const o of outcomes) {
    byCategory[o.classification.category] = (byCategory[o.classification.category] ?? 0) + 1;
    byAction[o.recommendation.action] = (byAction[o.recommendation.action] ?? 0) + 1;
    if (o.classification.is_avoidable) avoidable++;
    recovery += o.recommendation.estimated_recovery_cents ?? 0;
  }

  return {
    outcomes,
    summary: {
      total: claims.length,
      by_category: byCategory as Record<DenialCategory, number>,
      by_action: byAction as Record<RecommendedAction, number>,
      avoidable_count: avoidable,
      total_estimated_recovery_cents: recovery,
    },
  };
}
