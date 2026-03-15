/**
 * Claims Tracking Agent — ELLIE-741
 *
 * Monitors submitted claims, detects aging/stalled claims,
 * routes status changes, generates timely filing warnings,
 * and computes tracking metrics.
 *
 * Pure pipeline logic — payer polling and DB are injected.
 */

// ── Types ────────────────────────────────────────────────────

export type ClaimStatus =
  | "submitted"
  | "received"
  | "processing"
  | "approved"
  | "denied"
  | "pending_info"
  | "appealed"
  | "paid"
  | "closed";

export const VALID_CLAIM_STATUSES: ClaimStatus[] = [
  "submitted", "received", "processing", "approved",
  "denied", "pending_info", "appealed", "paid", "closed",
];

export const TERMINAL_STATUSES: ClaimStatus[] = ["approved", "denied", "paid", "closed"];

/** A tracked claim record. */
export interface TrackedClaim {
  claim_id: string;
  payer_id: string;
  payer_name: string;
  status: ClaimStatus;
  submitted_at: string;
  last_status_change: string;
  tracking_number: string | null;
  total_charge_cents: number;
  paid_amount_cents: number | null;
  denial_code: string | null;
  denial_reason: string | null;
  days_since_submission: number;
  company_id: string | null;
}

/** A status change detected by polling. */
export interface StatusChange {
  claim_id: string;
  previous_status: ClaimStatus;
  new_status: ClaimStatus;
  changed_at: string;
  details: string | null;
  denial_code: string | null;
}

/** Alert generated for stalled/denied claims. */
export interface ClaimAlert {
  claim_id: string;
  alert_type: "aging" | "denied" | "pending_info" | "timely_filing_warning";
  severity: "low" | "medium" | "high" | "critical";
  message: string;
  days_since_submission: number;
  payer_id: string;
}

/** Metrics for the tracking dashboard. */
export interface TrackingMetrics {
  total_tracked: number;
  by_status: Record<ClaimStatus, number>;
  average_days_to_payment: number | null;
  aging_over_45: number;
  aging_over_90: number;
  denial_rate_percent: number;
  total_submitted_cents: number;
  total_paid_cents: number;
}

/** Typed output for the tracking agent. */
export interface ClaimsTrackingOutcome {
  claims_polled: number;
  status_changes: StatusChange[];
  alerts_generated: ClaimAlert[];
  metrics: TrackingMetrics;
}

/** Default aging threshold in days. */
export const AGING_THRESHOLD_DAYS = 45;

/** Critical aging threshold. */
export const CRITICAL_AGING_DAYS = 90;

/** Days before timely filing deadline to warn. */
export const TIMELY_FILING_WARNING_DAYS = 30;

// ── Status Parsing ──────────────────────────────────────────

/**
 * Detect status changes between previous and current claim states.
 * Pure function.
 */
export function detectStatusChanges(
  previous: TrackedClaim[],
  current: TrackedClaim[],
): StatusChange[] {
  const prevMap = new Map(previous.map(c => [c.claim_id, c]));
  const changes: StatusChange[] = [];

  for (const curr of current) {
    const prev = prevMap.get(curr.claim_id);
    if (prev && prev.status !== curr.status) {
      changes.push({
        claim_id: curr.claim_id,
        previous_status: prev.status,
        new_status: curr.status,
        changed_at: curr.last_status_change,
        details: null,
        denial_code: curr.denial_code,
      });
    }
  }

  return changes;
}

// ── Aging Detection ─────────────────────────────────────────

/**
 * Identify aging claims that exceed the threshold.
 * Pure function.
 */
export function findAgingClaims(
  claims: TrackedClaim[],
  thresholdDays: number = AGING_THRESHOLD_DAYS,
): TrackedClaim[] {
  return claims.filter(
    c => !TERMINAL_STATUSES.includes(c.status) && c.days_since_submission > thresholdDays,
  );
}

// ── Alert Generation ────────────────────────────────────────

/**
 * Generate alerts from current claim state.
 * Pure function.
 */
export function generateAlerts(
  claims: TrackedClaim[],
  opts: {
    timelyFilingDays?: Map<string, number>;
  } = {},
): ClaimAlert[] {
  const alerts: ClaimAlert[] = [];

  for (const claim of claims) {
    // Aging alerts
    if (!TERMINAL_STATUSES.includes(claim.status)) {
      if (claim.days_since_submission > CRITICAL_AGING_DAYS) {
        alerts.push({
          claim_id: claim.claim_id,
          alert_type: "aging",
          severity: "critical",
          message: `Claim aging ${claim.days_since_submission} days (critical: >${CRITICAL_AGING_DAYS})`,
          days_since_submission: claim.days_since_submission,
          payer_id: claim.payer_id,
        });
      } else if (claim.days_since_submission > AGING_THRESHOLD_DAYS) {
        alerts.push({
          claim_id: claim.claim_id,
          alert_type: "aging",
          severity: "high",
          message: `Claim aging ${claim.days_since_submission} days (threshold: ${AGING_THRESHOLD_DAYS})`,
          days_since_submission: claim.days_since_submission,
          payer_id: claim.payer_id,
        });
      }
    }

    // Denial alerts
    if (claim.status === "denied") {
      alerts.push({
        claim_id: claim.claim_id,
        alert_type: "denied",
        severity: "high",
        message: `Claim denied${claim.denial_code ? ` (${claim.denial_code})` : ""}: ${claim.denial_reason ?? "No reason provided"}`,
        days_since_submission: claim.days_since_submission,
        payer_id: claim.payer_id,
      });
    }

    // Pending info alerts
    if (claim.status === "pending_info") {
      alerts.push({
        claim_id: claim.claim_id,
        alert_type: "pending_info",
        severity: "medium",
        message: "Payer requesting additional information",
        days_since_submission: claim.days_since_submission,
        payer_id: claim.payer_id,
      });
    }

    // Timely filing warning
    if (opts.timelyFilingDays && !TERMINAL_STATUSES.includes(claim.status)) {
      const filingDays = opts.timelyFilingDays.get(claim.payer_id);
      if (filingDays) {
        const daysRemaining = filingDays - claim.days_since_submission;
        if (daysRemaining > 0 && daysRemaining <= TIMELY_FILING_WARNING_DAYS) {
          alerts.push({
            claim_id: claim.claim_id,
            alert_type: "timely_filing_warning",
            severity: daysRemaining <= 7 ? "critical" : "high",
            message: `Timely filing deadline in ${daysRemaining} days (${filingDays}-day limit for ${claim.payer_name})`,
            days_since_submission: claim.days_since_submission,
            payer_id: claim.payer_id,
          });
        }
      }
    }
  }

  return alerts;
}

// ── Metrics ─────────────────────────────────────────────────

/**
 * Compute tracking metrics from claim data.
 * Pure function.
 */
export function computeMetrics(claims: TrackedClaim[]): TrackingMetrics {
  const byStatus: Record<ClaimStatus, number> = {} as any;
  for (const s of VALID_CLAIM_STATUSES) byStatus[s] = 0;
  for (const c of claims) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;

  const paidClaims = claims.filter(c => c.status === "paid" && c.paid_amount_cents !== null);
  const avgDays = paidClaims.length > 0
    ? Math.round(paidClaims.reduce((sum, c) => sum + c.days_since_submission, 0) / paidClaims.length)
    : null;

  const totalDenied = byStatus.denied ?? 0;
  const totalResolved = (byStatus.approved ?? 0) + totalDenied + (byStatus.paid ?? 0);
  const denialRate = totalResolved > 0 ? Math.round((totalDenied / totalResolved) * 100) : 0;

  return {
    total_tracked: claims.length,
    by_status: byStatus,
    average_days_to_payment: avgDays,
    aging_over_45: claims.filter(c => !TERMINAL_STATUSES.includes(c.status) && c.days_since_submission > 45).length,
    aging_over_90: claims.filter(c => !TERMINAL_STATUSES.includes(c.status) && c.days_since_submission > 90).length,
    denial_rate_percent: denialRate,
    total_submitted_cents: claims.reduce((s, c) => s + c.total_charge_cents, 0),
    total_paid_cents: claims.reduce((s, c) => s + (c.paid_amount_cents ?? 0), 0),
  };
}

// ── RAG Queries ─────────────────────────────────────────────

/**
 * Build RAG queries for claims tracking context.
 * Pure function.
 */
export function buildTrackingRAGQueries(
  claim: TrackedClaim,
): { query: string; categories: string[] }[] {
  const queries: { query: string; categories: string[] }[] = [];

  queries.push({
    query: `${claim.payer_name} expected claim processing timeline and response time`,
    categories: ["payer_rules"],
  });

  queries.push({
    query: `${claim.payer_name} timely filing deadline`,
    categories: ["payer_rules"],
  });

  if (claim.status === "denied" && claim.denial_code) {
    queries.push({
      query: `Denial code ${claim.denial_code} ${claim.denial_reason ?? ""} resolution steps`,
      categories: ["denial_reasons"],
    });
  }

  return queries;
}

// ── Routing ─────────────────────────────────────────────────

/** Route destination for a status change. */
export type RouteDestination = "denial_handler" | "payment_posting" | "info_request_handler" | "appeal_handler" | "no_action";

/**
 * Determine where to route a status change.
 * Pure function.
 */
export function routeStatusChange(change: StatusChange): RouteDestination {
  switch (change.new_status) {
    case "denied": return "denial_handler";
    case "approved":
    case "paid": return "payment_posting";
    case "pending_info": return "info_request_handler";
    case "appealed": return "appeal_handler";
    default: return "no_action";
  }
}

// ── Pipeline Orchestration ──────────────────────────────────

/**
 * Run the full tracking pipeline on a batch of claims.
 * Pure function — caller provides current and previous state.
 */
export function runTrackingPipeline(
  previousClaims: TrackedClaim[],
  currentClaims: TrackedClaim[],
  opts: { timelyFilingDays?: Map<string, number> } = {},
): ClaimsTrackingOutcome {
  const statusChanges = detectStatusChanges(previousClaims, currentClaims);
  const alerts = generateAlerts(currentClaims, opts);
  const metrics = computeMetrics(currentClaims);

  return {
    claims_polled: currentClaims.length,
    status_changes: statusChanges,
    alerts_generated: alerts,
    metrics,
  };
}
