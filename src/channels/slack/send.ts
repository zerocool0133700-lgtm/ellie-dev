/**
 * Slack Outbound Sender — ELLIE-443
 *
 * Plain fetch-based Slack Web API client.
 * No SDK dependency — uses native Bun fetch.
 *
 * sendSlackMessage()         — post text to a channel/thread, auto-chunked at 3000 chars
 * deleteSlackMessage()       — delete a message by ts (used to remove typing indicator)
 * sendSlackCommandResponse() — delayed response via slash command response_url
 */

import { log } from '../../logger.ts'

const logger = log.child('slack-send')

const SLACK_API = 'https://slack.com/api'
const SLACK_CHUNK = 3000

// ── Chunking ──────────────────────────────────────────────────

function chunkText(text: string): string[] {
  if (text.length <= SLACK_CHUNK) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > SLACK_CHUNK) {
    const slice = remaining.slice(0, SLACK_CHUNK)
    const lastNewline = slice.lastIndexOf('\n')
    const breakAt = lastNewline > SLACK_CHUNK / 2 ? lastNewline : SLACK_CHUNK
    chunks.push(remaining.slice(0, breakAt))
    remaining = remaining.slice(breakAt).trimStart()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

// ── Core send ─────────────────────────────────────────────────

/**
 * Post a message to a Slack channel or thread.
 * Returns the ts of the first posted message (needed to delete typing indicators).
 * Automatically chunks at 3000 characters.
 */
export async function sendSlackMessage(
  token: string,
  channelId: string,
  text: string,
  threadTs?: string,
): Promise<{ ts?: string }> {
  const chunks = chunkText(text)
  let firstTs: string | undefined

  for (const chunk of chunks) {
    const body: Record<string, unknown> = { channel: channelId, text: chunk }
    if (threadTs) body.thread_ts = threadTs

    try {
      const resp = await fetch(`${SLACK_API}/chat.postMessage`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })

      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({})) as { error?: string }
        logger.warn('Slack API error', { status: resp.status, error: detail.error, channelId })
        return {}
      }

      const result = await resp.json() as { ok: boolean; ts?: string; error?: string }
      if (!result.ok) {
        logger.warn('Slack postMessage failed', { error: result.error, channelId })
        return {}
      }
      if (!firstTs) firstTs = result.ts
    } catch (err) {
      logger.error('sendSlackMessage fetch error', { channelId, error: err instanceof Error ? err.message : String(err) })
      return {}
    }
  }

  return { ts: firstTs }
}

/**
 * Delete a Slack message by channel + ts.
 * Used to remove the typing indicator after Claude responds.
 */
export async function deleteSlackMessage(
  token: string,
  channelId: string,
  ts: string,
): Promise<void> {
  try {
    await fetch(`${SLACK_API}/chat.delete`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel: channelId, ts }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    // Non-fatal — indicator just stays visible
  }
}

/**
 * Post a response to a slash command's response_url (delayed response).
 * response_type "in_channel" makes it visible to all; "ephemeral" only to the user.
 */
export async function sendSlackCommandResponse(
  responseUrl: string,
  text: string,
  responseType: 'in_channel' | 'ephemeral' = 'in_channel',
): Promise<void> {
  try {
    const resp = await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: responseType, text }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!resp.ok) {
      logger.warn('Slack command response failed', { status: resp.status })
    }
  } catch (err) {
    logger.error('sendSlackCommandResponse error', { error: err instanceof Error ? err.message : String(err) })
  }
}
