/**
 * ELLIE:: Playbook Command System
 *
 * Tag-based dispatch where the general agent emits structured commands
 * in her responses. The relay catches them post-response (same pattern
 * as [CONFIRM:] and [MEMORY:]), strips them from the user-facing text,
 * and executes infrastructure actions asynchronously.
 *
 * Commands:
 *   ELLIE:: send ELLIE-144 to dev     — dispatch agent to work a ticket
 *   ELLIE:: close ELLIE-144 "summary" — close ticket (Plane + forest + auto-deploy)
 *   ELLIE:: create ticket "title" "description" — create Plane issue
 */

import type { Bot } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import { notify, type NotifyContext } from "./notification-policy.ts";
import { log } from "./logger.ts";
import { getAgentArchetype, getPsyContext, getPhaseContext, getHealthContext } from "./prompt-builder.ts";

const logger = log.child("playbook");
import {
  fetchWorkItemDetails,
  createPlaneIssue,
} from "./plane.ts";
import { dispatchAgent, syncResponse } from "./agent-router.ts";
import { processMemoryIntents } from "./memory.ts";
import { emitEvent } from "./orchestration-ledger.ts";

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface PlaybookCommand {
  type: "send" | "close" | "create";
  ticketId?: string;
  agentName?: string;
  summary?: string;
  title?: string;
  description?: string;
  raw: string;
}

export interface PlaybookContext {
  bot: Bot;
  supabase: SupabaseClient | null;
  telegramUserId: string;
  gchatSpaceName?: string;
  channel: string;
  callClaudeFn: (prompt: string, options?: { resume?: boolean; allowedTools?: string[]; model?: string }) => Promise<string>;
  buildPromptFn: (
    userMessage: string,
    contextDocket?: string,
    relevantContext?: string,
    elasticContext?: string,
    channel?: string,
    agentConfig?: { system_prompt?: string | null; name?: string; tools_enabled?: string[] },
    workItemContext?: string,
    structuredContext?: string,
    recentMessages?: string,
    skillContext?: { name: string; description: string },
    forestContext?: string,
    agentMemoryContext?: string,
    sessionIds?: { tree_id: string; branch_id?: string; creature_id?: string; entity_id?: string; work_item_id?: string },
    archetypeContext?: string,
    psyContext?: string,
    phaseContext?: string,
    healthContext?: string,
  ) => string;
}

// ────────────────────────────────────────────────────────────────
// Tag Extraction
// ────────────────────────────────────────────────────────────────

const SEND_RE  = /ELLIE::\s*send\s+([A-Z]+-\d+)\s+to\s+(\w+)/gi;
const CLOSE_RE = /ELLIE::\s*close\s+([A-Z]+-\d+)\s+"([^"]+)"/gi;
const CREATE_RE = /ELLIE::\s*create\s+ticket\s+"([^"]+)"\s+"([^"]+)"/gi;

/**
 * Extract ELLIE:: commands from a response.
 * Returns cleaned text (tags stripped) and parsed commands.
 */
export function extractPlaybookCommands(response: string): {
  cleanedText: string;
  commands: PlaybookCommand[];
} {
  const commands: PlaybookCommand[] = [];
  let cleaned = response;

  for (const match of response.matchAll(SEND_RE)) {
    commands.push({
      type: "send",
      ticketId: match[1],
      agentName: match[2].toLowerCase(),
      raw: match[0],
    });
    cleaned = cleaned.replace(match[0], "");
  }

  for (const match of response.matchAll(CLOSE_RE)) {
    commands.push({
      type: "close",
      ticketId: match[1],
      summary: match[2],
      raw: match[0],
    });
    cleaned = cleaned.replace(match[0], "");
  }

  for (const match of response.matchAll(CREATE_RE)) {
    commands.push({
      type: "create",
      title: match[1],
      description: match[2],
      raw: match[0],
    });
    cleaned = cleaned.replace(match[0], "");
  }

  return { cleanedText: cleaned.trim(), commands };
}

// ────────────────────────────────────────────────────────────────
// Command Execution
// ────────────────────────────────────────────────────────────────

function getNotifyCtx(ctx: PlaybookContext): NotifyContext {
  return {
    bot: ctx.bot,
    telegramUserId: ctx.telegramUserId,
    gchatSpaceName: ctx.gchatSpaceName,
  };
}

/**
 * Execute extracted playbook commands. Fire-and-forget from the caller.
 * Each command handler is independent and non-fatal.
 */
export async function executePlaybookCommands(
  commands: PlaybookCommand[],
  ctx: PlaybookContext,
): Promise<void> {
  for (const cmd of commands) {
    try {
      switch (cmd.type) {
        case "send":
          await handleSend(cmd, ctx);
          break;
        case "close":
          await handleClose(cmd, ctx);
          break;
        case "create":
          await handleCreate(cmd, ctx);
          break;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error("Command execution failed", { command: cmd.type, ticket: cmd.ticketId }, err);
      if (cmd.type === "send") {
        emitEvent(crypto.randomUUID(), "failed", cmd.agentName || "dev", cmd.ticketId, { error: errMsg.slice(0, 500), source: "playbook" });
      }
      await notify(getNotifyCtx(ctx), {
        event: "error",
        workItemId: cmd.ticketId || "playbook",
        telegramMessage: `Playbook ${cmd.type} failed: ${errMsg.slice(0, 100) || "unknown error"}`,
        gchatMessage: `Playbook ${cmd.type} error:\n${errMsg.slice(0, 300) || "unknown error"}`,
      }).catch(() => {});
    }
  }
}

// ────────────────────────────────────────────────────────────────
// send — dispatch agent to work a ticket
// ────────────────────────────────────────────────────────────────

async function handleSend(cmd: PlaybookCommand, ctx: PlaybookContext): Promise<void> {
  const ticketId = cmd.ticketId!;
  const agentName = cmd.agentName || "dev";
  const runId = crypto.randomUUID();

  console.log(`[playbook] send ${ticketId} to ${agentName} (run ${runId.slice(0, 8)})`);

  // 1. Fetch ticket details
  const details = await fetchWorkItemDetails(ticketId);
  if (!details) {
    await notify(getNotifyCtx(ctx), {
      event: "error",
      workItemId: ticketId,
      telegramMessage: `Could not find ${ticketId} in Plane`,
    });
    return;
  }

  // 2. Notify dispatch + emit orchestration event
  await notify(getNotifyCtx(ctx), {
    event: "dispatch_confirm",
    workItemId: ticketId,
    telegramMessage: `Dispatching ${agentName} to ${ticketId}: ${details.name}`,
    gchatMessage: `Playbook: dispatching ${agentName} to ${ticketId}: ${details.name}`,
  });
  emitEvent(runId, "dispatched", agentName, ticketId, { ticket_title: details.name, source: "playbook" });

  // 3. Start work session (creates forest tree)
  let sessionResult: Record<string, unknown> | undefined;
  try {
    const resp = await fetch("http://localhost:3001/api/work-session/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ work_item_id: ticketId, title: details.name, project: "ELLIE", entity_name: `${agentName}_agent` }),
    });
    sessionResult = await resp.json();
    if (!sessionResult?.success) {
      logger.warn("Work session start returned unexpected result", { result: sessionResult });
    }
  } catch (err: unknown) {
    logger.warn("Work session start failed (non-fatal)", err);
  }

  // 3b. Extract sessionIds from work-session/start response
  const sessionIds = sessionResult?.success ? {
    tree_id: sessionResult.tree_id,
    branch_id: sessionResult.creatures?.[0]?.branch_id,
    creature_id: sessionResult.creatures?.[0]?.id,
    entity_id: sessionResult.creatures?.[0]?.entity_id,
  } : undefined;

  // 4. Dispatch agent (get session + agent config)
  const dispatch = await dispatchAgent(ctx.supabase, agentName, ctx.telegramUserId, ctx.channel, `Work on ${ticketId}: ${details.name}`, ticketId);
  if (!dispatch) {
    await notify(getNotifyCtx(ctx), {
      event: "error",
      workItemId: ticketId,
      telegramMessage: `Failed to dispatch ${agentName} agent for ${ticketId}`,
    });
    return;
  }

  // 5. Build prompt with work item context
  const workItemContext = `\nACTIVE WORK ITEM: ${ticketId}\n` +
    `Title: ${details.name}\n` +
    `Priority: ${details.priority}\n` +
    `Description: ${details.description}\n`;

  // Load personality context for the dispatched agent
  const [archetype, psy, phase, health] = await Promise.all([
    getAgentArchetype(agentName),
    getPsyContext(),
    getPhaseContext(),
    getHealthContext(),
  ]);

  const prompt = ctx.buildPromptFn(
    `Work on ${ticketId}: ${details.name}\n\n${details.description}`,
    undefined, // contextDocket
    undefined, // relevantContext
    undefined, // elasticContext
    ctx.channel,
    dispatch.agent,
    workItemContext,
    undefined, // structuredContext
    undefined, // recentMessages
    undefined, // skillContext
    undefined, // forestContext
    undefined, // agentMemoryContext
    sessionIds, // forest sessionIds
    archetype,
    psy,
    phase,
    health,
  );

  // 6. Call Claude
  console.log(`[playbook] Calling ${agentName} for ${ticketId}...`);
  const startTime = Date.now();
  const rawResponse = await ctx.callClaudeFn(prompt, {
    resume: false,
    model: dispatch.agent.model,
    allowedTools: dispatch.agent.tools_enabled,
  });
  const durationMs = Date.now() - startTime;
  const durationMin = Math.round(durationMs / 1000 / 60);

  // 6b. Emit completion event
  emitEvent(runId, "completed", agentName, ticketId, {
    duration_ms: durationMs,
    response_length: rawResponse.length,
  });

  // 7. Process memory intents from the dev agent's response
  await processMemoryIntents(ctx.supabase, rawResponse, agentName, "shared", sessionIds);

  // 7b. Close agent session in Supabase
  if (dispatch.session_id) {
    await syncResponse(ctx.supabase, dispatch.session_id, rawResponse, {
      duration_ms: Date.now() - startTime,
      status: "completed",
      agent_name: agentName,
    });
  }

  // 8. Notify completion
  const preview = rawResponse.replace(/\[MEMORY:[^\]]*\]/gi, "").trim().slice(0, 300);
  await notify(getNotifyCtx(ctx), {
    event: "session_complete",
    workItemId: ticketId,
    telegramMessage: `${agentName} finished ${ticketId} (${durationMin}min):\n${preview}`,
    gchatMessage: `${agentName} agent completed ${ticketId} (${durationMin}min):\n${rawResponse.slice(0, 800)}`,
  });

  console.log(`[playbook] ${agentName} completed ${ticketId} in ${durationMin}min`);
}

// ────────────────────────────────────────────────────────────────
// close — complete ticket (Plane + forest + auto-deploy)
// ────────────────────────────────────────────────────────────────

async function handleClose(cmd: PlaybookCommand, ctx: PlaybookContext): Promise<void> {
  const ticketId = cmd.ticketId!;
  const summary = cmd.summary!;

  console.log(`[playbook] close ${ticketId}: ${summary.slice(0, 80)}`);

  // Call the existing work-session complete endpoint
  // It handles: forest dormant transition, auto-deploy, Plane Done update, notifications
  const resp = await fetch("http://localhost:3001/api/work-session/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ work_item_id: ticketId, summary }),
  });
  const result = await resp.json();

  if (!result?.success) {
    logger.warn("Close ticket returned unexpected result", { ticket: ticketId, result });
    // Endpoint already sends its own notifications on success,
    // so only notify on unexpected failure
    if (result?.error) {
      await notify(getNotifyCtx(ctx), {
        event: "error",
        workItemId: ticketId,
        telegramMessage: `Failed to close ${ticketId}: ${result.error}`,
      });
    }
  }
}

// ────────────────────────────────────────────────────────────────
// create — create new Plane ticket
// ────────────────────────────────────────────────────────────────

async function handleCreate(cmd: PlaybookCommand, ctx: PlaybookContext): Promise<void> {
  const title = cmd.title!;
  const description = cmd.description!;

  console.log(`[playbook] create ticket: ${title}`);

  const result = await createPlaneIssue("ELLIE", title, description);
  if (!result) {
    await notify(getNotifyCtx(ctx), {
      event: "error",
      workItemId: "create",
      telegramMessage: `Failed to create ticket: ${title}`,
    });
    return;
  }

  await notify(getNotifyCtx(ctx), {
    event: "session_start",
    workItemId: result.identifier,
    telegramMessage: `Created ${result.identifier}: ${title}`,
    gchatMessage: `New ticket ${result.identifier}: ${title}\n${description}`,
  });

  console.log(`[playbook] Created ${result.identifier}: ${title}`);
}
