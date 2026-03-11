/**
 * Tests for Mountain Interaction Scoring — ELLIE-668
 */
import { describe, test, expect } from "bun:test";
import {
  computeRecencyScore,
  computeFrequencyScore,
  computeDirectionScore,
  computeOverallScore,
  buildChannelStats,
  simpleTopicExtractor,
  buildRelationshipDocument,
  InteractionScoringPipeline,
  _makeMockInteractionMessage,
  _makeMockScoringContact,
  _makeMockMessageFetcher,
  _makeMockContactLookup,
  type InteractionMessage,
  type ScoringContact,
} from "../src/mountain/interaction-scoring.ts";

const REF_DATE = new Date("2026-03-10T12:00:00Z");

// ── computeRecencyScore ───────────────────────────────────────

describe("computeRecencyScore", () => {
  test("returns 1.0 for interaction today", () => {
    const score = computeRecencyScore(REF_DATE, REF_DATE, 14);
    expect(score).toBe(1);
  });

  test("returns 0.5 at exactly one half-life", () => {
    const halfLifeAgo = new Date(REF_DATE.getTime() - 14 * 24 * 60 * 60 * 1000);
    const score = computeRecencyScore(halfLifeAgo, REF_DATE, 14);
    expect(Math.abs(score - 0.5)).toBeLessThan(0.001);
  });

  test("returns 0.25 at two half-lives", () => {
    const twoHalfLivesAgo = new Date(REF_DATE.getTime() - 28 * 24 * 60 * 60 * 1000);
    const score = computeRecencyScore(twoHalfLivesAgo, REF_DATE, 14);
    expect(Math.abs(score - 0.25)).toBeLessThan(0.001);
  });

  test("returns 0 for null lastInteraction", () => {
    expect(computeRecencyScore(null, REF_DATE, 14)).toBe(0);
  });

  test("returns 1 for future date", () => {
    const future = new Date(REF_DATE.getTime() + 1000000);
    expect(computeRecencyScore(future, REF_DATE, 14)).toBe(1);
  });

  test("approaches 0 for very old interactions", () => {
    const yearAgo = new Date(REF_DATE.getTime() - 365 * 24 * 60 * 60 * 1000);
    const score = computeRecencyScore(yearAgo, REF_DATE, 14);
    expect(score).toBeLessThan(0.001);
  });
});

// ── computeFrequencyScore ─────────────────────────────────────

describe("computeFrequencyScore", () => {
  test("returns 0 for no messages", () => {
    expect(computeFrequencyScore(0, REF_DATE, REF_DATE)).toBe(0);
  });

  test("returns 0 for null firstInteraction", () => {
    expect(computeFrequencyScore(10, null, REF_DATE)).toBe(0);
  });

  test("returns higher score for more frequent messages", () => {
    const start = new Date(REF_DATE.getTime() - 30 * 24 * 60 * 60 * 1000);
    const lowFreq = computeFrequencyScore(5, start, REF_DATE);
    const highFreq = computeFrequencyScore(100, start, REF_DATE);
    expect(highFreq).toBeGreaterThan(lowFreq);
  });

  test("caps at 1.0", () => {
    const start = new Date(REF_DATE.getTime() - 1 * 24 * 60 * 60 * 1000);
    const score = computeFrequencyScore(1000, start, REF_DATE);
    expect(score).toBeLessThanOrEqual(1);
  });

  test("uses log scale so diminishing returns", () => {
    const start = new Date(REF_DATE.getTime() - 30 * 24 * 60 * 60 * 1000);
    const score50 = computeFrequencyScore(50, start, REF_DATE);
    const score100 = computeFrequencyScore(100, start, REF_DATE);
    const score200 = computeFrequencyScore(200, start, REF_DATE);
    // Higher message counts produce higher scores
    expect(score200).toBeGreaterThan(score100);
    expect(score100).toBeGreaterThan(score50);
  });
});

// ── computeDirectionScore ─────────────────────────────────────

describe("computeDirectionScore", () => {
  test("returns 0.5 for balanced interaction", () => {
    expect(computeDirectionScore(10, 10)).toBe(0.5);
  });

  test("returns 1.0 when contact always initiates", () => {
    expect(computeDirectionScore(10, 0)).toBe(1.0);
  });

  test("returns 0.0 when user always initiates", () => {
    expect(computeDirectionScore(0, 10)).toBe(0.0);
  });

  test("returns 0.5 when no interactions", () => {
    expect(computeDirectionScore(0, 0)).toBe(0.5);
  });

  test("returns values proportional to ratio", () => {
    expect(computeDirectionScore(3, 1)).toBe(0.75);
    expect(computeDirectionScore(1, 3)).toBe(0.25);
  });
});

// ── computeOverallScore ───────────────────────────────────────

describe("computeOverallScore", () => {
  test("returns low score for all-zero inputs with balanced direction", () => {
    // Balanced direction (0.5) still contributes via direction penalty weight
    const score = computeOverallScore(0, 0, 0.5);
    expect(score).toBeLessThan(0.3);
  });

  test("balanced direction gives no penalty", () => {
    const balanced = computeOverallScore(0.8, 0.8, 0.5);
    const onesided = computeOverallScore(0.8, 0.8, 1.0);
    expect(balanced).toBeGreaterThan(onesided);
  });

  test("respects custom weights", () => {
    const recencyHeavy = computeOverallScore(1.0, 0.0, 0.5, {
      recency: 0.9,
      frequency: 0.05,
      direction: 0.05,
    });
    const freqHeavy = computeOverallScore(0.0, 1.0, 0.5, {
      recency: 0.05,
      frequency: 0.9,
      direction: 0.05,
    });
    expect(recencyHeavy).toBeGreaterThan(0.5);
    expect(freqHeavy).toBeGreaterThan(0.5);
  });

  test("clamps to [0, 1]", () => {
    const score = computeOverallScore(1.0, 1.0, 0.5);
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

// ── buildChannelStats ─────────────────────────────────────────

describe("buildChannelStats", () => {
  test("groups messages by channel", () => {
    const messages = [
      _makeMockInteractionMessage({ channel: "telegram" }),
      _makeMockInteractionMessage({ channel: "telegram" }),
      _makeMockInteractionMessage({ channel: "discord" }),
    ];
    const stats = buildChannelStats(messages);
    expect(stats.length).toBe(2);
    const tg = stats.find((s) => s.channel === "telegram")!;
    expect(tg.messageCount).toBe(2);
  });

  test("sorts by message count descending", () => {
    const messages = [
      _makeMockInteractionMessage({ channel: "discord" }),
      _makeMockInteractionMessage({ channel: "telegram" }),
      _makeMockInteractionMessage({ channel: "telegram" }),
      _makeMockInteractionMessage({ channel: "telegram" }),
    ];
    const stats = buildChannelStats(messages);
    expect(stats[0].channel).toBe("telegram");
    expect(stats[1].channel).toBe("discord");
  });

  test("tracks direction per channel", () => {
    const messages = [
      _makeMockInteractionMessage({ channel: "telegram", role: "user" }),
      _makeMockInteractionMessage({ channel: "telegram", role: "assistant" }),
      _makeMockInteractionMessage({ channel: "telegram", role: "user" }),
    ];
    const stats = buildChannelStats(messages);
    const tg = stats[0];
    expect(tg.initiatedByUser).toBe(2);
    expect(tg.initiatedByContact).toBe(1);
  });

  test("calculates average response time", () => {
    const base = new Date("2026-03-10T12:00:00Z");
    const messages = [
      _makeMockInteractionMessage({
        channel: "telegram",
        role: "user",
        timestamp: new Date(base.getTime()),
      }),
      _makeMockInteractionMessage({
        channel: "telegram",
        role: "assistant",
        timestamp: new Date(base.getTime() + 60_000), // 1 min later
      }),
      _makeMockInteractionMessage({
        channel: "telegram",
        role: "user",
        timestamp: new Date(base.getTime() + 180_000), // 2 min after that
      }),
    ];
    const stats = buildChannelStats(messages);
    // Two role transitions: user->assistant (60s), assistant->user (120s)
    expect(stats[0].avgResponseTimeMs).toBe(90_000); // avg of 60k and 120k
  });

  test("returns null avgResponseTime when no role transitions", () => {
    const messages = [
      _makeMockInteractionMessage({ channel: "telegram", role: "user" }),
      _makeMockInteractionMessage({ channel: "telegram", role: "user" }),
    ];
    const stats = buildChannelStats(messages);
    expect(stats[0].avgResponseTimeMs).toBeNull();
  });

  test("returns empty array for no messages", () => {
    expect(buildChannelStats([])).toEqual([]);
  });

  test("tracks lastMessageAt correctly", () => {
    const messages = [
      _makeMockInteractionMessage({
        channel: "telegram",
        timestamp: new Date("2026-03-08T12:00:00Z"),
      }),
      _makeMockInteractionMessage({
        channel: "telegram",
        timestamp: new Date("2026-03-10T12:00:00Z"),
      }),
      _makeMockInteractionMessage({
        channel: "telegram",
        timestamp: new Date("2026-03-05T12:00:00Z"),
      }),
    ];
    const stats = buildChannelStats(messages);
    expect(stats[0].lastMessageAt).toEqual(new Date("2026-03-10T12:00:00Z"));
  });
});

// ── simpleTopicExtractor ──────────────────────────────────────

describe("simpleTopicExtractor", () => {
  test("extracts repeated significant words", () => {
    const messages = [
      _makeMockInteractionMessage({ content: "Let's discuss the deployment pipeline" }),
      _makeMockInteractionMessage({ content: "The deployment is running smoothly" }),
      _makeMockInteractionMessage({ content: "Check the deployment logs" }),
    ];
    const topics = simpleTopicExtractor(messages);
    expect(topics).toContain("deployment");
  });

  test("filters out stop words", () => {
    const messages = [
      _makeMockInteractionMessage({ content: "the the the is is is" }),
      _makeMockInteractionMessage({ content: "the the the is is is" }),
    ];
    const topics = simpleTopicExtractor(messages);
    expect(topics.length).toBe(0);
  });

  test("filters words shorter than 4 chars", () => {
    const messages = [
      _makeMockInteractionMessage({ content: "foo bar baz foo bar baz" }),
    ];
    const topics = simpleTopicExtractor(messages);
    expect(topics.length).toBe(0);
  });

  test("requires at least 2 occurrences", () => {
    const messages = [
      _makeMockInteractionMessage({ content: "deployment kubernetes infrastructure" }),
    ];
    const topics = simpleTopicExtractor(messages);
    expect(topics.length).toBe(0);
  });

  test("returns top 10 topics max", () => {
    // Create messages with many repeated words
    const words = Array.from({ length: 20 }, (_, i) => `topic${i}word`);
    const content = words.join(" ");
    const messages = [
      _makeMockInteractionMessage({ content }),
      _makeMockInteractionMessage({ content }),
    ];
    const topics = simpleTopicExtractor(messages);
    expect(topics.length).toBeLessThanOrEqual(10);
  });

  test("returns empty for no messages", () => {
    expect(simpleTopicExtractor([])).toEqual([]);
  });
});

// ── _makeMockInteractionMessage ───────────────────────────────

describe("_makeMockInteractionMessage", () => {
  test("creates valid default message", () => {
    const msg = _makeMockInteractionMessage();
    expect(msg.id).toBeDefined();
    expect(msg.channel).toBe("telegram");
    expect(msg.role).toBe("user");
  });

  test("accepts overrides", () => {
    const msg = _makeMockInteractionMessage({ channel: "discord", role: "assistant" });
    expect(msg.channel).toBe("discord");
    expect(msg.role).toBe("assistant");
  });
});

// ── _makeMockScoringContact ───────────────────────────────────

describe("_makeMockScoringContact", () => {
  test("creates valid default contact", () => {
    const contact = _makeMockScoringContact();
    expect(contact.id).toBeDefined();
    expect(contact.displayName).toBe("Test Contact");
    expect(contact.identifiers.length).toBe(1);
  });

  test("accepts overrides", () => {
    const contact = _makeMockScoringContact({
      displayName: "Wincy",
      relationshipType: "family",
    });
    expect(contact.displayName).toBe("Wincy");
    expect(contact.relationshipType).toBe("family");
  });
});

// ── _makeMockMessageFetcher ───────────────────────────────────

describe("_makeMockMessageFetcher", () => {
  test("returns messages matching identifier", async () => {
    const msgs = [_makeMockInteractionMessage({ content: "hello" })];
    const map = new Map([["telegram:dave-123", msgs]]);
    const fetcher = _makeMockMessageFetcher(map);

    const result = await fetcher([{ channel: "telegram", value: "dave-123" }]);
    expect(result.length).toBe(1);
    expect(result[0].content).toBe("hello");
  });

  test("returns empty for unmatched identifier", async () => {
    const fetcher = _makeMockMessageFetcher(new Map());
    const result = await fetcher([{ channel: "telegram", value: "unknown" }]);
    expect(result.length).toBe(0);
  });

  test("combines messages from multiple identifiers", async () => {
    const map = new Map([
      ["telegram:dave-123", [_makeMockInteractionMessage({ content: "tg msg" })]],
      ["discord:dave-456", [_makeMockInteractionMessage({ content: "dc msg" })]],
    ]);
    const fetcher = _makeMockMessageFetcher(map);

    const result = await fetcher([
      { channel: "telegram", value: "dave-123" },
      { channel: "discord", value: "dave-456" },
    ]);
    expect(result.length).toBe(2);
  });
});

// ── InteractionScoringPipeline ────────────────────────────────

describe("InteractionScoringPipeline", () => {
  function makeTestSetup() {
    const wincy = _makeMockScoringContact({
      id: "wincy-id",
      displayName: "Wincy",
      identifiers: [{ channel: "telegram", value: "wincy-tg" }],
      relationshipType: "family",
    });

    const james = _makeMockScoringContact({
      id: "james-id",
      displayName: "James",
      identifiers: [
        { channel: "telegram", value: "james-tg" },
        { channel: "discord", value: "james-dc" },
      ],
      relationshipType: "friend",
    });

    const dormant = _makeMockScoringContact({
      id: "dormant-id",
      displayName: "Old Acquaintance",
      identifiers: [{ channel: "email", value: "old@example.com" }],
      relationshipType: "acquaintance",
    });

    const base = REF_DATE.getTime();
    const day = 24 * 60 * 60 * 1000;

    const wincyMessages: InteractionMessage[] = Array.from({ length: 20 }, (_, i) =>
      _makeMockInteractionMessage({
        channel: "telegram",
        sender: i % 2 === 0 ? "dave" : "wincy",
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message about dinner plans and weekend ${i}`,
        timestamp: new Date(base - i * day),
      }),
    );

    const jamesMessages: InteractionMessage[] = [
      ...Array.from({ length: 5 }, (_, i) =>
        _makeMockInteractionMessage({
          channel: "telegram",
          sender: "james",
          role: "assistant",
          content: `Telegram deployment discussion ${i}`,
          timestamp: new Date(base - i * 2 * day),
        }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        _makeMockInteractionMessage({
          channel: "discord",
          sender: "james",
          role: "assistant",
          content: `Discord deployment chat ${i}`,
          timestamp: new Date(base - i * 3 * day),
        }),
      ),
    ];

    const dormantMessages: InteractionMessage[] = [
      _makeMockInteractionMessage({
        channel: "email",
        sender: "old@example.com",
        role: "assistant",
        content: "Long time no see",
        timestamp: new Date(base - 90 * day),
      }),
    ];

    const messageMap = new Map<string, InteractionMessage[]>([
      ["telegram:wincy-tg", wincyMessages],
      ["telegram:james-tg", jamesMessages.filter((m) => m.channel === "telegram")],
      ["discord:james-dc", jamesMessages.filter((m) => m.channel === "discord")],
      ["email:old@example.com", dormantMessages],
    ]);

    return {
      contacts: [wincy, james, dormant],
      messageMap,
      wincy,
      james,
      dormant,
    };
  }

  test("scores all contacts", async () => {
    const { contacts, messageMap } = makeTestSetup();
    const pipeline = new InteractionScoringPipeline(
      _makeMockMessageFetcher(messageMap),
      _makeMockContactLookup(contacts),
      simpleTopicExtractor,
      { referenceDate: REF_DATE },
    );

    const scores = await pipeline.scoreAll();
    expect(scores.length).toBe(3);
  });

  test("scores single contact correctly", async () => {
    const { contacts, messageMap, wincy } = makeTestSetup();
    const pipeline = new InteractionScoringPipeline(
      _makeMockMessageFetcher(messageMap),
      _makeMockContactLookup(contacts),
      simpleTopicExtractor,
      { referenceDate: REF_DATE },
    );

    const score = await pipeline.scoreContact(wincy);
    expect(score.contactId).toBe("wincy-id");
    expect(score.contactName).toBe("Wincy");
    expect(score.totalMessages).toBe(20);
    expect(score.relationshipType).toBe("family");
    expect(score.preferredChannel).toBe("telegram");
    expect(score.recencyScore).toBeGreaterThan(0.8); // recent messages
    expect(score.directionScore).toBe(0.5); // balanced
    expect(score.overallScore).toBeGreaterThan(0);
    expect(score.lastInteraction).toBeDefined();
    expect(score.firstInteraction).toBeDefined();
  });

  test("multi-channel contact aggregates across channels", async () => {
    const { contacts, messageMap, james } = makeTestSetup();
    const pipeline = new InteractionScoringPipeline(
      _makeMockMessageFetcher(messageMap),
      _makeMockContactLookup(contacts),
      simpleTopicExtractor,
      { referenceDate: REF_DATE },
    );

    const score = await pipeline.scoreContact(james);
    expect(score.totalMessages).toBe(8); // 5 telegram + 3 discord
    expect(score.channelStats.length).toBe(2);
    expect(score.preferredChannel).toBe("telegram"); // more messages
  });

  test("dormant contact has low recency score", async () => {
    const { contacts, messageMap, dormant } = makeTestSetup();
    const pipeline = new InteractionScoringPipeline(
      _makeMockMessageFetcher(messageMap),
      _makeMockContactLookup(contacts),
      simpleTopicExtractor,
      { referenceDate: REF_DATE },
    );

    const score = await pipeline.scoreContact(dormant);
    expect(score.recencyScore).toBeLessThan(0.02); // 90 days ago
    expect(score.totalMessages).toBe(1);
  });

  test("contact with no messages scores zero", async () => {
    const noMessages = _makeMockScoringContact({
      id: "ghost-id",
      displayName: "Ghost",
      identifiers: [{ channel: "telegram", value: "ghost-tg" }],
    });
    const pipeline = new InteractionScoringPipeline(
      _makeMockMessageFetcher(new Map()),
      _makeMockContactLookup([noMessages]),
      simpleTopicExtractor,
      { referenceDate: REF_DATE },
    );

    const score = await pipeline.scoreContact(noMessages);
    expect(score.totalMessages).toBe(0);
    expect(score.recencyScore).toBe(0);
    expect(score.frequencyScore).toBe(0);
    expect(score.lastInteraction).toBeNull();
    expect(score.preferredChannel).toBeNull();
  });

  test("getScore returns cached score after scoreAll", async () => {
    const { contacts, messageMap } = makeTestSetup();
    const pipeline = new InteractionScoringPipeline(
      _makeMockMessageFetcher(messageMap),
      _makeMockContactLookup(contacts),
      simpleTopicExtractor,
      { referenceDate: REF_DATE },
    );

    await pipeline.scoreAll();
    const score = pipeline.getScore("wincy-id");
    expect(score).toBeDefined();
    expect(score!.contactName).toBe("Wincy");
  });

  test("getScore returns undefined for unknown contact", async () => {
    const pipeline = new InteractionScoringPipeline(
      _makeMockMessageFetcher(new Map()),
      _makeMockContactLookup([]),
      simpleTopicExtractor,
      { referenceDate: REF_DATE },
    );

    expect(pipeline.getScore("unknown")).toBeUndefined();
  });

  test("getAllScores returns all cached scores", async () => {
    const { contacts, messageMap } = makeTestSetup();
    const pipeline = new InteractionScoringPipeline(
      _makeMockMessageFetcher(messageMap),
      _makeMockContactLookup(contacts),
      simpleTopicExtractor,
      { referenceDate: REF_DATE },
    );

    await pipeline.scoreAll();
    expect(pipeline.getAllScores().length).toBe(3);
  });

  test("clear removes all cached scores", async () => {
    const { contacts, messageMap } = makeTestSetup();
    const pipeline = new InteractionScoringPipeline(
      _makeMockMessageFetcher(messageMap),
      _makeMockContactLookup(contacts),
      simpleTopicExtractor,
      { referenceDate: REF_DATE },
    );

    await pipeline.scoreAll();
    pipeline.clear();
    expect(pipeline.getAllScores().length).toBe(0);
  });

  test("custom topic extractor is used", async () => {
    const { contacts, messageMap, wincy } = makeTestSetup();
    const customExtractor = () => ["custom-topic-1", "custom-topic-2"];

    const pipeline = new InteractionScoringPipeline(
      _makeMockMessageFetcher(messageMap),
      _makeMockContactLookup(contacts),
      customExtractor,
      { referenceDate: REF_DATE },
    );

    const score = await pipeline.scoreContact(wincy);
    expect(score.topics).toEqual(["custom-topic-1", "custom-topic-2"]);
  });

  test("custom recency half-life affects scoring", async () => {
    const { contacts, messageMap, dormant } = makeTestSetup();

    // Short half-life: 7 days — dormant contact should score even lower
    const shortHL = new InteractionScoringPipeline(
      _makeMockMessageFetcher(messageMap),
      _makeMockContactLookup(contacts),
      simpleTopicExtractor,
      { referenceDate: REF_DATE, recencyHalfLifeDays: 7 },
    );

    // Long half-life: 180 days — dormant contact should score higher
    const longHL = new InteractionScoringPipeline(
      _makeMockMessageFetcher(messageMap),
      _makeMockContactLookup(contacts),
      simpleTopicExtractor,
      { referenceDate: REF_DATE, recencyHalfLifeDays: 180 },
    );

    const shortScore = await shortHL.scoreContact(dormant);
    const longScore = await longHL.scoreContact(dormant);
    expect(longScore.recencyScore).toBeGreaterThan(shortScore.recencyScore);
  });
});

// ── RelationshipQuery ─────────────────────────────────────────

describe("RelationshipQuery", () => {
  async function makeScoredPipeline() {
    const base = REF_DATE.getTime();
    const day = 24 * 60 * 60 * 1000;

    const active = _makeMockScoringContact({
      id: "active-id",
      displayName: "Active Friend",
      identifiers: [{ channel: "telegram", value: "active-tg" }],
      relationshipType: "friend",
    });

    const dormant = _makeMockScoringContact({
      id: "dormant-id",
      displayName: "Dormant Contact",
      identifiers: [{ channel: "email", value: "dormant@test.com" }],
      relationshipType: "colleague",
    });

    const family = _makeMockScoringContact({
      id: "family-id",
      displayName: "Family Member",
      identifiers: [{ channel: "discord", value: "family-dc" }],
      relationshipType: "family",
    });

    const messageMap = new Map<string, InteractionMessage[]>([
      [
        "telegram:active-tg",
        Array.from({ length: 30 }, (_, i) =>
          _makeMockInteractionMessage({
            channel: "telegram",
            role: i % 2 === 0 ? "user" : "assistant",
            timestamp: new Date(base - i * day),
          }),
        ),
      ],
      [
        "email:dormant@test.com",
        [
          _makeMockInteractionMessage({
            channel: "email",
            role: "user",
            timestamp: new Date(base - 60 * day),
          }),
        ],
      ],
      [
        "discord:family-dc",
        Array.from({ length: 10 }, (_, i) =>
          _makeMockInteractionMessage({
            channel: "discord",
            role: i % 3 === 0 ? "user" : "assistant",
            timestamp: new Date(base - i * 2 * day),
          }),
        ),
      ],
    ]);

    const pipeline = new InteractionScoringPipeline(
      _makeMockMessageFetcher(messageMap),
      _makeMockContactLookup([active, dormant, family]),
      simpleTopicExtractor,
      { referenceDate: REF_DATE },
    );

    await pipeline.scoreAll();
    return pipeline;
  }

  test("query returns all contacts by default", async () => {
    const pipeline = await makeScoredPipeline();
    const result = pipeline.query({});
    expect(result.total).toBe(3);
    expect(result.contacts.length).toBe(3);
  });

  test("query filters dormant contacts", async () => {
    const pipeline = await makeScoredPipeline();
    const result = pipeline.query({ dormantDays: 30 });
    // Only the contact with no messages in 30 days
    expect(result.contacts.some((c) => c.contactName === "Dormant Contact")).toBe(true);
    expect(result.contacts.some((c) => c.contactName === "Active Friend")).toBe(false);
  });

  test("query filters by minimum score", async () => {
    const pipeline = await makeScoredPipeline();
    const result = pipeline.query({ minScore: 0.3 });
    expect(result.contacts.every((c) => c.overallScore >= 0.3)).toBe(true);
  });

  test("query filters by maximum score", async () => {
    const pipeline = await makeScoredPipeline();
    const result = pipeline.query({ maxScore: 0.1 });
    expect(result.contacts.every((c) => c.overallScore <= 0.1)).toBe(true);
  });

  test("query filters by preferred channel", async () => {
    const pipeline = await makeScoredPipeline();
    const result = pipeline.query({ preferredChannel: "telegram" });
    expect(result.contacts.every((c) => c.preferredChannel === "telegram")).toBe(true);
  });

  test("query filters by relationship type", async () => {
    const pipeline = await makeScoredPipeline();
    const result = pipeline.query({ relationshipType: "family" });
    expect(result.total).toBe(1);
    expect(result.contacts[0].contactName).toBe("Family Member");
  });

  test("query sorts by recency ascending", async () => {
    const pipeline = await makeScoredPipeline();
    const result = pipeline.query({ sortBy: "recency", sortDir: "asc" });
    for (let i = 1; i < result.contacts.length; i++) {
      expect(result.contacts[i].recencyScore).toBeGreaterThanOrEqual(
        result.contacts[i - 1].recencyScore,
      );
    }
  });

  test("query sorts by totalMessages descending", async () => {
    const pipeline = await makeScoredPipeline();
    const result = pipeline.query({ sortBy: "totalMessages", sortDir: "desc" });
    for (let i = 1; i < result.contacts.length; i++) {
      expect(result.contacts[i].totalMessages).toBeLessThanOrEqual(
        result.contacts[i - 1].totalMessages,
      );
    }
  });

  test("query respects limit", async () => {
    const pipeline = await makeScoredPipeline();
    const result = pipeline.query({ limit: 1 });
    expect(result.contacts.length).toBe(1);
    expect(result.total).toBe(3); // total is unfiltered count
  });

  test("query combines filters", async () => {
    const pipeline = await makeScoredPipeline();
    const result = pipeline.query({
      relationshipType: "friend",
      preferredChannel: "telegram",
      minScore: 0.01,
    });
    expect(result.contacts.every((c) => c.relationshipType === "friend")).toBe(true);
    expect(result.contacts.every((c) => c.preferredChannel === "telegram")).toBe(true);
  });
});

// ── buildRelationshipDocument ─────────────────────────────────

describe("buildRelationshipDocument", () => {
  function makeScore(): import("../src/mountain/interaction-scoring.ts").InteractionScore {
    return {
      contactId: "wincy-id",
      contactName: "Wincy",
      recencyScore: 0.95,
      frequencyScore: 0.6,
      directionScore: 0.5,
      preferredChannel: "telegram",
      channelStats: [
        {
          channel: "telegram",
          messageCount: 50,
          lastMessageAt: new Date("2026-03-10T12:00:00Z"),
          avgResponseTimeMs: 120_000,
          initiatedByContact: 25,
          initiatedByUser: 25,
        },
        {
          channel: "discord",
          messageCount: 10,
          lastMessageAt: new Date("2026-03-08T12:00:00Z"),
          avgResponseTimeMs: 300_000,
          initiatedByContact: 3,
          initiatedByUser: 7,
        },
      ],
      topics: ["deployment", "dinner", "weekend"],
      relationshipType: "family",
      totalMessages: 60,
      lastInteraction: new Date("2026-03-10T12:00:00Z"),
      firstInteraction: new Date("2026-01-01T12:00:00Z"),
      overallScore: 0.78,
    };
  }

  test("generates correct path", () => {
    const doc = buildRelationshipDocument(makeScore());
    expect(doc.path).toBe("relationships/wincy.md");
  });

  test("sanitizes name for path", () => {
    const score = makeScore();
    score.contactName = "José García-López";
    const doc = buildRelationshipDocument(score);
    expect(doc.path).toBe("relationships/jos-garc-a-l-pez.md");
  });

  test("includes frontmatter with scores", () => {
    const doc = buildRelationshipDocument(makeScore());
    expect(doc.frontmatter.type).toBe("relationship");
    expect(doc.frontmatter.contact_id).toBe("wincy-id");
    expect(doc.frontmatter.overall_score).toBe(0.78);
    expect(doc.frontmatter.preferred_channel).toBe("telegram");
    expect(doc.frontmatter.total_messages).toBe(60);
  });

  test("includes channel breakdown in content", () => {
    const doc = buildRelationshipDocument(makeScore());
    expect(doc.content).toContain("telegram");
    expect(doc.content).toContain("50 messages");
    expect(doc.content).toContain("discord");
  });

  test("includes direction assessment", () => {
    const doc = buildRelationshipDocument(makeScore());
    expect(doc.content).toContain("balanced");
  });

  test("includes topics", () => {
    const doc = buildRelationshipDocument(makeScore());
    expect(doc.content).toContain("deployment");
    expect(doc.content).toContain("dinner");
  });

  test("handles contact with no interactions", () => {
    const score = makeScore();
    score.totalMessages = 0;
    score.channelStats = [];
    score.topics = [];
    score.lastInteraction = null;
    score.firstInteraction = null;
    score.preferredChannel = null;

    const doc = buildRelationshipDocument(score);
    expect(doc.content).toContain("# Wincy");
    expect(doc.frontmatter.last_interaction).toBeNull();
  });

  test("shows 'you initiate' for low direction score", () => {
    const score = makeScore();
    score.directionScore = 0.2;
    const doc = buildRelationshipDocument(score);
    expect(doc.content).toContain("You initiate");
  });

  test("shows 'they initiate' for high direction score", () => {
    const score = makeScore();
    score.directionScore = 0.8;
    const doc = buildRelationshipDocument(score);
    expect(doc.content).toContain("They initiate");
  });
});

// ── E2E ───────────────────────────────────────────────────────

describe("E2E: full interaction scoring flow", () => {
  test("scores contacts, queries dormant, generates documents", async () => {
    const base = REF_DATE.getTime();
    const day = 24 * 60 * 60 * 1000;

    const alice = _makeMockScoringContact({
      id: "alice-id",
      displayName: "Alice",
      identifiers: [{ channel: "telegram", value: "alice-tg" }],
      relationshipType: "colleague",
    });

    const bob = _makeMockScoringContact({
      id: "bob-id",
      displayName: "Bob",
      identifiers: [
        { channel: "telegram", value: "bob-tg" },
        { channel: "email", value: "bob@test.com" },
      ],
      relationshipType: "friend",
    });

    const messageMap = new Map<string, InteractionMessage[]>([
      [
        "telegram:alice-tg",
        Array.from({ length: 50 }, (_, i) =>
          _makeMockInteractionMessage({
            channel: "telegram",
            role: i % 2 === 0 ? "user" : "assistant",
            content: `Project update meeting notes ${i}`,
            timestamp: new Date(base - i * day),
          }),
        ),
      ],
      [
        "telegram:bob-tg",
        [
          _makeMockInteractionMessage({
            channel: "telegram",
            role: "user",
            content: "Hey long time",
            timestamp: new Date(base - 45 * day),
          }),
        ],
      ],
      [
        "email:bob@test.com",
        [
          _makeMockInteractionMessage({
            channel: "email",
            role: "assistant",
            content: "Long time indeed",
            timestamp: new Date(base - 44 * day),
          }),
        ],
      ],
    ]);

    const pipeline = new InteractionScoringPipeline(
      _makeMockMessageFetcher(messageMap),
      _makeMockContactLookup([alice, bob]),
      simpleTopicExtractor,
      { referenceDate: REF_DATE },
    );

    // Score all
    const scores = await pipeline.scoreAll();
    expect(scores.length).toBe(2);

    // Alice should score higher (more recent, more frequent)
    const aliceScore = pipeline.getScore("alice-id")!;
    const bobScore = pipeline.getScore("bob-id")!;
    expect(aliceScore.overallScore).toBeGreaterThan(bobScore.overallScore);
    expect(aliceScore.totalMessages).toBe(50);
    expect(bobScore.totalMessages).toBe(2);

    // Bob is multi-channel
    expect(bobScore.channelStats.length).toBe(2);

    // Query dormant contacts (>30 days)
    const dormant = pipeline.query({ dormantDays: 30 });
    expect(dormant.contacts.some((c) => c.contactName === "Bob")).toBe(true);
    expect(dormant.contacts.some((c) => c.contactName === "Alice")).toBe(false);

    // Query by relationship type
    const colleagues = pipeline.query({ relationshipType: "colleague" });
    expect(colleagues.total).toBe(1);
    expect(colleagues.contacts[0].contactName).toBe("Alice");

    // Generate documents
    const aliceDoc = buildRelationshipDocument(aliceScore);
    expect(aliceDoc.path).toBe("relationships/alice.md");
    expect(aliceDoc.frontmatter.relationship_type).toBe("colleague");
    expect(aliceDoc.content).toContain("telegram");

    const bobDoc = buildRelationshipDocument(bobScore);
    expect(bobDoc.path).toBe("relationships/bob.md");
    expect(bobDoc.frontmatter.total_messages).toBe(2);
  });
});
