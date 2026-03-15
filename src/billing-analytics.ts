/**
 * Billing Analytics Agent — ELLIE-745
 *
 * Aggregates pipeline outcomes, calculates KPIs, detects trends,
 * compares against benchmarks, generates actionable recommendations.
 *
 * Pure pipeline logic — no side effects.
 */

// ── Types ────────────────────────────────────────────────────

/** Aggregate data from all billing pipeline agents. */
export interface PipelineSnapshot {
  period: string;
  claims_submitted: number;
  claims_accepted: number;
  claims_denied: number;
  claims_paid: number;
  claims_appealed: number;
  appeals_won: number;
  appeals_lost: number;
  total_billed_cents: number;
  total_collected_cents: number;
  total_adjustments_cents: number;
  total_patient_responsibility_cents: number;
  total_write_off_cents: number;
  total_pipeline_cost_cents: number;
  avg_days_to_payment: number | null;
  denial_codes: { code: string; count: number }[];
  payer_breakdown: { payer_id: string; payer_name: string; claims: number; paid_cents: number; denied: number }[];
}

/** Calculated KPIs for the billing pipeline. */
export interface BillingKPIs {
  clean_claim_rate: number;
  denial_rate: number;
  collection_rate: number;
  appeal_success_rate: number | null;
  avg_days_to_payment: number | null;
  cost_per_claim_cents: number;
  net_collection_rate: number;
  write_off_rate: number;
}

/** Industry benchmarks for comparison. */
export interface Benchmarks {
  clean_claim_rate: number;
  denial_rate: number;
  collection_rate: number;
  appeal_success_rate: number;
  avg_days_to_payment: number;
  cost_per_claim_cents: number;
}

export const INDUSTRY_BENCHMARKS: Benchmarks = {
  clean_claim_rate: 95,
  denial_rate: 8,
  collection_rate: 95,
  appeal_success_rate: 50,
  avg_days_to_payment: 45,
  cost_per_claim_cents: 25,
};

/** A detected trend. */
export interface Trend {
  metric: string;
  direction: "improving" | "declining" | "stable";
  current_value: number;
  previous_value: number;
  change_percent: number;
  severity: "info" | "warning" | "critical";
}

/** An actionable recommendation. */
export interface Recommendation {
  priority: "high" | "medium" | "low";
  category: "denial_reduction" | "collection" | "speed" | "cost" | "compliance";
  title: string;
  detail: string;
  estimated_impact: string;
}

/** Typed outcome from the analytics agent. */
export interface AnalyticsOutcome {
  period: string;
  kpis: BillingKPIs;
  benchmark_comparison: BenchmarkComparison[];
  trends: Trend[];
  recommendations: Recommendation[];
  top_denial_codes: { code: string; count: number; percent: number }[];
  payer_performance: PayerPerformance[];
  rag_queries_used: string[];
}

export interface BenchmarkComparison {
  metric: string;
  current: number;
  benchmark: number;
  status: "above" | "at" | "below";
  gap: number;
}

export interface PayerPerformance {
  payer_id: string;
  payer_name: string;
  claims: number;
  denial_rate: number;
  collection_rate: number;
  paid_cents: number;
}

// ── KPI Calculation ─────────────────────────────────────────

/**
 * Calculate billing KPIs from a pipeline snapshot.
 * Pure function.
 */
export function calculateKPIs(snapshot: PipelineSnapshot): BillingKPIs {
  const totalResolved = snapshot.claims_accepted + snapshot.claims_denied;

  const cleanClaimRate = snapshot.claims_submitted > 0
    ? round((snapshot.claims_accepted / snapshot.claims_submitted) * 100)
    : 0;

  const denialRate = totalResolved > 0
    ? round((snapshot.claims_denied / totalResolved) * 100)
    : 0;

  const collectionRate = snapshot.total_billed_cents > 0
    ? round((snapshot.total_collected_cents / snapshot.total_billed_cents) * 100)
    : 0;

  const totalAppeals = snapshot.appeals_won + snapshot.appeals_lost;
  const appealSuccessRate = totalAppeals > 0
    ? round((snapshot.appeals_won / totalAppeals) * 100)
    : null;

  const costPerClaim = snapshot.claims_submitted > 0
    ? Math.round(snapshot.total_pipeline_cost_cents / snapshot.claims_submitted)
    : 0;

  const netCollectable = snapshot.total_billed_cents - snapshot.total_adjustments_cents;
  const netCollectionRate = netCollectable > 0
    ? round((snapshot.total_collected_cents / netCollectable) * 100)
    : 0;

  const writeOffRate = snapshot.total_billed_cents > 0
    ? round((snapshot.total_write_off_cents / snapshot.total_billed_cents) * 100)
    : 0;

  return {
    clean_claim_rate: cleanClaimRate,
    denial_rate: denialRate,
    collection_rate: collectionRate,
    appeal_success_rate: appealSuccessRate,
    avg_days_to_payment: snapshot.avg_days_to_payment,
    cost_per_claim_cents: costPerClaim,
    net_collection_rate: netCollectionRate,
    write_off_rate: writeOffRate,
  };
}

// ── Benchmark Comparison ────────────────────────────────────

/**
 * Compare KPIs against benchmarks.
 * Pure function.
 */
export function compareToBenchmarks(
  kpis: BillingKPIs,
  benchmarks: Benchmarks = INDUSTRY_BENCHMARKS,
): BenchmarkComparison[] {
  const comparisons: BenchmarkComparison[] = [];

  function compare(metric: string, current: number | null, benchmark: number, higherIsBetter: boolean) {
    if (current === null) return;
    const gap = round(current - benchmark);
    const status = Math.abs(gap) < 1 ? "at"
      : (higherIsBetter ? (gap > 0 ? "above" : "below") : (gap < 0 ? "above" : "below"));
    comparisons.push({ metric, current, benchmark, status, gap });
  }

  compare("Clean Claim Rate", kpis.clean_claim_rate, benchmarks.clean_claim_rate, true);
  compare("Denial Rate", kpis.denial_rate, benchmarks.denial_rate, false);
  compare("Collection Rate", kpis.collection_rate, benchmarks.collection_rate, true);
  compare("Appeal Success Rate", kpis.appeal_success_rate, benchmarks.appeal_success_rate, true);
  compare("Avg Days to Payment", kpis.avg_days_to_payment, benchmarks.avg_days_to_payment, false);
  compare("Cost per Claim (cents)", kpis.cost_per_claim_cents, benchmarks.cost_per_claim_cents, false);

  return comparisons;
}

// ── Trend Detection ─────────────────────────────────────────

/**
 * Detect trends between two periods.
 * Pure function.
 */
export function detectTrends(
  current: BillingKPIs,
  previous: BillingKPIs,
  thresholdPercent: number = 5,
): Trend[] {
  const trends: Trend[] = [];

  function check(metric: string, curr: number | null, prev: number | null, higherIsBetter: boolean) {
    if (curr === null || prev === null || prev === 0) return;
    const changePct = round(((curr - prev) / prev) * 100);
    if (Math.abs(changePct) < thresholdPercent) {
      trends.push({ metric, direction: "stable", current_value: curr, previous_value: prev, change_percent: changePct, severity: "info" });
      return;
    }
    const improving = higherIsBetter ? changePct > 0 : changePct < 0;
    trends.push({
      metric,
      direction: improving ? "improving" : "declining",
      current_value: curr,
      previous_value: prev,
      change_percent: changePct,
      severity: !improving && Math.abs(changePct) > 15 ? "critical" : !improving ? "warning" : "info",
    });
  }

  check("Clean Claim Rate", current.clean_claim_rate, previous.clean_claim_rate, true);
  check("Denial Rate", current.denial_rate, previous.denial_rate, false);
  check("Collection Rate", current.collection_rate, previous.collection_rate, true);
  check("Appeal Success Rate", current.appeal_success_rate, previous.appeal_success_rate, true);
  check("Avg Days to Payment", current.avg_days_to_payment, previous.avg_days_to_payment, false);
  check("Cost per Claim", current.cost_per_claim_cents, previous.cost_per_claim_cents, false);

  return trends;
}

// ── Recommendations ─────────────────────────────────────────

/**
 * Generate actionable recommendations from KPIs and benchmarks.
 * Pure function.
 */
export function generateRecommendations(
  kpis: BillingKPIs,
  benchmarkComps: BenchmarkComparison[],
  snapshot: PipelineSnapshot,
): Recommendation[] {
  const recs: Recommendation[] = [];

  const denialComp = benchmarkComps.find(c => c.metric === "Denial Rate");
  if (denialComp && denialComp.status === "below") {
    const topCodes = snapshot.denial_codes.slice(0, 3).map(d => d.code).join(", ");
    recs.push({
      priority: "high",
      category: "denial_reduction",
      title: `Reduce denial rate from ${kpis.denial_rate}% to ${denialComp.benchmark}%`,
      detail: `Top denial codes: ${topCodes || "N/A"}. Focus denial prevention training on these codes.`,
      estimated_impact: `${Math.round(denialComp.gap)}% reduction could recover significant revenue`,
    });
  }

  const collectionComp = benchmarkComps.find(c => c.metric === "Collection Rate");
  if (collectionComp && collectionComp.status === "below") {
    recs.push({
      priority: "high",
      category: "collection",
      title: `Improve collection rate from ${kpis.collection_rate}% to ${collectionComp.benchmark}%`,
      detail: "Review underpayments and patient collections processes.",
      estimated_impact: `${Math.abs(Math.round(collectionComp.gap))}% improvement target`,
    });
  }

  const daysComp = benchmarkComps.find(c => c.metric === "Avg Days to Payment");
  if (daysComp && daysComp.status === "below" && kpis.avg_days_to_payment) {
    recs.push({
      priority: "medium",
      category: "speed",
      title: `Reduce days to payment from ${kpis.avg_days_to_payment} to ${daysComp.benchmark} days`,
      detail: "Identify slow payers and implement electronic claim submission where not already in use.",
      estimated_impact: `${Math.round(daysComp.gap)} day reduction improves cash flow`,
    });
  }

  if (kpis.write_off_rate > 5) {
    recs.push({
      priority: "medium",
      category: "collection",
      title: `Write-off rate ${kpis.write_off_rate}% exceeds 5% threshold`,
      detail: "Review write-off criteria and appeal more denied claims before writing off.",
      estimated_impact: "Reduce write-offs to recover additional revenue",
    });
  }

  const costComp = benchmarkComps.find(c => c.metric === "Cost per Claim (cents)");
  if (costComp && costComp.status === "below") {
    recs.push({
      priority: "low",
      category: "cost",
      title: `Reduce cost per claim from ${kpis.cost_per_claim_cents}c to ${costComp.benchmark}c`,
      detail: "Optimize automation rates and reduce manual intervention steps.",
      estimated_impact: `${Math.round(costComp.gap)}c per claim savings`,
    });
  }

  return recs;
}

// ── Payer Performance ───────────────────────────────────────

/**
 * Calculate per-payer performance from snapshot.
 * Pure function.
 */
export function calculatePayerPerformance(snapshot: PipelineSnapshot): PayerPerformance[] {
  return snapshot.payer_breakdown.map(p => ({
    payer_id: p.payer_id,
    payer_name: p.payer_name,
    claims: p.claims,
    denial_rate: p.claims > 0 ? round((p.denied / p.claims) * 100) : 0,
    collection_rate: p.paid_cents > 0 && p.claims > 0 ? round((p.paid_cents / (p.claims * (snapshot.total_billed_cents / snapshot.claims_submitted))) * 100) : 0,
    paid_cents: p.paid_cents,
  }));
}

// ── RAG Queries ─────────────────────────────────────────────

export function buildAnalyticsRAGQueries(): { query: string; categories: string[] }[] {
  return [
    { query: "Industry benchmark metrics for medical billing practice RCM", categories: ["compliance", "payer_rules"] },
    { query: "Denial rate trends by payer and denial code patterns", categories: ["denial_reasons", "payer_rules"] },
    { query: "Collection rate optimization strategies medical billing", categories: ["payer_rules", "compliance"] },
  ];
}

// ── Full Pipeline ───────────────────────────────────────────

/**
 * Run the full analytics pipeline.
 * Pure function.
 */
export function runAnalyticsPipeline(
  current: PipelineSnapshot,
  previous?: PipelineSnapshot,
  benchmarks?: Benchmarks,
): AnalyticsOutcome {
  const kpis = calculateKPIs(current);
  const benchmarkComps = compareToBenchmarks(kpis, benchmarks);

  let trends: Trend[] = [];
  if (previous) {
    const prevKpis = calculateKPIs(previous);
    trends = detectTrends(kpis, prevKpis);
  }

  const recommendations = generateRecommendations(kpis, benchmarkComps, current);
  const topDenials = current.denial_codes
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map(d => ({
      ...d,
      percent: current.claims_denied > 0 ? round((d.count / current.claims_denied) * 100) : 0,
    }));

  const payerPerf = calculatePayerPerformance(current);
  const ragQueries = buildAnalyticsRAGQueries();

  return {
    period: current.period,
    kpis,
    benchmark_comparison: benchmarkComps,
    trends,
    recommendations,
    top_denial_codes: topDenials,
    payer_performance: payerPerf,
    rag_queries_used: ragQueries.map(q => q.query),
  };
}

// ── Helpers ──────────────────────────────────────────────────

function round(n: number, decimals: number = 1): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}
