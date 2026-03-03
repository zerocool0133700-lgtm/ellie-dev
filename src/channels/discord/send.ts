/**
 * Discord Outbound Sender — ELLIE-471
 *
 * Two sending paths:
 *   sendToChannel()   — bot identity (general messages, command replies)
 *   sendViaWebhook()  — agent-specific webhook identity (custom name + avatar)
 *
 * Webhook URLs are configured per agent type via env vars:
 *   DISCORD_WEBHOOK_DEV, DISCORD_WEBHOOK_STRATEGY, DISCORD_WEBHOOK_RESEARCH, etc.
 *
 * Message chunking: Discord enforces a 2000-char limit per message and 4096 per embed.
 * sendToChannel() chunks plain text automatically.
 */

import type { Client, TextChannel, ThreadChannel } from "discord.js";
import { log } from "../../logger.ts";
import { responseEmbed } from "./embeds.ts";

const logger = log.child("discord-send");

const DISCORD_CHUNK_SIZE = 1990; // leave 10 chars safety margin

// ── Webhook registry — populated from env at startup ─────────

const WEBHOOK_URLS: Record<string, string> = {};

export function initWebhooks(): void {
  const agents = ["dev", "strategy", "research", "workflow", "general", "creature", "jobs"];
  for (const agent of agents) {
    const url = process.env[`DISCORD_WEBHOOK_${agent.toUpperCase()}`];
    if (url) {
      WEBHOOK_URLS[agent] = url;
      logger.info(`Webhook registered for agent: ${agent}`);
    }
  }
}

export function getWebhookUrl(agentLabel: string): string | undefined {
  return WEBHOOK_URLS[agentLabel.toLowerCase()];
}

// ── Channel send (bot identity) ───────────────────────────────

/**
 * Send a plain text response to a Discord channel or thread via the bot.
 * Automatically chunks at 2000 chars.
 */
export async function sendToChannel(
  client: Client,
  channelId: string,
  text: string,
  replyToMessageId?: string,
): Promise<void> {
  try {
    const channel = await client.channels.fetch(channelId) as TextChannel | ThreadChannel | null;
    if (!channel || !("send" in channel)) {
      logger.warn("sendToChannel: channel not found or not sendable", { channelId });
      return;
    }
    const chunks = chunkText(text);
    for (let i = 0; i < chunks.length; i++) {
      const options: Record<string, unknown> = { content: chunks[i] };
      // Only reply-link on the first chunk
      if (i === 0 && replyToMessageId) {
        options.reply = { messageReference: replyToMessageId, failIfNotExists: false };
      }
      await channel.send(options as Parameters<typeof channel.send>[0]);
    }
  } catch (err) {
    logger.error("sendToChannel failed", { channelId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Send an embed response to a channel via the bot.
 */
export async function sendEmbedToChannel(
  client: Client,
  channelId: string,
  text: string,
  agentLabel: string,
): Promise<void> {
  try {
    const channel = await client.channels.fetch(channelId) as TextChannel | ThreadChannel | null;
    if (!channel || !("send" in channel)) return;
    const embed = responseEmbed(text, agentLabel);
    await channel.send({ embeds: [embed] });
  } catch (err) {
    logger.error("sendEmbedToChannel failed", { channelId, error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Webhook send (agent identity) ─────────────────────────────

/**
 * Send a message via a webhook, giving the agent its own name and avatar.
 * Falls back to bot send if no webhook URL is configured for this agent.
 */
export async function sendViaWebhook(
  client: Client,
  channelId: string,
  text: string,
  agentLabel: string,
  threadId?: string,
  avatarUrl?: string,
): Promise<void> {
  const webhookUrl = getWebhookUrl(agentLabel);
  if (!webhookUrl) {
    // No webhook configured — fall back to bot identity
    await sendToChannel(client, threadId ?? channelId, text);
    return;
  }

  const chunks = chunkText(text);
  for (const chunk of chunks) {
    const body: Record<string, unknown> = {
      content: chunk,
      username: agentLabel.charAt(0).toUpperCase() + agentLabel.slice(1),
    };
    if (avatarUrl) body.avatar_url = avatarUrl;
    if (threadId) body.thread_id = threadId;

    try {
      const resp = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        logger.warn("Webhook send failed", { agentLabel, status: resp.status });
      }
    } catch (err) {
      logger.error("sendViaWebhook fetch error", { agentLabel, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

// ── Utilities ─────────────────────────────────────────────────

function chunkText(text: string): string[] {
  if (text.length <= DISCORD_CHUNK_SIZE) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > DISCORD_CHUNK_SIZE) {
    // Break at last newline within chunk boundary for cleaner splits
    const slice = remaining.slice(0, DISCORD_CHUNK_SIZE);
    const lastNewline = slice.lastIndexOf("\n");
    const breakAt = lastNewline > DISCORD_CHUNK_SIZE / 2 ? lastNewline : DISCORD_CHUNK_SIZE;
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
