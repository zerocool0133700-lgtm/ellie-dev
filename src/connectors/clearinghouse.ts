/**
 * Clearinghouse Connector — ELLIE-784
 *
 * Adapter pattern abstracting clearinghouse-specific APIs.
 * Eligibility verification (270/271), claim status (277),
 * retry logic, error classification.
 *
 * Pure module — HTTP calls are injected as deps.
 */

// ── Types ────────────────────────────────────────────────────

export type ClearinghouseName = "availity" | "change_healthcare" | "trizetto" | "office_ally";
export type ErrorCategory = "rejection" | "denial" | "timeout" | "auth_failure" | "validation" | "transient" | "unknown";

export const VALID_CLEARINGHOUSES: ClearinghouseName[] = ["availity", "change_healthcare", "trizetto", "office_ally"];

/** Clearinghouse adapter interface. */
export interface ClearinghouseAdapter {
  name: ClearinghouseName;
  submitClaim: (payload: string, format: string) => Promise<SubmissionResponse>;
  checkStatus: (trackingNumber: string) => Promise<StatusResponse>;
  checkEligibility: (request: EligibilityRequest) => Promise<EligibilityResponse>;
}

export interface SubmissionResponse {
  success: boolean;
  tracking_number: string | null;
  acknowledgement_code: string | null;
  errors: SubmissionError[];
  raw_response: string | null;
}

export interface SubmissionError {
  code: string;
  message: string;
  category: ErrorCategory;
  retryable: boolean;
}

export interface StatusResponse {
  claim_id: string | null;
  status: "accepted" | "rejected" | "pending" | "paid" | "denied" | "unknown";
  status_code: string | null;
  status_message: string | null;
  effective_date: string | null;
}

export interface EligibilityRequest {
  payer_id: string;
  subscriber_id: string;
  member_id: string;
  patient_first_name: string;
  patient_last_name: string;
  patient_dob: string;
  service_type_code?: string;
  date_of_service?: string;
}

export interface EligibilityResponse {
  eligible: boolean;
  payer_name: string | null;
  plan_name: string | null;
  coverage_status: "active" | "inactive" | "unknown";
  copay_cents: number | null;
  deductible_cents: number | null;
  deductible_remaining_cents: number | null;
  coinsurance_percent: number | null;
  prior_auth_required: boolean | null;
  errors: string[];
}

// ── Error Classification ────────────────────────────────────

/**
 * Classify an error from a clearinghouse response.
 * Pure function.
 */
export function classifyError(code: string, message: string): { category: ErrorCategory; retryable: boolean } {
  const lower = message.toLowerCase();

  if (lower.includes("timeout") || lower.includes("timed out") || code === "ETIMEDOUT") {
    return { category: "timeout", retryable: true };
  }
  if (lower.includes("unauthorized") || lower.includes("auth") || code === "401" || code === "403") {
    return { category: "auth_failure", retryable: false };
  }
  if (lower.includes("rate limit") || lower.includes("too many") || code === "429") {
    return { category: "transient", retryable: true };
  }
  if (lower.includes("service unavailable") || code === "503" || code === "502") {
    return { category: "transient", retryable: true };
  }
  if (lower.includes("reject") || code.startsWith("R")) {
    return { category: "rejection", retryable: false };
  }
  if (lower.includes("denied") || lower.includes("denial")) {
    return { category: "denial", retryable: false };
  }
  if (lower.includes("invalid") || lower.includes("missing") || lower.includes("required")) {
    return { category: "validation", retryable: false };
  }

  return { category: "unknown", retryable: false };
}

// ── Retry Logic ─────────────────────────────────────────────

export interface RetryConfig {
  max_attempts: number;
  base_delay_ms: number;
  max_delay_ms: number;
  backoff_factor: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  max_attempts: 3,
  base_delay_ms: 1000,
  max_delay_ms: 30000,
  backoff_factor: 2,
};

/**
 * Calculate delay for a retry attempt using exponential backoff.
 * Pure function.
 */
export function calculateRetryDelay(
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
): number {
  const delay = config.base_delay_ms * Math.pow(config.backoff_factor, attempt);
  return Math.min(delay, config.max_delay_ms);
}

/**
 * Determine if an operation should be retried.
 * Pure function.
 */
export function shouldRetry(
  error: SubmissionError,
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
): boolean {
  return error.retryable && attempt < config.max_attempts;
}

/**
 * Execute with retry logic. Injected operation for testability.
 */
export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  onRetry?: (attempt: number, delay: number) => void,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.max_attempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt < config.max_attempts && isRetryable(err)) {
        const delay = calculateRetryDelay(attempt, config);
        onRetry?.(attempt + 1, delay);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        break;
      }
    }
  }

  throw lastError;
}

// ── Eligibility Request Builder (270) ───────────────────────

/**
 * Build an X12 270 eligibility inquiry.
 * Simplified — covers core segments.
 * Pure function.
 */
export function buildEligibilityRequest270(req: EligibilityRequest): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const segments = [
    `ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *${date.slice(2, 8)}*1200*^*00501*000000001*0*P*:`,
    `GS*HS*SENDER*RECEIVER*${date}*1200*1*X*005010X279A1`,
    `ST*270*0001*005010X279A1`,
    `BHT*0022*13*ELG${date}*${date}*1200`,
    `HL*1**20*1`,
    `NM1*PR*2*${req.payer_id}****PI*${req.payer_id}`,
    `HL*2*1*21*1`,
    `NM1*1P*1*****XX*1234567890`,
    `HL*3*2*22*0`,
    `NM1*IL*1*${req.patient_last_name}*${req.patient_first_name}****MI*${req.member_id}`,
    `DMG*D8*${req.patient_dob.replace(/-/g, "")}`,
    `DTP*291*D8*${(req.date_of_service ?? new Date().toISOString().slice(0, 10)).replace(/-/g, "")}`,
    `EQ*${req.service_type_code ?? "30"}`,
    `SE*13*0001`,
    `GE*1*1`,
    `IEA*1*000000001`,
  ];
  return segments.join("~\n") + "~\n";
}

// ── Eligibility Response Parser (271) ───────────────────────

/**
 * Parse an X12 271 eligibility response.
 * Simplified — extracts key coverage info.
 * Pure function.
 */
export function parseEligibilityResponse271(raw: string): EligibilityResponse {
  const segments = raw.split("~").map(s => s.trim()).filter(Boolean);
  const response: EligibilityResponse = {
    eligible: false,
    payer_name: null,
    plan_name: null,
    coverage_status: "unknown",
    copay_cents: null,
    deductible_cents: null,
    deductible_remaining_cents: null,
    coinsurance_percent: null,
    prior_auth_required: null,
    errors: [],
  };

  for (const seg of segments) {
    const el = seg.split("*");

    if (el[0] === "NM1" && el[1] === "PR") {
      response.payer_name = el[3] ?? null;
    }

    if (el[0] === "EB") {
      const infoCode = el[1];
      if (infoCode === "1") {
        response.eligible = true;
        response.coverage_status = "active";
      }
      if (infoCode === "6") {
        response.eligible = false;
        response.coverage_status = "inactive";
      }
      // Copay
      if (infoCode === "B" && el[5]) {
        response.copay_cents = Math.round(parseFloat(el[5]) * 100);
      }
      // Deductible
      if (infoCode === "C" && el[5]) {
        response.deductible_cents = Math.round(parseFloat(el[5]) * 100);
      }
      // Coinsurance
      if (infoCode === "A" && el[5]) {
        response.coinsurance_percent = Math.round(parseFloat(el[5]) * 100);
      }
      // Prior auth required
      if (infoCode === "Y") {
        response.prior_auth_required = true;
      }
    }

    if (el[0] === "AAA") {
      response.errors.push(el[3] ?? `Error code: ${el[1]}`);
    }
  }

  return response;
}

// ── 277 Status Response Parser ──────────────────────────────

/**
 * Parse an X12 277 claim status response.
 * Pure function.
 */
export function parseClaimStatus277(raw: string): StatusResponse[] {
  const segments = raw.split("~").map(s => s.trim()).filter(Boolean);
  const responses: StatusResponse[] = [];
  let current: Partial<StatusResponse> = {};

  for (const seg of segments) {
    const el = seg.split("*");

    if (el[0] === "TRN") {
      if (current.claim_id) responses.push(finalizeStatus(current));
      current = { claim_id: el[2] ?? null };
    }

    if (el[0] === "STC") {
      const statusCode = el[1]?.split(":")[0] ?? null;
      current.status_code = statusCode;
      current.status_message = el[3] ?? null;
      current.effective_date = el[2] ?? null;
      current.status = mapStatusCode(statusCode);
    }
  }

  if (current.claim_id) responses.push(finalizeStatus(current));
  return responses;
}

function mapStatusCode(code: string | null): StatusResponse["status"] {
  if (!code) return "unknown";
  const map: Record<string, StatusResponse["status"]> = {
    "A0": "accepted", "A1": "accepted", "A2": "accepted",
    "R0": "rejected", "R1": "rejected", "R3": "rejected",
    "P0": "pending", "P1": "pending", "P2": "pending",
    "F0": "paid", "F1": "paid",
    "D0": "denied",
  };
  return map[code] ?? "unknown";
}

function finalizeStatus(partial: Partial<StatusResponse>): StatusResponse {
  return {
    claim_id: partial.claim_id ?? null,
    status: partial.status ?? "unknown",
    status_code: partial.status_code ?? null,
    status_message: partial.status_message ?? null,
    effective_date: partial.effective_date ?? null,
  };
}
