/**
 * Slack Channel Plugin — ELLIE-443
 *
 * HTTP Events API adapter. Activates only if SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET are set.
 * Register from relay.ts: startSlackChannel()
 *
 * Architecture:
 *   - Inbound:  POST /slack  → verify.ts (signature) → handler.ts (event/command)
 *   - Outbound: send.ts (chat.postMessage via native fetch — no SDK)
 *   - Routing:  SLACK_CHANNEL_* env vars → agent name map
 *
 * Env vars:
 *   SLACK_BOT_TOKEN            — xoxb-... (required)
 *   SLACK_SIGNING_SECRET       — from app config (required)
 *   SLACK_ALLOWED_USER_ID      — Slack user ID whitelist (optional, recommended)
 *   SLACK_NOTIFICATION_CHANNEL — channel ID for proactive notifications
 *   SLACK_CHANNEL_GENERAL      — channel ID → general agent
 *   SLACK_CHANNEL_DEV          — channel ID → dev agent
 *   SLACK_CHANNEL_STRATEGY     — channel ID → strategy agent
 *   SLACK_CHANNEL_RESEARCH     — channel ID → research agent
 */

import { log } from '../../logger.ts'
import { sendSlackMessage } from './send.ts'

export { sendSlackMessage } from './send.ts'

const logger = log.child('slack')

// ── Channel → agent routing ───────────────────────────────────

const CHANNEL_AGENT_MAP: Record<string, string> = {}

function buildChannelMap(): void {
  const mappings: Array<[string, string]> = [
    ['SLACK_CHANNEL_GENERAL', 'general'],
    ['SLACK_CHANNEL_DEV', 'dev'],
    ['SLACK_CHANNEL_STRATEGY', 'strategy'],
    ['SLACK_CHANNEL_RESEARCH', 'research'],
    ['SLACK_CHANNEL_WORKFLOW', 'workflow'],
  ]
  for (const [envKey, agent] of mappings) {
    const channelId = process.env[envKey]
    if (channelId) CHANNEL_AGENT_MAP[channelId] = agent
  }
}

export function resolveAgent(channelId: string): string {
  return CHANNEL_AGENT_MAP[channelId] ?? 'general'
}

// ── Status ────────────────────────────────────────────────────

export function isSlackConfigured(): boolean {
  return !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET)
}

export function getSlackNotificationChannel(): string | undefined {
  return process.env.SLACK_NOTIFICATION_CHANNEL || undefined
}

// ── Notification helper (for notification-policy.ts) ─────────

/**
 * Returns a bound function that posts a plain-text notification to the
 * configured SLACK_NOTIFICATION_CHANNEL. Used as NotifyContext.slackSend.
 */
export function getSlackSendFn(): ((message: string) => Promise<void>) | undefined {
  const token = process.env.SLACK_BOT_TOKEN
  const channelId = process.env.SLACK_NOTIFICATION_CHANNEL
  if (!token || !channelId) return undefined

  return (message: string) => sendSlackMessage(token, channelId, message)
}

// ── Startup ───────────────────────────────────────────────────

export function startSlackChannel(): void {
  if (!process.env.SLACK_BOT_TOKEN) {
    logger.info('SLACK_BOT_TOKEN not set — Slack channel disabled')
    return
  }
  if (!process.env.SLACK_SIGNING_SECRET) {
    logger.warn('SLACK_BOT_TOKEN set but SLACK_SIGNING_SECRET missing — Slack channel disabled')
    return
  }

  buildChannelMap()

  const channelCount = Object.keys(CHANNEL_AGENT_MAP).length
  const notifyChannel = getSlackNotificationChannel()
  logger.info('Slack channel enabled', {
    channel_routes: channelCount,
    notification_channel: notifyChannel ?? 'not configured',
    user_filter: process.env.SLACK_ALLOWED_USER_ID ? 'enabled' : 'disabled',
  })
}
