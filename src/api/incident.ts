/**
 * Incident Response Endpoints
 *
 * These endpoints handle the incident lifecycle:
 * - POST /api/incident/raise — create new incident tree
 * - POST /api/incident/update — add investigation findings
 * - POST /api/incident/resolve — close incident with root cause
 *
 * Notifications route to Telegram (alerts) and Google Chat (details)
 * via the notification policy engine.
 */

import type { Bot } from "grammy";
import {
  raiseIncident as forestRaiseIncident,
  updateInvestigation as forestUpdateInvestigation,
  resolveIncident as forestResolveIncident,
  getActiveIncident,
  listOpenBranches,
} from '../../../ellie-forest/src/index';
import { notify, type NotifyContext } from "../notification-policy.ts";
import { log } from "../logger.ts";

const logger = log.child("incident");

const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID!;
const GCHAT_SPACE = process.env.GOOGLE_CHAT_SPACE_NAME;

function getNotifyCtx(bot: Bot): NotifyContext {
  return { bot, telegramUserId: TELEGRAM_USER_ID, gchatSpaceName: GCHAT_SPACE };
}

const escapeMarkdown = (text: string) => text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');

/**
 * POST /api/incident/raise
 *
 * Body:
 * {
 *   "title": "Relay process crashed",
 *   "severity": "p0",
 *   "source": "monitoring",
 *   "affected_services": ["relay", "telegram"],
 *   "external_ref": "alert-42",   // optional, for dedup
 *   "entity_names": ["dev_agent"], // optional
 *   "tags": ["production"]         // optional
 * }
 */
export async function raiseIncident(req: any, res: any, bot: Bot) {
  try {
    const { title, severity, source, affected_services, external_ref, entity_names, tags } = req.body;

    if (!title || !severity || !source || !affected_services) {
      return res.status(400).json({
        error: 'Missing required fields: title, severity, source, affected_services'
      });
    }

    const result = await forestRaiseIncident({
      title, severity, source, affected_services,
      external_ref, entity_names, tags,
    });
    const { tree, trunk, creatures } = result;

    // Notify via policy engine (both channels for incidents)
    const sevEmoji = severity === 'p0' ? '🔴' : severity === 'p1' ? '🟠' : '🟡';

    const telegramMsg = [
      `${sevEmoji} **Incident Raised** \\[${escapeMarkdown(severity.toUpperCase())}\\]`,
      ``,
      `**${escapeMarkdown(title)}**`,
      `**Source:** ${escapeMarkdown(source)}`,
      `**Affected:** ${affected_services.map(escapeMarkdown).join(', ')}`,
      creatures.length > 0 ? `**Investigators:** ${creatures.length} dispatched` : '',
    ].filter(Boolean).join('\n');

    const gchatMsg = [
      `${sevEmoji} Incident Raised [${severity.toUpperCase()}]`,
      ``,
      title,
      `Source: ${source}`,
      `Affected: ${affected_services.join(', ')}`,
      `Tree: ${tree.id}`,
      creatures.length > 0 ? `Investigators dispatched: ${creatures.length}` : '',
    ].filter(Boolean).join('\n');

    await notify(getNotifyCtx(bot), {
      event: "incident_raised",
      workItemId: external_ref || tree.id,
      telegramMessage: telegramMsg,
      gchatMessage: gchatMsg,
    });

    return res.json({
      success: true,
      tree_id: tree.id,
      severity,
      creatures_dispatched: creatures.length,
    });

  } catch (error) {
    logger.error("Raise failed", error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/incident/update
 *
 * Body:
 * {
 *   "tree_id": "uuid",         // or "external_ref": "alert-42"
 *   "branch_id": "uuid",       // investigation branch
 *   "findings": "Found: ...",
 *   "agent": "dev_agent"       // optional
 * }
 */
export async function updateIncident(req: any, res: any, bot: Bot) {
  try {
    const { tree_id, external_ref, branch_id, findings, agent } = req.body;

    if (!findings || !branch_id) {
      return res.status(400).json({
        error: 'Missing required fields: findings, branch_id'
      });
    }

    // Resolve tree
    let treeId = tree_id;
    if (!treeId && external_ref) {
      const tree = await getActiveIncident(external_ref);
      if (!tree) return res.status(404).json({ error: 'No active incident found for this external_ref' });
      treeId = tree.id;
    }
    if (!treeId) {
      return res.status(400).json({ error: 'Must provide tree_id or external_ref' });
    }

    const commit = await forestUpdateInvestigation(treeId, branch_id, findings, agent);

    // Notify (silent on Telegram, detail on GChat per policy)
    const gchatMsg = [
      `📝 Investigation Update`,
      ``,
      `Tree: ${treeId}`,
      agent ? `Agent: ${agent}` : '',
      ``,
      findings,
    ].filter(Boolean).join('\n');

    await notify(getNotifyCtx(bot), {
      event: "incident_update",
      workItemId: external_ref || treeId,
      telegramMessage: `📝 Investigation update: ${escapeMarkdown(findings.slice(0, 100))}`,
      gchatMessage: gchatMsg,
    });

    return res.json({
      success: true,
      tree_id: treeId,
      commit_id: commit.id,
    });

  } catch (error) {
    logger.error("Update failed", error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/incident/resolve
 *
 * Body:
 * {
 *   "tree_id": "uuid",               // or "external_ref": "alert-42"
 *   "winning_branch_id": "uuid",
 *   "root_cause": "Bun 1.1.38 WebSocket use-after-free",
 *   "fix_summary": "Pinned to Bun 1.1.37, filed upstream issue"
 * }
 */
export async function resolveIncident(req: any, res: any, bot: Bot) {
  try {
    const { tree_id, external_ref, winning_branch_id, root_cause, fix_summary } = req.body;

    if (!root_cause || !fix_summary) {
      return res.status(400).json({
        error: 'Missing required fields: root_cause, fix_summary'
      });
    }

    // Resolve tree
    let treeId = tree_id;
    let tree: any = null;
    if (!treeId && external_ref) {
      tree = await getActiveIncident(external_ref);
      if (!tree) return res.status(404).json({ error: 'No active incident found for this external_ref' });
      treeId = tree.id;
    }
    if (!treeId) {
      return res.status(400).json({ error: 'Must provide tree_id or external_ref' });
    }

    // If no winning_branch_id, use the first open branch (single-theory resolution)
    let branchId = winning_branch_id;
    if (!branchId) {
      const branches = await listOpenBranches(treeId);
      if (branches.length === 0) {
        return res.status(409).json({ error: 'No open branches to resolve' });
      }
      branchId = branches[0].id;
    }

    const resolved = await forestResolveIncident(treeId, branchId, root_cause, fix_summary);

    const duration = Math.round(
      (new Date().getTime() - new Date(resolved.created_at).getTime()) / 1000 / 60
    );

    // Notify via policy engine (both channels for resolution)
    const telegramMsg = [
      `✅ **Incident Resolved**`,
      ``,
      `**${escapeMarkdown(resolved.title || 'Incident')}**`,
      `**Duration:** ${duration} minutes`,
      `**Root Cause:** ${escapeMarkdown(root_cause)}`,
      `**Fix:** ${escapeMarkdown(fix_summary)}`,
    ].join('\n');

    const gchatMsg = [
      `✅ Incident Resolved`,
      ``,
      resolved.title || 'Incident',
      `Duration: ${duration} minutes`,
      ``,
      `Root Cause: ${root_cause}`,
      `Fix: ${fix_summary}`,
      `Tree: ${treeId}`,
    ].join('\n');

    await notify(getNotifyCtx(bot), {
      event: "incident_resolved",
      workItemId: external_ref || treeId,
      telegramMessage: telegramMsg,
      gchatMessage: gchatMsg,
    });

    return res.json({
      success: true,
      tree_id: treeId,
      state: 'mature',
      duration_minutes: duration,
      root_cause,
    });

  } catch (error) {
    logger.error("Resolve failed", error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
