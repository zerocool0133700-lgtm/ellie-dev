/**
 * Agent Creation API — Task 4
 *
 * POST /api/agents/create
 *
 * Full lifecycle agent creation: writes to Supabase agents table, Forest
 * knowledge bridge, and updates any requested foundations.
 */

import type { ApiRequest, ApiResponse } from "./types.ts";
import { getRelayDeps } from "../relay-state.ts";
import { log } from "../logger.ts";

const logger = log.child("agent-create");

// ── Cognitive style mapping ───────────────────────────────────────────────────

const COGNITIVE_STYLES: Record<string, string> = {
  squirrel: "breadth-first, context-aware, strategic routing",
  ant: "depth-first, single-threaded, methodical verification",
  owl: "depth-first, pattern-recognition, systematic-review",
  bee: "specialized, task-focused, efficient execution",
};

// ── Endpoint ──────────────────────────────────────────────────────────────────

/**
 * POST /api/agents/create
 *
 * Creates an agent across Supabase, Forest, and any named foundations in one
 * atomic-ish call.  Partial failures are tolerated — the response includes a
 * per-step results map so the caller knows exactly what succeeded.
 */
export async function createAgentEndpoint(
  req: ApiRequest,
  res: ApiResponse,
): Promise<void> {
  const body = req.body ?? {};

  // ── 1. Validate ─────────────────────────────────────────────────────────────

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const persona_name =
    typeof body.persona_name === "string" ? body.persona_name.trim() : "";
  const role = typeof body.role === "string" ? body.role.trim() : "";
  const color = typeof body.color === "string" ? body.color.trim() : "";
  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  const model =
    typeof body.model === "string"
      ? body.model.trim()
      : "claude-sonnet-4-6";
  const creature =
    typeof body.creature === "string" ? body.creature.trim() : "squirrel";
  const tools = Array.isArray(body.tools)
    ? (body.tools as unknown[]).filter((t) => typeof t === "string") as string[]
    : [];
  const capabilities = Array.isArray(body.capabilities)
    ? (body.capabilities as unknown[]).filter((c) => typeof c === "string") as string[]
    : [];
  const foundations = Array.isArray(body.foundations)
    ? (body.foundations as unknown[]).filter((f) => typeof f === "string") as string[]
    : [];
  const token_budget =
    typeof body.token_budget === "number" ? body.token_budget : undefined;

  if (!name) {
    res.status(400).json({ error: "Missing required field: name" });
    return;
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    res
      .status(400)
      .json({
        error:
          "Invalid name: must be lowercase alphanumeric + hyphens only (^[a-z0-9-]+$)",
      });
    return;
  }
  if (!persona_name) {
    res.status(400).json({ error: "Missing required field: persona_name" });
    return;
  }
  if (!role) {
    res.status(400).json({ error: "Missing required field: role" });
    return;
  }

  // ── 2. Check uniqueness ──────────────────────────────────────────────────────

  const { supabase } = getRelayDeps();
  if (!supabase) {
    res.status(503).json({ error: "Supabase not available" });
    return;
  }

  const { data: existing, error: lookupError } = await supabase
    .from("agents")
    .select("name")
    .eq("name", name)
    .maybeSingle();

  if (lookupError) {
    logger.error("Uniqueness check failed", lookupError);
    res.status(500).json({ error: "Failed to check agent uniqueness" });
    return;
  }
  if (existing) {
    res.status(409).json({ error: `Agent "${name}" already exists` });
    return;
  }

  // ── 3. Supabase INSERT ────────────────────────────────────────────────────────

  const results: Record<string, string> = {};

  const cognitiveStyle =
    COGNITIVE_STYLES[creature] ?? "breadth-first, context-aware, strategic routing";

  const { error: insertError } = await supabase.from("agents").insert({
    name,
    type: role,
    status: "active",
    capabilities,
    tools_enabled: tools,
    metadata: {
      species: creature,
      cognitive_style: cognitiveStyle,
      description,
      persona_name,
      color,
    },
  });

  if (insertError) {
    logger.error("Supabase insert failed", insertError);
    res
      .status(500)
      .json({ error: `Failed to insert agent: ${insertError.message}` });
    return;
  }

  results["supabase"] = "created";
  logger.info(`Agent "${name}" inserted into Supabase`);

  // ── 4. Forest write ───────────────────────────────────────────────────────────

  const bridgeKey = process.env.BRIDGE_KEY;

  const tokenLine =
    token_budget !== undefined ? `\n- Token budget: ${token_budget}` : "";
  const forestContent = [
    `Agent: ${name} (${persona_name})`,
    `Role: ${role}`,
    `Model: ${model}`,
    `Creature: ${creature} — ${cognitiveStyle}`,
    `Color: ${color}`,
    `Description: ${description}`,
    `Tools: ${tools.length > 0 ? tools.join(", ") : "none"}`,
    `Capabilities: ${capabilities.length > 0 ? capabilities.join(", ") : "none"}` + tokenLine,
  ].join("\n");

  try {
    const forestRes = await fetch("http://localhost:3001/api/bridge/write", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-key": bridgeKey ?? "",
      },
      body: JSON.stringify({
        content: forestContent,
        type: "fact",
        scope_path: "2/1",
      }),
    });

    if (forestRes.ok) {
      results["forest"] = "created";
      logger.info(`Agent "${name}" written to Forest`);
    } else {
      const text = await forestRes.text().catch(() => "");
      logger.warn(`Forest write failed (${forestRes.status}): ${text}`);
      results["forest"] = `failed: ${forestRes.status}`;
    }
  } catch (err) {
    logger.warn("Forest write threw", err);
    results["forest"] = `failed: ${String(err)}`;
  }

  // ── 5. Foundation updates ─────────────────────────────────────────────────────

  for (const foundationName of foundations) {
    try {
      // Fetch the foundation
      const { data: foundation, error: fetchError } = await supabase
        .from("foundations")
        .select("id, name, agents")
        .eq("name", foundationName)
        .maybeSingle();

      if (fetchError || !foundation) {
        const reason = fetchError?.message ?? "not found";
        logger.warn(`Foundation "${foundationName}" fetch failed: ${reason}`);
        results[`foundation:${foundationName}`] = `failed: ${reason}`;
        continue;
      }

      // Append new agent def to the agents JSONB array
      const existingAgents: unknown[] = Array.isArray(foundation.agents)
        ? foundation.agents
        : [];

      const newAgentDef = {
        name,
        role,
        model,
        tools,
      };

      const updatedAgents = [...existingAgents, newAgentDef];

      const { error: updateError } = await supabase
        .from("foundations")
        .update({ agents: updatedAgents })
        .eq("id", foundation.id);

      if (updateError) {
        logger.warn(
          `Foundation "${foundationName}" update failed: ${updateError.message}`,
        );
        results[`foundation:${foundationName}`] = `failed: ${updateError.message}`;
      } else {
        results[`foundation:${foundationName}`] = "added";
        logger.info(`Agent "${name}" added to foundation "${foundationName}"`);
      }
    } catch (err) {
      logger.warn(`Foundation "${foundationName}" threw`, err);
      results[`foundation:${foundationName}`] = `failed: ${String(err)}`;
    }
  }

  // ── 6. Respond ────────────────────────────────────────────────────────────────

  res.json({
    success: true,
    agent_name: name,
    results,
  });
}
