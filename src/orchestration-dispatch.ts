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
import { startRun, endRun } from "./orchestration-tracker.ts";
import { fetchWorkItemDetails } from "./plane.ts";
import { dispatchAgent, syncResponse } from "./agent-router.ts";
import { processMemoryIntents } from "./memory.ts";
import { notify, type NotifyContext } from "./notification-policy.ts";
import { getAgentArchetype, getPsyContext, getPhaseContext, getHealthContext } from "./prompt-builder.ts";
import type { PlaybookContext } from "./playbook.ts";

const logger = log.child("orchestration-dispatch");

export interface TrackedDispatchOpts {
  agentType: string;
  workItemId: string;
  channel: string;
  message?: string;
  playbookCtx: PlaybookContext;
}

export interface TrackedDispatchResult {
  runId: string;
  promise: Promise<void>;
}

/**
 * Execute a tracked dispatch. Returns runId immediately;
 * the actual agent work runs in the background.
 */
export function executeTrackedDispatch(opts: TrackedDispatchOpts): TrackedDispatchResult {
  const runId = crypto.randomUUID();

  // Register in tracker immediately
  startRun(runId, opts.agentType, opts.workItemId, undefined, {
    channel: opts.channel,
    message: opts.message,
  });

  // Emit dispatched event
  emitEvent(runId, "dispatched", opts.agentType, opts.workItemId, {
    source: "formal_dispatch",
    channel: opts.channel,
  });

  // Run the actual dispatch async
  const promise = runDispatch(runId, opts).catch((err) => {
    logger.error("Tracked dispatch failed", { runId: runId.slice(0, 8), error: err.message });
  });

  return { runId, promise };
}

async function runDispatch(runId: string, opts: TrackedDispatchOpts): Promise<void> {
  const { agentType, workItemId, channel, playbookCtx } = opts;
  const ctx = playbookCtx;

  const notifyCtx: NotifyContext = {
    bot: ctx.bot,
    telegramUserId: ctx.telegramUserId,
    gchatSpaceName: ctx.gchatSpaceName,
  };

  try {
    // 1. Fetch ticket details
    const details = await fetchWorkItemDetails(workItemId);
    if (!details) {
      emitEvent(runId, "failed", agentType, workItemId, { error: "Ticket not found in Plane" });
      endRun(runId, "failed");
      await notify(notifyCtx, {
        event: "error",
        workItemId,
        telegramMessage: `Could not find ${workItemId} in Plane`,
      });
      return;
    }

    emitEvent(runId, "progress", agentType, workItemId, { step: "ticket_fetched", ticket_title: details.name });

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
      const resp = await fetch("http://localhost:3001/api/work-session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ work_item_id: workItemId, title: details.name, project: "ELLIE", entity_name: `${agentType}_agent` }),
      });
      sessionResult = await resp.json();
    } catch (err: unknown) {
      logger.warn("Work session start failed (non-fatal)", err);
    }

    const sessionIds = sessionResult?.success ? {
      tree_id: sessionResult.tree_id,
      branch_id: (sessionResult.creatures as any)?.[0]?.branch_id,
      creature_id: (sessionResult.creatures as any)?.[0]?.id,
      entity_id: (sessionResult.creatures as any)?.[0]?.entity_id,
    } : undefined;

    // 4. Dispatch agent
    const dispatch = await dispatchAgent(ctx.supabase, agentType, ctx.telegramUserId, channel, `Work on ${workItemId}: ${details.name}`, workItemId);
    if (!dispatch) {
      emitEvent(runId, "failed", agentType, workItemId, { error: "Agent dispatch failed" });
      endRun(runId, "failed");
      await notify(notifyCtx, {
        event: "error",
        workItemId,
        telegramMessage: `Failed to dispatch ${agentType} agent for ${workItemId}`,
      });
      return;
    }

    // 5. Build prompt with personality context
    const workItemContext = `\nACTIVE WORK ITEM: ${workItemId}\n` +
      `Title: ${details.name}\nPriority: ${details.priority}\nDescription: ${details.description}\n`;

    const [archetype, psy, phase, health] = await Promise.all([
      getAgentArchetype(agentType),
      getPsyContext(),
      getPhaseContext(),
      getHealthContext(),
    ]);

    const prompt = ctx.buildPromptFn(
      `Work on ${workItemId}: ${details.name}\n\n${details.description}`,
      undefined, undefined, undefined,
      channel, dispatch.agent, workItemContext,
      undefined, undefined, undefined, undefined, undefined,
      sessionIds,
      archetype, psy, phase, health,
    );

    // 6. Call Claude with runId for heartbeat tracking
    emitEvent(runId, "progress", agentType, workItemId, { step: "calling_claude" });
    const startTime = Date.now();
    const rawResponse = await ctx.callClaudeFn(prompt, {
      resume: false,
      model: dispatch.agent.model,
      allowedTools: dispatch.agent.tools_enabled,
    });
    const durationMs = Date.now() - startTime;
    const durationMin = Math.round(durationMs / 1000 / 60);

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
    });
    endRun(runId, "completed");

    // 10. Notify
    const preview = rawResponse.replace(/\[MEMORY:[^\]]*\]/gi, "").trim().slice(0, 300);
    await notify(notifyCtx, {
      event: "session_complete",
      workItemId,
      telegramMessage: `${agentType} finished ${workItemId} (${durationMin}min):\n${preview}`,
      gchatMessage: `${agentType} agent completed ${workItemId} (${durationMin}min):\n${rawResponse.slice(0, 800)}`,
    });

  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    emitEvent(runId, "failed", agentType, workItemId, { error: errMsg.slice(0, 500) });
    endRun(runId, "failed");

    await notify(notifyCtx, {
      event: "error",
      workItemId,
      telegramMessage: `${agentType} dispatch failed for ${workItemId}: ${errMsg.slice(0, 100)}`,
    }).catch(() => {});
  }
}
