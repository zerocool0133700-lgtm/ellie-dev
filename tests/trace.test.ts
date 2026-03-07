/**
 * ELLIE-559 — trace.ts tests
 *
 * Tests trace ID generation, async context propagation.
 */

import { describe, test, expect } from "bun:test";
import {
  generateTraceId,
  getTraceId,
  withTrace,
  withTraceAsync,
} from "../src/trace.ts";

// ── generateTraceId ─────────────────────────────────────────

describe("generateTraceId", () => {
  test("returns 16-character hex string", () => {
    const id = generateTraceId();
    expect(id.length).toBe(16);
    expect(/^[0-9a-f]{16}$/.test(id)).toBe(true);
  });

  test("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
    expect(ids.size).toBe(100);
  });
});

// ── getTraceId ──────────────────────────────────────────────

describe("getTraceId", () => {
  test("returns null outside trace context", () => {
    expect(getTraceId()).toBeNull();
  });
});

// ── withTrace ───────────────────────────────────────────────

describe("withTrace", () => {
  test("sets trace ID within callback", () => {
    const captured = withTrace(() => getTraceId());
    expect(captured).not.toBeNull();
    expect(captured!.length).toBe(16);
  });

  test("uses provided trace ID", () => {
    const id = withTrace(() => getTraceId(), "custom1234567890");
    expect(id).toBe("custom1234567890");
  });

  test("trace ID not visible after callback", () => {
    withTrace(() => {});
    expect(getTraceId()).toBeNull();
  });

  test("nested traces get new IDs", () => {
    withTrace(() => {
      const outer = getTraceId();
      withTrace(() => {
        const inner = getTraceId();
        expect(inner).not.toBe(outer);
      });
      expect(getTraceId()).toBe(outer);
    });
  });
});

// ── withTraceAsync ──────────────────────────────────────────

describe("withTraceAsync", () => {
  test("sets trace ID in async callback", async () => {
    const captured = await withTraceAsync(async () => {
      await new Promise(r => setTimeout(r, 1));
      return getTraceId();
    });
    expect(captured).not.toBeNull();
  });

  test("uses provided trace ID", async () => {
    const id = await withTraceAsync(async () => getTraceId(), "async123456789a");
    expect(id).toBe("async123456789a");
  });

  test("propagates across async boundaries", async () => {
    await withTraceAsync(async () => {
      const before = getTraceId();
      await new Promise(r => setTimeout(r, 1));
      const after = getTraceId();
      expect(before).toBe(after);
    });
  });
});
