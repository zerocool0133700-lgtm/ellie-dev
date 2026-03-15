/**
 * Clearinghouse Connector Tests — ELLIE-784
 *
 * Tests for clearinghouse adapter, eligibility, retry, error classification:
 * - Error classification (timeout, auth, transient, rejection, denial, validation)
 * - Retry logic (delay calculation, shouldRetry, executeWithRetry)
 * - Eligibility request builder (270)
 * - Eligibility response parser (271)
 * - Claim status parser (277)
 * - E2E scenarios
 */

import { describe, test, expect } from "bun:test";
import {
  classifyError,
  calculateRetryDelay,
  shouldRetry,
  executeWithRetry,
  buildEligibilityRequest270,
  parseEligibilityResponse271,
  parseClaimStatus277,
  DEFAULT_RETRY_CONFIG,
  VALID_CLEARINGHOUSES,
  type SubmissionError,
  type EligibilityRequest,
  type RetryConfig,
} from "../src/connectors/clearinghouse.ts";

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("VALID_CLEARINGHOUSES has 4 clearinghouses", () => {
    expect(VALID_CLEARINGHOUSES).toHaveLength(4);
    expect(VALID_CLEARINGHOUSES).toContain("availity");
    expect(VALID_CLEARINGHOUSES).toContain("change_healthcare");
  });

  test("DEFAULT_RETRY_CONFIG has sensible defaults", () => {
    expect(DEFAULT_RETRY_CONFIG.max_attempts).toBe(3);
    expect(DEFAULT_RETRY_CONFIG.base_delay_ms).toBe(1000);
    expect(DEFAULT_RETRY_CONFIG.backoff_factor).toBe(2);
  });
});

// ── classifyError ───────────────────────────────────────────

describe("classifyError", () => {
  test("timeout classified and retryable", () => {
    const r = classifyError("ETIMEDOUT", "Request timed out");
    expect(r.category).toBe("timeout");
    expect(r.retryable).toBe(true);
  });

  test("auth failure not retryable", () => {
    const r = classifyError("401", "Unauthorized access");
    expect(r.category).toBe("auth_failure");
    expect(r.retryable).toBe(false);
  });

  test("rate limit is transient and retryable", () => {
    const r = classifyError("429", "Too many requests");
    expect(r.category).toBe("transient");
    expect(r.retryable).toBe(true);
  });

  test("503 is transient and retryable", () => {
    expect(classifyError("503", "Service unavailable").retryable).toBe(true);
  });

  test("rejection not retryable", () => {
    const r = classifyError("R01", "Claim rejected: invalid format");
    expect(r.category).toBe("rejection");
    expect(r.retryable).toBe(false);
  });

  test("denial not retryable", () => {
    expect(classifyError("D01", "Claim denied").category).toBe("denial");
  });

  test("validation error not retryable", () => {
    expect(classifyError("V01", "Missing required field").category).toBe("validation");
  });

  test("unknown error not retryable", () => {
    const r = classifyError("X99", "Something went wrong");
    expect(r.category).toBe("unknown");
    expect(r.retryable).toBe(false);
  });
});

// ── Retry Logic ─────────────────────────────────────────────

describe("calculateRetryDelay", () => {
  test("first attempt: base delay", () => {
    expect(calculateRetryDelay(0)).toBe(1000);
  });

  test("exponential backoff", () => {
    expect(calculateRetryDelay(1)).toBe(2000);
    expect(calculateRetryDelay(2)).toBe(4000);
    expect(calculateRetryDelay(3)).toBe(8000);
  });

  test("caps at max_delay_ms", () => {
    expect(calculateRetryDelay(100)).toBe(DEFAULT_RETRY_CONFIG.max_delay_ms);
  });

  test("custom config", () => {
    const config: RetryConfig = { max_attempts: 5, base_delay_ms: 500, max_delay_ms: 5000, backoff_factor: 3 };
    expect(calculateRetryDelay(0, config)).toBe(500);
    expect(calculateRetryDelay(1, config)).toBe(1500);
    expect(calculateRetryDelay(2, config)).toBe(4500);
    expect(calculateRetryDelay(3, config)).toBe(5000); // capped
  });
});

describe("shouldRetry", () => {
  test("retryable error with attempts remaining -> true", () => {
    const err: SubmissionError = { code: "503", message: "Unavailable", category: "transient", retryable: true };
    expect(shouldRetry(err, 0)).toBe(true);
    expect(shouldRetry(err, 2)).toBe(true);
  });

  test("retryable error with no attempts remaining -> false", () => {
    const err: SubmissionError = { code: "503", message: "Unavailable", category: "transient", retryable: true };
    expect(shouldRetry(err, 3)).toBe(false); // max_attempts = 3
  });

  test("non-retryable error -> false regardless of attempts", () => {
    const err: SubmissionError = { code: "401", message: "Unauthorized", category: "auth_failure", retryable: false };
    expect(shouldRetry(err, 0)).toBe(false);
  });
});

describe("executeWithRetry", () => {
  test("succeeds on first try", async () => {
    let calls = 0;
    const result = await executeWithRetry(
      async () => { calls++; return "ok"; },
      () => true,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  test("retries on retryable failure then succeeds", async () => {
    let calls = 0;
    const result = await executeWithRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return "ok";
      },
      () => true,
      { max_attempts: 3, base_delay_ms: 1, max_delay_ms: 10, backoff_factor: 2 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  test("throws after max retries exhausted", async () => {
    await expect(
      executeWithRetry(
        async () => { throw new Error("always fails"); },
        () => true,
        { max_attempts: 2, base_delay_ms: 1, max_delay_ms: 10, backoff_factor: 2 },
      ),
    ).rejects.toThrow("always fails");
  });

  test("does not retry non-retryable errors", async () => {
    let calls = 0;
    await expect(
      executeWithRetry(
        async () => { calls++; throw new Error("auth"); },
        () => false,
        { max_attempts: 3, base_delay_ms: 1, max_delay_ms: 10, backoff_factor: 2 },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("calls onRetry callback", async () => {
    const retries: number[] = [];
    await expect(
      executeWithRetry(
        async () => { throw new Error("fail"); },
        () => true,
        { max_attempts: 2, base_delay_ms: 1, max_delay_ms: 10, backoff_factor: 2 },
        (attempt) => retries.push(attempt),
      ),
    ).rejects.toThrow();
    expect(retries).toEqual([1, 2]);
  });
});

// ── Eligibility 270 Builder ─────────────────────────────────

describe("buildEligibilityRequest270", () => {
  const req: EligibilityRequest = {
    payer_id: "aetna", subscriber_id: "SUB-123", member_id: "MEM-456",
    patient_first_name: "Jane", patient_last_name: "Doe", patient_dob: "1985-06-15",
  };

  test("produces X12 270 with ISA/GS/ST envelope", () => {
    const edi = buildEligibilityRequest270(req);
    expect(edi).toContain("ISA*");
    expect(edi).toContain("ST*270*");
    expect(edi).toContain("IEA*");
  });

  test("includes payer ID", () => {
    expect(buildEligibilityRequest270(req)).toContain("aetna");
  });

  test("includes patient name and member ID", () => {
    const edi = buildEligibilityRequest270(req);
    expect(edi).toContain("Doe");
    expect(edi).toContain("Jane");
    expect(edi).toContain("MEM-456");
  });

  test("includes DOB in DMG segment", () => {
    expect(buildEligibilityRequest270(req)).toContain("DMG*D8*19850615");
  });

  test("defaults service type to 30 (health benefit plan coverage)", () => {
    expect(buildEligibilityRequest270(req)).toContain("EQ*30");
  });

  test("uses custom service type when provided", () => {
    expect(buildEligibilityRequest270({ ...req, service_type_code: "47" })).toContain("EQ*47");
  });
});

// ── Eligibility 271 Parser ──────────────────────────────────

describe("parseEligibilityResponse271", () => {
  test("parses active coverage", () => {
    const raw = "NM1*PR*2*Aetna~EB*1~EB*B****30.00~EB*C****500.00~";
    const r = parseEligibilityResponse271(raw);
    expect(r.eligible).toBe(true);
    expect(r.coverage_status).toBe("active");
    expect(r.payer_name).toBe("Aetna");
    expect(r.copay_cents).toBe(3000);
    expect(r.deductible_cents).toBe(50000);
  });

  test("parses inactive coverage", () => {
    const r = parseEligibilityResponse271("EB*6~");
    expect(r.eligible).toBe(false);
    expect(r.coverage_status).toBe("inactive");
  });

  test("parses prior auth required", () => {
    const r = parseEligibilityResponse271("EB*1~EB*Y~");
    expect(r.prior_auth_required).toBe(true);
  });

  test("parses errors", () => {
    const r = parseEligibilityResponse271("AAA*N*72*Unable to verify~");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("Unable to verify");
  });

  test("handles empty response", () => {
    const r = parseEligibilityResponse271("");
    expect(r.eligible).toBe(false);
    expect(r.coverage_status).toBe("unknown");
  });
});

// ── 277 Status Parser ───────────────────────────────────────

describe("parseClaimStatus277", () => {
  test("parses accepted status", () => {
    const raw = "TRN*1*CLM-001~STC*A0:accepted*20260315*Claim accepted~";
    const statuses = parseClaimStatus277(raw);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].claim_id).toBe("CLM-001");
    expect(statuses[0].status).toBe("accepted");
    expect(statuses[0].status_message).toBe("Claim accepted");
  });

  test("parses rejected status", () => {
    const statuses = parseClaimStatus277("TRN*1*CLM-002~STC*R0:rejected*20260315*Invalid format~");
    expect(statuses[0].status).toBe("rejected");
  });

  test("parses paid status", () => {
    const statuses = parseClaimStatus277("TRN*1*CLM-003~STC*F0:finalized*20260315*Payment issued~");
    expect(statuses[0].status).toBe("paid");
  });

  test("parses denied status", () => {
    expect(parseClaimStatus277("TRN*1*CLM-004~STC*D0:denied~")[0].status).toBe("denied");
  });

  test("handles multiple claims", () => {
    const raw = "TRN*1*CLM-A~STC*A0~TRN*1*CLM-B~STC*P0~";
    const statuses = parseClaimStatus277(raw);
    expect(statuses).toHaveLength(2);
    expect(statuses[0].claim_id).toBe("CLM-A");
    expect(statuses[1].claim_id).toBe("CLM-B");
    expect(statuses[1].status).toBe("pending");
  });

  test("handles empty input", () => {
    expect(parseClaimStatus277("")).toHaveLength(0);
  });
});

// ── E2E Scenarios ───────────────────────────────────────────

describe("E2E: clearinghouse scenarios", () => {
  test("eligibility check: build 270 -> parse 271 response", () => {
    const req: EligibilityRequest = {
      payer_id: "aetna", subscriber_id: "SUB-123", member_id: "MEM-456",
      patient_first_name: "Jane", patient_last_name: "Doe", patient_dob: "1985-06-15",
    };
    const edi270 = buildEligibilityRequest270(req);
    expect(edi270).toContain("ST*270");

    // Simulated 271 response
    const response271 = "NM1*PR*2*Aetna~EB*1~EB*B****25.00~EB*C****250.00~EB*A****20~";
    const eligibility = parseEligibilityResponse271(response271);
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.copay_cents).toBe(2500);
    expect(eligibility.deductible_cents).toBe(25000);
    expect(eligibility.coinsurance_percent).toBe(2000); // 20% as cents-like
  });

  test("error classification -> retry decision -> execution", async () => {
    // Classify a transient error
    const err = classifyError("503", "Service unavailable");
    expect(err.retryable).toBe(true);

    // Check retry is allowed
    const submissionErr: SubmissionError = { code: "503", message: "Service unavailable", ...err };
    expect(shouldRetry(submissionErr, 0)).toBe(true);
    expect(shouldRetry(submissionErr, 2)).toBe(true);
    expect(shouldRetry(submissionErr, 3)).toBe(false); // exhausted

    // Execute with retry (succeeds on attempt 2)
    let attempts = 0;
    const result = await executeWithRetry(
      async () => {
        attempts++;
        if (attempts < 2) throw new Error("503");
        return "success";
      },
      () => true,
      { max_attempts: 3, base_delay_ms: 1, max_delay_ms: 10, backoff_factor: 2 },
    );
    expect(result).toBe("success");
    expect(attempts).toBe(2);
  });
});
