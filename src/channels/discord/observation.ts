/**
 * Discord Observation Layer — ELLIE-442 Phase 2
 *
 * Posts creature lifecycle and job status events to Discord automatically.
 * This is the "orchestra pit" — agents post their work in progress so
 * Dave can observe all agent activity from Discord without touching Ellie Chat.
 *
 * Channels (env-configured):
 *   DISCORD_CHANNEL_CREATURE_LOG  → creature lifecycle events (#creature-log)
 *   DISCORD_CHANNEL_JOB_TRACKER   → job status updates (#job-tracker)
 *
 * Agent-specific channels (DISCORD_CHANNEL_DEV etc.) also receive
 * completed/failed embeds for per-agent visibility.
 *
 * All functions are fire-and-forget — they never throw.
 */

import type { Client, TextChannel, ThreadChannel } from "discord.js";
import { EmbedBuilder } from "discord.js";
import { log } from "../../logger.ts";
import { agentColor } from "./embeds.ts";

const logger = log.child("discord-observation");

// ── Client reference (set by index.ts at gateway startup) ────────────────────

let _client: Client | null = null;

export function setObservationClient(client: Client | null): void {
  _client = client;
}

// ── Channel IDs (read from env at startup) ───────────────────────────────────

let creatureLogChannelId: string | null = null;
let jobTrackerChannelId: string | null = null;

export function initObservationChannels(): void {
  creatureLogChannelId = process.env.DISCORD_CHANNEL_CREATURE_LOG ?? null;
  jobTrackerChannelId = process.env.DISCORD_CHANNEL_JOB_TRACKER ?? null;

  if (creatureLogChannelId) logger.info("Observation: creature-log channel ready", { channelId: creatureLogChannelId });
  if (jobTrackerChannelId) logger.info("Observation: job-tracker channel ready", { channelId: jobTrackerChannelId });
  if (!creatureLogChannelId && !jobTrackerChannelId) {
    logger.info("Observation: no channels configured — skipping (set DISCORD_CHANNEL_CREATURE_LOG / JOB_TRACKER to enable)");
  }
}

// ── Internal send helper ──────────────────────────────────────────────────────

async function postEmbed(channelId: string, embed: EmbedBuilder): Promise<void> {
  if (!_client) return;
  try {
    const channel = await _client.channels.fetch(channelId).catch(() => null) as TextChannel | ThreadChannel | null;
    if (!channel || !("send" in channel)) {
      logger.warn("Observation: channel not found", { channelId });
      return;
    }
    await channel.send({ embeds: [embed] });
  } catch (err) {
    logger.warn("Observation: embed post failed (non-fatal)", {
      channelId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Creature lifecycle posts ──────────────────────────────────────────────────

export interface CreatureEventData {
  agentType: string;
  workItemId?: string;
  durationMs?: number;
  error?: string;
  responsePreview?: string;
}

/**
 * Post a creature lifecycle event to #creature-log and the agent's own channel.
 * Fired at: dispatched, completed, failed.
 */
export function postCreatureEvent(
  event: "dispatched" | "completed" | "failed",
  data: CreatureEventData,
): void {
  const { agentType, workItemId, durationMs, error, responsePreview } = data;
  const workLabel = workItemId ? ` → ${workItemId}` : "";

  let embed: EmbedBuilder;

  switch (event) {
    case "dispatched":
      embed = new EmbedBuilder()
        .setTitle(`🚀 Agent Dispatched: ${agentType}${workLabel}`)
        .setDescription(workItemId ? `Starting work on **${workItemId}**` : "Agent dispatched")
        .setColor(agentColor(agentType))
        .setTimestamp();
      break;

    case "completed": {
      const dur = durationMs ? ` in ${Math.round(durationMs / 60_000)}min` : "";
      const preview = responsePreview ? `\n\n${responsePreview.slice(0, 400)}` : "";
      embed = new EmbedBuilder()
        .setTitle(`✅ Agent Done: ${agentType}${workLabel}`)
        .setDescription(`Completed${dur}${preview}`)
        .setColor(0x57f287) // green
        .setTimestamp();
      break;
    }

    case "failed":
      embed = new EmbedBuilder()
        .setTitle(`❌ Agent Failed: ${agentType}${workLabel}`)
        .setDescription(error ? error.slice(0, 500) : "Unknown error")
        .setColor(0xed4245) // red
        .setTimestamp();
      break;

    default:
      return;
  }

  // Post to creature-log channel
  if (creatureLogChannelId) {
    postEmbed(creatureLogChannelId, embed);
  }

  // Also post completed/failed to the agent's own channel for per-agent visibility
  if (event !== "dispatched") {
    const agentChannelId = process.env[`DISCORD_CHANNEL_${agentType.toUpperCase()}`];
    if (agentChannelId && agentChannelId !== creatureLogChannelId) {
      postEmbed(agentChannelId, embed);
    }
  }
}

// ── Job tracker posts ─────────────────────────────────────────────────────────

export interface JobEventData {
  agentType: string;
  workItemId?: string;
  durationMs?: number;
  costUsd?: string;
  error?: string;
}

/**
 * Post a job status event to #job-tracker.
 * Fired at: created, completed, responded, failed.
 */
export function postJobEvent(
  event: "created" | "completed" | "responded" | "failed",
  data: JobEventData,
): void {
  if (!jobTrackerChannelId) return;

  const { agentType, workItemId, durationMs, costUsd, error } = data;
  const workLabel = workItemId ? ` • ${workItemId}` : "";

  let embed: EmbedBuilder;

  switch (event) {
    case "created":
      embed = new EmbedBuilder()
        .setTitle(`📋 Job Queued: ${agentType}${workLabel}`)
        .setDescription(workItemId
          ? `Dispatching **${agentType}** to **${workItemId}**`
          : `New ${agentType} job queued`)
        .setColor(agentColor(agentType))
        .setTimestamp();
      break;

    case "completed":
    case "responded": {
      const dur = durationMs ? ` ${Math.round(durationMs / 60_000)}min` : "";
      const cost = costUsd ? ` · $${parseFloat(costUsd).toFixed(3)}` : "";
      const label = event === "completed" ? "Done" : "Responded";
      embed = new EmbedBuilder()
        .setTitle(`✅ Job ${label}: ${agentType}${workLabel}`)
        .setDescription(`Finished in${dur}${cost}`)
        .setColor(0x57f287) // green
        .setTimestamp();
      break;
    }

    case "failed":
      embed = new EmbedBuilder()
        .setTitle(`❌ Job Failed: ${agentType}${workLabel}`)
        .setDescription(error ? error.slice(0, 500) : "Unknown error")
        .setColor(0xed4245) // red
        .setTimestamp();
      break;

    default:
      return;
  }

  postEmbed(jobTrackerChannelId, embed);
}
