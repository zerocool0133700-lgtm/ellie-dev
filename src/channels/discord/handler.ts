/**
 * Discord Message Handler — ELLIE-469
 *
 * Bridges a normalized Discord message to the Claude pipeline.
 * Sends the response back to the originating channel/thread.
 */

import type { Client } from "discord.js";
import { log } from "../../logger.ts";
import type { NormalizedDiscordMessage } from "./normalize.ts";
import { sendToChannel, sendViaWebhook, getWebhookUrl } from "./send.ts";

const logger = log.child("discord-handler");

/** Agent label → webhook username display name */
const AGENT_DISPLAY: Record<string, string> = {
  dev: "Ellie · Dev",
  strategy: "Ellie · Strategy",
  research: "Ellie · Research",
  workflow: "Ellie · Workflow",
  general: "Ellie",
};

export async function handleDiscordMessage(
  client: Client,
  msg: NormalizedDiscordMessage,
  agent: string,
): Promise<void> {
  // Determine reply target — prefer thread, fall back to originating channel
  const replyChannelId = msg.threadId ?? msg.channelId;

  try {
    const { callClaude } = await import("../../claude-cli.ts");

    // Build a context-aware prompt
    const contextPrefix = `[Discord · ${agent} · from ${msg.authorName}]\n\n`;
    const fullPrompt = contextPrefix + (msg.text || "(image/attachment)");

    const response = await callClaude(fullPrompt, { resume: false });

    // Use webhook identity if available, bot identity otherwise
    if (getWebhookUrl(agent)) {
      await sendViaWebhook(client, msg.channelId, response, agent, msg.threadId ?? undefined);
    } else {
      await sendToChannel(client, replyChannelId, response, msg.messageId);
    }

    logger.info("Discord response sent", { agent, channelId: replyChannelId });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("Discord handler error", { agent, error: errMsg });
    await sendToChannel(client, replyChannelId, "Sorry, something went wrong. Please try again.").catch(() => {});
  }
}
