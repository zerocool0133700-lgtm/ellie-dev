/**
 * Message Reactions Tests — ELLIE-637
 *
 * Tests emoji reaction logic: add, remove, toggle, summarize,
 * batch retrieval, and multi-user scenarios.
 * Uses injectable mock deps — no real Supabase calls.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  summarizeReactions,
  toggleReaction,
  QUICK_REACTIONS,
  _makeMockReactionsDeps,
  _makeMockReactionsStore,
  type MockReactionsStore,
  type ReactionsDeps,
  type Reaction,
} from "../src/api/reactions.ts";

// ── Helpers ─────────────────────────────────────────────────

let store: MockReactionsStore;
let deps: ReactionsDeps;

const MSG_1 = "msg-00000001-0000-0000-0000-000000000001";
const MSG_2 = "msg-00000002-0000-0000-0000-000000000002";
const MSG_3 = "msg-00000003-0000-0000-0000-000000000003";
const USER_DAVE = "system-dashboard";
const USER_WINCY = "user-wincy";

beforeEach(() => {
  const mock = _makeMockReactionsDeps();
  store = mock.store;
  deps = mock.deps;
});

// ── Add reaction ────────────────────────────────────────────

describe("add reaction", () => {
  test("adds a reaction to a message", async () => {
    const result = await deps.addReaction(MSG_1, "👍", USER_DAVE);

    expect(result).toBeDefined();
    expect(result!.message_id).toBe(MSG_1);
    expect(result!.emoji).toBe("👍");
    expect(result!.user_id).toBe(USER_DAVE);
    expect(result!.id).toBeTruthy();
    expect(result!.created_at).toBeTruthy();
  });

  test("same user can add different emoji to same message", async () => {
    await deps.addReaction(MSG_1, "👍", USER_DAVE);
    await deps.addReaction(MSG_1, "❤️", USER_DAVE);

    const reactions = await deps.getReactions(MSG_1);
    expect(reactions.length).toBe(2);
  });

  test("different users can add same emoji to same message", async () => {
    await deps.addReaction(MSG_1, "👍", USER_DAVE);
    await deps.addReaction(MSG_1, "👍", USER_WINCY);

    const reactions = await deps.getReactions(MSG_1);
    expect(reactions.length).toBe(2);
  });

  test("duplicate reaction by same user overwrites (upsert)", async () => {
    await deps.addReaction(MSG_1, "👍", USER_DAVE);
    await deps.addReaction(MSG_1, "👍", USER_DAVE);

    const reactions = await deps.getReactions(MSG_1);
    expect(reactions.length).toBe(1);
  });
});

// ── Remove reaction ─────────────────────────────────────────

describe("remove reaction", () => {
  test("removes an existing reaction", async () => {
    await deps.addReaction(MSG_1, "👍", USER_DAVE);
    const removed = await deps.removeReaction(MSG_1, "👍", USER_DAVE);

    expect(removed).toBe(true);
    const reactions = await deps.getReactions(MSG_1);
    expect(reactions.length).toBe(0);
  });

  test("removing non-existent reaction returns false", async () => {
    const removed = await deps.removeReaction(MSG_1, "👍", USER_DAVE);
    expect(removed).toBe(false);
  });

  test("removing one user's reaction doesn't affect another user's", async () => {
    await deps.addReaction(MSG_1, "👍", USER_DAVE);
    await deps.addReaction(MSG_1, "👍", USER_WINCY);

    await deps.removeReaction(MSG_1, "👍", USER_DAVE);

    const reactions = await deps.getReactions(MSG_1);
    expect(reactions.length).toBe(1);
    expect(reactions[0].user_id).toBe(USER_WINCY);
  });
});

// ── Get reactions ───────────────────────────────────────────

describe("get reactions", () => {
  test("returns empty array for message with no reactions", async () => {
    const reactions = await deps.getReactions(MSG_1);
    expect(reactions).toEqual([]);
  });

  test("returns all reactions for a message", async () => {
    await deps.addReaction(MSG_1, "👍", USER_DAVE);
    await deps.addReaction(MSG_1, "❤️", USER_WINCY);
    await deps.addReaction(MSG_1, "🎉", USER_DAVE);

    const reactions = await deps.getReactions(MSG_1);
    expect(reactions.length).toBe(3);
  });

  test("does not include reactions from other messages", async () => {
    await deps.addReaction(MSG_1, "👍", USER_DAVE);
    await deps.addReaction(MSG_2, "❤️", USER_DAVE);

    const reactions = await deps.getReactions(MSG_1);
    expect(reactions.length).toBe(1);
    expect(reactions[0].emoji).toBe("👍");
  });
});

// ── Summarize reactions ─────────────────────────────────────

describe("summarizeReactions", () => {
  test("empty reactions returns empty summary", () => {
    expect(summarizeReactions([])).toEqual([]);
  });

  test("single reaction returns count 1", () => {
    const reactions: Reaction[] = [{
      id: "r1", message_id: MSG_1, emoji: "👍",
      user_id: USER_DAVE, created_at: new Date().toISOString(),
    }];
    const summary = summarizeReactions(reactions);
    expect(summary).toEqual([{ emoji: "👍", count: 1, users: [USER_DAVE] }]);
  });

  test("multiple users with same emoji grouped correctly", () => {
    const reactions: Reaction[] = [
      { id: "r1", message_id: MSG_1, emoji: "👍", user_id: USER_DAVE, created_at: new Date().toISOString() },
      { id: "r2", message_id: MSG_1, emoji: "👍", user_id: USER_WINCY, created_at: new Date().toISOString() },
    ];
    const summary = summarizeReactions(reactions);
    expect(summary.length).toBe(1);
    expect(summary[0].emoji).toBe("👍");
    expect(summary[0].count).toBe(2);
    expect(summary[0].users).toContain(USER_DAVE);
    expect(summary[0].users).toContain(USER_WINCY);
  });

  test("different emoji produce separate summary entries", () => {
    const reactions: Reaction[] = [
      { id: "r1", message_id: MSG_1, emoji: "👍", user_id: USER_DAVE, created_at: new Date().toISOString() },
      { id: "r2", message_id: MSG_1, emoji: "❤️", user_id: USER_DAVE, created_at: new Date().toISOString() },
      { id: "r3", message_id: MSG_1, emoji: "❤️", user_id: USER_WINCY, created_at: new Date().toISOString() },
    ];
    const summary = summarizeReactions(reactions);
    expect(summary.length).toBe(2);
    const thumbs = summary.find(s => s.emoji === "👍");
    const hearts = summary.find(s => s.emoji === "❤️");
    expect(thumbs!.count).toBe(1);
    expect(hearts!.count).toBe(2);
  });

  test("same user same emoji is deduplicated", () => {
    const reactions: Reaction[] = [
      { id: "r1", message_id: MSG_1, emoji: "👍", user_id: USER_DAVE, created_at: new Date().toISOString() },
      { id: "r2", message_id: MSG_1, emoji: "👍", user_id: USER_DAVE, created_at: new Date().toISOString() },
    ];
    const summary = summarizeReactions(reactions);
    expect(summary[0].count).toBe(1);
  });
});

// ── Reaction summary via deps ───────────────────────────────

describe("getReactionSummary", () => {
  test("returns grouped summary for a message", async () => {
    await deps.addReaction(MSG_1, "👍", USER_DAVE);
    await deps.addReaction(MSG_1, "👍", USER_WINCY);
    await deps.addReaction(MSG_1, "🎉", USER_DAVE);

    const summary = await deps.getReactionSummary(MSG_1);
    expect(summary.length).toBe(2);

    const thumbs = summary.find(s => s.emoji === "👍");
    expect(thumbs!.count).toBe(2);

    const party = summary.find(s => s.emoji === "🎉");
    expect(party!.count).toBe(1);
  });
});

// ── Toggle reaction ─────────────────────────────────────────

describe("toggleReaction", () => {
  test("adds reaction when not present", async () => {
    const result = await toggleReaction(deps, MSG_1, "👍", USER_DAVE);

    expect(result.action).toBe("added");
    expect(result.summary.length).toBe(1);
    expect(result.summary[0].emoji).toBe("👍");
    expect(result.summary[0].count).toBe(1);
  });

  test("removes reaction when already present", async () => {
    await deps.addReaction(MSG_1, "👍", USER_DAVE);
    const result = await toggleReaction(deps, MSG_1, "👍", USER_DAVE);

    expect(result.action).toBe("removed");
    expect(result.summary.length).toBe(0);
  });

  test("toggle add-remove-add cycle works", async () => {
    const r1 = await toggleReaction(deps, MSG_1, "❤️", USER_DAVE);
    expect(r1.action).toBe("added");

    const r2 = await toggleReaction(deps, MSG_1, "❤️", USER_DAVE);
    expect(r2.action).toBe("removed");

    const r3 = await toggleReaction(deps, MSG_1, "❤️", USER_DAVE);
    expect(r3.action).toBe("added");
    expect(r3.summary[0].count).toBe(1);
  });

  test("toggling one user's reaction doesn't affect another user's", async () => {
    await deps.addReaction(MSG_1, "👍", USER_DAVE);
    await deps.addReaction(MSG_1, "👍", USER_WINCY);

    const result = await toggleReaction(deps, MSG_1, "👍", USER_DAVE);
    expect(result.action).toBe("removed");
    expect(result.summary.length).toBe(1);
    expect(result.summary[0].count).toBe(1);
    expect(result.summary[0].users).toEqual([USER_WINCY]);
  });
});

// ── Batch retrieval ─────────────────────────────────────────

describe("getReactionsForMessages", () => {
  test("returns empty map for empty input", async () => {
    const result = await deps.getReactionsForMessages([]);
    expect(result.size).toBe(0);
  });

  test("returns reactions grouped by message", async () => {
    await deps.addReaction(MSG_1, "👍", USER_DAVE);
    await deps.addReaction(MSG_1, "❤️", USER_WINCY);
    await deps.addReaction(MSG_2, "🎉", USER_DAVE);

    const result = await deps.getReactionsForMessages([MSG_1, MSG_2, MSG_3]);

    expect(result.has(MSG_1)).toBe(true);
    expect(result.has(MSG_2)).toBe(true);
    expect(result.has(MSG_3)).toBe(false);

    expect(result.get(MSG_1)!.length).toBe(2);
    expect(result.get(MSG_2)!.length).toBe(1);
  });

  test("messages with no reactions are not included", async () => {
    const result = await deps.getReactionsForMessages([MSG_1, MSG_2]);
    expect(result.size).toBe(0);
  });
});

// ── Multi-message isolation ─────────────────────────────────

describe("multi-message isolation", () => {
  test("reactions on different messages are independent", async () => {
    await deps.addReaction(MSG_1, "👍", USER_DAVE);
    await deps.addReaction(MSG_2, "👍", USER_DAVE);
    await deps.addReaction(MSG_3, "❤️", USER_WINCY);

    // Remove from MSG_1 only
    await deps.removeReaction(MSG_1, "👍", USER_DAVE);

    expect((await deps.getReactions(MSG_1)).length).toBe(0);
    expect((await deps.getReactions(MSG_2)).length).toBe(1);
    expect((await deps.getReactions(MSG_3)).length).toBe(1);
  });
});

// ── Quick reactions constant ────────────────────────────────

describe("quick reactions", () => {
  test("QUICK_REACTIONS has 6 emoji", () => {
    expect(QUICK_REACTIONS.length).toBe(6);
  });

  test("includes common emoji", () => {
    expect(QUICK_REACTIONS).toContain("👍");
    expect(QUICK_REACTIONS).toContain("❤️");
    expect(QUICK_REACTIONS).toContain("😂");
    expect(QUICK_REACTIONS).toContain("🎉");
  });

  test("all entries are single emoji strings", () => {
    for (const emoji of QUICK_REACTIONS) {
      expect(typeof emoji).toBe("string");
      expect(emoji.length).toBeGreaterThan(0);
      expect(emoji.length).toBeLessThanOrEqual(4); // emoji can be up to 4 bytes
    }
  });
});

// ── Edge cases ──────────────────────────────────────────────

describe("edge cases", () => {
  test("unicode emoji with skin tones work", async () => {
    await deps.addReaction(MSG_1, "👍🏽", USER_DAVE);
    const reactions = await deps.getReactions(MSG_1);
    expect(reactions.length).toBe(1);
    expect(reactions[0].emoji).toBe("👍🏽");
  });

  test("flag emoji work", async () => {
    await deps.addReaction(MSG_1, "🇺🇸", USER_DAVE);
    const summary = await deps.getReactionSummary(MSG_1);
    expect(summary[0].emoji).toBe("🇺🇸");
  });

  test("compound emoji work", async () => {
    await deps.addReaction(MSG_1, "👨‍💻", USER_DAVE);
    const reactions = await deps.getReactions(MSG_1);
    expect(reactions[0].emoji).toBe("👨‍💻");
  });

  test("many reactions on a single message", async () => {
    const emojis = ["👍", "❤️", "😂", "🎉", "🤔", "👀", "🔥", "💯", "👏", "🙌"];
    for (const emoji of emojis) {
      await deps.addReaction(MSG_1, emoji, USER_DAVE);
    }

    const reactions = await deps.getReactions(MSG_1);
    expect(reactions.length).toBe(10);

    const summary = await deps.getReactionSummary(MSG_1);
    expect(summary.length).toBe(10);
  });

  test("many users reacting with same emoji", async () => {
    for (let i = 0; i < 20; i++) {
      await deps.addReaction(MSG_1, "👍", `user-${i}`);
    }

    const summary = await deps.getReactionSummary(MSG_1);
    expect(summary.length).toBe(1);
    expect(summary[0].count).toBe(20);
    expect(summary[0].users.length).toBe(20);
  });
});
