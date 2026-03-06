/**
 * ELLIE-508 — Discord message normalizer tests
 *
 * normalizeMessage() filters bot messages, strips mentions, resolves kind,
 * and extracts attachment URLs. setBotId() controls mention detection.
 *
 * discord.js is mocked to avoid native module deps.
 * Message objects are plain objects matching the shape accessed by normalizeMessage.
 */

import { describe, test, expect, mock, beforeAll } from "bun:test";

// ── Mocks ─────────────────────────────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock() }) },
}));

// ChannelType numeric values matching discord.js
const CT = {
  DM: 1,
  GuildText: 0,
  PublicThread: 11,
  PrivateThread: 12,
  AnnouncementThread: 10,
};

mock.module("discord.js", () => ({ ChannelType: CT }));

// ── Imports ───────────────────────────────────────────────────────────────────

import { normalizeMessage, setBotId } from "../src/channels/discord/normalize.ts";

// ── Fixture helpers ───────────────────────────────────────────────────────────

const BOT_ID = "999999999999";

beforeAll(() => {
  setBotId(BOT_ID);
});

/** Build a mock guild channel Message with sensible defaults. */
function makeMsg(overrides: Record<string, any> = {}): any {
  const base: any = {
    id: "msg-001",
    content: "Hello world",
    guildId: "guild-001",
    channelId: "channel-001",
    author: {
      bot: false,
      id: "user-001",
      displayName: "User Display",
      username: "username",
    },
    member: { displayName: "Guild Display Name" },
    channel: { type: CT.GuildText, parentId: null },
    mentions: { users: new Map([[BOT_ID, {}]]) },
    attachments: new Map(),
  };

  // Shallow-merge overrides, with deep merge for nested author/channel/mentions
  return {
    ...base,
    ...overrides,
    author: { ...base.author, ...(overrides.author ?? {}) },
    channel: { ...base.channel, ...(overrides.channel ?? {}) },
  };
}

// ── Ignored messages ──────────────────────────────────────────────────────────

describe("normalizeMessage — ignored", () => {
  test("bot author → null", () => {
    expect(normalizeMessage(makeMsg({ author: { bot: true, id: "bot-001", displayName: "Bot", username: "bot" } }))).toBeNull();
  });

  test("guild channel without bot mention → null", () => {
    expect(normalizeMessage(makeMsg({ mentions: { users: new Map() } }))).toBeNull();
  });

  test("content that strips to empty string with no attachments → null", () => {
    expect(normalizeMessage(makeMsg({
      content: `<@${BOT_ID}>`,
      // mentions present but text becomes empty after stripping
    }))).toBeNull();
  });
});

// ── Guild channel messages ─────────────────────────────────────────────────────

describe("normalizeMessage — channel (guild text)", () => {
  test("mentioned → kind: 'channel'", () => {
    const r = normalizeMessage(makeMsg({ content: `<@${BOT_ID}> please help` }));
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("channel");
  });

  test("mention stripped from text", () => {
    const r = normalizeMessage(makeMsg({ content: `<@${BOT_ID}> please help` }));
    expect(r!.text).toBe("please help");
  });

  test("bang-mention <@!id> also stripped", () => {
    const r = normalizeMessage(makeMsg({
      content: `<@!${BOT_ID}> hi there`,
      mentions: { users: new Map([[BOT_ID, {}]]) },
    }));
    expect(r!.text).toBe("hi there");
  });

  test("authorName from member.displayName", () => {
    const r = normalizeMessage(makeMsg({ content: `<@${BOT_ID}> hi` }));
    expect(r!.authorName).toBe("Guild Display Name");
  });

  test("authorName falls back to author.displayName when no member", () => {
    const r = normalizeMessage(makeMsg({ content: `<@${BOT_ID}> hi`, member: null }));
    expect(r!.authorName).toBe("User Display");
  });

  test("threadId and parentChannelId are null for channel messages", () => {
    const r = normalizeMessage(makeMsg({ content: `<@${BOT_ID}> hi` }));
    expect(r!.threadId).toBeNull();
    expect(r!.parentChannelId).toBeNull();
  });

  test("includes authorId, channelId, messageId", () => {
    const r = normalizeMessage(makeMsg({ content: `<@${BOT_ID}> hi` }));
    expect(r!.authorId).toBe("user-001");
    expect(r!.channelId).toBe("channel-001");
    expect(r!.messageId).toBe("msg-001");
  });
});

// ── Thread messages ────────────────────────────────────────────────────────────

describe("normalizeMessage — thread", () => {
  test("PublicThread → kind: 'thread' (no mention required)", () => {
    const r = normalizeMessage(makeMsg({
      content: "Thread reply",
      channel: { type: CT.PublicThread, parentId: "parent-001" },
      mentions: { users: new Map() },
    }));
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("thread");
  });

  test("PrivateThread → kind: 'thread'", () => {
    const r = normalizeMessage(makeMsg({
      content: "Private thread reply",
      channel: { type: CT.PrivateThread, parentId: "parent-001" },
      mentions: { users: new Map() },
    }));
    expect(r!.kind).toBe("thread");
  });

  test("threadId equals channelId for thread messages", () => {
    const r = normalizeMessage(makeMsg({
      content: "Thread reply",
      channelId: "thread-channel-001",
      channel: { type: CT.PublicThread, parentId: "parent-001" },
      mentions: { users: new Map() },
    }));
    expect(r!.threadId).toBe("thread-channel-001");
  });

  test("parentChannelId from channel.parentId", () => {
    const r = normalizeMessage(makeMsg({
      content: "Thread reply",
      channel: { type: CT.PublicThread, parentId: "parent-001" },
      mentions: { users: new Map() },
    }));
    expect(r!.parentChannelId).toBe("parent-001");
  });
});

// ── DMs ────────────────────────────────────────────────────────────────────────

describe("normalizeMessage — DM", () => {
  test("guildId null → kind: 'dm' (no mention required)", () => {
    const r = normalizeMessage(makeMsg({
      guildId: null,
      channel: { type: CT.DM, parentId: null },
      mentions: { users: new Map() },
    }));
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("dm");
  });

  test("DM result has guildId: null", () => {
    const r = normalizeMessage(makeMsg({
      guildId: null,
      channel: { type: CT.DM, parentId: null },
      mentions: { users: new Map() },
    }));
    expect(r!.guildId).toBeNull();
  });

  test("DM threadId and parentChannelId are null", () => {
    const r = normalizeMessage(makeMsg({
      guildId: null,
      channel: { type: CT.DM, parentId: null },
      mentions: { users: new Map() },
    }));
    expect(r!.threadId).toBeNull();
    expect(r!.parentChannelId).toBeNull();
  });
});

// ── Attachments ───────────────────────────────────────────────────────────────

describe("normalizeMessage — attachments", () => {
  test("single attachment URL captured", () => {
    const att = new Map([["att1", { url: "https://cdn.discordapp.com/img.png" }]]);
    const r = normalizeMessage(makeMsg({ content: `<@${BOT_ID}> see attached`, attachments: att }));
    expect(r!.attachmentUrl).toBe("https://cdn.discordapp.com/img.png");
    expect(r!.attachmentUrls).toEqual(["https://cdn.discordapp.com/img.png"]);
  });

  test("no attachment → attachmentUrl null, attachmentUrls []", () => {
    const r = normalizeMessage(makeMsg({ content: `<@${BOT_ID}> hi` }));
    expect(r!.attachmentUrl).toBeNull();
    expect(r!.attachmentUrls).toEqual([]);
  });

  test("empty text with attachment → not null (attachment-only message)", () => {
    const att = new Map([["att1", { url: "https://cdn.example.com/file.jpg" }]]);
    const r = normalizeMessage(makeMsg({ content: `<@${BOT_ID}>`, attachments: att }));
    expect(r).not.toBeNull();
  });
});
