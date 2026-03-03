/**
 * Discord Channel Plugin — ELLIE-469 / ELLIE-442 Phase 1
 *
 * Self-contained module. Only activates if DISCORD_BOT_TOKEN is set.
 * Register from relay.ts: startDiscordGateway(supabase)
 *
 * Architecture:
 *   - Inbound:  Message events → normalize.ts → enqueue or enqueueEllieChat
 *   - Outbound: send.ts (bot identity) or sendViaWebhook (agent identity)
 *   - Bindings: thread-bindings.ts (Supabase-persisted session → thread map)
 *
 * Channel routing (env-configured):
 *   DISCORD_CHANNEL_GENERAL   → general queue (all agents)
 *   DISCORD_CHANNEL_DEV       → dev agent
 *   DISCORD_CHANNEL_STRATEGY  → strategy agent
 *   DISCORD_CHANNEL_RESEARCH  → research agent
 *   DISCORD_ELLIE_CHAT_GUILD  → guild ID where DMs route to ellie-chat pipeline
 */

import { Client, GatewayIntentBits, Events } from "discord.js";
import { log } from "../../logger.ts";
import { normalizeMessage, setBotId, type NormalizedDiscordMessage } from "./normalize.ts";
import { sendToChannel, initWebhooks } from "./send.ts";
import { initThreadBindings, cleanExpiredBindings } from "./thread-bindings.ts";
import { enqueue } from "../../message-queue.ts";
import { periodicTask } from "../../periodic-task.ts";

const logger = log.child("discord");

// ── Channel → agent routing ───────────────────────────────────

const CHANNEL_AGENT_MAP: Record<string, string> = {};

function buildChannelMap(): void {
  const mappings: Array<[string, string]> = [
    ["DISCORD_CHANNEL_GENERAL", "general"],
    ["DISCORD_CHANNEL_DEV", "dev"],
    ["DISCORD_CHANNEL_STRATEGY", "strategy"],
    ["DISCORD_CHANNEL_RESEARCH", "research"],
    ["DISCORD_CHANNEL_WORKFLOW", "workflow"],
  ];
  for (const [envKey, agent] of mappings) {
    const channelId = process.env[envKey];
    if (channelId) CHANNEL_AGENT_MAP[channelId] = agent;
  }
}

function resolveAgent(channelId: string, parentChannelId: string | null): string {
  return (
    CHANNEL_AGENT_MAP[channelId] ??
    (parentChannelId ? CHANNEL_AGENT_MAP[parentChannelId] : null) ??
    "general"
  );
}

// ── Inbound handler ───────────────────────────────────────────

async function handleInbound(client: Client, msg: NormalizedDiscordMessage): Promise<void> {
  const agent = resolveAgent(msg.channelId, msg.parentChannelId);
  const preview = msg.text.slice(0, 60) || "(attachment)";

  logger.info("Discord message received", {
    kind: msg.kind,
    agent,
    authorId: msg.authorId,
    channelId: msg.channelId,
    preview,
  });

  await enqueue(async () => {
    // Dynamic import avoids circular deps — same pattern used elsewhere in relay
    const { handleDiscordMessage } = await import("./handler.ts");
    await handleDiscordMessage(client, msg, agent);
  }, `discord-${agent}`, preview);
}

// ── Gateway lifecycle ─────────────────────────────────────────

let _client: Client | null = null;

export function getDiscordClient(): Client | null {
  return _client;
}

export function startDiscordGateway(supabase: any): void {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    logger.info("DISCORD_BOT_TOKEN not set — Discord channel disabled");
    return;
  }

  initWebhooks();
  initThreadBindings(supabase);
  buildChannelMap();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  client.once(Events.ClientReady, (c) => {
    setBotId(c.user.id);
    logger.info("Discord bot ready", { tag: c.user.tag, id: c.user.id });
  });

  client.on(Events.MessageCreate, async (message) => {
    const normalized = normalizeMessage(message);
    if (!normalized) return;
    handleInbound(client, normalized).catch(err => {
      logger.error("Discord inbound handler error", { error: err instanceof Error ? err.message : String(err) });
    });
  });

  client.on(Events.Error, (err) => {
    logger.error("Discord gateway error", { error: err.message });
  });

  client.login(token).then(() => {
    logger.info("Discord gateway connected");
  }).catch(err => {
    logger.error("Discord login failed", { error: err instanceof Error ? err.message : String(err) });
  });

  _client = client;

  // Periodic cleanup of expired thread bindings (hourly)
  periodicTask(() => cleanExpiredBindings(), 60 * 60_000, "discord-binding-cleanup");
}

export async function stopDiscordGateway(): Promise<void> {
  if (_client) {
    await _client.destroy();
    _client = null;
    logger.info("Discord gateway disconnected");
  }
}

// ── Public send helpers (re-exported for use from relay/specialists) ──

export { sendToChannel, sendViaWebhook, sendEmbedToChannel } from "./send.ts";
export { bindThread, getBinding, unbindThread } from "./thread-bindings.ts";
