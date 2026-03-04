/**
 * ELLIE-479 — resilientTask fire-and-forget resilience
 *
 * Verifies that:
 * - critical tasks retry up to 3× with backoff, then record a final failure
 * - best-effort tasks fail immediately without retry
 * - cosmetic tasks fail immediately and are NOT tracked in metrics
 * - getFireForgetMetrics() returns correct summary + per-operation records
 * - custom opts override the default retry/delay behaviour
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  resilientTask,
  getFireForgetMetrics,
  _resetMetricsForTesting,
} from "../src/resilient-task.ts";

// Short drain after fire-and-forget calls so the async IIFE finishes
const drain = (ms = 100) => new Promise<void>(r => setTimeout(r, ms));

// Unique label helper so tests never share counters
let _seq = 0;
const uid = (prefix: string) => `${prefix}-${++_seq}`;

beforeEach(() => {
  _resetMetricsForTesting();
});

// ── critical category ─────────────────────────────────────────

describe("resilientTask — critical", () => {
  test("succeeds on first try — increments totalSuccesses, no failures", async () => {
    const label = uid("ok");
    let calls = 0;
    resilientTask(label, "critical", async () => { calls++; }, { baseDelayMs: 1 });
    await drain();

    expect(calls).toBe(1);
    const { summary, operations } = getFireForgetMetrics();
    const op = operations.find(o => o.label === label);
    expect(op?.totalSuccesses).toBe(1);
    expect(op?.totalFailures).toBe(0);
    expect(op?.totalRetries).toBe(0);
    expect(summary.totalSuccesses).toBe(1);
    expect(summary.totalFailures).toBe(0);
  });

  test("retries 3× then records final failure — fn called 4× total", async () => {
    const label = uid("always-fail");
    let calls = 0;
    resilientTask(label, "critical", async () => {
      calls++;
      throw new Error("boom");
    }, { baseDelayMs: 1, maxDelayMs: 5 });
    await drain(200);

    expect(calls).toBe(4); // 1 initial + 3 retries
    const { operations } = getFireForgetMetrics();
    const op = operations.find(o => o.label === label);
    expect(op?.totalFailures).toBe(1);
    expect(op?.totalRetries).toBe(3);
    expect(op?.totalSuccesses).toBe(0);
  });

  test("succeeds on 2nd attempt after 1 failure — totalRetries:1 totalSuccesses:1", async () => {
    const label = uid("fail-once");
    let calls = 0;
    resilientTask(label, "critical", async () => {
      calls++;
      if (calls < 2) throw new Error("transient");
    }, { baseDelayMs: 1, maxDelayMs: 5 });
    await drain(200);

    expect(calls).toBe(2);
    const { operations } = getFireForgetMetrics();
    const op = operations.find(o => o.label === label);
    expect(op?.totalRetries).toBe(1);
    expect(op?.totalSuccesses).toBe(1);
    expect(op?.totalFailures).toBe(0);
  });

  test("records lastError and lastFailure timestamp on final failure", async () => {
    const label = uid("record-err");
    const before = Date.now();
    resilientTask(label, "critical", async () => {
      throw new Error("specific-error-message");
    }, { baseDelayMs: 1, maxDelayMs: 5 });
    await drain(200);

    const { operations } = getFireForgetMetrics();
    const op = operations.find(o => o.label === label);
    expect(op?.lastError).toBe("specific-error-message");
    expect(op?.lastFailure).toBeGreaterThanOrEqual(before);
    expect(op?.lastFailure).toBeLessThanOrEqual(Date.now());
  });

  test("multiple successful calls accumulate totalSuccesses", async () => {
    const label = uid("multi-ok");
    resilientTask(label, "critical", async () => {}, { baseDelayMs: 1 });
    resilientTask(label, "critical", async () => {}, { baseDelayMs: 1 });
    resilientTask(label, "critical", async () => {}, { baseDelayMs: 1 });
    await drain();

    const { operations } = getFireForgetMetrics();
    const op = operations.find(o => o.label === label);
    expect(op?.totalSuccesses).toBe(3);
  });
});

// ── best-effort category ──────────────────────────────────────

describe("resilientTask — best-effort", () => {
  test("failure — fn called once, no retry, totalRetries:0 totalFailures:1", async () => {
    const label = uid("be-fail");
    let calls = 0;
    resilientTask(label, "best-effort", async () => {
      calls++;
      throw new Error("fail");
    }, { baseDelayMs: 1 });
    await drain();

    expect(calls).toBe(1);
    const { operations } = getFireForgetMetrics();
    const op = operations.find(o => o.label === label);
    expect(op?.totalRetries).toBe(0);
    expect(op?.totalFailures).toBe(1);
  });

  test("success — increments totalSuccesses, no retries", async () => {
    const label = uid("be-ok");
    resilientTask(label, "best-effort", async () => {}, { baseDelayMs: 1 });
    await drain();

    const { operations } = getFireForgetMetrics();
    const op = operations.find(o => o.label === label);
    expect(op?.totalSuccesses).toBe(1);
    expect(op?.totalRetries).toBe(0);
  });
});

// ── cosmetic category ─────────────────────────────────────────

describe("resilientTask — cosmetic", () => {
  test("failure — fn called once, no retry, failure still recorded in metrics", async () => {
    const label = uid("cosmetic-fail");
    let calls = 0;
    resilientTask(label, "cosmetic", async () => {
      calls++;
      throw new Error("minor-fail");
    }, { baseDelayMs: 1 });
    await drain();

    expect(calls).toBe(1);
    // cosmetic records failures (no retry, no error-level log — but still tracked)
    const { operations } = getFireForgetMetrics();
    const op = operations.find(o => o.label === label);
    expect(op?.totalFailures).toBe(1);
    expect(op?.totalRetries).toBe(0);
  });

  test("success — totalSuccesses incremented, totalFailures stays 0", async () => {
    const label = uid("cosmetic-ok");
    resilientTask(label, "cosmetic", async () => {}, { baseDelayMs: 1 });
    await drain();

    const { operations } = getFireForgetMetrics();
    const op = operations.find(o => o.label === label);
    expect(op?.totalSuccesses).toBe(1);
    expect(op?.totalFailures).toBe(0);
  });
});

// ── custom opts ───────────────────────────────────────────────

describe("resilientTask — custom opts", () => {
  test("maxRetries:1 — fn called 2× total, not 4×", async () => {
    const label = uid("custom-1retry");
    let calls = 0;
    resilientTask(label, "critical", async () => {
      calls++;
      throw new Error("fail");
    }, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 });
    await drain(100);

    expect(calls).toBe(2); // 1 initial + 1 retry
    const { operations } = getFireForgetMetrics();
    const op = operations.find(o => o.label === label);
    expect(op?.totalRetries).toBe(1);
    expect(op?.totalFailures).toBe(1);
  });

  test("maxRetries:0 on critical — fn called once, immediate failure", async () => {
    const label = uid("custom-0retry");
    let calls = 0;
    resilientTask(label, "critical", async () => {
      calls++;
      throw new Error("fail");
    }, { maxRetries: 0, baseDelayMs: 1 });
    await drain();

    expect(calls).toBe(1);
    const { operations } = getFireForgetMetrics();
    const op = operations.find(o => o.label === label);
    expect(op?.totalRetries).toBe(0);
    expect(op?.totalFailures).toBe(1);
  });
});

// ── getFireForgetMetrics ──────────────────────────────────────

describe("getFireForgetMetrics", () => {
  test("returns empty summary and empty operations after reset", () => {
    const { summary, operations } = getFireForgetMetrics();
    expect(summary.totalFailures).toBe(0);
    expect(summary.totalRetries).toBe(0);
    expect(summary.totalSuccesses).toBe(0);
    expect(operations).toHaveLength(0);
  });

  test("summary aggregates across multiple operations", async () => {
    const a = uid("agg-a");
    const b = uid("agg-b");
    resilientTask(a, "critical", async () => {}, { baseDelayMs: 1 });
    resilientTask(b, "critical", async () => { throw new Error("x"); }, { maxRetries: 0, baseDelayMs: 1 });
    await drain();

    const { summary } = getFireForgetMetrics();
    expect(summary.totalSuccesses).toBe(1);
    expect(summary.totalFailures).toBe(1);
  });

  test("only reports operations that have actually run", async () => {
    const label = uid("ran");
    resilientTask(label, "critical", async () => {}, { baseDelayMs: 1 });
    await drain();

    const { operations } = getFireForgetMetrics();
    expect(operations.every(o => o.totalFailures > 0 || o.totalSuccesses > 0)).toBe(true);
  });
});

// ── concurrent / independent tasks ───────────────────────────

describe("resilientTask — concurrent tasks", () => {
  test("two tasks run independently — failure in A does not affect B", async () => {
    const a = uid("concurrent-a");
    const b = uid("concurrent-b");
    let bCalls = 0;

    resilientTask(a, "best-effort", async () => { throw new Error("A fails"); }, { baseDelayMs: 1 });
    resilientTask(b, "best-effort", async () => { bCalls++; }, { baseDelayMs: 1 });
    await drain();

    expect(bCalls).toBe(1);
    const { operations } = getFireForgetMetrics();
    const opA = operations.find(o => o.label === a);
    const opB = operations.find(o => o.label === b);
    expect(opA?.totalFailures).toBe(1);
    expect(opB?.totalSuccesses).toBe(1);
    expect(opB?.totalFailures).toBe(0);
  });

  test("three tasks dispatched concurrently all complete", async () => {
    const labels = [uid("c"), uid("c"), uid("c")];
    let calls = 0;
    for (const label of labels) {
      resilientTask(label, "critical", async () => { calls++; }, { baseDelayMs: 1 });
    }
    await drain();
    expect(calls).toBe(3);
  });
});
