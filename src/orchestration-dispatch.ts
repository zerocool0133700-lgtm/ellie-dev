/**
 * Orchestration Dispatch — ELLIE-352
 *
 * Formal dispatch entry point with tracking. Wraps the existing
 * playbook handleSend logic with run_id generation, tracker registration,
 * and ledger events.
 *
 * Returns the run_id immediately; the actual agent work runs async.
 */

import { log } from "./logger.ts";
import { emitEvent } from "./orchestration-ledger.ts";
import { startRun, endRun, getActiveRunForWorkItem, getActiveRunCount } from "./orchestration-tracker.ts";
import { fetchWorkItemDetails } from "./plane.ts";
import { dispatchAgent, syncResponse } from "./agent-router.ts";
import { processMemoryIntents } from "./memory.ts";
import { notify, type NotifyContext } from "./notification-policy.ts";
import { getAgentArchetype, getAgentRoleContext, getPsyContext, getPhaseContext, getHealthContext } from "./prompt-builder.ts";
import { getRiverContextForAgent } from "./context-sources.ts";
import type { PlaybookContext } from "./playbook.ts";
import { withRetry, classifyError } from "./dispatch-retry.ts";
import { getAdviceForDispatch, enrichPromptWithAdvice } from "./dispatch-advice-injector.ts";
import { checkReadiness, formatReadinessResult } from "./dispatch-readiness.ts";
import { enqueue, getQueueDepth } from "./dispatch-queue.ts";
import { withTrace, getTraceId, generateTraceId } from "./trace.ts";
import { enterDispatchMode, exitDispatchMode } from "./tool-approval.ts";
import { createJob, updateJob, appendJobEvent, verifyJobWork, estimateJobCost, writeJobTouchpointForAgent } from "./jobs-ledger.ts";
import { estimateTokens } from "./relay-utils.ts";
import { recordUsage, shouldBlock } from "./creature-cost-tracker.ts";
import { startCreature, failCreature, completeCreature, dispatchPushCreature, writeJobCompletionMetric } from "../../ellie-forest/src/index";
import { postCreatureEvent, postJobEvent } from "./channels/discord/observation.ts";
import { RELAY_BASE_URL } from "./relay-config.ts";
import { logToolUsage } from "./tool-usage-audit.ts";
import {
  spawnSession,
  markRunning as markSpawnRunning,
  markCompleted as markSpawnCompleted,
  markFailed as markSpawnFailed,
  buildAnnouncement,
  getSpawnRecord,
  captureDeliveryContext,
  killChildrenForParent,
  resolveArcForSpawn,
  buildCostRollup,
} from "./session-spawn.ts";
import type { SpawnOpts, SpawnAnnouncement } from "./types/session-spawn.ts";
import { broadcastToEllieChatClients } from "./relay-state.ts";

const logger = log.child("orchestration-dispatch");

export interface TrackedDispatchOpts {
  agentType: string;
  workItemId: string;
  channel: string;
  message?: string;
  playbookCtx: PlaybookContext;
  /** ELLIE-979: Run agent in a Docker sandbox container. */
  sandbox?: {
    enabled: boolean;
    image?: string;
    memoryLimit?: number;
    cpuQuota?: number;
    env?: string[];
    binds?: string[];
  };
  /** ELLIE-1268: Override readiness check config (e.g. strictMode for overnight). */
  readinessConfig?: Partial<import("./dispatch-readiness.ts").ReadinessConfig>;
  /** Internal: tracks how many times this dispatch has been re-queued. */
  _retryCount?: number;
}

export interface TrackedDispatchResult {
  runId: string;
  promise: Promise<void>;
}

/**
 * Execute a tracked dispatch. Returns runId immediately;
 * the actual agent work runs in the background.
 */
// Max concurrent dispatches — prevents OOM from too many Claude CLI processes
const MAX_CONCURRENT_DISPATCHES = 3;

export function executeTrackedDispatch(opts: TrackedDispatchOpts): TrackedDispatchResult {
  // ELLIE-376: Dispatch locking — prevent duplicate dispatches to same ticket
  // ELLIE-396: Queue instead of rejecting when agent is busy
  const existingRun = getActiveRunForWorkItem(opts.workItemId);
  if (existingRun) {
    const queueId = crypto.randomUUID();
    const notifyCtx: NotifyContext = {
      bot: opts.playbookCtx.bot,
      telegramUserId: opts.playbookCtx.telegramUserId,
      gchatSpaceName: opts.playbookCtx.gchatSpaceName,
    };

    const retryCount = opts._retryCount ?? 0;
    const { position } = enqueue({
      id: queueId,
      agentType: opts.agentType,
      workItemId: opts.workItemId,
      channel: opts.channel,
      message: opts.message,
      enqueuedAt: Date.now(),
      retryCount,
      notifyCtx,
      execute: () => {
        // Re-dispatch when the current run completes (increment retry count)
        executeTrackedDispatch({ ...opts, _retryCount: retryCount + 1 });
      },
    });

    logger.info("Dispatch queued — active run exists", {
      workItemId: opts.workItemId,
      existingRunId: existingRun.runId.slice(0, 8),
      requestedAgent: opts.agentType,
      queuePosition: position,
      retryCount,
    });

    notify(notifyCtx, {
      event: "dispatch_confirm",
      workItemId: opts.workItemId,
      telegramMessage: `${opts.workItemId} queued for ${opts.agentType} (position ${position}) — waiting for current ${existingRun.agentType} run to finish`,
    }).catch(() => {});

    return { runId: queueId, promise: Promise.resolve() };
  }

  // Concurrency cap — queue if too many agents running (prevents OOM)
  const activeCount = getActiveRunCount();
  if (activeCount >= MAX_CONCURRENT_DISPATCHES) {
    const queueId = crypto.randomUUID();
    const notifyCtx: NotifyContext = {
      bot: opts.playbookCtx.bot,
      telegramUserId: opts.playbookCtx.telegramUserId,
      gchatSpaceName: opts.playbookCtx.gchatSpaceName,
    };

    const retryCount2 = opts._retryCount ?? 0;
    const { position } = enqueue({
      id: queueId,
      agentType: opts.agentType,
      workItemId: opts.workItemId,
      channel: opts.channel,
      message: opts.message,
      enqueuedAt: Date.now(),
      retryCount: retryCount2,
      notifyCtx,
      execute: () => {
        executeTrackedDispatch({ ...opts, _retryCount: retryCount2 + 1 });
      },
    });

    logger.info("Dispatch queued — concurrency limit reached", {
      workItemId: opts.workItemId,
      activeCount,
      maxConcurrent: MAX_CONCURRENT_DISPATCHES,
      queuePosition: position,
      retryCount: retryCount2,
    });

    notify(notifyCtx, {
      event: "dispatch_confirm",
      workItemId: opts.workItemId,
      telegramMessage: `${opts.workItemId} queued for ${opts.agentType} (position ${position}) — ${activeCount}/${MAX_CONCURRENT_DISPATCHES} dispatches running`,
    }).catch(() => {});

    return { runId: queueId, promise: Promise.resolve() };
  }

  const runId = crypto.randomUUID();
  const traceId = getTraceId() || generateTraceId();

  // Register in tracker immediately
  startRun(runId, opts.agentType, opts.workItemId, undefined, {
    channel: opts.channel,
    message: opts.message,
  });

  // Emit dispatched event (include traceId for end-to-end correlation)
  emitEvent(runId, "dispatched", opts.agentType, opts.workItemId, {
    source: "formal_dispatch",
    channel: opts.channel,
    trace_id: traceId,
  });

  // Run the actual dispatch async within trace context
  const promise = withTrace(
    () => runDispatch(runId, opts).catch((err) => {
      logger.error("Tracked dispatch failed", { runId: runId.slice(0, 8), error: err.message });
    }),
    traceId,
  );

  return { runId, promise };
}

async function runDispatch(runId: string, opts: TrackedDispatchOpts): Promise<void> {
  const { agentType, workItemId, channel, playbookCtx } = opts;
  const ctx = playbookCtx;

  // Cost control check — log warning but don't block (can make blocking later)
  const costCheck = shouldBlock(agentType);
  if (costCheck.blocked) {
    logger.warn("Dispatch cost warning — budget exceeded", { agent: agentType, reason: costCheck.reason, workItemId });
  }

  const notifyCtx: NotifyContext = {
    bot: ctx.bot,
    telegramUserId: ctx.telegramUserId,
    gchatSpaceName: ctx.gchatSpaceName,
  };

  // ELLIE-440: Create job record here (inside async fn) so jobId is always available
  const jobId = await createJob({
    type: "dispatch",
    source: channel,
    work_item_id: workItemId,
    agent_type: agentType,
    run_id: runId,
  }).catch((err) => { logger.error("Job creation failed", { channel, agentType, workItemId }, err); return null; });

  // Transition to running immediately — don't wait for context gathering / Plane lookups
  if (jobId) {
    await updateJob(jobId, { status: "running", current_step: "gathering_context", last_heartbeat: new Date() });
    appendJobEvent(jobId, "running", { agent_type: agentType });
    // ELLIE-442: Post job creation to #job-tracker
    postJobEvent("created", { agentType, workItemId });
  }

  // ELLIE-446: Periodic heartbeat so orphan cleanup doesn't claim long-running dispatches
  const heartbeatInterval = jobId
    ? setInterval(() => updateJob(jobId, { last_heartbeat: new Date() }), 60_000)
    : null;

  // ELLIE-447: Hoisted so catch block can call failCreature on any failure path
  let sessionIds: { tree_id: string; branch_id: string; creature_id: string; entity_id: string } | undefined;
  // ELLIE-949: Hoisted so cascade kill in catch block can use the agent session ID
  let dispatchSessionId: string | undefined;

  try {
    // 1. Fetch ticket details (with retry for transient Plane API failures)
    const retryOpts = { runId, agentType, workItemId };
    const detailsResult = await withRetry(
      () => fetchWorkItemDetails(workItemId),
      retryOpts,
    );
    const details = detailsResult.success ? detailsResult.result : null;
    if (!details) {
      const retryNote = detailsResult.attempts > 1 ? ` (after ${detailsResult.attempts} attempts)` : "";
      emitEvent(runId, "failed", agentType, workItemId, { error: `Ticket not found in Plane${retryNote}` });
      endRun(runId, "failed");
      if (jobId) {
        await updateJob(jobId, { status: "failed", error_count: 1, current_step: null });
        await appendJobEvent(jobId, "failed", { error: `Ticket not found in Plane${retryNote}` });
      }
      await notify(notifyCtx, {
        event: "error",
        workItemId,
        telegramMessage: `Could not find ${workItemId} in Plane${retryNote}`,
      });
      return;
    }

    emitEvent(runId, "progress", agentType, workItemId, { step: "ticket_fetched", ticket_title: details.name });

    // 1b. Pre-dispatch readiness validation (ELLIE-1268)
    const readiness = checkReadiness(details, opts.readinessConfig);
    if (readiness.warnings.length > 0) {
      const summary = formatReadinessResult(readiness, workItemId);
      logger.warn("Dispatch readiness warnings", { workItemId, warnings: readiness.warnings });
      emitEvent(runId, "progress", agentType, workItemId, { step: "readiness_warnings", warnings: readiness.warnings });
    }
    if (!readiness.ready) {
      const summary = formatReadinessResult(readiness, workItemId);
      logger.warn("Dispatch blocked by readiness check", { workItemId, blockers: readiness.blockers });
      emitEvent(runId, "failed", agentType, workItemId, { error: "Readiness check failed", blockers: readiness.blockers });
      endRun(runId, "failed");
      if (jobId) {
        await updateJob(jobId, { status: "failed", error_count: 1, current_step: null });
        await appendJobEvent(jobId, "failed", { error: summary });
      }
      await notify(notifyCtx, {
        event: "error",
        workItemId,
        telegramMessage: summary,
      });
      return;
    }

    // 2. Notify dispatch
    await notify(notifyCtx, {
      event: "dispatch_confirm",
      workItemId,
      telegramMessage: `Dispatching ${agentType} to ${workItemId}: ${details.name}`,
      gchatMessage: `Dispatching ${agentType} to ${workItemId}: ${details.name}`,
    });

    // 3. Start work session
    let sessionResult: Record<string, unknown> | undefined;
    try {
      const resp = await fetch(`${RELAY_BASE_URL}/api/work-session/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ work_item_id: workItemId, title: details.name, project: "ELLIE", entity_name: `${agentType}_agent` }),
      });
      sessionResult = await resp.json();
    } catch (err: unknown) {
      logger.warn("Work session start failed (non-fatal)", err);
    }

    sessionIds = sessionResult?.success ? {
      tree_id: sessionResult.tree_id as string,
      branch_id: (sessionResult.creatures as any)?.[0]?.branch_id,
      creature_id: (sessionResult.creatures as any)?.[0]?.id,
      entity_id: (sessionResult.creatures as any)?.[0]?.entity_id,
    } : undefined;

    // 4. Dispatch agent (with retry for transient Supabase/edge-function failures)
    const dispatchResult = await withRetry(
      async () => {
        const d = await dispatchAgent(ctx.supabase, agentType, ctx.telegramUserId, channel, `Work on ${workItemId}: ${details.name}`, workItemId);
        if (!d) throw new Error("Agent dispatch returned null");
        return d;
      },
      retryOpts,
    );
    if (!dispatchResult.success || !dispatchResult.result) {
      const retryNote = dispatchResult.attempts > 1 ? ` (after ${dispatchResult.attempts} attempts)` : "";
      // ELLIE-447: Mark creature failed — agent never started
      if (sessionIds?.creature_id) {
        failCreature(sessionIds.creature_id, `Agent dispatch failed${retryNote}`).catch(err =>
          logger.warn("failCreature failed (non-fatal)", { err: err.message })
        );
      }
      emitEvent(runId, "failed", agentType, workItemId, { error: `Agent dispatch failed${retryNote}` });
      endRun(runId, "failed");
      if (jobId) {
        await updateJob(jobId, { status: "failed", error_count: 1, current_step: null });
        await appendJobEvent(jobId, "failed", { error: `Agent dispatch failed${retryNote}` });
      }
      await notify(notifyCtx, {
        event: "error",
        workItemId,
        telegramMessage: `Failed to dispatch ${agentType} agent for ${workItemId}${retryNote}`,
      });
      return;
    }
    const dispatch = dispatchResult.result;
    dispatchSessionId = dispatch.session_id;

    // 5. Build prompt with personality context
    let workItemContext = `\nACTIVE WORK ITEM: ${workItemId}\n` +
      `Title: ${details.name}\nPriority: ${details.priority}\nDescription: ${details.description}\n`;

    // ELLIE-571: Check for post-mortem advice before dispatch (fire-and-forget safe)
    // Use allSettled so a single failing context source doesn't block dispatch
    const contextResults = await Promise.allSettled([
      getAgentArchetype(agentType),
      getAgentRoleContext(agentType),
      getPsyContext(),
      getPhaseContext(),
      getHealthContext(),
      getRiverContextForAgent(agentType, details.description),  // ELLIE-150
      getAdviceForDispatch(workItemId),  // ELLIE-571
    ]);
    const [archetype, roleContext, psy, phase, health, riverContext, dispatchAdvice] =
      contextResults.map(r => r.status === "fulfilled" ? r.value : null) as [any, any, any, any, any, any, any];

    // ELLIE-571: Inject post-mortem advice into prompt context if found
    if (dispatchAdvice) {
      workItemContext = enrichPromptWithAdvice(workItemContext, dispatchAdvice);
    }

    const prompt = ctx.buildPromptFn(
      `Work on ${workItemId}: ${details.name}\n\n${details.description}`,
      undefined, undefined, undefined,
      channel, dispatch.agent, workItemContext,
      undefined, undefined, undefined, riverContext || undefined, undefined,
      sessionIds,
      archetype, roleContext, psy, phase, health,
    );

    // 6. Call Claude with runId for heartbeat tracking (with retry for transient failures)
    // ELLIE-447: Transition creature dispatched → working before the agent begins execution
    if (sessionIds?.creature_id) {
      startCreature(sessionIds.creature_id).catch(err =>
        logger.warn("startCreature failed (non-fatal)", { creature_id: sessionIds.creature_id, err: err.message })
      );
      // ELLIE-442: Post dispatched event to #creature-log
      postCreatureEvent("dispatched", { agentType, workItemId });
    }
    // ELLIE-455: J scope touchpoint — job started
    if (jobId) {
      writeJobTouchpointForAgent(jobId, agentType, sessionIds?.creature_id, "started",
        `${agentType} started work on ${workItemId}: ${details.name}`,
        { workItemId },
      ).catch(err => logger.warn("[touchpoint] started failed", { err: err.message }));
    }
    // Enter dispatch mode — auto-approves dev tools + extends TTL/timeouts
    enterDispatchMode();
    emitEvent(runId, "progress", agentType, workItemId, { step: "calling_claude" });
    // ELLIE-440: Update job with model + forest session IDs (already running)
    if (jobId) {
      // Bug 4: increment completed_steps when context gathering + dispatch finishes
      updateJob(jobId, {
        current_step: "calling_claude",
        model: dispatch.agent.model,
        tree_id: sessionIds?.tree_id as string | undefined,
        creature_id: sessionIds?.creature_id as string | undefined,
        last_heartbeat: new Date(),
        increment_completed_steps: 1,
      });
      appendJobEvent(jobId, "calling_claude", { agent_type: agentType, model: dispatch.agent.model });
    }
    const startTime = Date.now();
    let claudeResult;
    try {
      claudeResult = await withRetry(
        () => ctx.callClaudeFn(prompt, {
          resume: false,
          model: dispatch.agent.model,
          allowedTools: dispatch.agent.tools_enabled,
          timeoutMs: 900_000, // 15 min — dispatched agents need time for multi-step work
        }),
        retryOpts,
      );
    } finally {
      exitDispatchMode();
    }
    if (!claudeResult.success || !claudeResult.result) {
      const retryNote = claudeResult.attempts > 1 ? ` (after ${claudeResult.attempts} attempts)` : "";
      // ELLIE-447: Mark creature failed — Claude exited with error
      if (sessionIds?.creature_id) {
        failCreature(sessionIds.creature_id, `Claude call failed${retryNote}`).catch(err =>
          logger.warn("failCreature failed (non-fatal)", { err: err.message })
        );
      }
      emitEvent(runId, "failed", agentType, workItemId, {
        error: `Claude call failed${retryNote}`,
        claude_error: claudeResult.error?.message?.slice(0, 500),
      });
      endRun(runId, "failed");
      if (jobId) {
        await updateJob(jobId, { status: "failed", error_count: 1, current_step: null });
        await appendJobEvent(jobId, "failed", { error: `Claude call failed${retryNote}`, claude_error: claudeResult.error?.message?.slice(0, 500) });
        // ELLIE-455: J scope touchpoint — Claude call blocker
        writeJobTouchpointForAgent(jobId, agentType, sessionIds?.creature_id, "blocker",
          `${agentType} hit blocker on ${workItemId}: Claude call failed${retryNote}`,
          { workItemId },
        ).catch(() => {});
      }
      await notify(notifyCtx, {
        event: "error",
        workItemId,
        telegramMessage: `${agentType} Claude call failed for ${workItemId}${retryNote}: ${claudeResult.error?.message?.slice(0, 100) || "unknown"}`,
      });
      // ELLIE-970: Log dispatch failure for audit
      logToolUsage(ctx.supabase, {
        agent_name: agentType,
        agent_type: agentType,
        tool_name: "claude_dispatch",
        tool_category: "agent_execution",
        operation: "dispatch",
        session_id: dispatch.session_id,
        user_id: ctx.userId,
        channel: ctx.channel,
        success: false,
        error_message: claudeResult.error?.message?.slice(0, 500),
        duration_ms: Date.now() - startTime,
        metadata: { work_item_id: workItemId, run_id: runId, model: dispatch.agent.model },
      }).catch(() => {}); // Fire-and-forget
      return;
    }
    const rawResponse = claudeResult.result;
    const durationMs = Date.now() - startTime;
    const durationMin = Math.round(durationMs / 1000 / 60);
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    // ELLIE-970: Log successful dispatch for audit
    logToolUsage(ctx.supabase, {
      agent_name: agentType,
      agent_type: agentType,
      tool_name: "claude_dispatch",
      tool_category: "agent_execution",
      operation: "dispatch",
      session_id: dispatch.session_id,
      user_id: ctx.userId,
      channel: ctx.channel,
      success: true,
      duration_ms: durationMs,
      result_summary: `${rawResponse.length} chars response`,
      metadata: { work_item_id: workItemId, run_id: runId, model: dispatch.agent.model, attempts: claudeResult.attempts },
    }).catch(() => {}); // Fire-and-forget

    // 7. Process memory intents
    await processMemoryIntents(ctx.supabase, rawResponse, agentType, "shared", sessionIds);

    // 8. Close agent session
    if (dispatch.session_id) {
      await syncResponse(ctx.supabase, dispatch.session_id, rawResponse, {
        duration_ms: durationMs,
        status: "completed",
        agent_name: agentType,
      });
    }

    // 9. Complete
    emitEvent(runId, "completed", agentType, workItemId, {
      duration_ms: durationMs,
      response_length: rawResponse.length,
      trace_id: getTraceId(),
    });
    endRun(runId, "completed");
    // ELLIE-949: Cascade kill any active sub-agent spawns when parent completes.
    // Try both session_id and workItemId — spawns may be indexed by either depending on caller.
    if (dispatchSessionId) killChildrenForParent(dispatchSessionId, "Parent dispatch completed");
    killChildrenForParent(workItemId, "Parent dispatch completed");
    // ELLIE-447: Complete creature with meaningful result data (response preview + timing)
    if (sessionIds?.creature_id) {
      const responsePreview = rawResponse.replace(/\[MEMORY:[^\]]*\]/gi, "").trim().slice(0, 1000);
      completeCreature(sessionIds.creature_id, {
        response_preview: responsePreview,
        duration_ms: durationMs,
        work_item_id: workItemId,
      }).catch(err =>
        logger.warn("completeCreature failed (non-fatal)", { creature_id: sessionIds.creature_id, err: err.message })
      );
      // ELLIE-442: Post completed event to #creature-log
      postCreatureEvent("completed", { agentType, workItemId, durationMs, responsePreview });
    }
    // ELLIE-445: Verify dev agents produced file changes before marking completed
    if (jobId) {
      const { verified, note } = await verifyJobWork(agentType, startTime);
      const finalStatus = verified ? "completed" : "responded";
      // ELLIE-446: Populate token + cost accounting
      const tokensIn = estimateTokens(prompt, dispatch.agent.model ?? undefined);
      const tokensOut = estimateTokens(rawResponse, dispatch.agent.model ?? undefined);
      const costUsd = estimateJobCost(dispatch.agent.model, tokensIn, tokensOut);
      // Record usage in per-creature cost tracker
      const costResult = recordUsage({
        creature: agentType,
        model: dispatch.agent.model || "sonnet",
        inputTokens: tokensIn,
        outputTokens: tokensOut,
      });
      if (costResult.alerts.length > 0) {
        logger.warn("Cost alerts after dispatch", { creature: agentType, alerts: costResult.alerts, sessionTotal: costResult.sessionTotal, dailyTotal: costResult.dailyTotal });
      }
      await updateJob(jobId, {
        status: finalStatus, total_duration_ms: durationMs, current_step: null,
        tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: costUsd,
        increment_completed_steps: 1, // Bug 4: Claude call done
        result: { response_length: rawResponse.length },
      });
      // Bug 3: duration_ms belongs in opts (4th param), not details
      await appendJobEvent(jobId, finalStatus, { verified, verification_note: note }, { duration_ms: durationMs });
      if (!verified) logger.warn("Job marked 'responded' — work unverified", { jobId: jobId.slice(0, 8), note });
      // ELLIE-442: Post job completion to #job-tracker
      postJobEvent(finalStatus as "completed" | "responded", { agentType, workItemId, durationMs, costUsd });
      // ELLIE-454: Write performance metric to Forest C/1 scope
      writeJobCompletionMetric({
        agentType, workItemId, durationMs, costUsd,
        tokensIn, tokensOut,
        status: finalStatus as "completed" | "responded",
        sourceTreeId: sessionIds?.tree_id,
        sourceEntityId: sessionIds?.entity_id,
      });
      // ELLIE-455: J scope touchpoint — job completed/responded
      writeJobTouchpointForAgent(jobId, agentType, sessionIds?.creature_id,
        finalStatus === "completed" ? "completed" : "responded",
        `${agentType} ${finalStatus} ${workItemId} in ${durationMin}min`,
        { workItemId, duration_ms: durationMs, cost_usd: costUsd, tokens: tokensIn + tokensOut },
      ).catch(err => logger.warn("[touchpoint] completed failed", { err: err.message }));
    }

    // ELLIE-449: Spawn a push creature to record notification delivery.
    // Creates a child of the pull creature so the chain is traceable in the Forest.
    let pushCreatureId: string | undefined;
    if (sessionIds?.creature_id && sessionIds?.tree_id && sessionIds?.entity_id) {
      dispatchPushCreature({
        parent_creature_id: sessionIds.creature_id,
        tree_id: sessionIds.tree_id,
        entity_id: sessionIds.entity_id,
        intent: `deliver result for ${workItemId}`,
        instructions: {
          notification_type: "job_completion",
          work_item_id: workItemId,
          duration_ms: durationMs,
          agent_type: agentType,
        },
      }).then(pushCreature => {
        pushCreatureId = pushCreature.id;
        startCreature(pushCreature.id).catch(() => {});
      }).catch(err => logger.warn("[push-creature] dispatch failed (non-fatal)", { err: err.message }));
    }

    // 10. Notify
    const preview = rawResponse.replace(/\[MEMORY:[^\]]*\]/gi, "").trim().slice(0, 300);
    await notify(notifyCtx, {
      event: "session_complete",
      workItemId,
      telegramMessage: `${agentType} finished ${workItemId} (${durationMin}min):\n${preview}`,
      gchatMessage: `${agentType} agent completed ${workItemId} (${durationMin}min):\n${rawResponse.slice(0, 800)}`,
    });

    // Mark push creature delivered
    if (pushCreatureId) {
      completeCreature(pushCreatureId, { delivered_to: ["telegram"] }).catch(() => {});
    }

  } catch (err: unknown) {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    const errMsg = err instanceof Error ? err.message : String(err);
    // ELLIE-447: Mark creature failed on any unexpected error
    if (sessionIds?.creature_id) {
      failCreature(sessionIds.creature_id, errMsg.slice(0, 500)).catch(() => {});
      // ELLIE-442: Post failure to #creature-log
      postCreatureEvent("failed", { agentType, workItemId, error: errMsg.slice(0, 300) });
    }
    const { errorClass, reason } = classifyError(err);
    emitEvent(runId, "failed", agentType, workItemId, {
      error: errMsg.slice(0, 500),
      error_class: errorClass,
      error_reason: reason,
      trace_id: getTraceId(),
    });
    endRun(runId, "failed");
    // ELLIE-949: Cascade kill any active sub-agent spawns when parent fails.
    // Try both session_id and workItemId — spawns may be indexed by either.
    const failReason = `Parent dispatch failed: ${errMsg.slice(0, 200)}`;
    if (dispatchSessionId) killChildrenForParent(dispatchSessionId, failReason);
    killChildrenForParent(workItemId, failReason);
    // ELLIE-440: Update job to failed
    if (jobId) {
      await updateJob(jobId, { status: "failed", error_count: 1, current_step: null });
      await appendJobEvent(jobId, "failed", { error: errMsg.slice(0, 500), error_class: errorClass });
      // ELLIE-442: Post job failure to #job-tracker
      postJobEvent("failed", { agentType, workItemId, error: errMsg.slice(0, 300) });
      // ELLIE-455: J scope touchpoint — unexpected failure
      writeJobTouchpointForAgent(jobId, agentType, sessionIds?.creature_id, "failed",
        `${agentType} failed on ${workItemId}: ${errMsg.slice(0, 200)}`,
        { workItemId },
      ).catch(() => {});
    }

    await notify(notifyCtx, {
      event: "error",
      workItemId,
      telegramMessage: `${agentType} dispatch failed for ${workItemId}: ${errMsg.slice(0, 100)}`,
    }).catch(() => {});
  }
}

// ── ELLIE-942: Spawned sub-agent dispatch ──────────────────────────

export interface SpawnedDispatchOpts {
  parentSessionId: string;
  parentAgentName: string;
  targetAgentName: string;
  task: string;
  channel: string;
  userId: string;
  workItemId?: string;
  arcMode?: "inherit" | "fork";
  parentArcId?: string;
  threadBind?: boolean;
  deliveryContext?: {
    channel: string;
    chatId?: number | string;
    threadId?: string;
    webhookId?: string;
    webhookToken?: string;
    guildId?: string;
  };
  playbookCtx: PlaybookContext;
}

/**
 * Spawn a sub-agent session from a parent dispatch.
 *
 * 1. Creates a SpawnRecord in the registry
 * 2. Dispatches the child agent via the normal agent-router
 * 3. Marks spawn running
 * 4. On completion, marks spawn completed + builds announcement
 * 5. Notifies the parent's channel via the delivery context
 *
 * Returns the spawnId immediately; child work runs async.
 *
 * Called via POST /api/spawn (ELLIE-946) or programmatically.
 */
export function executeSpawnedDispatch(opts: SpawnedDispatchOpts): { spawnId: string; success: boolean; error?: string; promise: Promise<void> } {
  const spawnResult = spawnSession({
    parentSessionId: opts.parentSessionId,
    parentAgentName: opts.parentAgentName,
    targetAgentName: opts.targetAgentName,
    task: opts.task,
    channel: opts.channel,
    userId: opts.userId,
    workItemId: opts.workItemId,
    arcMode: opts.arcMode,
    parentArcId: opts.parentArcId,
    threadBind: opts.threadBind,
    deliveryContext: opts.deliveryContext,
  });

  if (!spawnResult.success) {
    return { spawnId: "", success: false, error: spawnResult.error, promise: Promise.resolve() };
  }

  // ELLIE-950: outer .catch must mark spawn failed — otherwise uncaught errors leave it stuck in pending/running
  const promise = runSpawnedDispatch(spawnResult.spawnId, opts).catch((err) => {
    const errMsg = err instanceof Error ? err.message : String(err);
    markSpawnFailed(spawnResult.spawnId, `Unhandled spawn error: ${errMsg.slice(0, 500)}`);
    logger.error("Spawned dispatch failed", { spawnId: spawnResult.spawnId, error: errMsg.slice(0, 300) });
  });

  return { spawnId: spawnResult.spawnId, success: true, promise };
}

async function runSpawnedDispatch(spawnId: string, opts: SpawnedDispatchOpts): Promise<void> {
  const { targetAgentName, task, channel, playbookCtx: ctx, workItemId } = opts;
  const notifyCtx: NotifyContext = {
    bot: ctx.bot,
    telegramUserId: ctx.telegramUserId,
    gchatSpaceName: ctx.gchatSpaceName,
  };

  try {
    // 1. Dispatch child agent session
    const dispatch = await dispatchAgent(
      ctx.supabase,
      targetAgentName,
      ctx.telegramUserId,
      channel,
      task,
      workItemId,
    );

    if (!dispatch) {
      markSpawnFailed(spawnId, "Agent dispatch returned null");
      return;
    }

    // 2. Mark spawn running with real session ID
    markSpawnRunning(spawnId, dispatch.session_id);

    // ELLIE-955: Notify ellie-chat that a sub-agent has started
    if (opts.deliveryContext?.channel === "ellie-chat") {
      broadcastToEllieChatClients({
        type: "spawn_status",
        spawnId,
        agent: targetAgentName,
        status: "running",
        task: task.slice(0, 200),
        ts: Date.now(),
      });
    }

    // 2b. ELLIE-942: Resolve memory arc for this spawn (inherit or fork)
    const arcId = await resolveArcForSpawn(spawnId, async (arcOpts) => {
      const { createArc } = await import("../../ellie-forest/src/arcs.ts");
      return createArc(arcOpts as any);
    });
    if (arcId) {
      logger.info("Spawn arc resolved", { spawnId, arcId, mode: opts.arcMode || "inherit" });
    }

    // 3. Build prompt and call Claude
    // ELLIE-953: Use named positions instead of positional undefineds
    const subAgentContext = workItemId
      ? `\nSUB-AGENT TASK for ${workItemId}:\n${task}\n\nYou are a spawned sub-agent. Complete this task and report results clearly.`
      : `\nSUB-AGENT TASK:\n${task}\n\nYou are a spawned sub-agent. Complete this task and report results clearly.`;
    const prompt = ctx.buildPromptFn(
      task,
      /* contextDocket */ undefined,
      /* relevantContext */ undefined,
      /* elasticContext */ undefined,
      /* channel */ channel,
      /* agentConfig */ dispatch.agent,
      /* workItemContext */ subAgentContext,
    );

    enterDispatchMode();
    let claudeResult;
    const startTime = Date.now();
    try {
      claudeResult = await ctx.callClaudeFn(prompt, {
        resume: false,
        model: dispatch.agent.model,
        allowedTools: dispatch.agent.tools_enabled,
        timeoutMs: 600_000, // 10 min for sub-agents
      });
    } finally {
      exitDispatchMode();
    }

    const durationMs = Date.now() - startTime;

    if (!claudeResult || typeof claudeResult !== "string") {
      markSpawnFailed(spawnId, "Claude call returned empty");
      // ELLIE-970: Log spawn failure for audit
      logToolUsage(ctx.supabase, {
        agent_name: targetAgentName,
        agent_type: targetAgentName,
        tool_name: "claude_spawn",
        tool_category: "agent_execution",
        operation: "spawn",
        session_id: dispatch.session_id,
        user_id: ctx.userId,
        channel: ctx.channel,
        success: false,
        error_message: "Claude call returned empty",
        duration_ms: durationMs,
        metadata: { spawn_id: spawnId, parent_session_id: opts.parentSessionId, model: dispatch.agent.model },
      }).catch(() => {});
      return;
    }

    // ELLIE-970: Log successful spawn for audit
    logToolUsage(ctx.supabase, {
      agent_name: targetAgentName,
      agent_type: targetAgentName,
      tool_name: "claude_spawn",
      tool_category: "agent_execution",
      operation: "spawn",
      session_id: dispatch.session_id,
      user_id: ctx.userId,
      channel: ctx.channel,
      success: true,
      duration_ms: durationMs,
      result_summary: `${claudeResult.length} chars response`,
      metadata: { spawn_id: spawnId, parent_session_id: opts.parentSessionId, model: dispatch.agent.model },
    }).catch(() => {});

    // 4. Sync response to agent session
    if (dispatch.session_id) {
      await syncResponse(ctx.supabase, dispatch.session_id, claudeResult, {
        duration_ms: durationMs,
        status: "completed",
        agent_name: targetAgentName,
      });
    }

    // 5. Record cost for this spawn
    try {
      const { recordCost } = await import("./formation-costs.ts");
      const { calculateCostCents } = await import("./types/formation-costs.ts");
      const { estimateTokens } = await import("./relay-utils.ts");
      const model = dispatch.agent.model || "claude-sonnet-4-6";
      const inputTokens = estimateTokens(prompt, model);
      const outputTokens = estimateTokens(claudeResult, model);
      const costCents = calculateCostCents(inputTokens, outputTokens, model);
      if (dispatch.session_id) {
        await recordCost({
          formation_session_id: dispatch.session_id,
          agent_id: dispatch.session_id, // Use session as agent proxy
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cost_cents: costCents,
          model,
          metadata: { spawn_id: spawnId, parent_session_id: opts.parentSessionId },
        });
      }
    } catch (err) {
      logger.warn("Spawn cost recording failed (non-fatal)", { spawnId, err: (err as Error).message });
    }

    // 6. Mark spawn completed
    const resultPreview = claudeResult.replace(/\[MEMORY:[^\]]*\]/gi, "").trim().slice(0, 500);
    markSpawnCompleted(spawnId, resultPreview);

    // 6b. Cost rollup — attribute child costs back to parent
    let spawnCostCents = 0;
    try {
      const { fetchChildCosts } = await import("./formation-costs.ts");
      const rollup = await buildCostRollup(opts.parentSessionId, fetchChildCosts);
      spawnCostCents = rollup.totalCostCents;
      if (spawnCostCents > 0) {
        logger.info("Spawn cost rollup", { spawnId, parentSessionId: opts.parentSessionId, totalCostCents: spawnCostCents });
      }
    } catch (err) {
      logger.warn("Spawn cost rollup failed (non-fatal)", { spawnId, err: (err as Error).message });
    }

    // 6. Build and deliver announcement to parent's channel
    const announcement = buildAnnouncement(spawnId, spawnCostCents);
    if (announcement) {
      const durationMin = Math.round(announcement.durationMs / 1000 / 60);
      await notify(notifyCtx, {
        event: "session_complete",
        workItemId: workItemId || "",
        telegramMessage: `Sub-agent ${targetAgentName} finished (${durationMin}min):\n${resultPreview.slice(0, 300)}`,
      });

      // ELLIE-955: Deliver to ellie-chat via WebSocket if thread-bound
      deliverSpawnAnnouncementToChat(announcement, opts.deliveryContext?.channel);
    }

    logger.info("Spawned dispatch completed", {
      spawnId,
      target: targetAgentName,
      durationMs,
    });

  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    markSpawnFailed(spawnId, errMsg.slice(0, 500));
    logger.error("Spawned dispatch error", { spawnId, target: targetAgentName, error: errMsg.slice(0, 300) });

    // ELLIE-955: Deliver failure announcement to ellie-chat
    const failAnnouncement = buildAnnouncement(spawnId);
    if (failAnnouncement) {
      deliverSpawnAnnouncementToChat(failAnnouncement, opts.deliveryContext?.channel);
    }
  }
}

// ── ELLIE-955: Ellie Chat spawn announcement delivery ───────

/**
 * Push a spawn announcement to all connected ellie-chat WebSocket clients.
 * Only fires when the spawn's delivery context channel is "ellie-chat".
 */
function deliverSpawnAnnouncementToChat(
  announcement: SpawnAnnouncement,
  deliveryChannel?: string,
): void {
  if (deliveryChannel !== "ellie-chat") return;

  const durationSec = Math.round(announcement.durationMs / 1000);
  const status = announcement.state === "completed" ? "completed"
    : announcement.state === "failed" ? "failed"
    : announcement.state === "timed_out" ? "timed out"
    : announcement.state;

  broadcastToEllieChatClients({
    type: "spawn_announcement",
    spawnId: announcement.spawnId,
    agent: announcement.targetAgentName,
    status,
    resultPreview: announcement.resultText?.slice(0, 300) ?? null,
    error: announcement.error ?? null,
    costCents: announcement.costCents,
    durationSec,
    ts: Date.now(),
  });
}
