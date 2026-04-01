/**
 * Markdown Fixer — ELLIE-787
 * Post-processing step that fixes common markdown formatting issues
 * in agent responses, particularly missing blank lines before lists.
 */

const LIST_ITEM_RE = /^(\d+[\.\)]\s|[-*+]\s)/;
const HEADING_RE = /^#{1,6}\s/;
const CODE_FENCE_RE = /^```/;
const HORIZONTAL_RULE_RE = /^-{3,}\s*$/;

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function isListItem(line: string): boolean {
  return LIST_ITEM_RE.test(line);
}

function isHeading(line: string): boolean {
  return HEADING_RE.test(line);
}

function isCodeFence(line: string): boolean {
  return CODE_FENCE_RE.test(line);
}

function isHorizontalRule(line: string): boolean {
  return HORIZONTAL_RULE_RE.test(line);
}

/**
 * Ensure blank lines exist before the start of a list block.
 * Only adds before the first item — not between consecutive list items.
 */
export function fixListSpacing(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = i > 0 ? lines[i - 1] : undefined;
    const next = i < lines.length - 1 ? lines[i + 1] : undefined;

    // Add blank line before start of list block
    if (isListItem(line) && prev !== undefined && !isBlank(prev) && !isListItem(prev)) {
      result.push("");
    }
    result.push(line);
    // Add blank line after end of list block
    if (isListItem(line) && next !== undefined && !isBlank(next) && !isListItem(next)) {
      result.push("");
    }
  }

  return result.join("\n");
}

/**
 * Ensure blank lines exist before headings (## etc.)
 */
export function fixHeadingSpacing(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = i > 0 ? lines[i - 1] : undefined;

    if (isHeading(line) && prev !== undefined && !isBlank(prev)) {
      result.push("");
    }
    result.push(line);
  }

  return result.join("\n");
}

/**
 * Ensure blank lines exist before code blocks (```)
 */
export function fixCodeBlockSpacing(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = i > 0 ? lines[i - 1] : undefined;

    if (isCodeFence(line)) {
      if (!inCodeBlock && prev !== undefined && !isBlank(prev)) {
        result.push("");
      }
      inCodeBlock = !inCodeBlock;
    }
    result.push(line);
  }

  return result.join("\n");
}

/**
 * Ensure blank lines exist before and after horizontal rules (---).
 * Also splits inline `---` onto its own line when surrounded by text.
 */
export function fixHorizontalRuleSpacing(text: string): string {
  // First pass: split inline `---` onto its own line
  // Matches " --- " (with surrounding text) mid-line
  let normalized = text.replace(/([^\n]) ---( )/g, "$1\n\n---\n\n");
  // Handle trailing " ---" at end of line (no text after)
  normalized = normalized.replace(/([^\n]) ---$/gm, "$1\n\n---");

  // Second pass: ensure blank lines around standalone --- lines
  const lines = normalized.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = i > 0 ? lines[i - 1] : undefined;
    const next = i < lines.length - 1 ? lines[i + 1] : undefined;

    if (isHorizontalRule(line)) {
      if (prev !== undefined && !isBlank(prev)) {
        result.push("");
      }
      result.push(line);
      if (next !== undefined && !isBlank(next)) {
        result.push("");
      }
    } else {
      result.push(line);
    }
  }

  return result.join("\n");
}

/**
 * Collapse excessive blank lines — normalize to standard paragraph separation (one blank line).
 */
export function collapseExcessiveBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

/**
 * Full markdown fix pipeline — apply all fixes in order.
 */
export function fixMarkdown(text: string): string {
  let result = text;
  result = fixListSpacing(result);
  result = fixHeadingSpacing(result);
  result = fixCodeBlockSpacing(result);
  result = fixHorizontalRuleSpacing(result);
  result = collapseExcessiveBlankLines(result);
  return result;
}
