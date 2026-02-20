/**
 * Work Session Communication Endpoints
 *
 * These endpoints back the CLAUDE.md dispatch protocol.
 * Claude Code sessions call these to send session lifecycle events
 * back to the relay for routing to Telegram (status notifications), Plane, and logs.
 * Rich content (idea extraction, reports) routes to Google Chat separately.
 */

import type { Bot } from "grammy";
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
} from '../../../ellie-forest/src/index';
import { notify, type NotifyContext } from "../notification-policy.ts";

const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID!;
const GCHAT_SPACE = process.env.GOOGLE_CHAT_SPACE_NAME;

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
export async function startWorkSession(req: any, res: any, bot: Bot) {
  try {
    const { work_item_id, title, project, agent } = req.body;

    if (!work_item_id || !title || !project) {
      return res.status(400).json({
        error: 'Missing required fields: work_item_id, title, project'
      });
    }

    // Map agent short names to forest entity names
    const AGENT_ENTITY_MAP: Record<string, string> = {
      dev: 'dev_agent', research: 'research_agent', critic: 'critic_agent',
      content: 'content_agent', finance: 'finance_agent', strategy: 'strategy_agent',
      general: 'general_agent', router: 'agent_router',
    };
    const entityName = agent ? (AGENT_ENTITY_MAP[agent] ?? agent) : undefined;
    const entityNames = entityName ? [entityName] : undefined;

    // Create forest tree (dedup + transactional — safe to call multiple times)
    const result = await forestStartSession({
      title, work_item_id,
      entity_names: entityNames,
    });
    const { tree, trunk } = result;
    if ((result as any).resumed) {
      console.log(`[work-session:start] Resumed existing session ${tree.id} for ${work_item_id}`);
    }

    // Notify via policy engine (Telegram + Google Chat per routing rules)
    const escapeMarkdown = (text: string) => text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
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

    // Update Plane work item: set "In Progress" + add session comment
    try {
      await updateWorkItemOnSessionStart(work_item_id, tree.id);
    } catch (planeError) {
      console.warn('[work-session:start] Plane update failed (non-fatal):', planeError);
    }

    return res.json({
      success: true,
      session_id: tree.id,
      tree_id: tree.id,
      work_item_id,
      started_at: tree.created_at
    });

  } catch (error) {
    console.error('[work-session:start] Error:', error);
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
 *   "message": "Created POST /api/work-session/start endpoint"
 * }
 */
export async function updateWorkSession(req: any, res: any, bot: Bot) {
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

    // Add progress commit (replaces Supabase insert)
    await forestAddUpdate(tree.id, entity?.id, message);

    // Notify via policy engine (Google Chat only by default — Telegram disabled for updates)
    const escapeMarkdown = (text: string) => text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    const telegramMsg = [
      `📝 **Progress Update**`,
      ``,
      `**${escapeMarkdown(work_item_id)}:** ${escapeMarkdown(tree.title || work_item_id)}`,
      ``,
      escapeMarkdown(message)
    ].join('\n');

    const gchatMsg = [
      `📝 Progress Update`,
      ``,
      `${work_item_id}: ${tree.title || work_item_id}`,
      ``,
      message,
    ].join('\n');

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
    console.error('[work-session:update] Error:', error);
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
export async function logDecision(req: any, res: any, bot: Bot) {
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
    const escapeMarkdown = (text: string) => text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    const telegramMsg = [
      `⚡ **Decision Point**`,
      ``,
      `**${escapeMarkdown(work_item_id)}:** ${escapeMarkdown(tree.title || work_item_id)}`,
      ``,
      escapeMarkdown(message)
    ].join('\n');

    const gchatMsg = [
      `⚡ Decision Point`,
      ``,
      `${work_item_id}: ${tree.title || work_item_id}`,
      ``,
      message,
    ].join('\n');

    await notify(getNotifyCtx(bot), {
      event: "session_decision",
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
    console.error('[work-session:decision] Error:', error);
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
export async function completeWorkSession(req: any, res: any, bot: Bot) {
  try {
    const { work_item_id, summary } = req.body;

    if (!work_item_id || !summary) {
      return res.status(400).json({
        error: 'Missing required fields: work_item_id, summary'
      });
    }

    // Find active forest tree
    const tree = await getWorkSessionByPlaneId(work_item_id);
    if (!tree) {
      return res.status(404).json({ error: 'No active session found for this work item' });
    }

    // Complete session in forest (merges branches, completes creatures, archives tree — transactional)
    await forestCompleteSession(tree.id, summary);

    // Update Plane work item: set "Done" + add completion comment
    try {
      await updateWorkItemOnSessionComplete(work_item_id, summary, "completed");
    } catch (planeError) {
      console.warn('[work-session:complete] Plane update failed (non-fatal):', planeError);
    }

    // Notify via policy engine (both channels for completion)
    const duration = Math.round(
      (new Date().getTime() - new Date(tree.created_at).getTime()) / 1000 / 60
    );

    const escapeMarkdown = (text: string) => text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    const telegramMsg = [
      `✅ **Work Session Complete**`,
      ``,
      `**${escapeMarkdown(work_item_id)}:** ${escapeMarkdown(tree.title || work_item_id)}`,
      `**Duration:** ${duration} minutes`,
      ``,
      escapeMarkdown(summary)
    ].join('\n');

    const gchatMsg = [
      `✅ Work Session Complete`,
      ``,
      `${work_item_id}: ${tree.title || work_item_id}`,
      `Duration: ${duration} minutes`,
      ``,
      `Summary:`,
      summary,
    ].join('\n');

    await notify(getNotifyCtx(bot), {
      event: "session_complete",
      workItemId: work_item_id,
      telegramMessage: telegramMsg,
      gchatMessage: gchatMsg,
    });

    return res.json({
      success: true,
      session_id: tree.id,
      work_item_id,
      duration_minutes: duration
    });

  } catch (error) {
    console.error('[work-session:complete] Error:', error);
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
export async function pauseWorkSession(req: any, res: any, bot: Bot) {
  try {
    const { work_item_id, reason } = req.body;

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
    const escapeMarkdown = (text: string) => text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    const telegramMsg = [
      `\u23F8\uFE0F **Work Session Paused**`,
      ``,
      `**${escapeMarkdown(work_item_id)}:** ${escapeMarkdown(tree.title || work_item_id)}`,
      reason ? `**Reason:** ${escapeMarkdown(reason)}` : '',
    ].filter(Boolean).join('\n');

    const gchatMsg = [
      `\u23F8\uFE0F Work Session Paused`,
      ``,
      `${work_item_id}: ${tree.title || work_item_id}`,
      reason ? `Reason: ${reason}` : '',
    ].filter(Boolean).join('\n');

    await notify(getNotifyCtx(bot), {
      event: "session_pause",
      workItemId: work_item_id,
      telegramMessage: telegramMsg,
      gchatMessage: gchatMsg,
    });

    return res.json({
      success: true,
      session_id: tree.id,
      work_item_id,
      state: 'dormant',
    });

  } catch (error) {
    console.error('[work-session:pause] Error:', error);
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
export async function resumeWorkSession(req: any, res: any, bot: Bot) {
  try {
    const { work_item_id } = req.body;

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
    const escapeMarkdown = (text: string) => text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    const telegramMsg = [
      `\u25B6\uFE0F **Work Session Resumed**`,
      ``,
      `**${escapeMarkdown(work_item_id)}:** ${escapeMarkdown(tree.title || work_item_id)}`,
    ].join('\n');

    const gchatMsg = [
      `\u25B6\uFE0F Work Session Resumed`,
      ``,
      `${work_item_id}: ${tree.title || work_item_id}`,
    ].join('\n');

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
    console.error('[work-session:resume] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
