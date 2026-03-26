/**
 * Agent Memory route handler — /api/agent-memory/*
 *
 * ELLIE-1027: Per-agent filesystem-based persistent memory.
 * Business logic lives in ../../agent-memory-store.ts.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "../../logger.ts";
import { readBody, makeRes, sendError } from "./utils.ts";

const logger = log.child("agent-memory-route");

export async function handleAgentMemoryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _supabase: SupabaseClient | null,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/agent-memory")) return false;

  const queryParams: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { queryParams[k] = v; });
  const mockRes = makeRes(res);

  try {
    // GET /api/agent-memory — list all agents with memory dirs
    if (url.pathname === "/api/agent-memory" && req.method === "GET") {
      const { readAgentMemory, listAgentMemoryDirs } = await import("../../agent-memory-store.ts");
      const agents = await listAgentMemoryDirs();
      const result = [];
      for (const agent of agents) {
        const entries = await readAgentMemory(agent);
        result.push({ agent, entryCount: entries.length });
      }
      mockRes.json(result);
      return true;
    }

    // Match /api/agent-memory/:agent/summary
    const summaryMatch = url.pathname.match(/^\/api\/agent-memory\/([^/]+)\/summary$/);
    if (summaryMatch && req.method === "GET") {
      const agent = summaryMatch[1];
      const maxTokens = queryParams.maxTokens ? parseInt(queryParams.maxTokens) : 2000;
      const { getAgentMemorySummary } = await import("../../agent-memory-store.ts");
      const summary = await getAgentMemorySummary(agent, maxTokens);
      mockRes.json({ agent, summary, tokens: Math.ceil(summary.length / 4) });
      return true;
    }

    // Match /api/agent-memory/:agent
    const agentMatch = url.pathname.match(/^\/api\/agent-memory\/([^/]+)$/);
    if (agentMatch && req.method === "GET") {
      const agent = agentMatch[1];
      const category = queryParams.category;
      const limit = queryParams.limit ? parseInt(queryParams.limit) : undefined;
      const { readAgentMemory } = await import("../../agent-memory-store.ts");
      const entries = await readAgentMemory(agent, { category: category as any, limit });
      mockRes.json(entries);
      return true;
    }

    if (agentMatch && req.method === "POST") {
      const agent = agentMatch[1];
      const body = await readBody(req);
      const data = body ? JSON.parse(body) : {};
      const { category, content, workItemId } = data;

      if (!category || !content) {
        sendError(res, 400, "category and content are required");
        return true;
      }

      const { writeAgentMemory } = await import("../../agent-memory-store.ts");
      await writeAgentMemory({ agent, category, content, workItemId });
      mockRes.json({ success: true, agent, category });
      return true;
    }

    return false;
  } catch (err: any) {
    logger.error("Agent memory route error", err);
    sendError(res, err.message?.includes("Invalid category") ? 400 : 500, err.message || "Internal error");
    return true;
  }
}
