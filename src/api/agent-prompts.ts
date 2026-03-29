/**
 * Agent Prompt History API — store and retrieve per-agent prompt history.
 *
 * Endpoints:
 *   POST  /api/agents/:name/prompts  — store a prompt entry
 *   GET   /api/agents/:name/prompts  — list recent prompts
 *
 * Also exports capturePrompt() — fire-and-forget helper for relay handlers.
 */

import { getRelayDeps } from "../relay-state.ts";
import { log } from "../logger.ts";
import type { ApiRequest, ApiResponse } from "./types.ts";

const logger = log.child("agent-prompts-api");

// ── POST /api/agents/:name/prompts ────────────────────────────────────────────

/**
 * Store a prompt entry for an agent.
 *
 * Body: { channel, prompt_text, work_item_id?, token_count?, cost_estimate_usd? }
 * Param: :name — agent name (injected via mockReq.params.name)
 */
export async function storePromptEndpoint(
  req: ApiRequest,
  res: ApiResponse,
): Promise<void> {
  const agentName = req.params?.name;
  const {
    channel,
    prompt_text,
    work_item_id,
    token_count,
    cost_estimate_usd,
  } = req.body ?? {};

  if (!agentName || typeof agentName !== "string") {
    res.status(400).json({ error: "Missing required param: agent name" });
    return;
  }
  if (!prompt_text || typeof prompt_text !== "string") {
    res.status(400).json({ error: "Missing required field: prompt_text" });
    return;
  }
  if (!channel || typeof channel !== "string") {
    res.status(400).json({ error: "Missing required field: channel" });
    return;
  }

  const { supabase } = getRelayDeps();
  if (!supabase) {
    res.status(503).json({ error: "Supabase not available" });
    return;
  }

  try {
    const { error } = await supabase.from("agent_prompt_history").insert({
      agent_name: agentName,
      channel,
      prompt_text,
      work_item_id: work_item_id ?? null,
      token_count: typeof token_count === "number" ? token_count : 0,
      cost_estimate_usd: typeof cost_estimate_usd === "number" ? cost_estimate_usd : 0,
    });

    if (error) {
      logger.error("storePrompt insert failed", { agentName }, error);
      res.status(500).json({ error: "Failed to store prompt" });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    logger.error("storePrompt error", { agentName }, err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── GET /api/agents/:name/prompts ─────────────────────────────────────────────

/**
 * List recent prompts for an agent.
 *
 * Query params:
 *   limit  — number of entries to return (default 5, max 20)
 *   full   — "true" to include prompt_text; omitted/false returns metadata only
 */
export async function getPromptsEndpoint(
  req: ApiRequest,
  res: ApiResponse,
): Promise<void> {
  const agentName = req.params?.name;

  if (!agentName || typeof agentName !== "string") {
    res.status(400).json({ error: "Missing required param: agent name" });
    return;
  }

  const rawLimit = parseInt(req.query?.limit ?? "5", 10);
  const limit = isNaN(rawLimit) ? 5 : Math.min(Math.max(rawLimit, 1), 20);
  const includeFull = req.query?.full === "true";

  const { supabase } = getRelayDeps();
  if (!supabase) {
    res.status(503).json({ error: "Supabase not available" });
    return;
  }

  try {
    const columns = includeFull
      ? "id, agent_name, channel, work_item_id, prompt_text, token_count, cost_estimate_usd, created_at"
      : "id, agent_name, channel, work_item_id, token_count, cost_estimate_usd, created_at";

    const { data, error } = await supabase
      .from("agent_prompt_history")
      .select(columns)
      .eq("agent_name", agentName)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      logger.error("getPrompts query failed", { agentName }, error);
      res.status(500).json({ error: "Failed to fetch prompts" });
      return;
    }

    res.json({ prompts: data ?? [] });
  } catch (err) {
    logger.error("getPrompts error", { agentName }, err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── capturePrompt — fire-and-forget helper ────────────────────────────────────

export interface CapturePromptOpts {
  agentName: string;
  channel: string;
  workItemId?: string;
  promptText: string;
  tokenCount?: number;
}

/**
 * Fire-and-forget: POST prompt to the local relay API.
 * Silent on failure — never throws.
 */
export function capturePrompt(opts: CapturePromptOpts): void {
  const { agentName, channel, workItemId, promptText, tokenCount } = opts;

  fetch(`http://localhost:3001/api/agents/${encodeURIComponent(agentName)}/prompts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channel,
      prompt_text: promptText,
      work_item_id: workItemId ?? null,
      token_count: tokenCount ?? 0,
    }),
  }).catch(() => {
    // Silent failure — prompt capture is best-effort
  });
}
