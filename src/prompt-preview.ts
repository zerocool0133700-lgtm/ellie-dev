/**
 * River Prompt Assembly Preview — ELLIE-759
 *
 * Dry-run prompt builder that returns section-level metadata
 * without sending to Claude. Used by the dashboard to visualize
 * what goes into each agent's prompt.
 */

import {
  buildPrompt,
  getLastBuildMetrics,
  type BuildMetrics,
} from "./prompt-builder.ts";
import { estimateTokens } from "./relay-utils.ts";

// ── Types ────────────────────────────────────────────────────

export type SectionStatus = "wired" | "hardcoded" | "missing";

export interface PromptSectionPreview {
  label: string;
  source: string | null;
  priority: number;
  tokens: number;
  content_preview: string;
  status: SectionStatus;
  /** Full section content for expand view. Only included when include_content=true. */
  full_content?: string;
  /** obsidian:// URI to open the source doc for editing. */
  edit_uri?: string;
}

export interface PromptPreviewResult {
  agent: string;
  channel: string;
  total_tokens: number;
  section_count: number;
  budget: number;
  sections: PromptSectionPreview[];
  river_cache_hits: number;
  river_cache_misses: number;
}

// ── River Doc Source Mapping ─────────────────────────────────

/** Maps section labels to their River vault source paths. */
const RIVER_SOURCE_MAP: Record<string, string> = {
  "soul": "river/soul/soul.md",
  "memory-protocol": "river/prompts/protocols/memory-management.md",
  "confirm-protocol": "river/prompts/protocols/action-confirmations.md",
  "forest-memory-writes": "river/prompts/protocols/forest-writes.md",
  "dev-protocol": "river/templates/dev-agent-base.md",
  "research-protocol": "river/templates/research-agent-base.md",
  "strategy-protocol": "river/templates/strategy-agent-base.md",
  "playbook-commands": "river/prompts/protocols/playbook-commands.md",
  "work-commands": "river/prompts/protocols/work-commands.md",
  "planning-mode": "river/prompts/protocols/planning-mode.md",
};

/** Sections that are always hardcoded (not from River). */
const HARDCODED_SECTIONS = new Set([
  "user-message", "base-prompt", "user-name", "time", "channel-context",
  "tools", "conversation", "search", "freshness", "profile",
  "context-docket", "structured-context", "agent-memory",
  "forest-awareness", "queue", "orchestration-status",
  "staleness-warning", "source-hierarchy", "ground-truth-conflicts",
  "cognitive-load-hint", "commitment-followups", "work-item",
  "emoji-guidance", "pending-commitments", "workflow-progress",
  "command-bar-context", "incidents",
]);

/** Sections expected per agent type (for "missing" detection). */
const EXPECTED_SECTIONS: Record<string, string[]> = {
  general: ["soul", "memory-protocol", "confirm-protocol", "forest-memory-writes", "playbook-commands", "work-commands"],
  dev: ["soul", "dev-protocol", "memory-protocol", "confirm-protocol", "forest-memory-writes", "work-commands"],
  research: ["soul", "research-protocol", "memory-protocol", "confirm-protocol", "forest-memory-writes"],
  strategy: ["soul", "strategy-protocol", "memory-protocol", "confirm-protocol", "forest-memory-writes"],
  critic: ["soul", "memory-protocol", "confirm-protocol"],
  ops: ["soul", "memory-protocol", "confirm-protocol", "work-commands"],
  content: ["soul", "memory-protocol", "confirm-protocol"],
  finance: ["soul", "memory-protocol", "confirm-protocol"],
};

export const VALID_AGENTS = ["general", "dev", "research", "strategy", "critic", "ops", "content", "finance"];
export const VALID_CHANNELS = ["telegram", "google-chat", "ellie-chat", "voice"];

// ── Preview Builder ─────────────────────────────────────────

/**
 * Build a prompt preview for an agent + channel combination.
 * Calls buildPrompt() in dry-run mode (no LLM call) and
 * enriches the metrics with source paths and status.
 */
export function buildPromptPreview(
  agent: string,
  channel: string = "telegram",
  opts: { include_content?: boolean } = {},
): PromptPreviewResult {
  // Build prompt in dry-run mode (just assembles, doesn't send)
  const agentConfig = agent !== "general"
    ? { system_prompt: null, name: agent, tools_enabled: [] as string[] }
    : undefined;

  const prompt = buildPrompt(
    "(preview mode — no actual user message)",
    undefined, // contextDocket
    undefined, // relevantContext
    undefined, // elasticContext
    channel,
    agentConfig,
  );

  // Get the metrics from the build
  const metrics = getLastBuildMetrics();

  if (!metrics) {
    return {
      agent,
      channel,
      total_tokens: estimateTokens(prompt),
      section_count: 0,
      budget: 24000,
      sections: [],
      river_cache_hits: 0,
      river_cache_misses: 0,
    };
  }

  // Enrich sections with source paths and status
  const expected = EXPECTED_SECTIONS[agent] ?? EXPECTED_SECTIONS.general;
  const presentLabels = new Set(metrics.sections.map(s => s.label));

  const sections: PromptSectionPreview[] = metrics.sections.map(s => {
    const source = RIVER_SOURCE_MAP[s.label] ?? null;
    const section: PromptSectionPreview = {
      label: s.label,
      source,
      priority: s.priority,
      tokens: s.tokens,
      content_preview: extractPreview(prompt, s.label),
      status: classifyStatus(s.label),
    };
    if (source) section.edit_uri = buildObsidianUri(source);
    if (opts.include_content) section.full_content = extractFullContent(prompt, s.label);
    return section;
  });

  // Add missing expected sections
  for (const label of expected) {
    if (!presentLabels.has(label)) {
      const source = RIVER_SOURCE_MAP[label] ?? null;
      sections.push({
        label,
        source,
        priority: 0,
        tokens: 0,
        content_preview: "",
        status: "missing",
        edit_uri: source ? buildObsidianUri(source) : undefined,
      });
    }
  }

  return {
    agent,
    channel,
    total_tokens: metrics.totalTokens,
    section_count: metrics.sectionCount,
    budget: metrics.budget,
    sections,
    river_cache_hits: metrics.riverCacheHits,
    river_cache_misses: metrics.riverCacheMisses,
  };
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Classify a section's source status.
 */
function classifyStatus(label: string): SectionStatus {
  if (RIVER_SOURCE_MAP[label]) return "wired";
  if (HARDCODED_SECTIONS.has(label)) return "hardcoded";
  return "hardcoded"; // Default to hardcoded for unknown sections
}

/**
 * Extract first 200 chars of a section from the assembled prompt.
 * Uses section label markers if present.
 */
function extractPreview(prompt: string, label: string): string {
  // Sections are separated by double newlines with headers
  // Try to find the section by its label pattern
  const patterns = [
    `## ${label}`,
    `# ${label}`,
    `[${label}]`,
    label.toUpperCase(),
  ];

  for (const pattern of patterns) {
    const idx = prompt.indexOf(pattern);
    if (idx >= 0) {
      const start = idx;
      const end = Math.min(start + 200, prompt.length);
      return prompt.slice(start, end).trim();
    }
  }

  // Fallback: return empty
  return "";
}

/**
 * Validate agent and channel parameters.
 */
export function validatePreviewParams(
  agent: string | undefined,
  channel: string | undefined,
): string[] {
  const errors: string[] = [];

  if (!agent) {
    errors.push("agent parameter is required");
  } else if (!VALID_AGENTS.includes(agent)) {
    errors.push(`Invalid agent: ${agent}. Valid: ${VALID_AGENTS.join(", ")}`);
  }

  if (channel && !VALID_CHANNELS.includes(channel)) {
    errors.push(`Invalid channel: ${channel}. Valid: ${VALID_CHANNELS.join(", ")}`);
  }

  return errors;
}

/**
 * Build an obsidian:// URI to open a River doc for editing.
 * Format: obsidian://open?vault=obsidian-vault&file=ellie-river/path
 */
export function buildObsidianUri(riverPath: string): string {
  // riverPath is like "river/soul/soul.md" — strip "river/" prefix,
  // the vault folder is "ellie-river" inside obsidian-vault
  const filePath = riverPath.replace(/^river\//, "ellie-river/").replace(/\.md$/, "");
  return `obsidian://open?vault=obsidian-vault&file=${encodeURIComponent(filePath)}`;
}

/**
 * Extract full content of a section from the assembled prompt.
 */
function extractFullContent(prompt: string, label: string): string {
  const patterns = [
    `## ${label}`,
    `# ${label}`,
    `[${label}]`,
    label.toUpperCase(),
  ];

  for (const pattern of patterns) {
    const idx = prompt.indexOf(pattern);
    if (idx >= 0) {
      // Find the next section boundary (double newline followed by ## or end)
      const rest = prompt.slice(idx);
      const nextSection = rest.search(/\n\n(?:##\s|#\s|\[)/);
      if (nextSection > 0) {
        return rest.slice(0, nextSection).trim();
      }
      return rest.trim();
    }
  }

  return "";
}
