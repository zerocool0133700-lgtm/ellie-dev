/**
 * Dispatch Advice Injector — ELLIE-571
 *
 * Before dispatching a retry agent, checks River for relevant post-mortems
 * and injects dispatch adjustments into the agent's prompt context.
 *
 * Two layers:
 *  - Pure: enrichPromptWithAdvice (appends advice to work item context)
 *  - Effectful: getAdviceForDispatch (fetches from River, formats, returns enrichment)
 */

import { getDispatchAdvice, formatAdviceForPrompt, type DispatchAdvice } from "./post-mortem.ts";
import { searchRiver } from "./api/bridge-river.ts";
import { log } from "./logger.ts";

const logger = log.child("dispatch-advice");

// ── Pure: Enrich prompt context with advice ───────────────────────────────────

/**
 * Append formatted post-mortem advice to the existing work item context.
 * Returns the original context unchanged if no advice is available.
 */
export function enrichPromptWithAdvice(
  workItemContext: string,
  advice: DispatchAdvice,
): string {
  const formatted = formatAdviceForPrompt(advice);
  if (!formatted) return workItemContext;
  return `${workItemContext}\n\n${formatted}`;
}

// ── Effectful: Fetch and format advice ────────────────────────────────────────

/**
 * Fetch post-mortem advice for a work item before dispatch.
 * Non-fatal: returns null on any error so dispatch is never blocked.
 */
export async function getAdviceForDispatch(
  workItemId: string,
  searchFn: typeof searchRiver = searchRiver,
): Promise<DispatchAdvice | null> {
  try {
    const advice = await getDispatchAdvice(workItemId, searchFn);
    if (advice.relevantPostMortems.length === 0) return null;

    logger.info("Post-mortem advice found for dispatch", {
      workItemId,
      postMortemCount: advice.relevantPostMortems.length,
      patterns: advice.patternsSeen,
    });

    return advice;
  } catch (err) {
    logger.warn("getAdviceForDispatch failed (non-fatal)", err);
    return null;
  }
}
