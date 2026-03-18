/**
 * @mention Parser — ELLIE-849
 *
 * Detects @agent-name, @here, @channel mentions in message text.
 * Returns structured mention data for storage and routing.
 */

import { log } from "./logger.ts";

const logger = log.child("mention-parser");

export interface Mention {
  type: "agent" | "user" | "here" | "channel";
  id: string | null;  // agent name or user ID; null for @here/@channel
  raw: string;        // the raw match text e.g. "@james"
  index: number;      // position in original text
}

// Known agent names → display names
const AGENT_MAP: Record<string, string> = {
  ellie: "general",
  james: "dev",
  kate: "research",
  amy: "content",
  brian: "critic",
  alan: "strategy",
  jason: "ops",
  // Also accept role names directly
  general: "general",
  dev: "dev",
  research: "research",
  content: "content",
  critic: "critic",
  strategy: "strategy",
  ops: "ops",
};

// Display name → agent role name
const DISPLAY_TO_ROLE: Record<string, string> = {};
for (const [display, role] of Object.entries(AGENT_MAP)) {
  DISPLAY_TO_ROLE[display] = role;
}

const MENTION_RE = /@([\w-]+)/g;

/**
 * Parse all mentions from message text.
 */
export function parseMentions(text: string): Mention[] {
  const mentions: Mention[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  MENTION_RE.lastIndex = 0;

  while ((match = MENTION_RE.exec(text)) !== null) {
    const name = match[1].toLowerCase();
    const raw = match[0];
    const index = match.index;

    if (name === "here") {
      mentions.push({ type: "here", id: null, raw, index });
    } else if (name === "channel" || name === "all") {
      mentions.push({ type: "channel", id: null, raw, index });
    } else if (AGENT_MAP[name]) {
      mentions.push({ type: "agent", id: AGENT_MAP[name], raw, index });
    } else {
      // Could be a user mention — store as-is
      mentions.push({ type: "user", id: name, raw, index });
    }
  }

  return mentions;
}

/**
 * Extract unique agent role names mentioned in text.
 */
export function extractMentionedAgents(text: string): string[] {
  const mentions = parseMentions(text);
  const agents = new Set<string>();
  for (const m of mentions) {
    if (m.type === "agent" && m.id) agents.add(m.id);
  }
  return [...agents];
}

/**
 * Check if text contains any @here or @channel mention.
 */
export function hasBroadcastMention(text: string): { here: boolean; channel: boolean } {
  const mentions = parseMentions(text);
  return {
    here: mentions.some(m => m.type === "here"),
    channel: mentions.some(m => m.type === "channel"),
  };
}

/**
 * Strip mention syntax from text (for clean display).
 */
export function stripMentions(text: string): string {
  return text.replace(MENTION_RE, (match, name) => {
    const lower = name.toLowerCase();
    if (AGENT_MAP[lower]) {
      // Replace @james with just "James"
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
    return match;
  });
}

/**
 * Convert mentions to HTML-highlighted format for display.
 */
export function highlightMentions(text: string): string {
  return text.replace(MENTION_RE, (match, name) => {
    const lower = name.toLowerCase();
    if (lower === "here" || lower === "channel" || lower === "all" || AGENT_MAP[lower]) {
      return `<span class="mention">${match}</span>`;
    }
    return match;
  });
}

/**
 * Store mentions in the database.
 */
export async function storeMentions(
  supabase: { from: (table: string) => any },
  messageId: string,
  channelId: string | null,
  mentions: Mention[],
): Promise<void> {
  if (mentions.length === 0) return;

  const rows = mentions.map(m => ({
    message_id: messageId,
    mentioned_type: m.type,
    mentioned_id: m.id,
    channel_id: channelId,
  }));

  const { error } = await supabase.from("message_mentions").insert(rows);
  if (error) {
    logger.error("Failed to store mentions", { messageId, error });
  }
}

/**
 * Get all agent names (for typeahead).
 */
export function getKnownAgents(): Array<{ name: string; role: string; displayName: string }> {
  return [
    { name: "ellie", role: "general", displayName: "Ellie" },
    { name: "james", role: "dev", displayName: "James" },
    { name: "kate", role: "research", displayName: "Kate" },
    { name: "amy", role: "content", displayName: "Amy" },
    { name: "brian", role: "critic", displayName: "Brian" },
    { name: "alan", role: "strategy", displayName: "Alan" },
    { name: "jason", role: "ops", displayName: "Jason" },
  ];
}
