/**
 * Discord Inbound Normalizer — ELLIE-470
 *
 * Converts a raw Discord Message into a clean Ellie inbound format
 * before it touches any agent logic. Adapter-first pattern from OpenClaw.
 *
 * Handles:
 *   - Guild channel messages (with optional @mention requirement)
 *   - Thread messages
 *   - DMs (direct messages to the bot)
 *   - Attachment URL extraction
 *   - Mention stripping
 */

import type { Client, Message } from "discord.js";
import { ChannelType } from "discord.js";
import { log } from "../../logger.ts";

const logger = log.child("discord-normalize");

// Discord mention pattern: <@123456789> or <@!123456789>
const MENTION_RE = /<@!?\d+>/g;

export type DiscordMessageKind = "dm" | "thread" | "channel";

export interface NormalizedDiscordMessage {
  /** Cleaned text with mentions stripped */
  text: string;
  /** Original Discord message ID — used for reply-to linking */
  messageId: string;
  /** User's Discord ID */
  authorId: string;
  /** User's display name in the guild, or username for DMs */
  authorName: string;
  /** Guild ID (null for DMs) */
  guildId: string | null;
  /** Channel ID where the message was sent */
  channelId: string;
  /** Thread ID if the message is inside a thread (may equal channelId for threads) */
  threadId: string | null;
  /** Parent channel ID for thread messages */
  parentChannelId: string | null;
  kind: DiscordMessageKind;
  /** First attachment URL if present */
  attachmentUrl: string | null;
  /** All attachment URLs */
  attachmentUrls: string[];
}

/** Bot user ID — set once the client is ready. */
let _botId: string | null = null;
export function setBotId(id: string): void { _botId = id; }

/**
 * Normalize a Discord Message into the standard Ellie format.
 * Returns null if the message should be ignored (bot, empty after strip, etc.)
 */
export function normalizeMessage(message: Message): NormalizedDiscordMessage | null {
  // Ignore bot messages (including our own)
  if (message.author.bot) return null;

  const kind = resolveKind(message);
  const rawText = message.content ?? "";

  // Strip all Discord mentions
  const text = rawText.replace(MENTION_RE, "").trim();

  // Guild channel messages require a bot mention unless it's a DM or thread reply
  if (kind === "channel") {
    const mentioned = _botId ? message.mentions.users.has(_botId) : false;
    if (!mentioned) return null; // not addressed to us
  }

  // Silently drop empty messages after stripping
  if (!text && message.attachments.size === 0) return null;

  const attachmentUrls = [...message.attachments.values()]
    .map(a => a.url)
    .filter(Boolean);

  const threadId = resolveThreadId(message);
  const parentChannelId = resolveParentChannelId(message);

  const authorName =
    (message.member?.displayName) ??
    message.author.displayName ??
    message.author.username;

  logger.debug("Normalized Discord message", {
    kind,
    messageId: message.id,
    authorId: message.author.id,
    channelId: message.channelId,
    threadId,
    textLength: text.length,
    attachments: attachmentUrls.length,
  });

  return {
    text,
    messageId: message.id,
    authorId: message.author.id,
    authorName,
    guildId: message.guildId,
    channelId: message.channelId,
    threadId,
    parentChannelId,
    kind,
    attachmentUrl: attachmentUrls[0] ?? null,
    attachmentUrls,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function resolveKind(message: Message): DiscordMessageKind {
  if (!message.guildId) return "dm";
  if (
    message.channel.type === ChannelType.PublicThread ||
    message.channel.type === ChannelType.PrivateThread ||
    message.channel.type === ChannelType.AnnouncementThread
  ) return "thread";
  return "channel";
}

function resolveThreadId(message: Message): string | null {
  if (
    message.channel.type === ChannelType.PublicThread ||
    message.channel.type === ChannelType.PrivateThread ||
    message.channel.type === ChannelType.AnnouncementThread
  ) {
    return message.channelId;
  }
  return null;
}

function resolveParentChannelId(message: Message): string | null {
  if (
    message.channel.type === ChannelType.PublicThread ||
    message.channel.type === ChannelType.PrivateThread ||
    message.channel.type === ChannelType.AnnouncementThread
  ) {
    const parent = (message.channel as { parentId?: string | null }).parentId;
    return parent ?? null;
  }
  return null;
}
