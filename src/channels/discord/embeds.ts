/**
 * Discord Embed Builders — ELLIE-471
 *
 * Helpers for building Discord embeds for agent output.
 * Keeps formatting logic out of send.ts.
 */

import { EmbedBuilder, type ColorResolvable } from "discord.js";

// Colour palette per agent type
const AGENT_COLORS: Record<string, ColorResolvable> = {
  dev: 0x5865f2,        // blurple
  research: 0x57f287,   // green
  strategy: 0xfee75c,   // yellow
  general: 0xeb459e,    // pink
  workflow: 0xed4245,   // red
  system: 0x99aab5,     // grey
};

export function agentColor(agentLabel: string): ColorResolvable {
  return AGENT_COLORS[agentLabel.toLowerCase()] ?? 0x99aab5;
}

/** Plain text response embed — most common usage. */
export function responseEmbed(text: string, agentLabel: string): EmbedBuilder {
  const truncated = text.length > 4096 ? text.slice(0, 4090) + "\u2026" : text;
  return new EmbedBuilder()
    .setDescription(truncated)
    .setColor(agentColor(agentLabel))
    .setTimestamp();
}

/** Error / warning embed. */
export function errorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Error")
    .setDescription(message)
    .setColor(0xed4245)
    .setTimestamp();
}

/** Status update embed — for agent progress posts. */
export function statusEmbed(title: string, body: string, agentLabel: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(body.length > 4096 ? body.slice(0, 4090) + "\u2026" : body)
    .setColor(agentColor(agentLabel))
    .setTimestamp();
}
