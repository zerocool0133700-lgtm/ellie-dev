/**
 * Work Session Communication Endpoints
 *
 * These endpoints back the CLAUDE.md dispatch protocol.
 * Claude Code sessions call these to send session lifecycle events
 * back to the relay for routing to Telegram, Plane, and logs.
 */

/**
 * These functions require supabase and bot instances to be passed
 * from the relay.ts HTTP handler context.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Bot } from "grammy";
import { updateWorkItemOnSessionStart } from "../plane.ts";

const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID!;

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
export async function startWorkSession(req: any, res: any, supabase: SupabaseClient, bot: Bot) {
  try {
    const { work_item_id, title, project, agent } = req.body;

    if (!work_item_id || !title || !project) {
      return res.status(400).json({
        error: 'Missing required fields: work_item_id, title, project'
      });
    }

    // Create session record in Supabase
    const { data: session, error: sessionError } = await supabase
      .from('work_sessions')
      .insert({
        work_item_id,
        work_item_title: title,
        project,
        agent: agent || null,
        state: 'active'
      })
      .select()
      .single();

    if (sessionError) {
      console.error('[work-session:start] Failed to create session:', sessionError);
      return res.status(500).json({ error: 'Failed to create session record' });
    }

    // Send Telegram notification (escape markdown special chars)
    const escapeMarkdown = (text: string) => text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    const message = [
      `🚀 **Work Session Started**`,
      ``,
      `**Work Item:** ${escapeMarkdown(work_item_id)}`,
      `**Title:** ${escapeMarkdown(title)}`,
      `**Project:** ${escapeMarkdown(project)}`,
      agent ? `**Agent:** ${escapeMarkdown(agent)}` : '',
      ``,
      `Session ID: \`${session.id}\``
    ].filter(Boolean).join('\n');

    await bot.api.sendMessage(TELEGRAM_USER_ID, message, { parse_mode: 'Markdown' });

    // Update Plane work item: set "In Progress" + add session comment
    try {
      await updateWorkItemOnSessionStart(work_item_id, session.id);
    } catch (planeError) {
      console.warn('[work-session:start] Plane update failed (non-fatal):', planeError);
    }

    return res.json({
      success: true,
      session_id: session.id,
      work_item_id,
      started_at: session.created_at
    });

  } catch (error) {
    console.error('[work-session:start] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/work-session/update
 *
 * Sends progress update to Telegram and logs to Supabase
 *
 * Body:
 * {
 *   "work_item_id": "ELLIE-1",
 *   "message": "Created POST /api/work-session/start endpoint"
 * }
 */
export async function updateWorkSession(req: any, res: any, supabase: SupabaseClient, bot: Bot) {
  try {
    const { work_item_id, message } = req.body;

    if (!work_item_id || !message) {
      return res.status(400).json({
        error: 'Missing required fields: work_item_id, message'
      });
    }

    // Find active session
    const { data: session, error: sessionError } = await supabase
      .from('work_sessions')
      .select('*')
      .eq('work_item_id', work_item_id)
      .eq('state', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (sessionError || !session) {
      return res.status(404).json({ error: 'No active session found for this work item' });
    }

    // Log update
    const { error: updateError } = await supabase
      .from('work_session_updates')
      .insert({
        session_id: session.id,
        type: 'progress',
        message
      });

    if (updateError) {
      console.error('[work-session:update] Failed to log update:', updateError);
    }

    // Send Telegram notification (escape markdown special chars)
    const escapeMarkdown = (text: string) => text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    const telegramMessage = [
      `📝 **Progress Update**`,
      ``,
      `**${escapeMarkdown(work_item_id)}:** ${escapeMarkdown(session.work_item_title)}`,
      ``,
      escapeMarkdown(message)
    ].join('\n');

    await bot.api.sendMessage(TELEGRAM_USER_ID, telegramMessage, { parse_mode: 'Markdown' });

    return res.json({
      success: true,
      session_id: session.id,
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
export async function logDecision(req: any, res: any, supabase: SupabaseClient, bot: Bot) {
  try {
    const { work_item_id, message } = req.body;

    if (!work_item_id || !message) {
      return res.status(400).json({
        error: 'Missing required fields: work_item_id, message'
      });
    }

    // Find active session
    const { data: session, error: sessionError } = await supabase
      .from('work_sessions')
      .select('*')
      .eq('work_item_id', work_item_id)
      .eq('state', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (sessionError || !session) {
      return res.status(404).json({ error: 'No active session found for this work item' });
    }

    // Log decision
    const { error: decisionError } = await supabase
      .from('work_session_updates')
      .insert({
        session_id: session.id,
        type: 'decision',
        message
      });

    if (decisionError) {
      console.error('[work-session:decision] Failed to log decision:', decisionError);
    }

    // Send Telegram notification (escape markdown special chars)
    const escapeMarkdown = (text: string) => text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    const telegramMessage = [
      `⚡ **Decision Point**`,
      ``,
      `**${escapeMarkdown(work_item_id)}:** ${escapeMarkdown(session.work_item_title)}`,
      ``,
      escapeMarkdown(message)
    ].join('\n');

    await bot.api.sendMessage(TELEGRAM_USER_ID, telegramMessage, { parse_mode: 'Markdown' });

    return res.json({
      success: true,
      session_id: session.id,
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
export async function completeWorkSession(req: any, res: any, supabase: SupabaseClient, bot: Bot) {
  try {
    const { work_item_id, summary } = req.body;

    if (!work_item_id || !summary) {
      return res.status(400).json({
        error: 'Missing required fields: work_item_id, summary'
      });
    }

    // Find active session
    const { data: session, error: sessionError } = await supabase
      .from('work_sessions')
      .select('*')
      .eq('work_item_id', work_item_id)
      .eq('state', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (sessionError || !session) {
      return res.status(404).json({ error: 'No active session found for this work item' });
    }

    // Mark session complete
    const { error: completeError } = await supabase
      .from('work_sessions')
      .update({
        state: 'completed',
        completed_at: new Date().toISOString()
      })
      .eq('id', session.id);

    if (completeError) {
      console.error('[work-session:complete] Failed to update session:', completeError);
      return res.status(500).json({ error: 'Failed to mark session complete' });
    }

    // Send Telegram notification
    const duration = Math.round(
      (new Date().getTime() - new Date(session.created_at).getTime()) / 1000 / 60
    );

    const escapeMarkdown = (text: string) => text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    const telegramMessage = [
      `✅ **Work Session Complete**`,
      ``,
      `**${escapeMarkdown(work_item_id)}:** ${escapeMarkdown(session.work_item_title)}`,
      `**Duration:** ${duration} minutes`,
      ``,
      `**Summary:**`,
      escapeMarkdown(summary)
    ].join('\n');

    await bot.api.sendMessage(TELEGRAM_USER_ID, telegramMessage, { parse_mode: 'Markdown' });

    return res.json({
      success: true,
      session_id: session.id,
      work_item_id,
      duration_minutes: duration
    });

  } catch (error) {
    console.error('[work-session:complete] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
