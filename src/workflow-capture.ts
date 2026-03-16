/**
 * Workflow Capture Queue — ELLIE-766
 *
 * Detects workflow/process descriptions in conversations that
 * haven't been captured as River docs. Surfaces gaps as a queue.
 *
 * Pure module — pattern detection and queue management, no DB.
 */

// ── Types ────────────────────────────────────────────────────

export type WorkflowStatus = "detected" | "dismissed" | "captured";

export interface DetectedWorkflow {
  id: string;
  detected_at: string;
  status: WorkflowStatus;
  /** The workflow description extracted from conversation. */
  description: string;
  /** Source message or conversation excerpt. */
  source_text: string;
  /** Channel where it was detected. */
  channel: string;
  /** Suggested River doc key for this workflow. */
  suggested_key: string;
  /** Suggested River vault path. */
  suggested_path: string;
  /** Confidence score 0-1. */
  confidence: number;
  /** Pattern that matched. */
  pattern_matched: string;
}

export interface WorkflowQueueResult {
  total: number;
  pending: number;
  items: DetectedWorkflow[];
}

// ── Pattern Detection ───────────────────────────────────────

/** Patterns that indicate workflow/process descriptions. */
export const WORKFLOW_PATTERNS: { name: string; pattern: RegExp; keyPrefix: string }[] = [
  {
    name: "when-then",
    pattern: /when\s+(?:a|an|the|we|you|i)\s+(.{10,80}?),?\s+(?:then|we|you|i)\s+(.{10,80})/gi,
    keyPrefix: "workflow",
  },
  {
    name: "process-for",
    pattern: /(?:the\s+)?process\s+for\s+(.{10,80})\s+is/gi,
    keyPrefix: "process",
  },
  {
    name: "steps-to",
    pattern: /(?:steps?\s+to|how\s+to)\s+(.{10,80}?)(?:\:|\.|\n)/gi,
    keyPrefix: "howto",
  },
  {
    name: "always-do",
    pattern: /(?:always|never|make\s+sure\s+to|remember\s+to)\s+(.{10,80}?)(?:\.|\n|$)/gi,
    keyPrefix: "rule",
  },
  {
    name: "decision-pattern",
    pattern: /if\s+(.{10,60}?),?\s+(?:then|we\s+should|you\s+should)\s+(.{10,80})/gi,
    keyPrefix: "decision",
  },
  {
    name: "deploy-process",
    pattern: /(?:to\s+deploy|deployment\s+process|release\s+process)\s+(.{10,80}?)(?:\:|\.|\n)/gi,
    keyPrefix: "deploy",
  },
  {
    name: "checklist",
    pattern: /(?:before|after)\s+(?:deploying|releasing|shipping|pushing|merging)\s+(.{10,80}?)(?:\:|\.|\n)/gi,
    keyPrefix: "checklist",
  },
];

/**
 * Detect workflow patterns in a text.
 * Pure function.
 */
export function detectWorkflows(
  text: string,
  channel: string = "unknown",
): DetectedWorkflow[] {
  const results: DetectedWorkflow[] = [];

  for (const { name, pattern, keyPrefix } of WORKFLOW_PATTERNS) {
    // Reset regex lastIndex for global patterns
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const description = match[0].trim();
      const keySlug = slugify(match[1]?.trim().slice(0, 40) ?? description.slice(0, 40));
      const id = `wf-${Date.now()}-${results.length}`;

      results.push({
        id,
        detected_at: new Date().toISOString(),
        status: "detected",
        description,
        source_text: extractContext(text, match.index, 200),
        channel,
        suggested_key: `${keyPrefix}-${keySlug}`,
        suggested_path: `prompts/workflows/${keyPrefix}-${keySlug}.md`,
        confidence: computeConfidence(description, name),
        pattern_matched: name,
      });
    }
  }

  return deduplicateWorkflows(results);
}

/**
 * Detect workflows in multiple messages.
 */
export function detectWorkflowsInMessages(
  messages: { text: string; channel: string }[],
): DetectedWorkflow[] {
  const all: DetectedWorkflow[] = [];
  for (const msg of messages) {
    all.push(...detectWorkflows(msg.text, msg.channel));
  }
  return deduplicateWorkflows(all);
}

// ── Queue Management ────────────────────────────────────────

/** In-memory workflow queue (persists across requests within a relay session). */
let _queue: DetectedWorkflow[] = [];

/**
 * Add detected workflows to the queue, skipping duplicates.
 */
export function addToQueue(workflows: DetectedWorkflow[]): number {
  const existingKeys = new Set(_queue.map(w => w.suggested_key));
  let added = 0;
  for (const wf of workflows) {
    if (!existingKeys.has(wf.suggested_key)) {
      _queue.push(wf);
      existingKeys.add(wf.suggested_key);
      added++;
    }
  }
  return added;
}

/**
 * Get the current workflow queue.
 */
export function getQueue(opts: { status?: WorkflowStatus } = {}): WorkflowQueueResult {
  let items = [..._queue];
  if (opts.status) {
    items = items.filter(w => w.status === opts.status);
  }

  return {
    total: _queue.length,
    pending: _queue.filter(w => w.status === "detected").length,
    items,
  };
}

/**
 * Update the status of a workflow item.
 */
export function updateWorkflowStatus(id: string, status: WorkflowStatus): boolean {
  const item = _queue.find(w => w.id === id);
  if (!item) return false;
  item.status = status;
  return true;
}

/**
 * Clear the queue (for testing).
 */
export function clearQueue(): void {
  _queue = [];
}

/**
 * Set the queue directly (for testing or persistence restore).
 */
export function _setQueueForTesting(items: DetectedWorkflow[]): void {
  _queue = [...items];
}

// ── Cross-Reference ─────────────────────────────────────────

/**
 * Filter out workflows that are already captured in River docs.
 * Pure function.
 */
export function filterAlreadyCaptured(
  workflows: DetectedWorkflow[],
  existingDocKeys: Set<string>,
): DetectedWorkflow[] {
  return workflows.filter(wf => !existingDocKeys.has(wf.suggested_key));
}

// ── Obsidian Template ───────────────────────────────────────

/**
 * Build an obsidian:// URI that creates a new River doc from a template.
 */
export function buildCreateDocUri(workflow: DetectedWorkflow): string {
  const content = [
    "---",
    `name: ${workflow.suggested_key}`,
    `description: ${workflow.description.slice(0, 100)}`,
    "---",
    "",
    `## ${workflow.description}`,
    "",
    "<!-- Captured from conversation -->",
    `<!-- Source: ${workflow.channel} -->`,
    `<!-- Pattern: ${workflow.pattern_matched} -->`,
    "",
    "### Steps",
    "",
    "1. ",
    "",
    "### Notes",
    "",
    workflow.source_text,
  ].join("\n");

  const filePath = `ellie-river/${workflow.suggested_path}`.replace(/\.md$/, "");
  return `obsidian://new?vault=obsidian-vault&file=${encodeURIComponent(filePath)}&content=${encodeURIComponent(content)}`;
}

// ── Helpers ──────────────────────────────────────────────────

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function extractContext(text: string, index: number, maxLen: number): string {
  const start = Math.max(0, index - 50);
  const end = Math.min(text.length, index + maxLen);
  return text.slice(start, end).trim();
}

function computeConfidence(description: string, patternName: string): number {
  let score = 0.5;
  if (description.length > 30) score += 0.1;
  if (description.length > 60) score += 0.1;
  if (patternName === "process-for" || patternName === "steps-to") score += 0.15;
  if (patternName === "when-then" || patternName === "decision-pattern") score += 0.1;
  if (patternName === "always-do") score += 0.05;
  return Math.min(1, Math.round(score * 100) / 100);
}

function deduplicateWorkflows(workflows: DetectedWorkflow[]): DetectedWorkflow[] {
  const seen = new Set<string>();
  return workflows.filter(wf => {
    const key = wf.suggested_key;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
