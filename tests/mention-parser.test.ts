/**
 * Mention Parser Tests — ELLIE-849
 */

import { describe, it, expect } from "bun:test";
import {
  parseMentions,
  extractMentionedAgents,
  hasBroadcastMention,
  stripMentions,
  highlightMentions,
  getKnownAgents,
} from "../src/mention-parser.ts";

describe("parseMentions", () => {
  it("detects agent mentions by display name", () => {
    const mentions = parseMentions("Hey @james can you fix this?");
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe("agent");
    expect(mentions[0].id).toBe("dev");
    expect(mentions[0].raw).toBe("@james");
  });

  it("detects agent mentions by role name", () => {
    const mentions = parseMentions("@dev please review");
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe("agent");
    expect(mentions[0].id).toBe("dev");
  });

  it("detects multiple agent mentions", () => {
    const mentions = parseMentions("@james and @kate please look at this");
    expect(mentions).toHaveLength(2);
    expect(mentions[0].id).toBe("dev");
    expect(mentions[1].id).toBe("research");
  });

  it("detects @here mention", () => {
    const mentions = parseMentions("@here heads up about the deploy");
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe("here");
    expect(mentions[0].id).toBeNull();
  });

  it("detects @channel mention", () => {
    const mentions = parseMentions("@channel important update");
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe("channel");
  });

  it("detects @all as channel broadcast", () => {
    const mentions = parseMentions("@all please read");
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe("channel");
  });

  it("detects mixed mentions", () => {
    const mentions = parseMentions("@james fix this, @brian review it, @here FYI");
    expect(mentions).toHaveLength(3);
    expect(mentions[0].type).toBe("agent");
    expect(mentions[1].type).toBe("agent");
    expect(mentions[2].type).toBe("here");
  });

  it("is case insensitive", () => {
    const mentions = parseMentions("@James please help");
    expect(mentions).toHaveLength(1);
    expect(mentions[0].id).toBe("dev");
  });

  it("returns empty for no mentions", () => {
    expect(parseMentions("just a regular message")).toHaveLength(0);
  });

  it("tracks position index", () => {
    const mentions = parseMentions("Hey @kate look");
    expect(mentions[0].index).toBe(4);
  });

  it("handles unknown mentions as user type", () => {
    const mentions = parseMentions("@someuser check this");
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe("user");
    expect(mentions[0].id).toBe("someuser");
  });

  it("detects all 7 agents by display name", () => {
    const text = "@ellie @james @kate @amy @brian @alan @jason";
    const mentions = parseMentions(text);
    expect(mentions).toHaveLength(7);
    const ids = mentions.map(m => m.id).sort();
    expect(ids).toEqual(["content", "critic", "dev", "general", "ops", "research", "strategy"]);
  });
});

describe("extractMentionedAgents", () => {
  it("returns unique agent role names", () => {
    const agents = extractMentionedAgents("@james and @kate please look, @james ping");
    expect(agents).toEqual(["dev", "research"]);
  });

  it("returns empty for no agent mentions", () => {
    expect(extractMentionedAgents("@here everyone")).toEqual([]);
  });
});

describe("hasBroadcastMention", () => {
  it("detects @here", () => {
    const result = hasBroadcastMention("@here update");
    expect(result.here).toBe(true);
    expect(result.channel).toBe(false);
  });

  it("detects @channel", () => {
    const result = hasBroadcastMention("@channel alert");
    expect(result.here).toBe(false);
    expect(result.channel).toBe(true);
  });

  it("detects both", () => {
    const result = hasBroadcastMention("@here and @channel");
    expect(result.here).toBe(true);
    expect(result.channel).toBe(true);
  });

  it("detects neither", () => {
    const result = hasBroadcastMention("@james just you");
    expect(result.here).toBe(false);
    expect(result.channel).toBe(false);
  });
});

describe("stripMentions", () => {
  it("replaces agent mentions with display names", () => {
    expect(stripMentions("Hey @james fix this")).toBe("Hey James fix this");
  });

  it("leaves unknown mentions as-is", () => {
    expect(stripMentions("@someuser check")).toBe("@someuser check");
  });
});

describe("highlightMentions", () => {
  it("wraps known mentions in span tags", () => {
    const html = highlightMentions("@james help");
    expect(html).toContain('<span class="mention">@james</span>');
  });

  it("wraps @here in span tags", () => {
    const html = highlightMentions("@here update");
    expect(html).toContain('<span class="mention">@here</span>');
  });

  it("leaves unknown mentions unwrapped", () => {
    const html = highlightMentions("@unknown user");
    expect(html).toBe("@unknown user");
  });
});

describe("getKnownAgents", () => {
  it("returns 7 agents with name, role, displayName", () => {
    const agents = getKnownAgents();
    expect(agents).toHaveLength(7);
    for (const a of agents) {
      expect(a.name).toBeDefined();
      expect(a.role).toBeDefined();
      expect(a.displayName).toBeDefined();
    }
  });

  it("includes all expected agents", () => {
    const names = getKnownAgents().map(a => a.name).sort();
    expect(names).toEqual(["alan", "amy", "brian", "ellie", "james", "jason", "kate"]);
  });
});
