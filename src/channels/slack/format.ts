/**
 * Markdown → Slack mrkdwn conversion — ELLIE-443
 *
 * Claude outputs standard markdown; Slack expects mrkdwn which has a
 * different syntax for bold, italic, links, and no header support.
 *
 * Slack mrkdwn reference:
 *   *bold*   _italic_   ~strikethrough~   `inline`   ```block```
 *   <url|text>  for links    > for blockquotes (same as markdown)
 */

/**
 * Convert a markdown string to Slack mrkdwn.
 * Code content is protected from substitution so it passes through verbatim.
 */
export function markdownToMrkdwn(text: string): string {
  // ── 1. Protect code from all substitutions ──────────────────
  const protected_: string[] = []
  const protect = (s: string): string => {
    const idx = protected_.push(s) - 1
    return `\x00P${idx}\x00`
  }
  const restore = (s: string): string =>
    s.replace(/\x00P(\d+)\x00/g, (_, i) => protected_[Number(i)])

  // Fenced code blocks — strip language identifier (Slack doesn't support it)
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, content) =>
    protect(`\`\`\`\n${content.trimEnd()}\n\`\`\``)
  )
  // Inline code
  text = text.replace(/`([^`\n]+)`/g, (m) => protect(m))

  // ── 2. Links: [text](url) → <url|text> ─────────────────────
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')

  // ── 3. Headers: ## Heading → *Heading* ─────────────────────
  // Slack has no heading syntax — bold is the closest visual equivalent
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*')

  // ── 4. Horizontal rule ──────────────────────────────────────
  text = text.replace(/^---+$/gm, '──────────────')

  // ── 5. Bold then italic (order matters) ────────────────────
  // Use a placeholder so bold markers aren't re-matched as italic
  const BOLD = '\x01'
  text = text.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${BOLD}`)

  // Single-asterisk italic (remaining after bold extracted)
  text = text.replace(/(?<!\*)\*(?!\*)([^*\n]+?)(?<!\*)\*(?!\*)/g, '_$1_')

  // Restore bold
  text = text.replace(new RegExp(`${BOLD}(.+?)${BOLD}`, 'gs'), '*$1*')

  // ── 6. Strikethrough: ~~text~~ → ~text~ ────────────────────
  text = text.replace(/~~(.+?)~~/g, '~$1~')

  // ── 7. Restore protected code ───────────────────────────────
  return restore(text)
}
