/**
 * Heartbeat Init — ELLIE-1164
 * Bootstrap heartbeat on relay startup, shutdown on exit.
 */

import { log } from "../logger.ts";
import { startHeartbeat, stopHeartbeat } from "./timer.ts";
import { getHeartbeatState } from "./state.ts";

const logger = log.child("heartbeat-init");

export async function initHeartbeat(): Promise<void> {
  const state = await getHeartbeatState();
  if (!state) {
    logger.warn("heartbeat_state not found, skipping init");
    return;
  }
  if (!state.enabled) {
    logger.info("Heartbeat disabled in config");
    return;
  }
  startHeartbeat();
  logger.info("Heartbeat initialized", { interval_ms: state.interval_ms, sources: state.sources });
}

export async function shutdownHeartbeat(): Promise<void> {
  stopHeartbeat();
  logger.info("Heartbeat stopped");
}
