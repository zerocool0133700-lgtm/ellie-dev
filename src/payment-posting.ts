/**
 * Payment Posting Agent — ELLIE-744
 *
 * Reconciles payments against expected amounts. Parses remittance
 * data, matches to claims, detects underpayments, classifies
 * adjustments, generates accounting entries.
 *
 * Pure pipeline logic — no side effects.
 */

// ── Types ────────────────────────────────────────────────────

export type AdjustmentType = "contractual" | "non_contractual" | "patient_responsibility" | "other";
export type MatchStatus = "matched" | "unmatched" | "partial";

export const VALID_ADJUSTMENT_TYPES: AdjustmentType[] = [
  "contractual", "non_contractual", "patient_responsibility", "other",
];

/** A payment line from remittance (ERA/835). */
export interface RemittanceLine {
  claim_id: string;
  patient_name: string | null;
  cpt_code: string;
  billed_cents: number;
  allowed_cents: number;
  paid_cents: number;
  adjustments: AdjustmentEntry[];
  patient_responsibility_cents: number;
}

export interface AdjustmentEntry {
  group_code: string;   // CO, PR, OA, PI, CR
  reason_code: string;  // e.g., "45" for contractual
  amount_cents: number;
}

/** A submitted claim for matching. */
export interface SubmittedClaim {
  claim_id: string;
  patient_name: string;
  total_charge_cents: number;
  expected_reimbursement_cents: number | null;
  line_items: { cpt_code: string; charge_cents: number }[];
}

/** Result of matching a payment to a claim. */
export interface PaymentMatch {
  claim_id: string;
  match_status: MatchStatus;
  billed_cents: number;
  allowed_cents: number;
  paid_cents: number;
  expected_cents: number | null;
  variance_cents: number | null;
  is_underpaid: boolean;
  patient_responsibility_cents: number;
  adjustments_classified: ClassifiedAdjustment[];
}

export interface ClassifiedAdjustment {
  group_code: string;
  reason_code: string;
  amount_cents: number;
  type: AdjustmentType;
  description: string;
}

/** An accounting journal entry. */
export interface JournalEntry {
  claim_id: string;
  debit_account: string;
  credit_account: string;
  amount_cents: number;
  description: string;
}

/** Underpayment alert. */
export interface UnderpaymentAlert {
  claim_id: string;
  expected_cents: number;
  paid_cents: number;
  variance_cents: number;
  variance_percent: number;
  payer_id: string | null;
}

/** Reconciliation summary. */
export interface ReconciliationSummary {
  total_remittance_lines: number;
  matched: number;
  unmatched: number;
  total_billed_cents: number;
  total_allowed_cents: number;
  total_paid_cents: number;
  total_adjustments_cents: number;
  total_patient_responsibility_cents: number;
  underpayment_count: number;
  underpayment_total_cents: number;
}

/** Typed outcome from the payment posting agent. */
export interface PaymentPostingOutcome {
  matches: PaymentMatch[];
  journal_entries: JournalEntry[];
  underpayment_alerts: UnderpaymentAlert[];
  reconciliation: ReconciliationSummary;
  rag_queries_used: string[];
}

// ── Adjustment Classification ───────────────────────────────

/** Known contractual adjustment reason codes. */
const CONTRACTUAL_REASON_CODES = new Set([
  "45", "42", "59", "253", // Common contractual obligation codes
]);

/** Patient responsibility group code. */
const PATIENT_RESPONSIBILITY_GROUP = "PR";

/**
 * Classify an adjustment entry.
 * Pure function.
 */
export function classifyAdjustment(adj: AdjustmentEntry): ClassifiedAdjustment {
  let type: AdjustmentType;
  let description: string;

  if (adj.group_code === PATIENT_RESPONSIBILITY_GROUP) {
    type = "patient_responsibility";
    description = describePatientResponsibility(adj.reason_code);
  } else if (adj.group_code === "CO" && CONTRACTUAL_REASON_CODES.has(adj.reason_code)) {
    type = "contractual";
    description = `Contractual obligation (${adj.reason_code})`;
  } else if (adj.group_code === "CO") {
    type = "non_contractual";
    description = `Non-contractual adjustment CO-${adj.reason_code}`;
  } else if (adj.group_code === "OA") {
    type = "other";
    description = `Other adjustment OA-${adj.reason_code}`;
  } else {
    type = "other";
    description = `${adj.group_code}-${adj.reason_code}`;
  }

  return { ...adj, type, description };
}

function describePatientResponsibility(reasonCode: string): string {
  const descriptions: Record<string, string> = {
    "1": "Deductible",
    "2": "Coinsurance",
    "3": "Copayment",
  };
  return descriptions[reasonCode] ?? `Patient responsibility (${reasonCode})`;
}

// ── Payment Matching ────────────────────────────────────────

/**
 * Match remittance lines to submitted claims.
 * Pure function.
 */
export function matchPayments(
  remittanceLines: RemittanceLine[],
  submittedClaims: SubmittedClaim[],
): PaymentMatch[] {
  const claimMap = new Map(submittedClaims.map(c => [c.claim_id, c]));

  return remittanceLines.map(line => {
    const claim = claimMap.get(line.claim_id);
    const adjustments = line.adjustments.map(classifyAdjustment);

    if (!claim) {
      return {
        claim_id: line.claim_id,
        match_status: "unmatched" as MatchStatus,
        billed_cents: line.billed_cents,
        allowed_cents: line.allowed_cents,
        paid_cents: line.paid_cents,
        expected_cents: null,
        variance_cents: null,
        is_underpaid: false,
        patient_responsibility_cents: line.patient_responsibility_cents,
        adjustments_classified: adjustments,
      };
    }

    const expected = claim.expected_reimbursement_cents;
    const variance = expected !== null ? line.paid_cents - expected : null;
    const isUnderpaid = variance !== null && variance < 0;

    return {
      claim_id: line.claim_id,
      match_status: "matched" as MatchStatus,
      billed_cents: line.billed_cents,
      allowed_cents: line.allowed_cents,
      paid_cents: line.paid_cents,
      expected_cents: expected,
      variance_cents: variance,
      is_underpaid: isUnderpaid,
      patient_responsibility_cents: line.patient_responsibility_cents,
      adjustments_classified: adjustments,
    };
  });
}

// ── Journal Entries ─────────────────────────────────────────

/**
 * Generate accounting journal entries from payment matches.
 * Pure function.
 */
export function generateJournalEntries(matches: PaymentMatch[]): JournalEntry[] {
  const entries: JournalEntry[] = [];

  for (const m of matches) {
    if (m.match_status === "unmatched") continue;

    // Cash received
    if (m.paid_cents > 0) {
      entries.push({
        claim_id: m.claim_id,
        debit_account: "Cash",
        credit_account: "Accounts Receivable",
        amount_cents: m.paid_cents,
        description: `Payment received for claim ${m.claim_id}`,
      });
    }

    // Contractual adjustments
    const contractualTotal = m.adjustments_classified
      .filter(a => a.type === "contractual")
      .reduce((sum, a) => sum + a.amount_cents, 0);
    if (contractualTotal > 0) {
      entries.push({
        claim_id: m.claim_id,
        debit_account: "Contractual Adjustments",
        credit_account: "Accounts Receivable",
        amount_cents: contractualTotal,
        description: `Contractual adjustment for claim ${m.claim_id}`,
      });
    }

    // Patient responsibility
    if (m.patient_responsibility_cents > 0) {
      entries.push({
        claim_id: m.claim_id,
        debit_account: "Patient Accounts Receivable",
        credit_account: "Accounts Receivable",
        amount_cents: m.patient_responsibility_cents,
        description: `Patient responsibility for claim ${m.claim_id}`,
      });
    }
  }

  return entries;
}

// ── Underpayment Detection ──────────────────────────────────

/**
 * Detect underpayments from matched payments.
 * Pure function.
 */
export function detectUnderpayments(
  matches: PaymentMatch[],
  payerId?: string,
): UnderpaymentAlert[] {
  return matches
    .filter(m => m.is_underpaid && m.variance_cents !== null && m.expected_cents !== null)
    .map(m => ({
      claim_id: m.claim_id,
      expected_cents: m.expected_cents!,
      paid_cents: m.paid_cents,
      variance_cents: Math.abs(m.variance_cents!),
      variance_percent: Math.round(Math.abs(m.variance_cents!) / m.expected_cents! * 100),
      payer_id: payerId ?? null,
    }));
}

// ── Reconciliation ──────────────────────────────────────────

/**
 * Compute reconciliation summary.
 * Pure function.
 */
export function computeReconciliation(matches: PaymentMatch[]): ReconciliationSummary {
  const underpayments = matches.filter(m => m.is_underpaid);

  return {
    total_remittance_lines: matches.length,
    matched: matches.filter(m => m.match_status === "matched").length,
    unmatched: matches.filter(m => m.match_status === "unmatched").length,
    total_billed_cents: matches.reduce((s, m) => s + m.billed_cents, 0),
    total_allowed_cents: matches.reduce((s, m) => s + m.allowed_cents, 0),
    total_paid_cents: matches.reduce((s, m) => s + m.paid_cents, 0),
    total_adjustments_cents: matches.reduce(
      (s, m) => s + m.adjustments_classified.reduce((a, adj) => a + adj.amount_cents, 0), 0,
    ),
    total_patient_responsibility_cents: matches.reduce((s, m) => s + m.patient_responsibility_cents, 0),
    underpayment_count: underpayments.length,
    underpayment_total_cents: underpayments.reduce((s, m) => s + Math.abs(m.variance_cents ?? 0), 0),
  };
}

// ── RAG Queries ─────────────────────────────────────────────

/**
 * Build RAG queries for payment posting context.
 */
export function buildPaymentRAGQueries(
  payerName: string,
): { query: string; categories: string[] }[] {
  return [
    { query: `${payerName} ERA 835 remittance parsing rules format`, categories: ["payer_rules"] },
    { query: `${payerName} fee schedule allowed amounts`, categories: ["fee_schedules"] },
    { query: `Contractual adjustment reason codes CO-45 CO-42 meanings`, categories: ["denial_reasons", "payer_rules"] },
  ];
}

// ── Full Pipeline ───────────────────────────────────────────

/**
 * Run the full payment posting pipeline.
 * Pure function.
 */
export function runPaymentPostingPipeline(
  remittanceLines: RemittanceLine[],
  submittedClaims: SubmittedClaim[],
  payerName: string,
  payerId?: string,
): PaymentPostingOutcome {
  const matches = matchPayments(remittanceLines, submittedClaims);
  const journalEntries = generateJournalEntries(matches);
  const underpaymentAlerts = detectUnderpayments(matches, payerId);
  const reconciliation = computeReconciliation(matches);
  const ragQueries = buildPaymentRAGQueries(payerName);

  return {
    matches,
    journal_entries: journalEntries,
    underpayment_alerts: underpaymentAlerts,
    reconciliation,
    rag_queries_used: ragQueries.map(q => q.query),
  };
}
