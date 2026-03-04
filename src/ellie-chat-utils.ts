/**
 * Pure helper utilities extracted from ellie-chat-handler.ts (ELLIE-512).
 * Zero external dependencies — safe to import in unit tests without any mocking.
 */

/** Channel ID for the Forest Editor inline command bar. */
export const COMMAND_BAR_CHANNEL_ID = "a0000000-0000-0000-0000-000000000100";

/**
 * Extract a [scope: X] prefix from command bar messages.
 *
 * When channelId matches the command bar, messages may start with
 * "[scope: 2/1]" — strip that prefix and return the scope path.
 * Returns { scopePath: null, strippedText: text } when not applicable.
 */
export function extractCommandBarScope(
  text: string,
  channelId: string | undefined,
): { scopePath: string | null; strippedText: string } {
  if (channelId !== COMMAND_BAR_CHANNEL_ID) {
    return { scopePath: null, strippedText: text };
  }
  const scopeMatch = text.match(/^\[scope:\s*([^\]]+)\]\s*/);
  if (!scopeMatch) return { scopePath: null, strippedText: text };
  return { scopePath: scopeMatch[1].trim(), strippedText: text.slice(scopeMatch[0].length) };
}

/**
 * Extract the first Plane-style work item ID (e.g. ELLIE-512, EVE-3) from text.
 * Returns null if none found.
 */
export function extractWorkItemId(text: string): string | null {
  return text.match(/\b([A-Z]+-\d+)\b/)?.[1] ?? null;
}

/**
 * Classify agent routing: specialist vs general, and single vs multi-step.
 *
 * @param agentName     The resolved agent name from routeAndDispatch.
 * @param executionMode The route's execution_mode (e.g. "single", "pipeline", "fan-out").
 * @param skillCount    Number of skills in the route (0 = no multi-step).
 */
export function classifyRoute(
  agentName: string,
  executionMode: string | undefined,
  skillCount: number,
): { isSpecialist: boolean; isMultiStep: boolean } {
  return {
    isSpecialist: agentName !== "general",
    isMultiStep: executionMode !== "single" && skillCount > 0,
  };
}
