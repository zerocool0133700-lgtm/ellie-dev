/**
 * Layered Prompt Orchestrator
 *
 * Replaces the 13-source _gatherContextSources() pipeline with three distinct layers:
 *   Layer 1: Identity (always loaded, cached .md files)
 *   Layer 2: Awareness (structured state, mode-filtered)
 *   Layer 3: Knowledge (on-demand Forest retrieval, scoped)
 */

import { log } from "../logger.ts";
import { detectLayeredMode } from "../context-mode";
import { renderIdentityBlock } from "./identity";
import { buildAwareness, filterAwarenessByMode } from "./awareness";
import { retrieveKnowledge, renderKnowledge } from "./knowledge";
import type { LayeredMode, LayeredPromptResult } from "./types";

const logger = log.child("prompt:layers");

const TOTAL_BUDGET_BYTES = 10240; // 10KB total budget

/**
 * Build the full layered prompt context.
 *
 * @param message - User message (null for heartbeat)
 * @param channel - Channel identifier (telegram, ellie-chat, voice, vscode, etc.)
 * @param agent - Active agent name
 * @param supabase - Supabase client for awareness queries
 * @param modeOverride - Force a specific mode (for testing or explicit mode switches)
 */
export async function buildLayeredContext(
  message: string | null,
  channel: string | null,
  agent: string = "ellie",
  supabase: any = null,
  modeOverride?: LayeredMode,
): Promise<LayeredPromptResult> {
  const start = Date.now();

  // 1. Detect mode
  const { mode, signal } = modeOverride
    ? { mode: modeOverride, signal: `override:${modeOverride}` }
    : detectLayeredMode(message, channel);

  logger.info({ mode, signal, channel }, "Layered prompt: mode detected");

  // 2. Build all three layers in parallel
  const [identity, awareness, knowledgeResult] = await Promise.all([
    renderIdentityBlock(),
    buildAwareness(supabase).then(a => filterAwarenessByMode(a, mode)),
    retrieveKnowledge(message, mode, agent),
  ]);

  const knowledge = renderKnowledge(knowledgeResult);

  // 3. Check total budget
  const encoder = new TextEncoder();
  const totalBytes = encoder.encode(identity).length +
    encoder.encode(awareness).length +
    encoder.encode(knowledge).length;

  if (totalBytes > TOTAL_BUDGET_BYTES) {
    logger.warn({ totalBytes, budget: TOTAL_BUDGET_BYTES, mode },
      "Layered prompt exceeds budget — knowledge will be trimmed");
  }

  const elapsed = Date.now() - start;
  logger.info({ mode, totalBytes, elapsed }, "Layered prompt built");

  return {
    identity,
    awareness,
    knowledge,
    mode,
    totalBytes,
  };
}

// Re-export for consumers
export { detectLayeredMode } from "../context-mode";
export type { LayeredMode, LayeredPromptResult } from "./types";
