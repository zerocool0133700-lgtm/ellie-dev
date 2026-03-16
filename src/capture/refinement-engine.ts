/**
 * Refinement Engine — ELLIE-770
 * Transforms raw conversation content into structured River-ready documents.
 * Pure functions with injected LLM dependency for testability.
 */

import type { CaptureContentType } from "../capture-queue.ts";

// Types

export interface RefinementInput {
  raw_content: string;
  channel: string;
  capture_type?: string;
  hint_content_type?: CaptureContentType;
  existing_paths?: string[];
}

export interface RefinementResult {
  content_type: CaptureContentType;
  confidence: number;
  title: string;
  suggested_path: string;
  suggested_section: string | null;
  markdown: string;
  frontmatter: Record<string, any>;
  summary: string;
}

export interface LLMProvider {
  complete(prompt: string): Promise<string>;
}

// Content type classification

const CONTENT_TYPE_SIGNALS: Record<CaptureContentType, string[]> = {
  workflow: ["steps", "process", "flow", "sequence", "first", "then", "next", "after that", "pipeline", "stage"],
  decision: ["decided", "chose", "picked", "went with", "option", "alternative", "because", "trade-off", "pros", "cons"],
  process: ["how to", "procedure", "always", "every time", "make sure", "don't forget", "checklist", "routine"],
  policy: ["must", "never", "always", "required", "policy", "rule", "compliance", "standard", "forbidden", "mandatory"],
  integration: ["api", "endpoint", "webhook", "connect", "sync", "integration", "service", "auth", "token", "url"],
  reference: ["info", "note", "fyi", "remember", "context", "background", "lookup", "definition"],
};

export function classifyContent(text: string, hint?: CaptureContentType): { type: CaptureContentType; confidence: number } {
  if (hint) {
    return { type: hint, confidence: 0.95 };
  }

  const lower = text.toLowerCase();
  const scores: Record<string, number> = {};

  for (const [type, signals] of Object.entries(CONTENT_TYPE_SIGNALS)) {
    let score = 0;
    for (const signal of signals) {
      if (lower.includes(signal)) score++;
    }
    scores[type] = score;
  }

  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const topScore = entries[0][1];
  const topType = entries[0][0] as CaptureContentType;

  if (topScore === 0) return { type: "reference", confidence: 0.3 };

  const secondScore = entries[1]?.[1] ?? 0;
  const gap = topScore - secondScore;
  const confidence = Math.min(0.5 + gap * 0.15 + topScore * 0.05, 0.95);

  return { type: topType, confidence: Math.round(confidence * 100) / 100 };
}

// Path suggestion

const TYPE_PATH_MAP: Record<CaptureContentType, string> = {
  workflow: "workflows",
  decision: "decisions",
  process: "processes",
  policy: "policies",
  integration: "integrations",
  reference: "reference",
};

export function suggestPath(title: string, contentType: CaptureContentType, existingPaths: string[] = []): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60)
    .replace(/-$/, "");

  const dir = TYPE_PATH_MAP[contentType] ?? "reference";
  const basePath = `${dir}/${slug}.md`;

  if (!existingPaths.includes(basePath)) return basePath;

  // Append date suffix if collision
  const date = new Date().toISOString().slice(0, 10);
  return `${dir}/${slug}-${date}.md`;
}

// Title extraction

export function extractTitle(text: string): string {
  // Try first sentence
  const firstLine = text.split("\n")[0].trim();
  if (firstLine.length <= 80 && firstLine.length >= 5) {
    return firstLine.replace(/[.!?:]+$/, "").trim();
  }

  // Take first 80 chars and trim to last word
  const truncated = text.slice(0, 80);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > 20) {
    return truncated.slice(0, lastSpace).replace(/[.!?:,]+$/, "").trim();
  }

  return truncated.trim();
}

// Frontmatter generation

export function buildFrontmatter(title: string, contentType: CaptureContentType, channel: string, extra: Record<string, any> = {}): Record<string, any> {
  return {
    title,
    type: contentType,
    source_channel: channel,
    created: new Date().toISOString().slice(0, 10),
    status: "draft",
    ...extra,
  };
}

export function formatFrontmatter(fm: Record<string, any>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fm)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

// Template-based structuring

const TEMPLATES: Record<CaptureContentType, (title: string, content: string) => string> = {
  workflow: (title, content) => `# ${title}\n\n## Overview\n\n${content}\n\n## Steps\n\n1. \n\n## Triggers\n\n- \n\n## Notes\n\n`,
  decision: (title, content) => `# ${title}\n\n## Context\n\n${content}\n\n## Decision\n\n\n\n## Alternatives Considered\n\n- \n\n## Rationale\n\n`,
  process: (title, content) => `# ${title}\n\n## Purpose\n\n${content}\n\n## Procedure\n\n1. \n\n## Frequency\n\n\n\n## Owner\n\n`,
  policy: (title, content) => `# ${title}\n\n## Policy\n\n${content}\n\n## Scope\n\n\n\n## Enforcement\n\n\n\n## Exceptions\n\n`,
  integration: (title, content) => `# ${title}\n\n## Overview\n\n${content}\n\n## Configuration\n\n\n\n## Endpoints\n\n\n\n## Authentication\n\n`,
  reference: (title, content) => `# ${title}\n\n${content}\n`,
};

export function structureContent(title: string, rawContent: string, contentType: CaptureContentType): string {
  const template = TEMPLATES[contentType] ?? TEMPLATES.reference;
  return template(title, rawContent.trim());
}

// Summary generation (heuristic, no LLM needed for basic summary)

export function generateSummary(rawContent: string, maxLength: number = 150): string {
  const cleaned = rawContent.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  const truncated = cleaned.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 50 ? truncated.slice(0, lastSpace) : truncated) + "...";
}

// Main refinement pipeline

export function refineCapture(input: RefinementInput): RefinementResult {
  const { type: contentType, confidence } = classifyContent(input.raw_content, input.hint_content_type);
  const title = extractTitle(input.raw_content);
  const suggestedPath = suggestPath(title, contentType, input.existing_paths);
  const frontmatter = buildFrontmatter(title, contentType, input.channel);
  const body = structureContent(title, input.raw_content, contentType);
  const markdown = formatFrontmatter(frontmatter) + "\n\n" + body;
  const summary = generateSummary(input.raw_content);

  return {
    content_type: contentType,
    confidence,
    title,
    suggested_path: suggestedPath,
    suggested_section: null,
    markdown,
    frontmatter,
    summary,
  };
}

// LLM-enhanced refinement (optional upgrade path)

export async function refineWithLLM(input: RefinementInput, llm: LLMProvider): Promise<RefinementResult> {
  // Start with heuristic result
  const base = refineCapture(input);

  // Use LLM to improve classification and structuring
  const prompt = `You are a content classifier and structurer. Given this raw content from a ${input.channel} conversation, improve the following:

Raw content:
"""
${input.raw_content}
"""

Current classification: ${base.content_type} (confidence: ${base.confidence})
Current title: ${base.title}

Respond in JSON with:
- content_type: one of workflow, decision, process, policy, integration, reference
- title: a concise title (max 80 chars)
- summary: one-sentence summary (max 150 chars)
- structured_content: the content restructured with proper sections`;

  try {
    const response = await llm.complete(prompt);
    const parsed = JSON.parse(response);

    const contentType = parsed.content_type ?? base.content_type;
    const title = parsed.title ?? base.title;
    const suggestedPath = suggestPath(title, contentType, input.existing_paths);
    const frontmatter = buildFrontmatter(title, contentType, input.channel);
    const body = parsed.structured_content ?? structureContent(title, input.raw_content, contentType);
    const markdown = formatFrontmatter(frontmatter) + "\n\n" + body;

    return {
      content_type: contentType,
      confidence: Math.max(base.confidence, 0.85),
      title,
      suggested_path: suggestedPath,
      suggested_section: null,
      markdown,
      frontmatter,
      summary: parsed.summary ?? base.summary,
    };
  } catch {
    // Fall back to heuristic result
    return base;
  }
}
