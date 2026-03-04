/**
 * Relay Epoch — ELLIE-480
 *
 * A UUID generated fresh each time the relay process starts.
 * Used to detect orphaned state from previous relay instances:
 *
 *   - New agent_sessions are tagged with this epoch in metadata.
 *   - On startup, the reconciler closes any sessions whose epoch
 *     doesn't match (i.e. created by a previous relay instance).
 *
 * This is a process-level singleton — all modules that import
 * RELAY_EPOCH in the same process get the same value.
 */

import { randomUUID } from "node:crypto";

/** Unique identifier for this relay process instance. */
export const RELAY_EPOCH: string = randomUUID();
