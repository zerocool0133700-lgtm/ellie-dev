/**
 * Billing Analytics Agent Tests — ELLIE-745
 *
 * Tests for analytics pipeline:
 * - KPI calculation
 * - Benchmark comparison
 * - Trend detection
 * - Recommendation generation
 * - Payer performance
 * - RAG queries
 * - Full pipeline
 * - E2E scenarios
 */

import { describe, test, expect } from "bun:test";
import {
  calculateKPIs,
  compareToBenchmarks,
  detectTrends,
  generateRecommendations,
  calculatePayerPerformance,
  buildAnalyticsRAGQueries,
  runAnalyticsPipeline,
  INDUSTRY_BENCHMARKS,
  type PipelineSnapshot,
  type BillingKPIs,
  type Benchmarks,
} from "../src/billing-analytics.ts";

// ── Helpers ─────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<PipelineSnapshot> = {}): PipelineSnapshot {
  return {
    period: "2026-03",
    claims_submitted: 1000,
    claims_accepted: 950,
    claims_denied: 50,
    claims_paid: 900,
    claims_appealed: 30,
    appeals_won: 18,
    appeals_lost: 12,
    total_billed_cents: 15000000,
    total_collected_cents: 12000000,
    total_adjustments_cents: 2000000,
    total_patient_responsibility_cents: 500000,
    total_write_off_cents: 500000,
    total_pipeline_cost_cents: 25000,
    avg_days_to_payment: 35,
    denial_codes: [
      { code: "CO-16", count: 15 },
      { code: "CO-55", count: 12 },
      { code: "CO-45", count: 8 },
    ],
    payer_breakdown: [
      { payer_id: "aetna", payer_name: "Aetna", claims: 400, paid_cents: 5000000, denied: 15 },
      { payer_id: "uhc", payer_name: "UHC", claims: 350, paid_cents: 4000000, denied: 20 },
      { payer_id: "bcbs", payer_name: "BCBS", claims: 250, paid_cents: 3000000, denied: 15 },
    ],
    ...overrides,
  };
}

// ── INDUSTRY_BENCHMARKS ─────────────────────────────────────

describe("INDUSTRY_BENCHMARKS", () => {
  test("has all benchmark fields", () => {
    expect(INDUSTRY_BENCHMARKS.clean_claim_rate).toBe(95);
    expect(INDUSTRY_BENCHMARKS.denial_rate).toBe(8);
    expect(INDUSTRY_BENCHMARKS.collection_rate).toBe(95);
    expect(INDUSTRY_BENCHMARKS.appeal_success_rate).toBe(50);
    expect(INDUSTRY_BENCHMARKS.avg_days_to_payment).toBe(45);
    expect(INDUSTRY_BENCHMARKS.cost_per_claim_cents).toBe(25);
  });
});

// ── calculateKPIs ───────────────────────────────────────────

describe("calculateKPIs", () => {
  test("calculates all KPIs from snapshot", () => {
    const kpis = calculateKPIs(makeSnapshot());
    expect(kpis.clean_claim_rate).toBe(95);
    expect(kpis.denial_rate).toBe(5);
    expect(kpis.collection_rate).toBe(80);
    expect(kpis.appeal_success_rate).toBe(60);
    expect(kpis.avg_days_to_payment).toBe(35);
    expect(kpis.cost_per_claim_cents).toBe(25);
  });

  test("handles zero claims", () => {
    const kpis = calculateKPIs(makeSnapshot({ claims_submitted: 0, claims_accepted: 0, claims_denied: 0 }));
    expect(kpis.clean_claim_rate).toBe(0);
    expect(kpis.denial_rate).toBe(0);
    expect(kpis.cost_per_claim_cents).toBe(0);
  });

  test("handles no appeals", () => {
    const kpis = calculateKPIs(makeSnapshot({ appeals_won: 0, appeals_lost: 0 }));
    expect(kpis.appeal_success_rate).toBeNull();
  });

  test("write_off_rate calculated correctly", () => {
    const kpis = calculateKPIs(makeSnapshot({ total_write_off_cents: 1500000, total_billed_cents: 15000000 }));
    expect(kpis.write_off_rate).toBe(10);
  });

  test("net_collection_rate excludes adjustments", () => {
    // billed 15M - adjustments 2M = 13M net collectable
    // collected 12M / 13M = 92.3%
    const kpis = calculateKPIs(makeSnapshot());
    expect(kpis.net_collection_rate).toBeGreaterThan(90);
  });
});

// ── compareToBenchmarks ─────────────────────────────────────

describe("compareToBenchmarks", () => {
  test("marks metrics above benchmark", () => {
    const kpis = calculateKPIs(makeSnapshot());
    const comps = compareToBenchmarks(kpis);
    const appealComp = comps.find(c => c.metric === "Appeal Success Rate");
    expect(appealComp?.status).toBe("above"); // 60% > 50%
  });

  test("marks metrics below benchmark", () => {
    const kpis = calculateKPIs(makeSnapshot({ total_collected_cents: 5000000 }));
    const comps = compareToBenchmarks(kpis);
    const collectionComp = comps.find(c => c.metric === "Collection Rate");
    expect(collectionComp?.status).toBe("below");
  });

  test("marks metrics at benchmark (within 1%)", () => {
    const kpis = calculateKPIs(makeSnapshot());
    const comps = compareToBenchmarks(kpis);
    const cleanComp = comps.find(c => c.metric === "Clean Claim Rate");
    expect(cleanComp?.status).toBe("at"); // 95% == 95%
  });

  test("denial rate: lower is better", () => {
    const kpis = calculateKPIs(makeSnapshot());
    const comps = compareToBenchmarks(kpis);
    const denialComp = comps.find(c => c.metric === "Denial Rate");
    expect(denialComp?.status).toBe("above"); // 5% < 8% benchmark = above
  });

  test("includes gap calculation", () => {
    const kpis = calculateKPIs(makeSnapshot());
    const comps = compareToBenchmarks(kpis);
    for (const c of comps) {
      expect(c.gap).toBe(Math.round((c.current - c.benchmark) * 10) / 10);
    }
  });
});

// ── detectTrends ────────────────────────────────────────────

describe("detectTrends", () => {
  test("detects improving trend", () => {
    const current = calculateKPIs(makeSnapshot({ claims_denied: 30 })); // 3% denial
    const previous = calculateKPIs(makeSnapshot({ claims_denied: 80 })); // 8% denial
    const trends = detectTrends(current, previous);
    const denial = trends.find(t => t.metric === "Denial Rate");
    expect(denial?.direction).toBe("improving"); // lower is better
  });

  test("detects declining trend", () => {
    const current = calculateKPIs(makeSnapshot({ total_collected_cents: 8000000 })); // lower
    const previous = calculateKPIs(makeSnapshot({ total_collected_cents: 14000000 }));
    const trends = detectTrends(current, previous);
    const collection = trends.find(t => t.metric === "Collection Rate");
    expect(collection?.direction).toBe("declining");
  });

  test("marks stable when change < threshold", () => {
    const kpis = calculateKPIs(makeSnapshot());
    const trends = detectTrends(kpis, kpis);
    for (const t of trends) {
      expect(t.direction).toBe("stable");
    }
  });

  test("critical severity for large negative changes", () => {
    const current = calculateKPIs(makeSnapshot({ claims_denied: 200, claims_accepted: 800 })); // 20% denial
    const previous = calculateKPIs(makeSnapshot({ claims_denied: 50 })); // 5%
    const trends = detectTrends(current, previous);
    const denial = trends.find(t => t.metric === "Denial Rate");
    expect(denial?.severity).toBe("critical");
  });

  test("respects custom threshold", () => {
    const a = calculateKPIs(makeSnapshot({ claims_denied: 55 }));
    const b = calculateKPIs(makeSnapshot({ claims_denied: 50 }));
    const tight = detectTrends(a, b, 1);
    const loose = detectTrends(a, b, 50);
    expect(tight.some(t => t.direction !== "stable")).toBe(true);
    expect(loose.every(t => t.direction === "stable")).toBe(true);
  });
});

// ── generateRecommendations ─────────────────────────────────

describe("generateRecommendations", () => {
  test("generates denial reduction recommendation when below benchmark", () => {
    const snapshot = makeSnapshot({ claims_denied: 150, claims_accepted: 850 }); // 15% denial
    const kpis = calculateKPIs(snapshot);
    const comps = compareToBenchmarks(kpis);
    const recs = generateRecommendations(kpis, comps, snapshot);
    expect(recs.some(r => r.category === "denial_reduction")).toBe(true);
  });

  test("generates collection recommendation when below benchmark", () => {
    const snapshot = makeSnapshot({ total_collected_cents: 5000000 }); // low collection
    const kpis = calculateKPIs(snapshot);
    const comps = compareToBenchmarks(kpis);
    const recs = generateRecommendations(kpis, comps, snapshot);
    expect(recs.some(r => r.category === "collection")).toBe(true);
  });

  test("generates write-off recommendation when > 5%", () => {
    const snapshot = makeSnapshot({ total_write_off_cents: 1500000 }); // 10%
    const kpis = calculateKPIs(snapshot);
    const recs = generateRecommendations(kpis, [], snapshot);
    expect(recs.some(r => r.title.includes("Write-off"))).toBe(true);
  });

  test("no recommendations when everything is above benchmark", () => {
    const snapshot = makeSnapshot({ total_write_off_cents: 0 });
    const kpis = calculateKPIs(snapshot);
    const comps = compareToBenchmarks(kpis);
    // Filter to only "below" benchmarks
    const belowComps = comps.filter(c => c.status === "below");
    const recs = generateRecommendations(kpis, belowComps, snapshot);
    // May still have write-off rec if > 5%
    expect(recs.filter(r => r.category === "denial_reduction")).toHaveLength(0);
  });

  test("includes top denial codes in recommendation detail", () => {
    const snapshot = makeSnapshot({ claims_denied: 150, claims_accepted: 850 });
    const kpis = calculateKPIs(snapshot);
    const comps = compareToBenchmarks(kpis);
    const recs = generateRecommendations(kpis, comps, snapshot);
    const denialRec = recs.find(r => r.category === "denial_reduction");
    expect(denialRec?.detail).toContain("CO-16");
  });
});

// ── calculatePayerPerformance ───────────────────────────────

describe("calculatePayerPerformance", () => {
  test("calculates per-payer metrics", () => {
    const perf = calculatePayerPerformance(makeSnapshot());
    expect(perf).toHaveLength(3);
    expect(perf[0].payer_id).toBe("aetna");
    expect(perf[0].denial_rate).toBeGreaterThanOrEqual(0);
  });
});

// ── buildAnalyticsRAGQueries ────────────────────────────────

describe("buildAnalyticsRAGQueries", () => {
  test("generates 3 queries", () => {
    const queries = buildAnalyticsRAGQueries();
    expect(queries).toHaveLength(3);
    expect(queries.some(q => q.query.includes("benchmark"))).toBe(true);
    expect(queries.some(q => q.query.includes("Denial rate"))).toBe(true);
    expect(queries.some(q => q.query.includes("Collection rate"))).toBe(true);
  });
});

// ── runAnalyticsPipeline ────────────────────────────────────

describe("runAnalyticsPipeline", () => {
  test("produces complete outcome without previous period", () => {
    const outcome = runAnalyticsPipeline(makeSnapshot());
    expect(outcome.period).toBe("2026-03");
    expect(outcome.kpis.clean_claim_rate).toBeGreaterThan(0);
    expect(outcome.benchmark_comparison.length).toBeGreaterThan(0);
    expect(outcome.trends).toHaveLength(0); // No previous
    expect(outcome.top_denial_codes.length).toBeGreaterThan(0);
    expect(outcome.payer_performance).toHaveLength(3);
    expect(outcome.rag_queries_used).toHaveLength(3);
  });

  test("includes trends when previous period provided", () => {
    const current = makeSnapshot({ period: "2026-03" });
    const previous = makeSnapshot({ period: "2026-02", claims_denied: 80 });
    const outcome = runAnalyticsPipeline(current, previous);
    expect(outcome.trends.length).toBeGreaterThan(0);
  });

  test("top denial codes include percent", () => {
    const outcome = runAnalyticsPipeline(makeSnapshot());
    expect(outcome.top_denial_codes[0].percent).toBeGreaterThan(0);
  });
});

// ── E2E: Analytics Scenarios ────────────────────────────────

describe("E2E: analytics scenarios", () => {
  test("healthy practice with good KPIs", () => {
    const snapshot = makeSnapshot();
    const outcome = runAnalyticsPipeline(snapshot);

    expect(outcome.kpis.clean_claim_rate).toBe(95);
    expect(outcome.kpis.denial_rate).toBe(5);
    expect(outcome.kpis.appeal_success_rate).toBe(60);

    // Should be at or above most benchmarks
    const aboveOrAt = outcome.benchmark_comparison.filter(c => c.status === "above" || c.status === "at");
    expect(aboveOrAt.length).toBeGreaterThanOrEqual(3);
  });

  test("struggling practice with declining metrics", () => {
    const current = makeSnapshot({
      claims_denied: 200,
      claims_accepted: 800,
      total_collected_cents: 7000000,
      total_write_off_cents: 3000000,
    });
    const previous = makeSnapshot();

    const outcome = runAnalyticsPipeline(current, previous);

    // High denial rate should trigger recommendation
    expect(outcome.kpis.denial_rate).toBe(20);
    expect(outcome.recommendations.some(r => r.category === "denial_reduction")).toBe(true);

    // Declining trends
    const declining = outcome.trends.filter(t => t.direction === "declining");
    expect(declining.length).toBeGreaterThan(0);

    // Write-off warning
    expect(outcome.recommendations.some(r => r.title.includes("Write-off"))).toBe(true);
  });
});
