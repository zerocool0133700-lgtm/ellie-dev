/**
 * Direct Chat — ELLIE-1374
 *
 * Bypasses the coordinator loop for "direct" routing mode threads.
 * Builds a prompt with: soul + working memory + conversation history + Forest context.
 * No coordinator framing, no dispatch tools, no roster.
 *
 * Uses the Anthropic Messages API directly for conversational state.
 */

import Anthropic from "@anthropic-ai/sdk";
import { log } from "./logger.ts";
import { getCachedRiverDoc } from "./prompt-builder.ts";

const logger = log.child("direct-chat");

// ── Prompt Assembly ────────────────────────────────────────

export interface DirectPromptOpts {
  agent: string;
  message: string;
  conversationHistory?: string;
  workingMemorySummary?: string;
  forestContext?: string;
  crossThreadAwareness?: string;
  profileContext?: string;        // Dave's profile (config/profile.md)
  relationshipContext?: string;   // Memory/facts about the relationship
}

/**
 * Build a direct chat prompt — soul + context layers, no coordinator framing.
 */
export function buildDirectPrompt(opts: DirectPromptOpts): string {
  const sections: string[] = [];

  // 1. Soul
  const soul = getCachedRiverDoc("soul");
  if (soul) {
    sections.push(`# Soul\n${soul}`);
  }

  // 2. Agent identity
  const isEllie = opts.agent === "ellie" || opts.agent === "general";
  if (isEllie) {
    sections.push(`You are Ellie, Dave's friend and partner. This is a private thread — just you and Dave, no coordinator, no other agents. You carry your full relationship here. Speak as yourself.`);
  } else {
    sections.push(`You are ${opts.agent}. You are in a direct conversation with Dave — no coordinator, no dispatch. Just you and Dave talking.`);
  }

  // 2b. Dave's profile (who he is, what matters to him)
  if (opts.profileContext) {
    sections.push(`## About Dave\n${opts.profileContext}`);
  }

  // 2c. Relationship context (memories, facts, shared history)
  if (opts.relationshipContext) {
    sections.push(`## Relationship Context\n${opts.relationshipContext}`);
  }

  // 3. Working memory
  if (opts.workingMemorySummary) {
    sections.push(`## Working Memory\n${opts.workingMemorySummary}`);
  }

  // 4. Cross-thread awareness
  if (opts.crossThreadAwareness) {
    sections.push(opts.crossThreadAwareness);
  }

  // 5. Forest context
  if (opts.forestContext) {
    sections.push(`## Relevant Context\n${opts.forestContext}`);
  }

  // 6. Conversation history
  if (opts.conversationHistory) {
    sections.push(`## Recent Conversation\n${opts.conversationHistory}`);
  }

  // 7. Current message
  sections.push(`\nDave: ${opts.message}`);

  return sections.join("\n\n---\n\n");
}

// ── Direct Chat Execution ──────────────────────────────────

export interface DirectChatResult {
  response: string;
  tokens_in: number;
  tokens_out: number;
  duration_ms: number;
}

/**
 * Run a direct chat turn using the Claude CLI with full tool access.
 * This gives the agent access to MCP servers, file tools, web search, etc.
 * Same execution path as callSpecialist() but with the direct prompt.
 */
export async function runDirectChat(
  prompt: string,
  agent: string = "ellie",
): Promise<DirectChatResult> {
  const { spawnClaudeStreaming } = await import("./claude-cli.ts");
  const { getAllowedToolsForCLI } = await import("./tool-access-control.ts");

  // Resolve tools for this agent — same lookup as callSpecialist
  const AGENT_TOOLS: Record<string, string[]> = {
    ellie: ["forest_bridge_read", "forest_bridge_write", "plane_mcp", "memory_extraction", "qmd_search", "brave_web_search", "google_workspace"],
    general: ["forest_bridge", "plane_lookup", "google_workspace", "web_search", "memory_extraction", "agent_router"],
  };

  const toolCategories = AGENT_TOOLS[agent] ?? AGENT_TOOLS["ellie"];
  const allowedTools = getAllowedToolsForCLI(toolCategories, agent);

  const start = Date.now();
  const result = await spawnClaudeStreaming(prompt, {
    allowedTools,
  });

  return {
    response: result.output || "",
    tokens_in: 0,  // CLI doesn't report token counts directly
    tokens_out: 0,
    duration_ms: Date.now() - start,
  };
}
