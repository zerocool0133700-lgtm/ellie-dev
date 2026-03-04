/**
 * ELLIE-XXX — Test isolation: Reset shared module state
 *
 * Many modules have module-level mutable state (arrays, Maps, Sets, caches).
 * This helper provides a central function to reset all shared state between tests.
 *
 * Usage in test files:
 *   import { resetAllSharedState } from "./helpers/reset-state.ts";
 *   beforeEach(() => resetAllSharedState());
 */

import { clearPendingMemoryQueue } from "../../src/memory.ts";

/**
 * Resets all module-level shared state across the codebase.
 * Call this in beforeEach() to ensure test isolation.
 */
export function resetAllSharedState(): void {
  // Memory module
  clearPendingMemoryQueue();

  // Reset other module-level state as needed
  // TODO: Add more reset functions as we identify shared state
}
