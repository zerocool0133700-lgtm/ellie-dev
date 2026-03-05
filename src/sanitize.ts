/**
 * User Message Sanitization — ELLIE-555
 *
 * Neutralizes prompt injection vectors in user messages before they
 * are embedded into the Claude prompt by buildPrompt().
 *
 * Tags like [REMEMBER:], [MEMORY:], [CONFIRM:], [GOAL:], [DONE:],
 * and ELLIE:: playbook commands are only meant to be emitted by Claude
 * in its responses. If a user includes them in a message, they get
 * neutralized here so downstream tag parsers (memory.ts, approval.ts,
 * playbook.ts) never match them.
 *
 * This is a pure, synchronous function with no dependencies — safe to
 * call on every inbound message with negligible overhead.
 */

/**
 * Neutralize active tags and strip control characters from a user message.
 *
 * What it does:
 *   - Strips non-printable control characters (keeps \n, \r, \t for readability)
 *   - Neutralizes [REMEMBER:], [MEMORY:], [CONFIRM:], [GOAL:], [DONE:] tags
 *   - Neutralizes ELLIE:: playbook command prefix
 *
 * What it does NOT do:
 *   - Truncate (user messages can be legitimately long)
 *   - Strip markdown, code blocks, or normal punctuation
 *   - Modify the semantic meaning of the message
 */
export function sanitizeUserMessage(message: string): string {
  return message
    // Strip control characters except \t (0x09), \n (0x0A), \r (0x0D)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    // Neutralize response tags that downstream parsers match on
    .replace(/\[REMEMBER:/gi, "[_REMEMBER_:")
    .replace(/\[MEMORY:/gi, "[_MEMORY_:")
    .replace(/\[CONFIRM:/gi, "[_CONFIRM_:")
    .replace(/\[GOAL:/gi, "[_GOAL_:")
    .replace(/\[DONE:/gi, "[_DONE_:")
    // Neutralize playbook command prefix
    .replace(/ELLIE::/gi, "ELLIE__");
}
