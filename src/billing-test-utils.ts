/**
 * Medical Billing Test Utilities & Agent Review Matrix — ELLIE-754
 *
 * Shared test fixtures, agent review matrix, performance benchmarks,
 * and integration test helpers for the billing pipeline.
 *
 * Pure module — no side effects.
 */

// ── Agent Review Matrix ─────────────────────────────────────

export type ReviewPerspective = "security" | "compliance" | "performance" | "simplicity" | "architecture";

export interface ReviewCriterion {
  perspective: ReviewPerspective;
  question: string;
  pass: boolean;
  notes: string | null;
}

export interface AgentReviewResult {
  agent_name: string;
  criteria: ReviewCriterion[];
  pass_count: number;
  fail_count: number;
  overall_pass: boolean;
}

/** The 5-perspective review matrix applied to every billing agent. */
export const REVIEW_MATRIX: Record<ReviewPerspective, string[]> = {
  security: [
    "No PHI in logs or error messages",
    "All inputs sanitized before SQL/API use",
    "Access scoped to agent role (least privilege)",
    "Encryption used for PHI at rest and in transit",
  ],
  compliance: [
    "Audit trail captures all state transitions",
    "Timely filing deadlines enforced",
    "State-specific rules applied",
    "No regulatory violations in output",
  ],
  performance: [
    "Cost per claim operation under target",
    "Latency within SLA for batch sizes",
    "Can handle projected daily volume",
    "No N+1 query patterns",
  ],
  simplicity: [
    "New developer can understand in <30 min",
    "No unnecessary abstractions",
    "Pure functions where possible",
    "Clear error messages",
  ],
  architecture: [
    "Follows formation patterns (injected deps)",
    "Properly decoupled from other agents",
    "Types exported for downstream consumers",
    "Testable without database",
  ],
};

/**
 * Run the agent review matrix against a set of criteria results.
 * Pure function.
 */
export function runAgentReview(
  agentName: string,
  results: { perspective: ReviewPerspective; question: string; pass: boolean; notes?: string }[],
): AgentReviewResult {
  const criteria: ReviewCriterion[] = results.map(r => ({
    perspective: r.perspective,
    question: r.question,
    pass: r.pass,
    notes: r.notes ?? null,
  }));

  const passCount = criteria.filter(c => c.pass).length;
  const failCount = criteria.filter(c => !c.pass).length;

  return {
    agent_name: agentName,
    criteria,
    pass_count: passCount,
    fail_count: failCount,
    overall_pass: failCount === 0,
  };
}

// ── Performance Benchmarks ──────────────────────────────────

export interface PerformanceBenchmark {
  agent: string;
  metric: string;
  target: number;
  unit: string;
  direction: "max" | "min";
}

export const PERFORMANCE_BENCHMARKS: PerformanceBenchmark[] = [
  { agent: "claim_submission", metric: "rejected_claims", target: 0, unit: "count", direction: "max" },
  { agent: "claim_submission", metric: "cost_per_claim_cents", target: 2, unit: "cents", direction: "max" },
  { agent: "claims_tracking", metric: "missed_followups", target: 0, unit: "count", direction: "max" },
  { agent: "denial_management", metric: "classification_time_ms", target: 300000, unit: "ms", direction: "max" },
  { agent: "appeals", metric: "success_rate_percent", target: 50, unit: "%", direction: "min" },
  { agent: "appeals", metric: "template_usage_percent", target: 80, unit: "%", direction: "min" },
  { agent: "payment_posting", metric: "variance_percent", target: 1, unit: "%", direction: "max" },
  { agent: "analytics", metric: "refresh_time_ms", target: 30000, unit: "ms", direction: "max" },
];

/**
 * Check if a metric meets its benchmark.
 */
export function meetsBenchmark(
  agent: string,
  metric: string,
  actual: number,
): { meets: boolean; benchmark: PerformanceBenchmark | null; actual: number } {
  const b = PERFORMANCE_BENCHMARKS.find(p => p.agent === agent && p.metric === metric);
  if (!b) return { meets: true, benchmark: null, actual };

  const meets = b.direction === "max" ? actual <= b.target : actual >= b.target;
  return { meets, benchmark: b, actual };
}

// ── Test Fixtures ───────────────────────────────────────────

/** Sample encounter for integration tests. */
export function sampleEncounter() {
  return {
    encounter_id: "enc-test-001",
    encounter_date: "2026-03-15",
    patient: {
      id: "pat-test", first_name: "Jane", last_name: "Doe",
      dob: "1985-06-15", gender: "female", member_id: "MEM-TEST-001",
    },
    insurance: {
      payer_id: "aetna", payer_name: "Aetna",
      plan_id: "PPO-500", group_number: "GRP-789", subscriber_id: "SUB-TEST",
    },
    diagnoses: [
      { code: "J06.9", description: "Acute upper respiratory infection", is_primary: true },
      { code: "R05.9", description: "Cough, unspecified", is_primary: false },
    ],
    procedures: [
      { cpt_code: "99213", description: "Office visit, low complexity", modifiers: [], units: 1, charge_cents: 15000 },
    ],
    provider: { npi: "1234567890", name: "Dr. Smith", taxonomy_code: "207Q00000X" },
    company_id: "comp-test",
  };
}

/** Sample denial for integration tests. */
export function sampleDenial() {
  return {
    claim_id: "CLM-TEST-001",
    payer_id: "aetna",
    payer_name: "Aetna",
    denial_code: "CO-16",
    denial_reason: "Claim lacks information needed for adjudication",
    total_charge_cents: 15000,
    cpt_codes: ["99213"],
    diagnosis_codes: ["J06.9"],
    submitted_at: "2026-03-16",
    denied_at: "2026-04-15",
    company_id: "comp-test",
  };
}

/** Sample remittance for integration tests. */
export function sampleRemittance() {
  return {
    claim_id: "CLM-TEST-001",
    patient_name: "Jane Doe",
    cpt_code: "99213",
    billed_cents: 15000,
    allowed_cents: 12000,
    paid_cents: 10000,
    adjustments: [
      { group_code: "CO", reason_code: "45", amount_cents: 3000 },
      { group_code: "PR", reason_code: "2", amount_cents: 2000 },
    ],
    patient_responsibility_cents: 2000,
  };
}

/** Sample completed claim lifecycle for feedback loop. */
export function sampleCompletedLifecycle() {
  return {
    claim_id: "CLM-TEST-001",
    payer_id: "aetna",
    payer_name: "Aetna",
    cpt_codes: ["99213"],
    diagnosis_codes: ["J06.9"],
    modifiers: [],
    total_charge_cents: 15000,
    paid_amount_cents: 10000,
    outcome: "paid" as const,
    denial_code: null,
    denial_reason: null,
    appeal_attempted: false,
    appeal_outcome: null,
    appeal_template_used: null,
    days_to_resolution: 28,
    company_id: "comp-test",
  };
}

// ── Pipeline Stage Validator ────────────────────────────────

export type PipelineStage =
  | "fhir_fetch"
  | "claim_submission"
  | "claims_tracking"
  | "denial_management"
  | "appeals"
  | "payment_posting"
  | "analytics"
  | "feedback_loop";

export const PIPELINE_STAGES: PipelineStage[] = [
  "fhir_fetch", "claim_submission", "claims_tracking",
  "denial_management", "appeals", "payment_posting",
  "analytics", "feedback_loop",
];

export interface StageResult {
  stage: PipelineStage;
  success: boolean;
  duration_ms: number;
  output_type: string;
  error: string | null;
}

/**
 * Validate that a pipeline execution covered all expected stages.
 */
export function validatePipelineCoverage(
  results: StageResult[],
  expectedStages: PipelineStage[],
): { complete: boolean; missing: PipelineStage[]; failed: PipelineStage[] } {
  const completed = new Set(results.filter(r => r.success).map(r => r.stage));
  const failed = results.filter(r => !r.success).map(r => r.stage);
  const missing = expectedStages.filter(s => !completed.has(s) && !failed.includes(s));

  return {
    complete: missing.length === 0 && failed.length === 0,
    missing,
    failed,
  };
}
