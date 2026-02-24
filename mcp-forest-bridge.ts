#!/usr/bin/env bun
/**
 * Forest Bridge MCP Server
 *
 * Exposes Ellie's Forest knowledge graph to Claude Code via MCP tools.
 * Wraps the Bridge API (localhost:3001/api/bridge/*) with Ellie's own key.
 *
 * Tools:
 *   forest_read   — Semantic search across forest knowledge
 *   forest_write  — Write facts, decisions, findings, hypotheses
 *   forest_list   — Browse existing memories by scope/type
 *   forest_scopes — Browse the scope hierarchy
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BRIDGE_URL = process.env.BRIDGE_URL || "http://localhost:3001/api/bridge";
const BRIDGE_KEY = process.env.BRIDGE_KEY || "";

if (!BRIDGE_KEY) {
  console.error("[forest-bridge] BRIDGE_KEY env var is required");
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────

async function bridgePost(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${BRIDGE_URL}/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bridge-key": BRIDGE_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bridge ${endpoint} returned ${res.status}: ${text}`);
  }
  return res.json();
}

async function bridgeGet(endpoint: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(`${BRIDGE_URL}/${endpoint}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    headers: { "x-bridge-key": BRIDGE_KEY },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bridge ${endpoint} returned ${res.status}: ${text}`);
  }
  return res.json();
}

// ── MCP Server ───────────────────────────────────────────────

const server = new McpServer({
  name: "forest-bridge",
  version: "1.0.0",
});

// ── forest_read ──────────────────────────────────────────────

server.tool(
  "forest_read",
  "Search Ellie's Forest knowledge graph. Returns memories (facts, decisions, findings, hypotheses) matching a semantic query. Use this to recall past decisions, look up what's known about a topic, or check if something has been recorded before.",
  {
    query: z.string().describe("Natural language search query"),
    scope_path: z.string().optional().describe("Scope path to search within (e.g. '2' for Projects, '2/1' for ellie-dev). Omit for broad search."),
    type: z.enum(["fact", "decision", "finding", "hypothesis"]).optional().describe("Filter by memory type"),
    match_count: z.number().optional().describe("Max results to return (default: 10)"),
  },
  async ({ query, scope_path, type, match_count }) => {
    const body: Record<string, unknown> = { query };
    if (scope_path) body.scope_path = scope_path;
    if (type) body.category = type;
    if (match_count) body.match_count = match_count;

    const result = await bridgePost("read", body) as any;

    if (!result.success) {
      return { content: [{ type: "text" as const, text: `Search failed: ${result.error}` }] };
    }

    if (!result.memories?.length) {
      return { content: [{ type: "text" as const, text: `No results found for "${query}"` }] };
    }

    const formatted = result.memories.map((m: any, i: number) => {
      const meta = [m.type, m.scope_path, m.confidence ? `confidence:${m.confidence}` : null]
        .filter(Boolean).join(" | ");
      return `${i + 1}. [${meta}] ${m.content}`;
    }).join("\n\n");

    return {
      content: [{ type: "text" as const, text: `Found ${result.count} memories:\n\n${formatted}` }],
    };
  },
);

// ── forest_write ─────────────────────────────────────────────

server.tool(
  "forest_write",
  "Write knowledge to Ellie's Forest. Use this to persist important facts, architectural decisions, research findings, or hypotheses that should be remembered across sessions. Every write is scoped to a project/area.",
  {
    content: z.string().describe("The knowledge to record"),
    scope_path: z.string().describe("Where to store it (e.g. '2/1' for ellie-dev, '2/2' for ellie-forest, '2/3' for ellie-home)"),
    type: z.enum(["fact", "decision", "finding", "hypothesis", "preference"]).default("finding").describe("Type of knowledge"),
    confidence: z.number().min(0).max(1).optional().describe("Confidence level 0-1 (default: 0.5)"),
    tags: z.array(z.string()).optional().describe("Tags for categorization"),
    work_item_id: z.string().optional().describe("Associated Plane ticket (e.g. 'ELLIE-188')"),
  },
  async ({ content, scope_path, type, confidence, tags, work_item_id }) => {
    const body: Record<string, unknown> = { content, scope_path, type };
    if (confidence !== undefined) body.confidence = confidence;
    if (tags?.length) body.tags = tags;
    if (work_item_id) body.work_item_id = work_item_id;

    const result = await bridgePost("write", body) as any;

    if (!result.success) {
      return { content: [{ type: "text" as const, text: `Write failed: ${result.error}` }] };
    }

    return {
      content: [{ type: "text" as const, text: `Recorded ${type} to ${scope_path} (id: ${result.memory_id}):\n${content}` }],
    };
  },
);

// ── forest_list ──────────────────────────────────────────────

server.tool(
  "forest_list",
  "Browse existing Forest memories. Use this to see what's been recorded in a scope, filter by type, or check recent activity.",
  {
    scope_path: z.string().optional().describe("Scope to browse (e.g. '2/1' for ellie-dev)"),
    type: z.enum(["fact", "decision", "finding", "hypothesis", "preference"]).optional().describe("Filter by memory type"),
    limit: z.number().optional().describe("Max results (default: 20)"),
    min_confidence: z.number().optional().describe("Minimum confidence threshold"),
  },
  async ({ scope_path, type, limit, min_confidence }) => {
    const params: Record<string, string> = {};
    if (scope_path) params.scope_path = scope_path;
    if (type) params.type = type;
    if (limit) params.limit = String(limit);
    if (min_confidence) params.min_confidence = String(min_confidence);

    const result = await bridgeGet("list", params) as any;

    if (!result.success) {
      return { content: [{ type: "text" as const, text: `List failed: ${result.error}` }] };
    }

    if (!result.memories?.length) {
      return { content: [{ type: "text" as const, text: "No memories found matching criteria." }] };
    }

    const formatted = result.memories.map((m: any, i: number) => {
      const meta = [m.type, m.scope_path, m.confidence ? `conf:${m.confidence}` : null]
        .filter(Boolean).join(" | ");
      const date = m.created_at ? new Date(m.created_at).toISOString().split("T")[0] : "";
      return `${i + 1}. [${meta}] (${date}) ${m.content}`;
    }).join("\n\n");

    return {
      content: [{ type: "text" as const, text: `${result.count} memories:\n\n${formatted}` }],
    };
  },
);

// ── forest_scopes ────────────────────────────────────────────

server.tool(
  "forest_scopes",
  "Browse the Forest scope hierarchy. Scopes organize knowledge by area — projects, sub-projects, topics. Use this to discover available scopes before reading or writing.",
  {
    path: z.string().optional().describe("Scope path to explore (omit for root)"),
  },
  async ({ path }) => {
    const params: Record<string, string> = {};
    if (path) params.path = path;

    const result = await bridgeGet("scopes", params) as any;

    if (!result.success) {
      return { content: [{ type: "text" as const, text: `Scopes failed: ${result.error}` }] };
    }

    let text: string;

    if (result.scope) {
      // Single scope with children
      const children = result.children?.map((c: any) => `  ${c.path} — ${c.name}`).join("\n") || "  (no children)";
      const breadcrumb = result.breadcrumb?.map((b: any) => b.name).join(" > ") || result.scope.name;
      text = `${breadcrumb}\n\nChildren:\n${children}`;
    } else if (result.scopes) {
      // Root listing
      text = result.scopes.map((s: any) => {
        const children = s.children?.map((c: any) => `  ${c.path} — ${c.name}`).join("\n") || "";
        return `${s.path} — ${s.name}\n${children}`;
      }).join("\n\n");
    } else {
      text = JSON.stringify(result, null, 2);
    }

    return { content: [{ type: "text" as const, text }] };
  },
);

// ── Start ────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
