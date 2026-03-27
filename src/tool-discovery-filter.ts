/**
 * Tool Discovery Filtering — ELLIE-1059
 * Reduces 18+ tools to relevant subset per dispatch.
 * Based on agent archetype, task type, and message intent.
 * Inspired by Context-Gateway internal/pipes/tool_discovery/
 */

import { log } from "./logger.ts";
import { estimateTokens } from "./relay-utils.ts";

const logger = log.child("compression:tool-filter");

export interface ToolDefinition {
  name: string;
  description: string;
  schema?: any;
}

/**
 * Per-archetype always-include tools.
 * These are core to the agent's function and should never be filtered.
 */
const ALWAYS_INCLUDE: Record<string, string[]> = {
  dev: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
  research: ["WebSearch", "WebFetch", "Read", "Grep"],
  content: ["Read", "Write", "Edit", "WebSearch"],
  critic: ["Read", "Grep", "Glob"],
  strategy: ["Read", "WebSearch", "WebFetch"],
  ops: ["Bash", "Read", "Grep", "Glob"],
  finance: ["Read", "Bash"],
  general: ["Read", "Bash", "Edit", "Write", "Glob", "Grep"],
};

/**
 * Intent-based tool relevance keywords.
 * Map message keywords to likely-needed tools.
 */
const INTENT_TOOL_MAP: Record<string, string[]> = {
  // Code keywords
  "fix": ["Bash", "Edit", "Read", "Grep"],
  "test": ["Bash", "Read"],
  "build": ["Bash"],
  "deploy": ["Bash"],
  "commit": ["Bash"],
  "search": ["Grep", "Glob", "WebSearch"],
  "find": ["Grep", "Glob"],
  "read": ["Read"],
  "write": ["Write", "Edit"],
  "create": ["Write", "Bash"],
  // Research keywords
  "research": ["WebSearch", "WebFetch", "Read"],
  "look up": ["WebSearch", "WebFetch"],
  "analyze": ["Read", "Grep"],
  // Communication
  "email": ["mcp__google-workspace__*"],
  "calendar": ["mcp__google-workspace__*"],
  "message": ["mcp__google-workspace__*"],
  // Project management
  "ticket": ["mcp__plane__*"],
  "issue": ["mcp__plane__*", "mcp__github__*"],
  "pr": ["mcp__github__*"],
  "github": ["mcp__github__*"],
};

const DEFAULT_MAX_TOOLS = 8;

/**
 * Filter tools to the most relevant subset for this dispatch.
 */
export function filterTools(
  allTools: ToolDefinition[],
  opts: {
    archetype: string;
    message: string;
    maxTools?: number;
  }
): { included: ToolDefinition[]; deferred: ToolDefinition[]; tokensSaved: number } {
  const maxTools = opts.maxTools ?? DEFAULT_MAX_TOOLS;
  const archetype = opts.archetype.toLowerCase();
  const messageLower = opts.message.toLowerCase();

  // Start with always-include for this archetype
  const alwaysInclude = new Set(ALWAYS_INCLUDE[archetype] || ALWAYS_INCLUDE.general);

  // Add intent-based tools
  for (const [keyword, tools] of Object.entries(INTENT_TOOL_MAP)) {
    if (messageLower.includes(keyword)) {
      for (const tool of tools) {
        alwaysInclude.add(tool);
      }
    }
  }

  // Partition tools
  const included: ToolDefinition[] = [];
  const deferred: ToolDefinition[] = [];

  for (const tool of allTools) {
    // Check if tool name matches any always-include pattern (supports wildcards)
    const isIncluded = [...alwaysInclude].some(pattern => {
      if (pattern.endsWith("*")) {
        return tool.name.startsWith(pattern.slice(0, -1));
      }
      return tool.name === pattern;
    });

    if (isIncluded) {
      included.push(tool);
    } else {
      deferred.push(tool);
    }
  }

  // If still over max, keep the first maxTools and defer rest
  if (included.length > maxTools) {
    const overflow = included.splice(maxTools);
    deferred.push(...overflow);
  }

  // Calculate token savings from deferred tools
  const deferredTokens = deferred.reduce((sum, t) => {
    return sum + estimateTokens(JSON.stringify(t));
  }, 0);

  if (deferred.length > 0) {
    logger.info("Filtered tools", {
      archetype,
      total: allTools.length,
      included: included.length,
      deferred: deferred.length,
      tokensSaved: deferredTokens,
    });
  }

  return { included, deferred, tokensSaved: deferredTokens };
}

/**
 * Get a compact tool summary for deferred tools (for context injection).
 */
export function getDeferredToolSummary(deferred: ToolDefinition[]): string {
  if (deferred.length === 0) return "";
  const names = deferred.map(t => t.name).join(", ");
  return `[${deferred.length} additional tools available on request: ${names}]`;
}

// Export for testing
export { ALWAYS_INCLUDE, INTENT_TOOL_MAP, DEFAULT_MAX_TOOLS };
