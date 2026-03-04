/**
 * Global test setup — runs before all tests via bunfig.toml preload
 *
 * Ensures test isolation by resetting shared module state before each test.
 * This prevents test pollution where one test's side effects leak into another.
 */

console.log("[test-setup] Global test setup loaded");

import { beforeEach, afterEach } from "bun:test";
import { clearPendingMemoryQueue } from "../../src/memory.ts";
import { breakers } from "../../src/resilience.ts";
import { resetBreaker as resetElasticsearchBreaker } from "../../src/elasticsearch/circuit-breaker.ts";

/**
 * Reset all shared module-level state before each test.
 * This runs globally for ALL tests, not just those that explicitly import this file.
 */
let testCount = 0;
beforeEach(() => {
  testCount++;
  if (testCount <= 5) {
    console.log(`[test-setup] beforeEach called (test #${testCount})`);
  }

  // Reset circuit breakers
  breakers.plane.reset();
  breakers.bridge.reset();
  breakers.outlook.reset();
  breakers.googleChat.reset();
  breakers.edgeFn.reset();
  resetElasticsearchBreaker();

  // Reset memory module state
  clearPendingMemoryQueue();

  // Reset logger mock if tests have replaced it
  // (some tests mock console.log/debug, need to restore)
  // Note: Individual tests should restore their own mocks in afterEach
});

/**
 * Optional cleanup after each test.
 * Currently no global cleanup needed, but keeping this hook for future use.
 */
afterEach(() => {
  // Global cleanup if needed
});
