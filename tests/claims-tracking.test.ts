/**
 * Claims Tracking Agent Tests — ELLIE-741
 *
 * Tests for claim monitoring pipeline:
 * - Status change detection
 * - Aging claim identification
 * - Alert generation (aging, denied, pending_info, timely filing)
 * - Metrics computation
 * - RAG query building
 * - Status change routing
 * - Full pipeline orchestration
 * - E2E scenarios
 */

import { describe, test, expect } from "bun:test";
import {
  detectStatusChanges,
  findAgingClaims,
  generateAlerts,
  computeMetrics,
  buildTrackingRAGQueries,
  routeStatusChange,
  runTrackingPipeline,
  VALID_CLAIM_STATUSES,
  TERMINAL_STATUSES,
  AGING_THRESHOLD_DAYS,
  CRITICAL_AGING_DAYS,
  TIMELY_FILING_WARNING_DAYS,
  type TrackedClaim,
  type StatusChange,
  type ClaimAlert,
  type TrackingMetrics,
  type ClaimsTrackingOutcome,
} from "../src/claims-tracking.ts";

// ── Helpers ─────────────────────────────────────────────────

function makeClaim(overrides: Partial<TrackedClaim> = {}): TrackedClaim {
  return {
    claim_id: "CLM-001",
    payer_id: "aetna",
    payer_name: "Aetna",
    status: "submitted",
    submitted_at: "2026-01-15",
    last_status_change: "2026-01-15",
    tracking_number: "TRK-001",
    total_charge_cents: 15000,
    paid_amount_cents: null,
    denial_code: null,
    denial_reason: null,
    days_since_submission: 10,
    company_id: "comp-1",
    ...overrides,
  };
}

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("VALID_CLAIM_STATUSES has 9 statuses", () => {
    expect(VALID_CLAIM_STATUSES).toHaveLength(9);
  });

  test("TERMINAL_STATUSES includes approved, denied, paid, closed", () => {
    expect(TERMINAL_STATUSES).toContain("approved");
    expect(TERMINAL_STATUSES).toContain("denied");
    expect(TERMINAL_STATUSES).toContain("paid");
    expect(TERMINAL_STATUSES).toContain("closed");
    expect(TERMINAL_STATUSES).toHaveLength(4);
  });

  test("AGING_THRESHOLD_DAYS is 45", () => {
    expect(AGING_THRESHOLD_DAYS).toBe(45);
  });

  test("CRITICAL_AGING_DAYS is 90", () => {
    expect(CRITICAL_AGING_DAYS).toBe(90);
  });

  test("TIMELY_FILING_WARNING_DAYS is 30", () => {
    expect(TIMELY_FILING_WARNING_DAYS).toBe(30);
  });
});

// ── detectStatusChanges ─────────────────────────────────────

describe("detectStatusChanges", () => {
  test("detects status change", () => {
    const prev = [makeClaim({ status: "submitted" })];
    const curr = [makeClaim({ status: "received", last_status_change: "2026-01-20" })];
    const changes = detectStatusChanges(prev, curr);
    expect(changes).toHaveLength(1);
    expect(changes[0].previous_status).toBe("submitted");
    expect(changes[0].new_status).toBe("received");
  });

  test("no change when status unchanged", () => {
    const claims = [makeClaim({ status: "processing" })];
    expect(detectStatusChanges(claims, claims)).toHaveLength(0);
  });

  test("detects multiple changes", () => {
    const prev = [
      makeClaim({ claim_id: "A", status: "submitted" }),
      makeClaim({ claim_id: "B", status: "processing" }),
    ];
    const curr = [
      makeClaim({ claim_id: "A", status: "received" }),
      makeClaim({ claim_id: "B", status: "denied", denial_code: "CO-16" }),
    ];
    const changes = detectStatusChanges(prev, curr);
    expect(changes).toHaveLength(2);
    expect(changes[1].denial_code).toBe("CO-16");
  });

  test("ignores new claims not in previous", () => {
    const prev = [makeClaim({ claim_id: "A" })];
    const curr = [makeClaim({ claim_id: "A" }), makeClaim({ claim_id: "B" })];
    expect(detectStatusChanges(prev, curr)).toHaveLength(0);
  });

  test("handles empty arrays", () => {
    expect(detectStatusChanges([], [])).toHaveLength(0);
  });
});

// ── findAgingClaims ─────────────────────────────────────────

describe("findAgingClaims", () => {
  test("finds claims over threshold", () => {
    const claims = [
      makeClaim({ claim_id: "A", days_since_submission: 50, status: "processing" }),
      makeClaim({ claim_id: "B", days_since_submission: 30, status: "processing" }),
      makeClaim({ claim_id: "C", days_since_submission: 60, status: "submitted" }),
    ];
    const aging = findAgingClaims(claims);
    expect(aging).toHaveLength(2);
  });

  test("excludes terminal statuses", () => {
    const claims = [
      makeClaim({ days_since_submission: 100, status: "paid" }),
      makeClaim({ days_since_submission: 100, status: "denied" }),
      makeClaim({ days_since_submission: 50, status: "processing" }),
    ];
    expect(findAgingClaims(claims)).toHaveLength(1);
  });

  test("accepts custom threshold", () => {
    const claims = [makeClaim({ days_since_submission: 20, status: "processing" })];
    expect(findAgingClaims(claims, 10)).toHaveLength(1);
    expect(findAgingClaims(claims, 30)).toHaveLength(0);
  });
});

// ── generateAlerts ──────────────────────────────────────────

describe("generateAlerts", () => {
  test("generates aging alert for >45 day claim", () => {
    const claims = [makeClaim({ days_since_submission: 50, status: "processing" })];
    const alerts = generateAlerts(claims);
    const aging = alerts.filter(a => a.alert_type === "aging");
    expect(aging).toHaveLength(1);
    expect(aging[0].severity).toBe("high");
  });

  test("generates critical alert for >90 day claim", () => {
    const claims = [makeClaim({ days_since_submission: 100, status: "processing" })];
    const alerts = generateAlerts(claims);
    const critical = alerts.filter(a => a.severity === "critical");
    expect(critical).toHaveLength(1);
  });

  test("generates denial alert", () => {
    const claims = [makeClaim({ status: "denied", denial_code: "CO-16", denial_reason: "Missing info" })];
    const alerts = generateAlerts(claims);
    const denied = alerts.filter(a => a.alert_type === "denied");
    expect(denied).toHaveLength(1);
    expect(denied[0].message).toContain("CO-16");
    expect(denied[0].message).toContain("Missing info");
  });

  test("generates pending_info alert", () => {
    const claims = [makeClaim({ status: "pending_info" })];
    const alerts = generateAlerts(claims);
    expect(alerts.some(a => a.alert_type === "pending_info")).toBe(true);
  });

  test("generates timely filing warning", () => {
    const claims = [makeClaim({ payer_id: "aetna", days_since_submission: 75, status: "processing" })];
    const filingDays = new Map([["aetna", 90]]);
    const alerts = generateAlerts(claims, { timelyFilingDays: filingDays });
    const warnings = alerts.filter(a => a.alert_type === "timely_filing_warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("15 days");
  });

  test("timely filing warning is critical when <=7 days", () => {
    const claims = [makeClaim({ payer_id: "aetna", days_since_submission: 85, status: "processing" })];
    const filingDays = new Map([["aetna", 90]]);
    const alerts = generateAlerts(claims, { timelyFilingDays: filingDays });
    const warnings = alerts.filter(a => a.alert_type === "timely_filing_warning");
    expect(warnings[0].severity).toBe("critical");
  });

  test("no timely filing warning for terminal claims", () => {
    const claims = [makeClaim({ payer_id: "aetna", days_since_submission: 85, status: "paid" })];
    const filingDays = new Map([["aetna", 90]]);
    const alerts = generateAlerts(claims, { timelyFilingDays: filingDays });
    expect(alerts.filter(a => a.alert_type === "timely_filing_warning")).toHaveLength(0);
  });

  test("no alerts for healthy claims", () => {
    const claims = [makeClaim({ days_since_submission: 10, status: "processing" })];
    expect(generateAlerts(claims)).toHaveLength(0);
  });
});

// ── computeMetrics ──────────────────────────────────────────

describe("computeMetrics", () => {
  test("computes all metrics", () => {
    const claims = [
      makeClaim({ status: "submitted", days_since_submission: 10, total_charge_cents: 10000 }),
      makeClaim({ claim_id: "B", status: "paid", days_since_submission: 30, total_charge_cents: 20000, paid_amount_cents: 18000 }),
      makeClaim({ claim_id: "C", status: "denied", days_since_submission: 20, total_charge_cents: 15000 }),
      makeClaim({ claim_id: "D", status: "processing", days_since_submission: 50, total_charge_cents: 25000 }),
    ];
    const m = computeMetrics(claims);
    expect(m.total_tracked).toBe(4);
    expect(m.by_status.submitted).toBe(1);
    expect(m.by_status.paid).toBe(1);
    expect(m.by_status.denied).toBe(1);
    expect(m.average_days_to_payment).toBe(30);
    expect(m.aging_over_45).toBe(1);
    expect(m.denial_rate_percent).toBe(50); // 1 denied / 2 resolved
    expect(m.total_submitted_cents).toBe(70000);
    expect(m.total_paid_cents).toBe(18000);
  });

  test("handles empty claims", () => {
    const m = computeMetrics([]);
    expect(m.total_tracked).toBe(0);
    expect(m.average_days_to_payment).toBeNull();
    expect(m.denial_rate_percent).toBe(0);
  });

  test("counts aging over 45 and 90 correctly", () => {
    const claims = [
      makeClaim({ claim_id: "A", status: "processing", days_since_submission: 50 }),
      makeClaim({ claim_id: "B", status: "processing", days_since_submission: 95 }),
      makeClaim({ claim_id: "C", status: "submitted", days_since_submission: 30 }),
    ];
    const m = computeMetrics(claims);
    expect(m.aging_over_45).toBe(2);
    expect(m.aging_over_90).toBe(1);
  });
});

// ── buildTrackingRAGQueries ─────────────────────────────────

describe("buildTrackingRAGQueries", () => {
  test("generates payer timeline and filing queries", () => {
    const queries = buildTrackingRAGQueries(makeClaim());
    expect(queries.length).toBeGreaterThanOrEqual(2);
    expect(queries.some(q => q.query.includes("timeline"))).toBe(true);
    expect(queries.some(q => q.query.includes("timely filing"))).toBe(true);
  });

  test("adds denial resolution query for denied claims", () => {
    const queries = buildTrackingRAGQueries(makeClaim({
      status: "denied", denial_code: "CO-16", denial_reason: "Missing info",
    }));
    const denialQ = queries.filter(q => q.categories.includes("denial_reasons"));
    expect(denialQ.length).toBeGreaterThanOrEqual(1);
    expect(denialQ[0].query).toContain("CO-16");
  });

  test("no denial query for non-denied claims", () => {
    const queries = buildTrackingRAGQueries(makeClaim({ status: "processing" }));
    expect(queries.filter(q => q.categories.includes("denial_reasons"))).toHaveLength(0);
  });
});

// ── routeStatusChange ───────────────────────────────────────

describe("routeStatusChange", () => {
  test("routes denied to denial_handler", () => {
    expect(routeStatusChange({ claim_id: "A", previous_status: "processing", new_status: "denied", changed_at: "", details: null, denial_code: null })).toBe("denial_handler");
  });

  test("routes approved to payment_posting", () => {
    expect(routeStatusChange({ claim_id: "A", previous_status: "processing", new_status: "approved", changed_at: "", details: null, denial_code: null })).toBe("payment_posting");
  });

  test("routes paid to payment_posting", () => {
    expect(routeStatusChange({ claim_id: "A", previous_status: "approved", new_status: "paid", changed_at: "", details: null, denial_code: null })).toBe("payment_posting");
  });

  test("routes pending_info to info_request_handler", () => {
    expect(routeStatusChange({ claim_id: "A", previous_status: "processing", new_status: "pending_info", changed_at: "", details: null, denial_code: null })).toBe("info_request_handler");
  });

  test("routes appealed to appeal_handler", () => {
    expect(routeStatusChange({ claim_id: "A", previous_status: "denied", new_status: "appealed", changed_at: "", details: null, denial_code: null })).toBe("appeal_handler");
  });

  test("routes received to no_action", () => {
    expect(routeStatusChange({ claim_id: "A", previous_status: "submitted", new_status: "received", changed_at: "", details: null, denial_code: null })).toBe("no_action");
  });
});

// ── runTrackingPipeline ─────────────────────────────────────

describe("runTrackingPipeline", () => {
  test("produces complete outcome", () => {
    const prev = [makeClaim({ status: "submitted" })];
    const curr = [makeClaim({ status: "processing", days_since_submission: 20 })];
    const outcome = runTrackingPipeline(prev, curr);
    expect(outcome.claims_polled).toBe(1);
    expect(outcome.status_changes).toHaveLength(1);
    expect(outcome.metrics.total_tracked).toBe(1);
  });

  test("includes timely filing warnings when provided", () => {
    const claims = [makeClaim({ payer_id: "aetna", days_since_submission: 80, status: "processing" })];
    const outcome = runTrackingPipeline([], claims, {
      timelyFilingDays: new Map([["aetna", 90]]),
    });
    expect(outcome.alerts_generated.some(a => a.alert_type === "timely_filing_warning")).toBe(true);
  });
});

// ── E2E: Claim Lifecycle ────────────────────────────────────

describe("E2E: claim tracking lifecycle", () => {
  test("submitted -> processing -> denied -> alert generated", () => {
    // Week 1: submitted
    const week1 = [makeClaim({ status: "submitted", days_since_submission: 3 })];
    const r1 = runTrackingPipeline([], week1);
    expect(r1.alerts_generated).toHaveLength(0);

    // Week 2: moved to processing
    const week2 = [makeClaim({ status: "processing", days_since_submission: 10 })];
    const r2 = runTrackingPipeline(week1, week2);
    expect(r2.status_changes).toHaveLength(1);
    expect(r2.status_changes[0].new_status).toBe("processing");
    expect(routeStatusChange(r2.status_changes[0])).toBe("no_action");

    // Week 8: denied
    const week8 = [makeClaim({
      status: "denied", days_since_submission: 55,
      denial_code: "CO-16", denial_reason: "Missing info",
    })];
    const r3 = runTrackingPipeline(week2, week8);
    expect(r3.status_changes).toHaveLength(1);
    expect(routeStatusChange(r3.status_changes[0])).toBe("denial_handler");
    expect(r3.alerts_generated.some(a => a.alert_type === "denied")).toBe(true);
    expect(r3.metrics.denial_rate_percent).toBe(100);
  });

  test("submitted -> paid with metrics", () => {
    const prev = [makeClaim({ status: "submitted" })];
    const curr = [makeClaim({ status: "paid", days_since_submission: 28, paid_amount_cents: 12000 })];
    const outcome = runTrackingPipeline(prev, curr);
    expect(outcome.metrics.average_days_to_payment).toBe(28);
    expect(outcome.metrics.total_paid_cents).toBe(12000);
  });
});
