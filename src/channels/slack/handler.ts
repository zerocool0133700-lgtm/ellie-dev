/**
 * Slack Message Handler — ELLIE-443
 *
 * Processes inbound Slack events and slash commands.
 * Routes through callClaude with agent context prefix, replies in thread.
 *
 * Events handled:
 *   app_mention  — @mention in any channel
 *   message.im   — DM to the bot
 *
 * Slash commands handled:
 *   /ellie <text>   — dispatch to agent
 *   /forest <query> — Forest bridge search
 */

import { log } from '../../logger.ts'
import { enqueue } from '../../message-queue.ts'
import { saveMessage } from '../../message-sender.ts'
import { sendSlackMessage, sendSlackCommandResponse } from './send.ts'

const logger = log.child('slack-handler')

// ── Types ─────────────────────────────────────────────────────

export interface SlackEventPayload {
  type: string
  user?: string
  bot_id?: string
  subtype?: string
  text?: string
  channel?: string
  channel_type?: string
  ts?: string
  thread_ts?: string
  event_ts?: string
  files?: unknown[]
}

export interface SlackCommandPayload {
  command: string
  text: string
  user_id: string
  channel_id: string
  response_url: string
  trigger_id: string
}

// ── Bot mention stripping ─────────────────────────────────────

const MENTION_RE = /<@[A-Z0-9]+>/g

function stripMentions(text: string): string {
  return text.replace(MENTION_RE, '').trim()
}

// ── Forest search (for /forest command) ───────────────────────

async function forestSearch(query: string): Promise<string> {
  try {
    const resp = await fetch('http://localhost:3001/api/bridge/read', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bridge-key': process.env.BRIDGE_KEY_SELF ?? '',
      },
      body: JSON.stringify({ query, match_count: 5 }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!resp.ok) return `Forest search failed (${resp.status})`
    const data = await resp.json() as { memories?: Array<{ content: string; scope_path?: string }> }
    const mems = data.memories ?? []
    if (!mems.length) return 'No Forest memories found for that query.'
    return mems.map((m, i) => `*${i + 1}.* [${m.scope_path ?? '?'}] ${m.content.slice(0, 200)}`).join('\n\n')
  } catch {
    return 'Forest search unavailable.'
  }
}

// ── Event handler ─────────────────────────────────────────────

/**
 * Handle an inbound Slack event (app_mention or message.im).
 * Reads env vars directly — only called when SLACK_BOT_TOKEN is set.
 */
export async function handleSlackEvent(
  event: SlackEventPayload,
  agentForChannel: (channelId: string) => string,
): Promise<void> {
  // Ignore bot messages and non-text subtypes
  if (event.bot_id || event.subtype === 'bot_message') return
  const text = stripMentions(event.text ?? '')
  if (!text && !event.files?.length) return

  const channelId = event.channel ?? ''
  const userId = event.user ?? 'unknown'
  const threadTs = event.thread_ts ?? event.ts
  const agent = agentForChannel(channelId)
  const preview = text.slice(0, 60) || '(attachment)'

  const allowedUserId = process.env.SLACK_ALLOWED_USER_ID
  if (allowedUserId && userId !== allowedUserId) {
    logger.warn('Slack: unauthorized user', { userId })
    return
  }

  logger.info('Slack event received', { event_type: event.type, agent, userId, channelId, preview })

  const token = process.env.SLACK_BOT_TOKEN ?? ''

  await enqueue(async () => {
    await saveMessage('user', text, { slack_channel: channelId, slack_ts: event.ts, slack_thread_ts: event.thread_ts }, 'slack', userId)

    try {
      const { callClaude } = await import('../../claude-cli.ts')
      const contextPrefix = `[Slack · ${agent} · from ${userId}]\n\n`
      const response = await callClaude(contextPrefix + text, { resume: false })

      await sendSlackMessage(token, channelId, response, threadTs)
      await saveMessage('assistant', response, { slack_channel: channelId }, 'slack')

      logger.info('Slack response sent', { agent, channelId })
    } catch (err) {
      logger.error('Slack handler error', { agent, error: err instanceof Error ? err.message : String(err) })
      await sendSlackMessage(token, channelId, 'Sorry, something went wrong. Please try again.', threadTs).catch(() => {})
    }
  }, `slack-${agent}`, preview)
}

// ── Slash command handler ─────────────────────────────────────

/**
 * Handle a Slack slash command.
 * Must acknowledge within 3 seconds — processing is async via response_url.
 */
export async function handleSlackCommand(payload: SlackCommandPayload): Promise<string> {
  const { command, text, user_id, channel_id, response_url } = payload

  const allowedUserId = process.env.SLACK_ALLOWED_USER_ID
  if (allowedUserId && user_id !== allowedUserId) {
    return 'Unauthorized.'
  }

  const token = process.env.SLACK_BOT_TOKEN ?? ''

  // /forest — Forest knowledge search
  if (command === '/forest') {
    const query = text.trim()
    if (!query) return 'Usage: `/forest <search query>`'

    // Async search — respond via response_url
    Promise.resolve().then(async () => {
      const result = await forestSearch(query)
      await sendSlackCommandResponse(response_url, `*Forest search:* "${query}"\n\n${result}`)
    }).catch(err => logger.error('Forest command failed', err))

    return `Searching Forest for "${query}"...`
  }

  // /ellie — dispatch to agent
  if (command === '/ellie') {
    const userText = text.trim()
    if (!userText) return 'Usage: `/ellie <message>`'

    // Acknowledge immediately, process async
    Promise.resolve().then(async () => {
      await saveMessage('user', userText, { slack_channel: channel_id, via: 'slash-command' }, 'slack', user_id)
      try {
        const { callClaude } = await import('../../claude-cli.ts')
        const contextPrefix = `[Slack slash command · general · from ${user_id}]\n\n`
        const response = await callClaude(contextPrefix + userText, { resume: false })
        await sendSlackCommandResponse(response_url, response)
        await saveMessage('assistant', response, { slack_channel: channel_id }, 'slack')
      } catch (err) {
        logger.error('/ellie command error', err)
        await sendSlackCommandResponse(response_url, 'Something went wrong. Please try again.')
      }
    }).catch(err => logger.error('/ellie async error', err))

    return `Processing your request...`
  }

  return `Unknown command: ${command}`
}
