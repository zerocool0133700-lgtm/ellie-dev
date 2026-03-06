/**
 * ELLIE:: Playbook Command System
 *
 * Tag-based dispatch where the general agent emits structured commands
 * in her responses. The relay catches them post-response (same pattern
 * as [CONFIRM:] and [MEMORY:]), strips them from the user-facing text,
 * and executes infrastructure actions asynchronously.
 *
 * Commands:
 *   ELLIE:: send ELLIE-144 to dev                                          — dispatch agent to work a ticket
 *   ELLIE:: close ELLIE-144 "summary"                                      — close ticket (Plane + forest + auto-deploy)
 *   ELLIE:: create ticket "title" "description"                            — create Plane issue
 *   ELLIE:: start session on ELLIE-144 with dev                            — start a work session (ELLIE-542)
 *   ELLIE:: check in on session ELLIE-144                                  — log progress check-in (ELLIE-542)
 *   ELLIE:: escalate ELLIE-144 to research "reason"                        — escalate to another agent (ELLIE-542)
 *   ELLIE:: handoff ELLIE-144 from dev to research "ctx"                   — transfer ownership (ELLIE-542)
 *   ELLIE:: pause session ELLIE-144 "blocker"                              — pause active session (ELLIE-542)
 *   ELLIE:: resume session ELLIE-144                                       — resume paused session (ELLIE-542)
 *   ELLIE:: pipeline ELLIE-144 dev→research→dev "impl→validate→finalize"  — sequential multi-agent pipeline (ELLIE-544)
 */

import type { Bot } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import { notify, type NotifyContext } from "./notification-policy.ts";
import { log } from "./logger.ts";
import { getAgentArchetype, getAgentRoleContext, getPsyContext, getPhaseContext, getHealthContext } from "./prompt-builder.ts";

const logger = log.child("playbook");
import {
  fetchWorkItemDetails,
  createPlaneIssue,
} from "./plane.ts";
import { parseAgentSequence, parseStepDescriptions } from "./pipeline.ts";
import { RELAY_BASE_URL } from "./relay-config.ts";
import { dispatchAgent, syncResponse } from "./agent-router.ts";
import { processMemoryIntents } from "./memory.ts";
import { emitEvent } from "./orchestration-ledger.ts";
import { startRun, endRun, getActiveRunForWorkItem } from "./orchestration-tracker.ts";
import { enqueue } from "./dispatch-queue.ts";
import { withTrace, getTraceId } from "./trace.ts";

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface PlaybookCommand {
  type: "send" | "close" | "create" | "start-session" | "check-in" | "escalate" | "handoff" | "pause-session" | "resume-session" | "pipeline";
  ticketId?: string;
  agentName?: string;
  fromAgent?: string;      // handoff: source agent
  summary?: string;
  title?: string;
  description?: string;
  reason?: string;         // escalate/pause-session: reason text
  context?: string;        // handoff: context note
  agents?: string[];       // pipeline: ordered agent sequence
  pipelineSteps?: string[]; // pipeline: step descriptions
  raw: string;
}

export interface PlaybookContext {
  bot: Bot;
  supabase: SupabaseClient | null;
  telegramUserId: string;
  gchatSpaceName?: string;
  channel: string;
  callClaudeFn: (prompt: string, options?: { resume?: boolean; allowedTools?: string[]; model?: string; runId?: string }) => Promise<string>;
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

const SEND_RE           = /ELLIE::\s*send\s+([A-Z]+-\d+)\s+to\s+(\w+)/gi;
const CLOSE_RE          = /ELLIE::\s*close\s+([A-Z]+-\d+)\s+"([^"]+)"/gi;
const CREATE_RE         = /ELLIE::\s*create\s+ticket\s+"([^"]+)"\s+"([^"]+)"/gi;
const START_SESSION_RE  = /ELLIE::\s*start\s+session\s+on\s+([A-Z]+-\d+)\s+with\s+(\w+)/gi;
const CHECK_IN_RE       = /ELLIE::\s*check\s+in\s+on\s+session\s+([A-Z]+-\d+)/gi;
const ESCALATE_RE       = /ELLIE::\s*escalate\s+([A-Z]+-\d+)\s+to\s+(\w+)\s+"([^"]+)"/gi;
const HANDOFF_RE        = /ELLIE::\s*handoff\s+([A-Z]+-\d+)\s+from\s+(\w+)\s+to\s+(\w+)\s+"([^"]+)"/gi;
const PAUSE_SESSION_RE  = /ELLIE::\s*pause\s+session\s+([A-Z]+-\d+)\s+"([^"]+)"/gi;
const RESUME_SESSION_RE = /ELLIE::\s*resume\s+session\s+([A-Z]+-\d+)/gi;
const PIPELINE_RE       = /ELLIE::\s*pipeline\s+([A-Z]+-\d+)\s+([^\s"]+)\s+"([^"]+)"/gi;

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

  for (const match of response.matchAll(START_SESSION_RE)) {
    commands.push({
      type: "start-session",
      ticketId: match[1],
      agentName: match[2].toLowerCase(),
      raw: match[0],
    });
    cleaned = cleaned.replace(match[0], "");
  }

  for (const match of response.matchAll(CHECK_IN_RE)) {
    commands.push({
      type: "check-in",
      ticketId: match[1],
      raw: match[0],
    });
    cleaned = cleaned.replace(match[0], "");
  }

  for (const match of response.matchAll(ESCALATE_RE)) {
    commands.push({
      type: "escalate",
      ticketId: match[1],
      agentName: match[2].toLowerCase(),
      reason: match[3],
      raw: match[0],
    });
    cleaned = cleaned.replace(match[0], "");
  }

  for (const match of response.matchAll(HANDOFF_RE)) {
    commands.push({
      type: "handoff",
      ticketId: match[1],
      fromAgent: match[2].toLowerCase(),
      agentName: match[3].toLowerCase(),
      context: match[4],
      raw: match[0],
    });
    cleaned = cleaned.replace(match[0], "");
  }

  for (const match of response.matchAll(PAUSE_SESSION_RE)) {
    commands.push({
      type: "pause-session",
      ticketId: match[1],
      reason: match[2],
      raw: match[0],
    });
    cleaned = cleaned.replace(match[0], "");
  }

  for (const match of response.matchAll(RESUME_SESSION_RE)) {
    commands.push({
      type: "resume-session",
      ticketId: match[1],
      raw: match[0],
    });
    cleaned = cleaned.replace(match[0], "");
  }

  for (const match of response.matchAll(PIPELINE_RE)) {
    commands.push({
      type: "pipeline",
      ticketId: match[1],
      agents: parseAgentSequence(match[2]),
      pipelineSteps: parseStepDescriptions(match[3]),
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
        case "start-session":
          await handleStartSession(cmd, ctx);
          break;
        case "check-in":
          await handleCheckIn(cmd, ctx);
          break;
        case "escalate":
          await handleEscalate(cmd, ctx);
          break;
        case "handoff":
          await handleHandoff(cmd, ctx);
          break;
        case "pause-session":
          await handlePauseSession(cmd, ctx);
          break;
        case "resume-session":
          await handleResumeSession(cmd, ctx);
          break;
        case "pipeline":
          await handlePipeline(cmd, ctx);
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
      }).catch(notifyErr => {
        logger.warn("Playbook error notification failed", { command: cmd.type }, notifyErr);
      });
    }
  }
}

// ────────────────────────────────────────────────────────────────
// send — dispatch agent to work a ticket
// ────────────────────────────────────────────────────────────────

async function handleSend(cmd: PlaybookCommand, ctx: PlaybookContext): Promise<void> {
  const ticketId = cmd.ticketId!;
  const agentName = cmd.agentName || "dev";

  // ELLIE-376 + ELLIE-396: Queue instead of rejecting when agent is busy
  const existingRun = getActiveRunForWorkItem(ticketId);
  if (existingRun) {
    const queueId = crypto.randomUUID();
    const notifyCtx = getNotifyCtx(ctx);

    const { position } = enqueue({
      id: queueId,
      agentType: agentName,
      workItemId: ticketId,
      channel: ctx.channel,
      message: `Work on ${ticketId}`,
      enqueuedAt: Date.now(),
      notifyCtx,
      execute: () => {
        handleSend(cmd, ctx);
      },
    });

    logger.info("Playbook dispatch queued — active run exists", {
      ticketId,
      existingRunId: existingRun.runId.slice(0, 8),
      requestedAgent: agentName,
      queuePosition: position,
    });

    await notify(notifyCtx, {
      event: "dispatch_confirm",
      workItemId: ticketId,
      telegramMessage: `${ticketId} queued for ${agentName} (position ${position}) — waiting for current ${existingRun.agentType} run`,
    });
    return;
  }

  const runId = crypto.randomUUID();

  logger.info(`send ${ticketId} to ${agentName}`, { ticketId, agentName, runId: runId.slice(0, 8) });

  // Register with orchestration tracker (ELLIE-371: was missing, caused zombie runs)
  startRun(runId, agentName, ticketId, undefined, { channel: ctx.channel, message: `Work on ${ticketId}` });

  // 1. Fetch ticket details
  const details = await fetchWorkItemDetails(ticketId);
  if (!details) {
    await notify(getNotifyCtx(ctx), {
      event: "error",
      workItemId: ticketId,
      telegramMessage: `Could not find ${ticketId} in Plane`,
    });
    emitEvent(runId, "failed", agentName, ticketId, { error: "ticket_not_found", source: "playbook" });
    endRun(runId, "failed");
    return;
  }

  // 2. Notify dispatch + emit orchestration event
  await notify(getNotifyCtx(ctx), {
    event: "dispatch_confirm",
    workItemId: ticketId,
    telegramMessage: `Dispatching ${agentName} to ${ticketId}: ${details.name}`,
    gchatMessage: `Playbook: dispatching ${agentName} to ${ticketId}: ${details.name}`,
  });
  emitEvent(runId, "dispatched", agentName, ticketId, { ticket_title: details.name, source: "playbook", trace_id: getTraceId() });

  // 3. Start work session (creates forest tree)
  let sessionResult: Record<string, unknown> | undefined;
  try {
    const resp = await fetch(`${RELAY_BASE_URL}/api/work-session/start`, {
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
    emitEvent(runId, "failed", agentName, ticketId, { error: "dispatch_failed", source: "playbook" });
    endRun(runId, "failed");
    return;
  }

  // 5. Build prompt with work item context
  const workItemContext = `\nACTIVE WORK ITEM: ${ticketId}\n` +
    `Title: ${details.name}\n` +
    `Priority: ${details.priority}\n` +
    `Description: ${details.description}\n`;

  // Load personality context for the dispatched agent
  const [archetype, roleContext, psy, phase, health] = await Promise.all([
    getAgentArchetype(agentName),
    getAgentRoleContext(agentName),
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
    roleContext,
    psy,
    phase,
    health,
  );

  // 6-8. Execute agent, process results, notify — all wrapped to ensure endRun() fires
  try {
    // 6. Call Claude (pass runId for heartbeat tracking)
    logger.info(`Calling ${agentName} for ${ticketId}`, { agentName, ticketId });
    const startTime = Date.now();
    const rawResponse = await ctx.callClaudeFn(prompt, {
      resume: false,
      model: dispatch.agent.model,
      allowedTools: dispatch.agent.tools_enabled,
      runId,
    });
    const durationMs = Date.now() - startTime;
    const durationMin = Math.round(durationMs / 1000 / 60);

    // 6b. Emit completion event and terminate run in tracker
    emitEvent(runId, "completed", agentName, ticketId, {
      duration_ms: durationMs,
      response_length: rawResponse.length,
    });
    endRun(runId, "completed");

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
  } catch (execErr: unknown) {
    // Ensure run is terminated even on crash
    const errMsg = execErr instanceof Error ? execErr.message : String(execErr);
    logger.error("Playbook agent execution failed", { runId: runId.slice(0, 8), agentName, ticketId }, execErr);
    emitEvent(runId, "failed", agentName, ticketId, { error: errMsg.slice(0, 500), source: "playbook" });
    endRun(runId, "failed");
    throw execErr; // Re-throw so outer catch can notify
  }

  logger.info(`${agentName} completed ${ticketId} in ${durationMin}min`, { agentName, ticketId, durationMin });
}

// ────────────────────────────────────────────────────────────────
// close — complete ticket (Plane + forest + auto-deploy)
// ────────────────────────────────────────────────────────────────

async function handleClose(cmd: PlaybookCommand, ctx: PlaybookContext): Promise<void> {
  const ticketId = cmd.ticketId!;
  const summary = cmd.summary!;

  logger.info("Close ticket", { ticketId, summary: summary.slice(0, 80) });

  // Call the existing work-session complete endpoint
  // It handles: forest dormant transition, auto-deploy, Plane Done update, notifications
  const resp = await fetch(`${RELAY_BASE_URL}/api/work-session/complete`, {
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

  logger.info(`Create ticket: ${title}`, { title });

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

  logger.info(`Created ${result.identifier}: ${title}`, { identifier: result.identifier, title });
}

// ────────────────────────────────────────────────────────────────
// start-session — start a work session for a ticket (ELLIE-542)
// ────────────────────────────────────────────────────────────────

async function handleStartSession(cmd: PlaybookCommand, ctx: PlaybookContext): Promise<void> {
  const ticketId = cmd.ticketId!;
  const agentName = cmd.agentName;

  logger.info(`start-session ${ticketId} with ${agentName ?? "auto"}`, { ticketId, agentName: agentName ?? "auto" });

  const details = await fetchWorkItemDetails(ticketId);
  if (!details) {
    await notify(getNotifyCtx(ctx), {
      event: "error",
      workItemId: ticketId,
      telegramMessage: `Could not find ${ticketId} in Plane`,
    });
    return;
  }

  const resp = await fetch(`${RELAY_BASE_URL}/api/work-session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ work_item_id: ticketId, title: details.name, project: "ELLIE", agent: agentName }),
  });
  const result = await resp.json();
  if (!result?.success && result?.error) {
    logger.warn("Start session returned unexpected result", { ticket: ticketId, result });
    await notify(getNotifyCtx(ctx), {
      event: "error",
      workItemId: ticketId,
      telegramMessage: `Failed to start session for ${ticketId}: ${result.error}`,
    });
  }
}

// ────────────────────────────────────────────────────────────────
// check-in — log a progress check-in for an active session (ELLIE-542)
// ────────────────────────────────────────────────────────────────

async function handleCheckIn(cmd: PlaybookCommand, ctx: PlaybookContext): Promise<void> {
  const ticketId = cmd.ticketId!;

  logger.info(`check-in ${ticketId}`, { ticketId });

  const resp = await fetch(`${RELAY_BASE_URL}/api/work-session/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ work_item_id: ticketId, message: "Agent check-in: still active" }),
  });
  const result = await resp.json();
  if (!result?.success) {
    logger.warn("Check-in returned unexpected result", { ticket: ticketId, result });
  }
}

// ────────────────────────────────────────────────────────────────
// escalate — escalate ticket to another agent (ELLIE-542)
// ────────────────────────────────────────────────────────────────

async function handleEscalate(cmd: PlaybookCommand, ctx: PlaybookContext): Promise<void> {
  const ticketId = cmd.ticketId!;
  const agentName = cmd.agentName!;
  const reason = cmd.reason!;

  logger.info("Escalate ticket", { ticketId, agentName, reason: reason.slice(0, 80) });

  const message = `Escalated to ${agentName}: ${reason}`;
  const resp = await fetch(`${RELAY_BASE_URL}/api/work-session/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ work_item_id: ticketId, message }),
  });
  const result = await resp.json();
  if (!result?.success) {
    logger.warn("Escalate update returned unexpected result", { ticket: ticketId, result });
  }

  await notify(getNotifyCtx(ctx), {
    event: "dispatch_confirm",
    workItemId: ticketId,
    telegramMessage: `Escalated ${ticketId} to ${agentName}: ${reason}`,
    gchatMessage: `Escalation: ${ticketId} → ${agentName}\n${reason}`,
  });
}

// ────────────────────────────────────────────────────────────────
// handoff — transfer ticket ownership between agents (ELLIE-542)
// ────────────────────────────────────────────────────────────────

async function handleHandoff(cmd: PlaybookCommand, ctx: PlaybookContext): Promise<void> {
  const ticketId = cmd.ticketId!;
  const fromAgent = cmd.fromAgent!;
  const toAgent = cmd.agentName!;
  const context = cmd.context!;

  logger.info(`handoff ${ticketId} from ${fromAgent} to ${toAgent}`, { ticketId, fromAgent, toAgent });

  const message = `Handoff from ${fromAgent} to ${toAgent}: ${context}`;
  const resp = await fetch(`${RELAY_BASE_URL}/api/work-session/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ work_item_id: ticketId, message, agent: toAgent }),
  });
  const result = await resp.json();
  if (!result?.success) {
    logger.warn("Handoff update returned unexpected result", { ticket: ticketId, result });
  }

  await notify(getNotifyCtx(ctx), {
    event: "dispatch_confirm",
    workItemId: ticketId,
    telegramMessage: `Handoff ${ticketId}: ${fromAgent} → ${toAgent}\n${context}`,
    gchatMessage: `Handoff: ${ticketId} from ${fromAgent} to ${toAgent}\n${context}`,
  });
}

// ────────────────────────────────────────────────────────────────
// pause-session — pause an active work session (ELLIE-542)
// ────────────────────────────────────────────────────────────────

async function handlePauseSession(cmd: PlaybookCommand, ctx: PlaybookContext): Promise<void> {
  const ticketId = cmd.ticketId!;
  const reason = cmd.reason;

  logger.info(`pause-session ${ticketId}`, { ticketId });

  const resp = await fetch(`${RELAY_BASE_URL}/api/work-session/pause`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ work_item_id: ticketId, reason }),
  });
  const result = await resp.json();
  if (!result?.success && result?.error) {
    logger.warn("Pause session returned unexpected result", { ticket: ticketId, result });
    await notify(getNotifyCtx(ctx), {
      event: "error",
      workItemId: ticketId,
      telegramMessage: `Failed to pause ${ticketId}: ${result.error}`,
    });
  }
}

// ────────────────────────────────────────────────────────────────
// resume-session — resume a paused work session (ELLIE-542)
// ────────────────────────────────────────────────────────────────

async function handleResumeSession(cmd: PlaybookCommand, ctx: PlaybookContext): Promise<void> {
  const ticketId = cmd.ticketId!;

  logger.info(`resume-session ${ticketId}`, { ticketId });

  const resp = await fetch(`${RELAY_BASE_URL}/api/work-session/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ work_item_id: ticketId }),
  });
  const result = await resp.json();
  if (!result?.success && result?.error) {
    logger.warn("Resume session returned unexpected result", { ticket: ticketId, result });
    await notify(getNotifyCtx(ctx), {
      event: "error",
      workItemId: ticketId,
      telegramMessage: `Failed to resume ${ticketId}: ${result.error}`,
    });
  }
}

// ────────────────────────────────────────────────────────────────
// pipeline — sequential multi-agent coordination (ELLIE-544)
// ────────────────────────────────────────────────────────────────

async function handlePipeline(cmd: PlaybookCommand, ctx: PlaybookContext): Promise<void> {
  const ticketId = cmd.ticketId!;
  const agents = cmd.agents ?? [];
  const stepDescs = cmd.pipelineSteps ?? [];

  if (agents.length === 0) {
    logger.warn("pipeline: no agents specified", { ticketId });
    return;
  }

  logger.info(`pipeline ${ticketId}: ${agents.join("→")}`, { ticketId, agents, stepCount: agents.length });

  // Fetch ticket details once — shared across all steps
  const details = await fetchWorkItemDetails(ticketId);
  if (!details) {
    await notify(getNotifyCtx(ctx), {
      event: "error",
      workItemId: ticketId,
      telegramMessage: `Pipeline: could not find ${ticketId} in Plane`,
    });
    return;
  }

  const {
    createPipeline,
    startCurrentStep,
    completeCurrentStep,
    failCurrentStep,
    buildStepContext,
    formatPipelineSummary,
  } = await import("./pipeline.ts");

  const pipeline = createPipeline(ticketId, agents, stepDescs);

  await notify(getNotifyCtx(ctx), {
    event: "session_start",
    workItemId: ticketId,
    telegramMessage: `Pipeline started: ${ticketId} — ${agents.join(" → ")} (${agents.length} steps)\n${details.name}`,
    gchatMessage: `Pipeline: ${ticketId}\n${agents.map((a, i) => `${i + 1}. ${a}: ${stepDescs[i] ?? "step"}`).join("\n")}`,
  });

  // Run each step sequentially
  for (let i = 0; i < pipeline.steps.length; i++) {
    startCurrentStep(pipeline.id);
    const step = pipeline.steps[i];
    const priorContext = buildStepContext(pipeline);

    const workItemContext =
      `\nPIPELINE: ${ticketId} — Step ${i + 1}/${pipeline.steps.length}\n` +
      `Task: ${step.description}\n`;

    const userMessage =
      `Work on ${ticketId} — ${step.description}\n\n${details.description}` +
      (priorContext ? `\n\nPRIOR STEPS:\n${priorContext}` : "");

    try {
      const dispatch = await dispatchAgent(
        ctx.supabase,
        step.agent,
        ctx.telegramUserId,
        ctx.channel,
        `${step.description} on ${ticketId}`,
        ticketId,
      );

      if (!dispatch) {
        failCurrentStep(pipeline.id, "dispatch failed");
        await notify(getNotifyCtx(ctx), {
          event: "error",
          workItemId: ticketId,
          telegramMessage: `Pipeline ${ticketId} step ${i + 1} failed: could not dispatch ${step.agent}`,
        });
        return;
      }

      await notify(getNotifyCtx(ctx), {
        event: "dispatch_confirm",
        workItemId: ticketId,
        telegramMessage: `Pipeline step ${i + 1}/${pipeline.steps.length}: ${step.agent} — ${step.description}`,
      });

      const prompt = ctx.buildPromptFn(
        userMessage,
        undefined, undefined, undefined,
        ctx.channel,
        dispatch.agent,
        workItemContext,
      );

      const response = await ctx.callClaudeFn(prompt, {
        resume: false,
        model: dispatch.agent.model,
        allowedTools: dispatch.agent.tools_enabled,
      });

      // Capture output (strip memory tags) for context passing to next step
      const output = response.replace(/\[MEMORY:[^\]]*\]/gi, "").trim().slice(0, 2000);

      if (dispatch.session_id) {
        await syncResponse(ctx.supabase, dispatch.session_id, response, {
          status: "completed",
          agent_name: step.agent,
        });
      }

      const result = completeCurrentStep(pipeline.id, output);

      if (result?.done) {
        await notify(getNotifyCtx(ctx), {
          event: "session_complete",
          workItemId: ticketId,
          telegramMessage: `Pipeline complete: ${ticketId} — all ${agents.length} steps done ✓\n${formatPipelineSummary(pipeline)}`,
          gchatMessage: formatPipelineSummary(pipeline),
        });
        return;
      }

      // Brief step-complete notification before continuing to next
      const preview = output.slice(0, 200);
      await notify(getNotifyCtx(ctx), {
        event: "session_update",
        workItemId: ticketId,
        telegramMessage: `Step ${i + 1} done (${step.agent}): ${preview}…\nHanding off to ${pipeline.steps[pipeline.currentStepIndex]?.agent}`,
        gchatMessage: `Step ${i + 1}/${pipeline.steps.length} complete — ${step.agent} → ${pipeline.steps[pipeline.currentStepIndex]?.agent}`,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      failCurrentStep(pipeline.id, errMsg);
      logger.error(`Pipeline step ${i + 1} failed for ${ticketId}`, { agent: step.agent, ticketId, step: i + 1, error: errMsg });
      await notify(getNotifyCtx(ctx), {
        event: "error",
        workItemId: ticketId,
        telegramMessage: `Pipeline ${ticketId} step ${i + 1} (${step.agent}) failed: ${errMsg.slice(0, 100)}`,
      });
      throw err;
    }
  }
}
