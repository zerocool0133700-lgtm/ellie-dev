/**
 * Message Reactions — ELLIE-637
 *
 * Add/remove/list emoji reactions on Ellie Chat messages.
 * Uses injectable deps for testing without real Supabase.
 */

import { log } from "../logger.ts";

const logger = log.child("reactions");

// ============================================================
// TYPES
// ============================================================

export interface Reaction {
  id: string;
  message_id: string;
  emoji: string;
  user_id: string;
  created_at: string;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  users: string[];
}

export interface ReactionsDeps {
  addReaction: (messageId: string, emoji: string, userId: string) => Promise<Reaction | null>;
  removeReaction: (messageId: string, emoji: string, userId: string) => Promise<boolean>;
  getReactions: (messageId: string) => Promise<Reaction[]>;
  getReactionSummary: (messageId: string) => Promise<ReactionSummary[]>;
  getReactionsForMessages: (messageIds: string[]) => Promise<Map<string, ReactionSummary[]>>;
}

// ============================================================
// DEFAULT IMPLEMENTATIONS (Supabase)
// ============================================================

export function makeReactionsDeps(supabase: {
  from: (table: string) => any;
}): ReactionsDeps {
  return {
    async addReaction(messageId, emoji, userId) {
      const { data, error } = await supabase
        .from("message_reactions")
        .upsert(
          { message_id: messageId, emoji, user_id: userId },
          { onConflict: "message_id,emoji,user_id" }
        )
        .select()
        .single();

      if (error) {
        logger.error("Failed to add reaction", { messageId, emoji, error: error.message });
        return null;
      }
      return data;
    },

    async removeReaction(messageId, emoji, userId) {
      const { error, count } = await supabase
        .from("message_reactions")
        .delete()
        .eq("message_id", messageId)
        .eq("emoji", emoji)
        .eq("user_id", userId);

      if (error) {
        logger.error("Failed to remove reaction", { messageId, emoji, error: error.message });
        return false;
      }
      return true;
    },

    async getReactions(messageId) {
      const { data, error } = await supabase
        .from("message_reactions")
        .select("*")
        .eq("message_id", messageId)
        .order("created_at", { ascending: true });

      if (error) {
        logger.error("Failed to get reactions", { messageId, error: error.message });
        return [];
      }
      return data || [];
    },

    async getReactionSummary(messageId) {
      const reactions = await this.getReactions(messageId);
      return summarizeReactions(reactions);
    },

    async getReactionsForMessages(messageIds) {
      if (!messageIds.length) return new Map();

      const { data, error } = await supabase
        .from("message_reactions")
        .select("*")
        .in("message_id", messageIds)
        .order("created_at", { ascending: true });

      if (error) {
        logger.error("Failed to batch get reactions", { error: error.message });
        return new Map();
      }

      const byMessage = new Map<string, Reaction[]>();
      for (const r of (data || [])) {
        const list = byMessage.get(r.message_id) || [];
        list.push(r);
        byMessage.set(r.message_id, list);
      }

      const result = new Map<string, ReactionSummary[]>();
      for (const [msgId, reactions] of byMessage) {
        result.set(msgId, summarizeReactions(reactions));
      }
      return result;
    },
  };
}

// ============================================================
// CORE LOGIC
// ============================================================

/** Aggregate raw reactions into emoji → count + users summaries. */
export function summarizeReactions(reactions: Reaction[]): ReactionSummary[] {
  const map = new Map<string, Set<string>>();
  for (const r of reactions) {
    const users = map.get(r.emoji) || new Set();
    users.add(r.user_id);
    map.set(r.emoji, users);
  }

  return Array.from(map.entries()).map(([emoji, users]) => ({
    emoji,
    count: users.size,
    users: Array.from(users),
  }));
}

/** Quick reactions for the reaction picker. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "🤔", "👀"];

/**
 * Toggle a reaction — add if not present, remove if already reacted.
 * Returns the new summary for the message.
 */
export async function toggleReaction(
  deps: ReactionsDeps,
  messageId: string,
  emoji: string,
  userId: string
): Promise<{ action: "added" | "removed"; summary: ReactionSummary[] }> {
  // Check if user already reacted with this emoji
  const existing = await deps.getReactions(messageId);
  const hasReaction = existing.some(
    (r) => r.emoji === emoji && r.user_id === userId
  );

  if (hasReaction) {
    await deps.removeReaction(messageId, emoji, userId);
    const summary = await deps.getReactionSummary(messageId);
    return { action: "removed", summary };
  } else {
    await deps.addReaction(messageId, emoji, userId);
    const summary = await deps.getReactionSummary(messageId);
    return { action: "added", summary };
  }
}

// ============================================================
// MOCK HELPERS (for testing)
// ============================================================

export interface MockReactionsStore {
  reactions: Map<string, Reaction>;
}

function reactionKey(messageId: string, emoji: string, userId: string): string {
  return `${messageId}:${emoji}:${userId}`;
}

export function _makeMockReactionsStore(): MockReactionsStore {
  return { reactions: new Map() };
}

export function _makeMockReactionsDeps(
  store?: MockReactionsStore
): { deps: ReactionsDeps; store: MockReactionsStore } {
  const s = store || _makeMockReactionsStore();

  const deps: ReactionsDeps = {
    async addReaction(messageId, emoji, userId) {
      const key = reactionKey(messageId, emoji, userId);
      const reaction: Reaction = {
        id: crypto.randomUUID(),
        message_id: messageId,
        emoji,
        user_id: userId,
        created_at: new Date().toISOString(),
      };
      s.reactions.set(key, reaction);
      return reaction;
    },

    async removeReaction(messageId, emoji, userId) {
      const key = reactionKey(messageId, emoji, userId);
      return s.reactions.delete(key);
    },

    async getReactions(messageId) {
      const results: Reaction[] = [];
      for (const [, r] of s.reactions) {
        if (r.message_id === messageId) results.push(r);
      }
      return results.sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
    },

    async getReactionSummary(messageId) {
      const reactions = await this.getReactions(messageId);
      return summarizeReactions(reactions);
    },

    async getReactionsForMessages(messageIds) {
      const result = new Map<string, ReactionSummary[]>();
      for (const msgId of messageIds) {
        const summary = await this.getReactionSummary(msgId);
        if (summary.length > 0) result.set(msgId, summary);
      }
      return result;
    },
  };

  return { deps, store: s };
}
