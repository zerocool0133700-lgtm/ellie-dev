/**
 * Work Session Communication Endpoints
 *
 * These endpoints back the CLAUDE.md dispatch protocol.
 * Claude Code sessions call these to send session lifecycle events
 * back to the relay for routing to Telegram (status notifications), Plane, and logs.
 * Rich content (idea extraction, reports) routes to Google Chat separately.
 */

import type { Bot } from "grammy";
import type { ApiRequest, ApiResponse } from "./types.ts";
import { log } from "../logger.ts";

const logger = log.child("work-session");
import type { SupabaseClient } from "@supabase/supabase-js";
import { updateWorkItemOnSessionStart, updateWorkItemOnSessionComplete } from "../plane.ts";
import {
  startWorkSession as forestStartSession,
  completeWorkSession as forestCompleteSession,
  pauseWorkSession as forestPauseSession,
  resumeWorkSession as forestResumeSession,
  addWorkSessionUpdate as forestAddUpdate,
  addWorkSessionDecision as forestAddDecision,
  getWorkSessionByPlaneId,
  getEntity,
  getAgent,
} from '../../../ellie-forest/src/index';
import { notify, type NotifyContext } from "../notification-policy.ts";
import { findJobByTreeId, writeJobTouchpointForAgent } from "../jobs-ledger.ts";
import { resolveEntityName } from "../agent-entity-map.ts";
import { writeDecisionToForest } from "../decision-forest-writer.ts";
import { writeFindingToForest } from "../finding-forest-writer.ts";
import {
  writeWorkTrailStart,
  appendWorkTrailProgress,
  buildWorkTrailUpdateAppend,
  buildWorkTrailCompleteAppend,
} from "../work-trail-writer.ts";
import { verifyDispatch } from "../dispatch-verifier.ts";
import { journalDispatchStart, journalDispatchEnd } from "../dispatch-journal.ts";
import { dashboardOnStart, dashboardOnComplete, dashboardOnPause, dashboardOnBlocked } from "../active-tickets-dashboard.ts";
import { ensureContextCard, appendWorkHistory, appendHandoffNote } from "../ticket-context-card.ts";
import { writePostMortem, classifyPauseReason } from "../post-mortem.ts";
import { validateWorkflowInput, type WorkflowDefinition, type WorkflowInput } from "../workflow-schema.ts";
import { resolveChainAction, formatChainForTelegram, formatChainForGChat } from "../workflow-chainer.ts";
import { persistToForest as persistMetricsToForest } from "../growth-metrics-collector.ts";
import { requestCriticReview } from "../dev-critic-review.ts";

/**
 * Resolve agent from Supabase agent_sessions when not explicitly provided.
 * Looks up the most recently active session to determine which agent was routed.
 */
async function resolveAgent(
  supabase: SupabaseClient | null,
  explicitAgent?: string,
): Promise<string | undefined> {
  if (explicitAgent) return explicitAgent;
  if (!supabase) return undefined;

  try {
    const { data } = await supabase
      .from("agent_sessions")
      .select("agents(name)")
      .eq("state", "active")
      .order("last_activity", { ascending: false })
      .limit(1)
      .single();

    const agents = (data as Record<string, unknown>)?.agents;
    const name = (agents as Record<string, unknown>)?.name;
    if (typeof name === "string" && name) {
      logger.info(`Auto-resolved agent from active session: ${name}`);
      return name;
    }
  } catch {
    // Non-fatal — fall back to no agent
  }
  return undefined;
}

const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID!;
const GCHAT_SPACE = process.env.GOOGLE_CHAT_SPACE_NAME;

// ── ELLIE-578: River write failure tracking ──────────────────────────────────

interface RiverWriteMetrics {
  totalFailures: number;
  failuresByOp: Record<string, number>;
  lastFailure: { op: string; error: string; ts: string } | null;
}

const _riverWriteMetrics: RiverWriteMetrics = {
  totalFailures: 0,
  failuresByOp: {},
  lastFailure: null,
};

/** Log and track a fire-and-forget River write failure. */
function logRiverWriteFailure(op: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  logger.warn(`River write failed: ${op}`, { op, error: msg });
  _riverWriteMetrics.totalFailures++;
  _riverWriteMetrics.failuresByOp[op] = (_riverWriteMetrics.failuresByOp[op] ?? 0) + 1;
  _riverWriteMetrics.lastFailure = { op, error: msg, ts: new Date().toISOString() };
}

/** Get River write failure metrics — wired into /api/token-health. */
export function getRiverWriteMetrics(): RiverWriteMetrics {
  return { ..._riverWriteMetrics, failuresByOp: { ..._riverWriteMetrics.failuresByOp } };
}

/** Reset metrics — for testing only. */
export function _resetRiverWriteMetricsForTesting(): void {
  _riverWriteMetrics.totalFailures = 0;
  _riverWriteMetrics.failuresByOp = {};
  _riverWriteMetrics.lastFailure = null;
}

/** Escape Telegram MarkdownV2 special characters. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

function getNotifyCtx(bot: Bot): NotifyContext {
  return { bot, telegramUserId: TELEGRAM_USER_ID, gchatSpaceName: GCHAT_SPACE };
}

/**
 * POST /api/work-session/start
 *
 * Logs session start, posts to Telegram, optionally updates Plane work item to "In Progress"
 *
 * Body:
 * {
 *   "work_item_id": "ELLIE-1",
 *   "title": "Implement Communication Endpoints",
 *   "project": "ellie-dev",
 *   "agent": "james" // optional
 * }
 */
export async function startWorkSession(req: ApiRequest, res: ApiResponse, bot: Bot, supabase?: SupabaseClient | null) {
  try {
    const { work_item_id, title, project, agent: explicitAgent,
      workflow_id, workflow_steps, current_step, on_complete, step_context,
    } = req.body as Record<string, unknown>;

    if (!work_item_id || !title || !project) {
      return res.status(400).json({
        error: 'Missing required fields: work_item_id, title, project'
      });
    }

    // ELLIE-593: Validate workflow fields if present
    const workflowInput: WorkflowInput = {
      workflow_id: workflow_id as string | undefined,
      workflow_steps: workflow_steps as unknown[] | undefined,
      current_step: current_step as number | undefined,
      on_complete: on_complete as string | undefined,
      step_context: step_context as string | undefined,
    };
    const workflowResult = validateWorkflowInput(workflowInput);
    if (!workflowResult.valid) {
      return res.status(400).json({
        error: "Invalid workflow definition",
        details: workflowResult.errors,
      });
    }
    const workflow: WorkflowDefinition | undefined = workflowResult.definition;

    // Resolve agent: use explicit value if provided, otherwise auto-detect from active session
    const agent = await resolveAgent(supabase ?? null, explicitAgent as string | undefined);

    // Validate agent exists before touching Plane or Forest
    if (agent) {
      const agentRecord = await getAgent(agent);
      if (!agentRecord) {
        return res.status(400).json({ error: `Agent "${agent}" does not exist` });
      }
    }

    const entityName = agent ? resolveEntityName(agent) : undefined;
    const entityNames = entityName ? [entityName] : undefined;

    // Create forest tree (dedup + transactional — safe to call multiple times)
    const result = await forestStartSession({
      title, work_item_id,
      entity_names: entityNames,
    });
    const { tree, trunk, creatures, branches } = result;

    // ELLIE-531: Create work trail document (fire-and-forget, non-fatal)
    writeWorkTrailStart(work_item_id, title, agent).catch(e => logRiverWriteFailure("writeWorkTrailStart", e));

    // ELLIE-565: Log dispatch start to daily journal (fire-and-forget)
    journalDispatchStart({
      workItemId: work_item_id,
      title,
      agent,
      sessionId: tree.id,
      pid: process.pid,
    }).catch(e => logRiverWriteFailure("journalDispatchStart", e));

    // ELLIE-566: Update active tickets dashboard (fire-and-forget)
    dashboardOnStart({
      workItemId: work_item_id,
      title,
      agent,
      startedAt: new Date().toISOString(),
    }).catch(e => logRiverWriteFailure("dashboardOnStart", e));

    // ELLIE-567: Ensure ticket context card exists (fire-and-forget)
    ensureContextCard({ workItemId: work_item_id, title, agent }).catch(e => logRiverWriteFailure("ensureContextCard", e));

    if ((result as Record<string, unknown>).resumed) {
      logger.info(`Resumed existing session ${tree.id} for ${work_item_id}`);
    }

    // Notify via policy engine (Telegram + Google Chat per routing rules)
    const telegramMsg = [
      `🚀 **Work Session Started**`,
      ``,
      `**${escapeMarkdown(work_item_id)}:** ${escapeMarkdown(title)}`,
      agent ? `**Agent:** ${escapeMarkdown(agent)}` : '',
    ].filter(Boolean).join('\n');

    const gchatMsg = [
      `🚀 Work Session Started`,
      ``,
      `${work_item_id}: ${title}`,
      `Project: ${project}`,
      agent ? `Agent: ${agent}` : '',
      `Session: ${tree.id}`,
    ].filter(Boolean).join('\n');

    await notify(getNotifyCtx(bot), {
      event: "session_start",
      workItemId: work_item_id,
      telegramMessage: telegramMsg,
      gchatMessage: gchatMsg,
    });

    // Update Plane work item: set "In Progress" + add session comment (skip on resumed sessions)
    if (!(result as Record<string, unknown>).resumed) {
      try {
        await updateWorkItemOnSessionStart(work_item_id, tree.id);
      } catch (planeError) {
        logger.warn("Plane update failed (non-fatal)", planeError);
      }
    } else {
      logger.info("Skipping Plane update — resumed session");
    }

    return res.json({
      success: true,
      session_id: tree.id,
      tree_id: tree.id,
      work_item_id,
      started_at: tree.created_at,
      branches: (branches ?? []).map((b: Record<string, unknown>) => ({
        id: b.id,
        name: b.name,
        entity_id: b.entity_id,
      })),
      creatures: (creatures ?? []).map((c: Record<string, unknown>) => ({
        id: c.id,
        branch_id: c.branch_id,
        entity_id: c.entity_id,
      })),
      // ELLIE-593: Include workflow definition if provided
      ...(workflow ? { workflow } : {}),
    });

  } catch (error) {
    logger.error("Start handler failed", error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/work-session/update
 *
 * Sends progress update to Telegram/GChat and logs to forest
 *
 * Body:
 * {
 *   "work_item_id": "ELLIE-1",
 *   "message": "Created POST /api/work-session/start endpoint",
 *   "type": "finding",       // optional — "finding" triggers Forest Bridge write (ELLIE-586)
 *   "confidence": 0.8        // optional — confidence for finding (default 0.7)
 * }
 */
export async function updateWorkSession(req: ApiRequest, res: ApiResponse, bot: Bot) {
  try {
    const { work_item_id, message, agent, git_sha, type, confidence } = req.body;

    if (!work_item_id || !message) {
      return res.status(400).json({
        error: 'Missing required fields: work_item_id, message'
      });
    }

    // Find active forest tree (replaces Supabase lookup)
    const tree = await getWorkSessionByPlaneId(work_item_id);
    if (!tree) {
      return res.status(404).json({ error: 'No active session found for this work item' });
    }

    // Resolve entity (optional)
    const entity = agent ? await getEntity(agent) : null;

    // Add progress commit (replaces Supabase insert)
    await forestAddUpdate(tree.id, entity?.id, message, undefined, git_sha || undefined);

    // ELLIE-586: If type is "finding", fire-and-forget write to Forest Bridge
    if (type === "finding") {
      writeFindingToForest(work_item_id, message, agent, confidence).catch(e =>
        logRiverWriteFailure("writeFindingToForest", e));
    }

    // ELLIE-531: Append update to work trail (fire-and-forget, non-fatal)
    appendWorkTrailProgress(work_item_id, buildWorkTrailUpdateAppend(message)).catch(e => logRiverWriteFailure("appendWorkTrailProgress/update", e));

    // Notify via policy engine (Google Chat only by default — Telegram disabled for updates)
    const telegramMsg = [
      `📝 **Progress Update**`,
      ``,
      `**${escapeMarkdown(work_item_id)}:** ${escapeMarkdown(tree.title || work_item_id)}`,
      agent ? `**Agent:** ${escapeMarkdown(agent)}` : '',
      ``,
      escapeMarkdown(message)
    ].filter(Boolean).join('\n');

    const gchatMsg = [
      `📝 Progress Update`,
      ``,
      `${work_item_id}: ${tree.title || work_item_id}`,
      agent ? `Agent: ${agent}` : '',
      ``,
      message,
    ].filter(Boolean).join('\n');

    await notify(getNotifyCtx(bot), {
      event: "session_update",
      workItemId: work_item_id,
      telegramMessage: telegramMsg,
      gchatMessage: gchatMsg,
    });

    return res.json({
      success: true,
      session_id: tree.id,
      work_item_id
    });

  } catch (error) {
    logger.error("Update handler failed", error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/work-session/decision
 *
 * Logs key decision point (architectural choice, blocker, needs user input)
 *
 * Body:
 * {
 *   "work_item_id": "ELLIE-1",
 *   "message": "Decision: Using Express router instead of direct app.post for modularity"
 * }
 */
export async function logDecision(req: ApiRequest, res: ApiResponse, bot: Bot) {
  try {
    const { work_item_id, message, agent } = req.body;

    if (!work_item_id || !message) {
      return res.status(400).json({
        error: 'Missing required fields: work_item_id, message'
      });
    }

    // Find active forest tree (replaces Supabase lookup)
    const tree = await getWorkSessionByPlaneId(work_item_id);
    if (!tree) {
      return res.status(404).json({ error: 'No active session found for this work item' });
    }

    // Resolve entity (optional)
    const entity = agent ? await getEntity(agent) : null;

    // Add decision commit (replaces Supabase insert)
    await forestAddDecision(tree.id, entity?.id, message);

    // Notify via policy engine (both channels — decisions always go through)
    const telegramMsg = [
      `⚡ **Decision Point**`,
      ``,
      `**${escapeMarkdown(work_item_id)}:** ${escapeMarkdown(tree.title || work_item_id)}`,
      agent ? `**Agent:** ${escapeMarkdown(agent)}` : '',
      ``,
      escapeMarkdown(message)
    ].filter(Boolean).join('\n');

    const gchatMsg = [
      `⚡ Decision Point`,
      ``,
      `${work_item_id}: ${tree.title || work_item_id}`,
      agent ? `Agent: ${agent}` : '',
      ``,
      message,
    ].filter(Boolean).join('\n');

    await notify(getNotifyCtx(bot), {
      event: "session_decision",
      workItemId: work_item_id,
      telegramMessage: telegramMsg,
      gchatMessage: gchatMsg,
    });

    // ELLIE-585: Fire-and-forget Forest Bridge write — queryable decision node
    writeDecisionToForest(work_item_id, message, agent).catch(e =>
      logRiverWriteFailure("writeDecisionToForest", e));

    // ELLIE-455: J scope touchpoint — decision logged
    findJobByTreeId(tree.id).then(job => {
      if (!job) return;
      writeJobTouchpointForAgent(job.job_id, job.agent_type, job.creature_id, "decision",
        `${agent ?? job.agent_type ?? "agent"} made decision on ${work_item_id}: ${message.slice(0, 400)}`,
        { workItemId: work_item_id },
      ).catch(e => logRiverWriteFailure("writeJobTouchpoint/decision", e));
    }).catch(e => logRiverWriteFailure("findJobByTreeId/decision", e));

    return res.json({
      success: true,
      session_id: tree.id,
      work_item_id
    });

  } catch (error) {
    logger.error("Decision handler failed", error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/work-session/complete
 *
 * Marks session complete, updates Plane work item to "Done", posts summary to Telegram
 *
 * Body:
 * {
 *   "work_item_id": "ELLIE-1",
 *   "summary": "Implemented all four communication endpoints. Tested with curl."
 * }
 */
export async function completeWorkSession(req: ApiRequest, res: ApiResponse, bot: Bot) {
  try {
    const { work_item_id, summary, agent, workflow: workflowRaw } = req.body as Record<string, unknown>;

    if (!work_item_id || !summary) {
      return res.status(400).json({
        error: 'Missing required fields: work_item_id, summary'
      });
    }

    // ELLIE-594: Parse optional workflow for chaining
    const workflow = workflowRaw as WorkflowDefinition | undefined;

    // Find active forest tree
    const tree = await getWorkSessionByPlaneId(work_item_id);
    if (!tree) {
      return res.status(404).json({ error: 'No active session found for this work item' });
    }

    // Complete session in forest (merges branches, completes creatures, transitions to dormant)
    await forestCompleteSession(tree.id, summary);

    // ELLIE-531: Append completion summary to work trail (fire-and-forget, non-fatal)
    appendWorkTrailProgress(work_item_id, buildWorkTrailCompleteAppend(summary)).catch(e => logRiverWriteFailure("appendWorkTrailProgress/complete", e));

    // ELLIE-564: Verify dispatch — check reality vs agent report (fire-and-forget)
    verifyDispatch({
      workItemId: work_item_id,
      agent,
      outcome: "success",
      summary,
    }).catch(e => logRiverWriteFailure("verifyDispatch", e));

    // ELLIE-565: Log dispatch end to daily journal (fire-and-forget)
    journalDispatchEnd({
      workItemId: work_item_id,
      agent,
      outcome: "completed",
      summary,
    }).catch(e => logRiverWriteFailure("journalDispatchEnd/complete", e));

    // ELLIE-566: Update active tickets dashboard (fire-and-forget)
    dashboardOnComplete({
      workItemId: work_item_id,
      title: tree.title || work_item_id,
      agent,
      completedAt: new Date().toISOString(),
      summary,
    }).catch(e => logRiverWriteFailure("dashboardOnComplete", e));

    // ELLIE-567: Append work history to ticket context card (fire-and-forget)
    appendWorkHistory(work_item_id, tree.title || work_item_id, {
      agent,
      outcome: "completed",
      summary,
    }).catch(e => logRiverWriteFailure("appendWorkHistory/complete", e));

    // ELLIE-613: Persist growth metrics to Forest (fire-and-forget)
    persistMetricsToForest().catch(e => logger.warn("Growth metrics persist failed (non-fatal)", e));

    // ELLIE-614: Request critic review of completed work (fire-and-forget)
    try {
      requestCriticReview(tree.id, {
        workItemId: work_item_id as string,
        summary: summary as string,
        agent: (agent as string) || "dev",
      });
    } catch (e) {
      logger.warn("Critic review request failed (non-fatal)", e);
    }

    // Auto-deploy: if dashboard source is newer than build, rebuild and restart
    try {
      const { execSync } = await import('child_process');
      const { statSync } = await import('fs');
      const dashboardDir = '/home/ellie/ellie-home';
      const buildMtime = statSync(`${dashboardDir}/.output/server/index.mjs`).mtimeMs;
      // Check if any app/ source file is newer than the build
      const newerFiles = execSync(
        `find app/ \\( -name '*.vue' -o -name '*.ts' \\) | xargs stat -c '%Y %n' | awk '$1 > ${Math.floor(buildMtime / 1000)} {print $2}'`,
        { cwd: dashboardDir, encoding: 'utf-8', timeout: 5000 }
      ).trim();
      if (newerFiles) {
        logger.info(`Auto-deploy: stale build detected (${newerFiles.split('\n').length} files newer)`);
        execSync('bun run build', { cwd: dashboardDir, encoding: 'utf-8', timeout: 60000 });
        logger.info("Auto-deploy: build done, restarting dashboard...");
        execSync('sudo systemctl restart ellie-dashboard', { encoding: 'utf-8', timeout: 10000 });
        logger.info("Auto-deploy: dashboard restarted");
      } else {
        logger.info("Auto-deploy: build is current, skipping");
      }
    } catch (deployErr: unknown) {
      logger.warn("Auto-deploy failed (non-fatal)", { message: deployErr instanceof Error ? deployErr.message?.slice(0, 200) : String(deployErr) });
    }

    // Only update Plane if the most recent creature session had meaningful duration (>= 2 min)
    // Use the creature's created_at, not the tree's — tree may have been created hours ago
    const { default: forestSql } = await import('../../../ellie-forest/src/db');
    const [lastCreature] = await forestSql<{ created_at: Date }[]>`
      SELECT created_at FROM creatures WHERE tree_id = ${tree.id}
      ORDER BY created_at DESC LIMIT 1
    `;
    const sessionStart = lastCreature?.created_at || tree.created_at;
    const duration = Math.round(
      (new Date().getTime() - new Date(sessionStart).getTime()) / 1000 / 60
    );
    if (duration >= 2) {
      try {
        await updateWorkItemOnSessionComplete(work_item_id, summary, "completed");
      } catch (planeError) {
        logger.warn("Plane update failed (non-fatal)", planeError);
      }
    } else {
      logger.info(`Skipping Plane update — session too short (${duration}min)`);
    }

    const telegramMsg = [
      `✅ **Work Session Complete**`,
      ``,
      `**${escapeMarkdown(work_item_id)}:** ${escapeMarkdown(tree.title || work_item_id)}`,
      agent ? `**Agent:** ${escapeMarkdown(agent)}` : '',
      `**Duration:** ${duration} minutes`,
      ``,
      escapeMarkdown(summary)
    ].filter(Boolean).join('\n');

    const gchatMsg = [
      `✅ Work Session Complete`,
      ``,
      `${work_item_id}: ${tree.title || work_item_id}`,
      agent ? `Agent: ${agent}` : '',
      `Duration: ${duration} minutes`,
      ``,
      `Summary:`,
      summary,
    ].filter(Boolean).join('\n');

    await notify(getNotifyCtx(bot), {
      event: "session_complete",
      workItemId: work_item_id,
      telegramMessage: telegramMsg,
      gchatMessage: gchatMsg,
    });

    // ELLIE-594: Resolve workflow chain action if workflow is attached
    const chainAction = resolveChainAction(workflow, summary as string, work_item_id as string);
    if (chainAction) {
      const chainTelegram = formatChainForTelegram(chainAction);
      const chainGChat = formatChainForGChat(chainAction);
      await notify(getNotifyCtx(bot), {
        event: "session_update",
        workItemId: work_item_id as string,
        telegramMessage: escapeMarkdown(chainTelegram),
        gchatMessage: chainGChat,
      });
      logger.info("Workflow chain action resolved", {
        type: chainAction.type,
        workflowId: workflow?.workflow_id,
        workItemId: work_item_id,
      });
    }

    return res.json({
      success: true,
      session_id: tree.id,
      work_item_id,
      duration_minutes: duration,
      // ELLIE-594: Include chain action in response
      ...(chainAction ? {
        chain_action: {
          type: chainAction.type,
          message: chainAction.message,
          ...(chainAction.type === "auto" ? { dispatch_payload: chainAction.dispatchPayload } : {}),
          ...(chainAction.type !== "done" ? {
            next_step: chainAction.nextStep,
            step_number: chainAction.stepNumber,
            total_steps: chainAction.totalSteps,
          } : {}),
          ...(chainAction.type !== "done" ? { workflow: chainAction.workflow } : {}),
        },
      } : {}),
    });

  } catch (error) {
    logger.error("Complete handler failed", error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/work-session/pause
 *
 * Pauses an active work session (sets tree state to dormant).
 *
 * Body:
 * {
 *   "work_item_id": "ELLIE-1",
 *   "reason": "Waiting on design review" // optional
 * }
 */
export async function pauseWorkSession(req: ApiRequest, res: ApiResponse, bot: Bot) {
  try {
    const { work_item_id, reason, agent } = req.body;

    if (!work_item_id) {
      return res.status(400).json({
        error: 'Missing required field: work_item_id'
      });
    }

    // Find active forest tree
    const tree = await getWorkSessionByPlaneId(work_item_id);
    if (!tree) {
      return res.status(404).json({ error: 'No active session found for this work item' });
    }

    // Pause in forest (transitions to dormant, optionally logs reason)
    const paused = await forestPauseSession(tree.id, reason);

    // Notify via policy engine
    const telegramMsg = [
      `\u23F8\uFE0F **Work Session Paused**`,
      ``,
      `**${escapeMarkdown(work_item_id)}:** ${escapeMarkdown(tree.title || work_item_id)}`,
      agent ? `**Agent:** ${escapeMarkdown(agent)}` : '',
      reason ? `**Reason:** ${escapeMarkdown(reason)}` : '',
    ].filter(Boolean).join('\n');

    const gchatMsg = [
      `\u23F8\uFE0F Work Session Paused`,
      ``,
      `${work_item_id}: ${tree.title || work_item_id}`,
      agent ? `Agent: ${agent}` : '',
      reason ? `Reason: ${reason}` : '',
    ].filter(Boolean).join('\n');

    await notify(getNotifyCtx(bot), {
      event: "session_pause",
      workItemId: work_item_id,
      telegramMessage: telegramMsg,
      gchatMessage: gchatMsg,
    });

    // ELLIE-565: Log dispatch pause to daily journal (fire-and-forget)
    journalDispatchEnd({
      workItemId: work_item_id,
      agent,
      outcome: "paused",
      summary: reason,
    }).catch(e => logRiverWriteFailure("journalDispatchEnd/pause", e));

    // ELLIE-566: Update active tickets dashboard (fire-and-forget)
    dashboardOnPause(work_item_id).catch(e => logRiverWriteFailure("dashboardOnPause", e));

    // ELLIE-567: Append work history to ticket context card (fire-and-forget)
    appendWorkHistory(work_item_id, tree.title || work_item_id, {
      agent,
      outcome: "paused",
      summary: reason,
    }).catch(e => logRiverWriteFailure("appendWorkHistory/pause", e));

    // ELLIE-569/573: Write post-mortem with classified failure type (fire-and-forget)
    if (reason) {
      const { failureType, patternTags } = classifyPauseReason(reason);
      writePostMortem({
        workItemId: work_item_id,
        title: tree.title || work_item_id,
        agent,
        failureType,
        whatHappened: reason,
        patternTags,
      }).catch(e => logRiverWriteFailure("writePostMortem", e));
    }

    // ELLIE-572: Write handoff note when agent pauses with a reason (fire-and-forget)
    if (reason) {
      appendHandoffNote(work_item_id, tree.title || work_item_id, {
        whatWasAttempted: reason,
      }).catch(e => logRiverWriteFailure("appendHandoffNote", e));
    }

    // ELLIE-572: Move ticket to Blocked section on dashboard (fire-and-forget)
    if (reason) {
      dashboardOnBlocked({
        workItemId: work_item_id,
        title: tree.title || work_item_id,
        blocker: reason,
        since: new Date().toISOString(),
      }).catch(e => logRiverWriteFailure("dashboardOnBlocked", e));
    }

    return res.json({
      success: true,
      session_id: tree.id,
      work_item_id,
      state: 'dormant',
    });

  } catch (error) {
    logger.error("Pause handler failed", error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/work-session/resume
 *
 * Resumes a paused (dormant) work session back to growing.
 *
 * Body:
 * {
 *   "work_item_id": "ELLIE-1"
 * }
 */
export async function resumeWorkSession(req: ApiRequest, res: ApiResponse, bot: Bot) {
  try {
    const { work_item_id, agent } = req.body;

    if (!work_item_id) {
      return res.status(400).json({
        error: 'Missing required field: work_item_id'
      });
    }

    // Find dormant forest tree — getWorkSessionByPlaneId excludes archived/composted,
    // but dormant trees are still returned
    const tree = await getWorkSessionByPlaneId(work_item_id);
    if (!tree) {
      return res.status(404).json({ error: 'No active or paused session found for this work item' });
    }

    if (tree.state !== 'dormant') {
      return res.status(409).json({
        error: `Session is not paused (current state: ${tree.state})`
      });
    }

    // Resume in forest (transitions dormant -> growing)
    const resumed = await forestResumeSession(tree.id);

    // Notify via policy engine
    const telegramMsg = [
      `\u25B6\uFE0F **Work Session Resumed**`,
      ``,
      `**${escapeMarkdown(work_item_id)}:** ${escapeMarkdown(tree.title || work_item_id)}`,
      agent ? `**Agent:** ${escapeMarkdown(agent)}` : '',
    ].filter(Boolean).join('\n');

    const gchatMsg = [
      `\u25B6\uFE0F Work Session Resumed`,
      ``,
      `${work_item_id}: ${tree.title || work_item_id}`,
      agent ? `Agent: ${agent}` : '',
    ].filter(Boolean).join('\n');

    await notify(getNotifyCtx(bot), {
      event: "session_resume",
      workItemId: work_item_id,
      telegramMessage: telegramMsg,
      gchatMessage: gchatMsg,
    });

    return res.json({
      success: true,
      session_id: tree.id,
      work_item_id,
      state: 'growing',
    });

  } catch (error) {
    logger.error("Resume handler failed", error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
