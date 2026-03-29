/**
 * Tool Access Control — Per-Agent MCP Filtering
 *
 * Enforces tool/MCP access restrictions based on agent type.
 * Maps abstract tool categories (from DB) to concrete MCP server names.
 *
 * ELLIE-970: Tool filtering enforcement layer
 */

import { log } from "./logger.ts";

const logger = log.child("tool-access");

/**
 * Tool category → MCP server mapping
 *
 * Maps the abstract tool categories stored in agents.tools_enabled
 * to the actual MCP server names that should be available.
 */
export const TOOL_CATEGORY_TO_MCP: Record<string, string[]> = {
  // File operations
  read: ["filesystem-read"],
  write: ["filesystem-write"],
  edit: ["filesystem-edit"],
  glob: ["filesystem-glob"],
  grep: ["filesystem-grep"],

  // Google Workspace
  google_workspace: ["google-workspace"],
  google_workspace_gmail: ["google-workspace"],
  google_workspace_calendar: ["google-workspace"],
  google_workspace_tasks: ["google-workspace"],
  google_workspace_drive: ["google-workspace"],
  google_workspace_docs: ["google-workspace"],
  google_workspace_sheets: ["google-workspace"],
  google_workspace_contacts: ["google-workspace"],

  // GitHub
  github_mcp: ["github"],
  git: ["git"],

  // Plane
  plane_mcp: ["plane"],
  plane_lookup: ["plane"],

  // Search
  brave_search: ["brave-search"],
  brave_web_search: ["brave-search"],
  web_search: ["brave-search"],

  // Knowledge systems
  forest_bridge: ["forest-bridge"],
  forest_bridge_read: ["forest-bridge"],
  forest_bridge_write: ["forest-bridge"],
  qmd_search: ["qmd"],
  memory_extraction: ["memory"],

  // Bash operations (granular)
  bash_builds: ["bash"],
  bash_tests: ["bash"],
  bash_type_checks: ["bash"],
  bash_systemctl: ["bash"],
  bash_journalctl: ["bash"],
  bash_process_mgmt: ["bash"],

  // Database
  supabase_mcp: ["supabase"],
  psql_forest: ["postgres"],

  // Messaging
  telegram: ["telegram"],
  google_chat: ["google-chat"],

  // Visualization
  miro: ["miro"],
  excalidraw: ["excalidraw"],

  // Deep analysis
  sequential_thinking: ["sequential-thinking"],

  // Ops/monitoring
  systemctl: ["bash"],
  health_endpoint_checks: ["bash"],
  log_analysis: ["bash"],

  // Finance
  transaction_import: ["finance"],
  receipt_parsing: ["finance"],

  // Email
  agentmail: ["agentmail"],

  // Agent routing
  agent_router: ["agent-router"],

  // Codebase tools
  grep_glob_codebase: ["filesystem-grep", "filesystem-glob"],
};

/**
 * Default tools available to ALL agents regardless of configuration.
 * These are core coordination and logging tools that every agent needs.
 */
const ALWAYS_ALLOWED_TOOLS = [
  "forest-bridge",  // All agents can read/write to Forest
  "qmd",            // All agents can search River vault
  "memory",         // All agents can extract memories
  "plane",          // All agents can query Plane (read-only by default)
];

/**
 * Get the list of allowed MCP servers for an agent based on their tools_enabled.
 *
 * @param toolsEnabled - Array of tool categories from agent.tools_enabled
 * @param agentName - Agent name for logging
 * @returns Array of allowed MCP server names
 */
export function getAllowedMCPs(
  toolsEnabled: string[] | null | undefined,
  agentName: string
): string[] {
  if (!toolsEnabled || toolsEnabled.length === 0) {
    logger.warn(`Agent ${agentName} has no tools_enabled — falling back to default tools`);
    return ALWAYS_ALLOWED_TOOLS;
  }

  const allowed = new Set<string>(ALWAYS_ALLOWED_TOOLS);

  for (const category of toolsEnabled) {
    const mcps = TOOL_CATEGORY_TO_MCP[category];
    if (mcps) {
      mcps.forEach(mcp => allowed.add(mcp));
    } else {
      logger.warn(`Unknown tool category '${category}' for agent ${agentName}`);
    }
  }

  const allowedArray = Array.from(allowed).sort();
  logger.debug(`Agent ${agentName} allowed MCPs:`, allowedArray);
  return allowedArray;
}

/**
 * Check if an agent is allowed to use a specific tool/MCP.
 *
 * @param toolsEnabled - Array of tool categories from agent.tools_enabled
 * @param agentName - Agent name for logging
 * @param toolName - Tool or MCP server name to check
 * @returns true if allowed, false otherwise
 */
export function isToolAllowed(
  toolsEnabled: string[] | null | undefined,
  agentName: string,
  toolName: string
): boolean {
  const allowed = getAllowedMCPs(toolsEnabled, agentName);
  return allowed.includes(toolName);
}

/**
 * Convert MCP server names to Claude CLI tool format.
 *
 * Converts: ["plane", "google-workspace"] → ["mcp__plane__*", "mcp__google-workspace__*"]
 *
 * @param mcpNames - Array of MCP server names
 * @returns Array of CLI-formatted MCP tool patterns
 */
export function formatMCPsForCLI(mcpNames: string[]): string[] {
  return mcpNames.map(name => `mcp__${name}__*`);
}

/**
 * Get allowed tools for Claude CLI in the correct format.
 *
 * Includes both:
 * - Built-in tools: Read, Edit, Write, Bash, Glob, Grep
 * - MCP tools: mcp__plane__*, mcp__google-workspace__*, etc.
 *
 * @param toolsEnabled - Array of tool categories from agent.tools_enabled
 * @param agentName - Agent name for logging
 * @returns Array of tool names in CLI format
 */
export function getAllowedToolsForCLI(
  toolsEnabled: string[] | null | undefined,
  agentName: string
): string[] {
  const mcpNames = getAllowedMCPs(toolsEnabled, agentName);
  const mcpTools = formatMCPsForCLI(mcpNames);

  // Built-in tools that every agent should have
  const builtInTools = ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"];

  return [...builtInTools, ...mcpTools];
}

/**
 * Format allowed MCPs for Claude CLI --allowedTools flag.
 *
 * @deprecated Use getAllowedToolsForCLI instead
 * @param toolsEnabled - Array of tool categories from agent.tools_enabled
 * @param agentName - Agent name for logging
 * @returns Comma-separated tool list or undefined
 */
export function formatAllowedToolsFlag(
  toolsEnabled: string[] | null | undefined,
  agentName: string
): string | undefined {
  if (!toolsEnabled || toolsEnabled.length === 0) {
    // No restrictions defined — allow all tools
    return undefined;
  }

  const tools = getAllowedToolsForCLI(toolsEnabled, agentName);
  if (tools.length === 0) {
    logger.warn(`Agent ${agentName} has no allowed tools after filtering`);
    return undefined;
  }

  return tools.join(",");
}
