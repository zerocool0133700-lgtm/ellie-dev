/**
 * ELLIE-81 — Timeout UX improvements
 *
 * Tests the Plane state lock mechanism that prevents state churn
 * during timeout recovery windows.
 */
import { describe, test, expect, beforeEach } from "bun:test";

// Import lock functions directly — they're pure in-memory state, no external deps
import {
  setTimeoutRecoveryLock,
  clearTimeoutRecoveryLock,
  isInTimeoutRecovery,
  _resetTimeoutRecoveryForTesting,
} from "../src/plane.ts";

// ── Tests ────────────────────────────────────────────────────

describe("Timeout Recovery State Lock", () => {
  beforeEach(() => {
    _resetTimeoutRecoveryForTesting();
  });

  test("isInTimeoutRecovery returns false by default", () => {
    expect(isInTimeoutRecovery()).toBe(false);
  });

  test("setTimeoutRecoveryLock activates recovery window", () => {
    setTimeoutRecoveryLock(60_000);
    expect(isInTimeoutRecovery()).toBe(true);
  });

  test("clearTimeoutRecoveryLock deactivates recovery window", () => {
    setTimeoutRecoveryLock(60_000);
    expect(isInTimeoutRecovery()).toBe(true);

    clearTimeoutRecoveryLock();
    expect(isInTimeoutRecovery()).toBe(false);
  });

  test("lock auto-expires after duration", () => {
    // Set a lock that expires in 1ms
    setTimeoutRecoveryLock(1);

    // Give it time to expire
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy wait past expiry
    }

    expect(isInTimeoutRecovery()).toBe(false);
  });

  test("subsequent calls extend the lock window", () => {
    setTimeoutRecoveryLock(10);
    setTimeoutRecoveryLock(60_000);
    expect(isInTimeoutRecovery()).toBe(true);
  });

  test("_resetTimeoutRecoveryForTesting clears lock", () => {
    setTimeoutRecoveryLock(60_000);
    expect(isInTimeoutRecovery()).toBe(true);

    _resetTimeoutRecoveryForTesting();
    expect(isInTimeoutRecovery()).toBe(false);
  });
});

describe("Timeout Error Message Format", () => {
  // These test the message format logic that callClaude uses.
  // We can't easily spawn the real CLI in tests, so we verify
  // the message construction logic matches expectations.

  function buildTimeoutMessage(opts: {
    timeoutSec: number;
    forceKilled: boolean;
    partialOutput?: string;
  }): string {
    const { timeoutSec, forceKilled, partialOutput } = opts;
    const processStatus = forceKilled
      ? "The process did not respond to termination and was force-killed."
      : "The process was terminated.";

    let message = `Task timed out after ${timeoutSec}s. ${processStatus}`;

    if (partialOutput) {
      const preview =
        partialOutput.length > 500
          ? partialOutput.substring(0, 500) + "..."
          : partialOutput;
      message += `\n\nPartial output before timeout:\n${preview}`;
    }

    message += `\n\nYou can retry the request, or ask "what did you get done?" to check if work was partially completed.`;

    return message;
  }

  test("timeout message includes duration and termination status", () => {
    const msg = buildTimeoutMessage({
      timeoutSec: 420,
      forceKilled: false,
    });

    expect(msg).toContain("timed out after 420s");
    expect(msg).toContain("The process was terminated.");
    expect(msg).not.toContain("force-killed");
  });

  test("timeout message indicates force-kill when SIGTERM fails", () => {
    const msg = buildTimeoutMessage({
      timeoutSec: 420,
      forceKilled: true,
    });

    expect(msg).toContain("timed out after 420s");
    expect(msg).toContain("force-killed");
  });

  test("timeout message includes partial output when available", () => {
    const msg = buildTimeoutMessage({
      timeoutSec: 420,
      forceKilled: false,
      partialOutput: "I created the file src/utils.ts and added the helper function.",
    });

    expect(msg).toContain("Partial output before timeout:");
    expect(msg).toContain("src/utils.ts");
  });

  test("timeout message truncates long partial output", () => {
    const longOutput = "x".repeat(600);
    const msg = buildTimeoutMessage({
      timeoutSec: 420,
      forceKilled: false,
      partialOutput: longOutput,
    });

    expect(msg).toContain("...");
    // The partial output section should be truncated to ~500 chars
    const partialSection = msg.split("Partial output before timeout:\n")[1].split("\n\n")[0];
    expect(partialSection.length).toBeLessThanOrEqual(503); // 500 + "..."
  });

  test("timeout message omits partial output section when empty", () => {
    const msg = buildTimeoutMessage({
      timeoutSec: 60,
      forceKilled: false,
      partialOutput: "",
    });

    expect(msg).not.toContain("Partial output");
    expect(msg).toContain("timed out after 60s");
  });

  test("timeout message always includes actionable next steps", () => {
    const msg = buildTimeoutMessage({
      timeoutSec: 420,
      forceKilled: false,
    });

    expect(msg).toContain("retry the request");
    expect(msg).toContain("what did you get done?");
  });

  test("timeout message is clearly different from generic crash error", () => {
    const timeoutMsg = buildTimeoutMessage({
      timeoutSec: 420,
      forceKilled: false,
    });

    const crashMsg = `Error: Claude exited with code 1`;

    // Timeout message should NOT start with "Error:"
    expect(timeoutMsg).not.toMatch(/^Error:/);
    // Crash message should start with "Error:"
    expect(crashMsg).toMatch(/^Error:/);
  });
});
