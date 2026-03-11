/**
 * Mountain Interaction Context & Relationship Scoring — ELLIE-668
 *
 * Correlates contact records with message history to produce
 * actionable relationship context:
 *   - Channel preference (fastest response channel)
 *   - Recency (when was last interaction?)
 *   - Frequency (daily vs quarterly contact)
 *   - Direction (who initiates more?)
 *   - Topics (what do we talk about?)
 *   - Relationship type (colleague, friend, family, vendor)
 *
 * Pattern: injectable MessageFetcher + ContactLookup for testability.
 */

import { log } from "../logger.ts";

const logger = log.child("interaction-scoring");

// ── Types ────────────────────────────────────────────────────

/** A message record used for interaction analysis. */
export interface InteractionMessage {
  id: string;
  channel: string;
  sender: string | null;
  role: "user" | "assistant" | string;
  content: string;
  timestamp: Date;
  conversation_id: string | null;
  metadata: Record<string, unknown>;
}

/** A resolved contact for scoring. */
export interface ScoringContact {
  id: string;
  displayName: string;
  identifiers: Array<{ channel: string; value: string }>;
  relationshipType?: RelationshipType;
}

/** Relationship type — inferred or user-tagged. */
export type RelationshipType =
  | "colleague"
  | "friend"
  | "family"
  | "vendor"
  | "acquaintance"
  | "unknown";

/** Per-channel interaction stats. */
export interface ChannelStats {
  channel: string;
  messageCount: number;
  lastMessageAt: Date;
  avgResponseTimeMs: number | null;
  initiatedByContact: number;
  initiatedByUser: number;
}

/** Computed interaction scores for a contact. */
export interface InteractionScore {
  contactId: string;
  contactName: string;
  /** 0–1, exponential decay from last interaction */
  recencyScore: number;
  /** 0–1, based on message frequency relative to most-active contact */
  frequencyScore: number;
  /** 0–1, 0.5 = balanced, >0.5 = contact initiates more */
  directionScore: number;
  /** Preferred channel (highest message count) */
  preferredChannel: string | null;
  /** Per-channel breakdown */
  channelStats: ChannelStats[];
  /** Topics discussed (from message content) */
  topics: string[];
  /** Relationship type */
  relationshipType: RelationshipType;
  /** Total messages exchanged */
  totalMessages: number;
  /** Last interaction timestamp */
  lastInteraction: Date | null;
  /** First interaction timestamp */
  firstInteraction: Date | null;
  /** Composite score (weighted combination) */
  overallScore: number;
}

/** Weights for the composite score. */
export interface ScoringWeights {
  recency: number;
  frequency: number;
  direction: number;
}

/** Configuration for the scoring pipeline. */
export interface ScoringConfig {
  /** Half-life for recency decay in days. Default: 14 */
  recencyHalfLifeDays?: number;
  /** Weights for composite score. Default: recency=0.4, frequency=0.4, direction=0.2 */
  weights?: ScoringWeights;
  /** Reference date for recency calculations. Default: now */
  referenceDate?: Date;
}

/** Query options for relationship lookups. */
export interface RelationshipQuery {
  /** Contacts not interacted with in N days */
  dormantDays?: number;
  /** Minimum overall score */
  minScore?: number;
  /** Maximum overall score */
  maxScore?: number;
  /** Filter by channel preference */
  preferredChannel?: string;
  /** Filter by relationship type */
  relationshipType?: RelationshipType;
  /** Sort field */
  sortBy?: "recency" | "frequency" | "overall" | "totalMessages";
  /** Sort direction */
  sortDir?: "asc" | "desc";
  /** Limit results */
  limit?: number;
}

/** Result from a relationship query. */
export interface RelationshipQueryResult {
  contacts: InteractionScore[];
  total: number;
  query: RelationshipQuery;
}

/** River document for relationship context. */
export interface RelationshipDocument {
  path: string;
  content: string;
  frontmatter: Record<string, unknown>;
}

// ── Injectable Interfaces ───────────────────────────────────

/**
 * Fetches messages involving a contact.
 * Injectable for testing without real DB.
 */
export type InteractionMessageFetcher = (
  contactIdentifiers: Array<{ channel: string; value: string }>,
) => Promise<InteractionMessage[]>;

/**
 * Fetches all known contacts.
 * Injectable for testing without real DB.
 */
export type ContactLookup = () => Promise<ScoringContact[]>;

/**
 * Extracts topics from a set of messages.
 * Injectable — can be simple keyword extraction or Claude-powered.
 */
export type TopicExtractor = (messages: InteractionMessage[]) => string[];

// ── Scoring Functions ───────────────────────────────────────

const DEFAULT_WEIGHTS: ScoringWeights = {
  recency: 0.4,
  frequency: 0.4,
  direction: 0.2,
};

const DEFAULT_HALF_LIFE_DAYS = 14;

/**
 * Compute recency score using exponential decay.
 * Score = 0.5^(daysSinceLastInteraction / halfLifeDays)
 */
export function computeRecencyScore(
  lastInteraction: Date | null,
  referenceDate: Date,
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): number {
  if (!lastInteraction) return 0;
  const daysSince = (referenceDate.getTime() - lastInteraction.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince < 0) return 1; // future date = max recency
  return Math.pow(0.5, daysSince / halfLifeDays);
}

/**
 * Compute frequency score — messages per day, normalized 0–1.
 * Uses log scale to compress range: score = log(1 + msgsPerDay) / log(1 + maxMsgsPerDay)
 */
export function computeFrequencyScore(
  totalMessages: number,
  firstInteraction: Date | null,
  referenceDate: Date,
  maxMessagesPerDay: number = 10,
): number {
  if (!firstInteraction || totalMessages === 0) return 0;
  const days = Math.max(1, (referenceDate.getTime() - firstInteraction.getTime()) / (1000 * 60 * 60 * 24));
  const msgsPerDay = totalMessages / days;
  return Math.min(1, Math.log(1 + msgsPerDay) / Math.log(1 + maxMessagesPerDay));
}

/**
 * Compute direction score — who initiates more?
 * 0.0 = user always initiates, 0.5 = balanced, 1.0 = contact always initiates
 */
export function computeDirectionScore(
  contactInitiated: number,
  userInitiated: number,
): number {
  const total = contactInitiated + userInitiated;
  if (total === 0) return 0.5;
  return contactInitiated / total;
}

/**
 * Compute the composite overall score from individual signals.
 */
export function computeOverallScore(
  recency: number,
  frequency: number,
  direction: number,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): number {
  // Direction penalty: very one-sided relationships score lower
  const directionPenalty = 1 - Math.abs(direction - 0.5) * 0.5;
  const raw =
    weights.recency * recency +
    weights.frequency * frequency +
    weights.direction * directionPenalty;
  return Math.min(1, Math.max(0, raw));
}

// ── Channel Stats Builder ───────────────────────────────────

/**
 * Build per-channel stats from a list of messages.
 * Messages are assumed to be for a single contact.
 */
export function buildChannelStats(messages: InteractionMessage[]): ChannelStats[] {
  const byChannel = new Map<string, InteractionMessage[]>();

  for (const msg of messages) {
    const list = byChannel.get(msg.channel) || [];
    list.push(msg);
    byChannel.set(msg.channel, list);
  }

  const stats: ChannelStats[] = [];

  for (const [channel, msgs] of byChannel) {
    // Sort by timestamp for response time calculation
    const sorted = [...msgs].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    let initiatedByContact = 0;
    let initiatedByUser = 0;
    let responseTimes: number[] = [];
    let lastMessageAt = sorted[0].timestamp;

    for (let i = 0; i < sorted.length; i++) {
      const msg = sorted[i];
      if (msg.timestamp > lastMessageAt) lastMessageAt = msg.timestamp;

      if (msg.role === "user") {
        initiatedByUser++;
      } else {
        initiatedByContact++;
      }

      // Track response times between user<->assistant messages
      if (i > 0 && sorted[i].role !== sorted[i - 1].role) {
        const gap = sorted[i].timestamp.getTime() - sorted[i - 1].timestamp.getTime();
        if (gap > 0 && gap < 7 * 24 * 60 * 60 * 1000) { // ignore gaps > 7 days
          responseTimes.push(gap);
        }
      }
    }

    stats.push({
      channel,
      messageCount: msgs.length,
      lastMessageAt,
      avgResponseTimeMs:
        responseTimes.length > 0
          ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
          : null,
      initiatedByContact,
      initiatedByUser,
    });
  }

  return stats.sort((a, b) => b.messageCount - a.messageCount);
}

// ── Simple Topic Extractor ──────────────────────────────────

/**
 * Default topic extractor — extracts common significant words from messages.
 * Can be replaced with Claude-powered extraction.
 */
export function simpleTopicExtractor(messages: InteractionMessage[]): string[] {
  const STOP_WORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "as", "into", "through", "during", "before", "after", "above", "below",
    "between", "out", "off", "over", "under", "again", "further", "then",
    "once", "here", "there", "when", "where", "why", "how", "all", "both",
    "each", "few", "more", "most", "other", "some", "such", "no", "nor",
    "not", "only", "own", "same", "so", "than", "too", "very", "just",
    "don", "now", "i", "me", "my", "you", "your", "he", "she", "it",
    "we", "they", "them", "their", "this", "that", "these", "those",
    "what", "which", "who", "whom", "and", "but", "if", "or", "because",
    "about", "up", "its", "his", "her", "our", "also", "get", "got",
    "like", "okay", "ok", "yeah", "yes", "hey", "hi", "hello", "thanks",
    "thank", "sure", "right", "well", "think", "know", "see", "go",
    "going", "went", "come", "make", "made", "take", "give", "let",
    "say", "said", "tell", "told", "look", "want", "really", "thing",
    "things", "still", "much", "something", "anything", "nothing",
  ]);

  const wordCounts = new Map<string, number>();

  for (const msg of messages) {
    const words = msg.content
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w));

    for (const word of words) {
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }
  }

  // Return top words by frequency (minimum 2 occurrences)
  return [...wordCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}

// ── Interaction Scoring Pipeline ────────────────────────────

/**
 * Main pipeline: scores all contacts by their interaction history.
 */
export class InteractionScoringPipeline {
  private scores = new Map<string, InteractionScore>();
  private messageFetcher: InteractionMessageFetcher;
  private contactLookup: ContactLookup;
  private topicExtractor: TopicExtractor;
  private config: Required<ScoringConfig>;

  constructor(
    messageFetcher: InteractionMessageFetcher,
    contactLookup: ContactLookup,
    topicExtractor: TopicExtractor = simpleTopicExtractor,
    config: ScoringConfig = {},
  ) {
    this.messageFetcher = messageFetcher;
    this.contactLookup = contactLookup;
    this.topicExtractor = topicExtractor;
    this.config = {
      recencyHalfLifeDays: config.recencyHalfLifeDays ?? DEFAULT_HALF_LIFE_DAYS,
      weights: config.weights ?? DEFAULT_WEIGHTS,
      referenceDate: config.referenceDate ?? new Date(),
    };
  }

  /** Score all contacts. */
  async scoreAll(): Promise<InteractionScore[]> {
    const contacts = await this.contactLookup();

    logger.info("Scoring contacts", { count: contacts.length });

    const results: InteractionScore[] = [];
    for (const contact of contacts) {
      const score = await this.scoreContact(contact);
      this.scores.set(contact.id, score);
      results.push(score);
    }

    logger.info("Scoring complete", {
      scored: results.length,
      withMessages: results.filter((r) => r.totalMessages > 0).length,
    });

    return results;
  }

  /** Score a single contact. */
  async scoreContact(contact: ScoringContact): Promise<InteractionScore> {
    const messages = await this.messageFetcher(contact.identifiers);
    const channelStats = buildChannelStats(messages);

    const totalMessages = messages.length;
    const sortedByTime = [...messages].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
    const firstInteraction = sortedByTime.length > 0 ? sortedByTime[0].timestamp : null;
    const lastInteraction =
      sortedByTime.length > 0 ? sortedByTime[sortedByTime.length - 1].timestamp : null;

    // Aggregate direction across all channels
    const totalContactInitiated = channelStats.reduce((s, c) => s + c.initiatedByContact, 0);
    const totalUserInitiated = channelStats.reduce((s, c) => s + c.initiatedByUser, 0);

    const recencyScore = computeRecencyScore(
      lastInteraction,
      this.config.referenceDate,
      this.config.recencyHalfLifeDays,
    );
    const frequencyScore = computeFrequencyScore(
      totalMessages,
      firstInteraction,
      this.config.referenceDate,
    );
    const directionScore = computeDirectionScore(totalContactInitiated, totalUserInitiated);
    const overallScore = computeOverallScore(
      recencyScore,
      frequencyScore,
      directionScore,
      this.config.weights,
    );

    const topics = this.topicExtractor(messages);
    const preferredChannel = channelStats.length > 0 ? channelStats[0].channel : null;

    return {
      contactId: contact.id,
      contactName: contact.displayName,
      recencyScore,
      frequencyScore,
      directionScore,
      preferredChannel,
      channelStats,
      topics,
      relationshipType: contact.relationshipType ?? "unknown",
      totalMessages,
      lastInteraction,
      firstInteraction,
      overallScore,
    };
  }

  /** Get a previously computed score. */
  getScore(contactId: string): InteractionScore | undefined {
    return this.scores.get(contactId);
  }

  /** Get all computed scores. */
  getAllScores(): InteractionScore[] {
    return [...this.scores.values()];
  }

  /** Query contacts by relationship signals. */
  query(opts: RelationshipQuery): RelationshipQueryResult {
    let results = [...this.scores.values()];

    // Dormant filter
    if (opts.dormantDays !== undefined) {
      const cutoff = new Date(
        this.config.referenceDate.getTime() - opts.dormantDays * 24 * 60 * 60 * 1000,
      );
      results = results.filter(
        (s) => !s.lastInteraction || s.lastInteraction < cutoff,
      );
    }

    // Score filters
    if (opts.minScore !== undefined) {
      results = results.filter((s) => s.overallScore >= opts.minScore!);
    }
    if (opts.maxScore !== undefined) {
      results = results.filter((s) => s.overallScore <= opts.maxScore!);
    }

    // Channel preference filter
    if (opts.preferredChannel) {
      results = results.filter((s) => s.preferredChannel === opts.preferredChannel);
    }

    // Relationship type filter
    if (opts.relationshipType) {
      results = results.filter((s) => s.relationshipType === opts.relationshipType);
    }

    // Sort
    const sortBy = opts.sortBy ?? "overall";
    const sortDir = opts.sortDir ?? "desc";
    const sortMultiplier = sortDir === "desc" ? -1 : 1;

    results.sort((a, b) => {
      let aVal: number, bVal: number;
      switch (sortBy) {
        case "recency":
          aVal = a.recencyScore;
          bVal = b.recencyScore;
          break;
        case "frequency":
          aVal = a.frequencyScore;
          bVal = b.frequencyScore;
          break;
        case "totalMessages":
          aVal = a.totalMessages;
          bVal = b.totalMessages;
          break;
        default:
          aVal = a.overallScore;
          bVal = b.overallScore;
      }
      return (aVal - bVal) * sortMultiplier;
    });

    const total = results.length;

    // Limit
    if (opts.limit !== undefined && opts.limit > 0) {
      results = results.slice(0, opts.limit);
    }

    return { contacts: results, total, query: opts };
  }

  /** Clear all cached scores. */
  clear(): void {
    this.scores.clear();
  }
}

// ── River Document Builder ──────────────────────────────────

/**
 * Build a River document for a contact's relationship context.
 * Enriches person entities with interaction data.
 */
export function buildRelationshipDocument(score: InteractionScore): RelationshipDocument {
  const safeName = score.contactName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const path = `relationships/${safeName}.md`;

  const frontmatter: Record<string, unknown> = {
    type: "relationship",
    contact_id: score.contactId,
    contact_name: score.contactName,
    relationship_type: score.relationshipType,
    overall_score: Math.round(score.overallScore * 100) / 100,
    recency_score: Math.round(score.recencyScore * 100) / 100,
    frequency_score: Math.round(score.frequencyScore * 100) / 100,
    direction_score: Math.round(score.directionScore * 100) / 100,
    preferred_channel: score.preferredChannel,
    total_messages: score.totalMessages,
    last_interaction: score.lastInteraction?.toISOString() ?? null,
    first_interaction: score.firstInteraction?.toISOString() ?? null,
    updated_at: new Date().toISOString(),
  };

  const lines: string[] = [];
  lines.push(`# ${score.contactName}`);
  lines.push("");

  // Relationship summary
  lines.push(`**Relationship**: ${score.relationshipType}`);
  if (score.preferredChannel) {
    lines.push(`**Preferred channel**: ${score.preferredChannel}`);
  }
  lines.push(`**Total messages**: ${score.totalMessages}`);
  lines.push("");

  // Interaction timeline
  if (score.lastInteraction) {
    lines.push("## Timeline");
    lines.push(`- First interaction: ${score.firstInteraction?.toISOString().split("T")[0] ?? "unknown"}`);
    lines.push(`- Last interaction: ${score.lastInteraction.toISOString().split("T")[0]}`);
    lines.push("");
  }

  // Channel breakdown
  if (score.channelStats.length > 0) {
    lines.push("## Channels");
    for (const ch of score.channelStats) {
      const avgResp = ch.avgResponseTimeMs
        ? `avg response: ${formatDuration(ch.avgResponseTimeMs)}`
        : "no response data";
      lines.push(
        `- **${ch.channel}**: ${ch.messageCount} messages (${avgResp})`,
      );
    }
    lines.push("");
  }

  // Direction
  lines.push("## Direction");
  if (score.directionScore > 0.6) {
    lines.push("They initiate most conversations.");
  } else if (score.directionScore < 0.4) {
    lines.push("You initiate most conversations.");
  } else {
    lines.push("Conversations are fairly balanced.");
  }
  lines.push("");

  // Topics
  if (score.topics.length > 0) {
    lines.push("## Common Topics");
    lines.push(score.topics.map((t) => `- ${t}`).join("\n"));
    lines.push("");
  }

  return {
    path,
    content: lines.join("\n"),
    frontmatter,
  };
}

/** Format milliseconds as human-readable duration. */
function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

// ── Testing Helpers ─────────────────────────────────────────

/** Create a mock interaction message for testing. */
export function _makeMockInteractionMessage(
  overrides: Partial<InteractionMessage> = {},
): InteractionMessage {
  return {
    id: crypto.randomUUID(),
    channel: "telegram",
    sender: "test-user",
    role: "user",
    content: "Test message",
    timestamp: new Date("2026-03-10T12:00:00Z"),
    conversation_id: null,
    metadata: {},
    ...overrides,
  };
}

/** Create a mock scoring contact for testing. */
export function _makeMockScoringContact(
  overrides: Partial<ScoringContact> = {},
): ScoringContact {
  return {
    id: crypto.randomUUID(),
    displayName: "Test Contact",
    identifiers: [{ channel: "telegram", value: "test-123" }],
    ...overrides,
  };
}

/** Create a mock message fetcher that returns predefined messages. */
export function _makeMockMessageFetcher(
  messagesByIdentifier: Map<string, InteractionMessage[]>,
): InteractionMessageFetcher {
  return async (identifiers) => {
    const allMessages: InteractionMessage[] = [];
    for (const id of identifiers) {
      const key = `${id.channel}:${id.value}`;
      const msgs = messagesByIdentifier.get(key) || [];
      allMessages.push(...msgs);
    }
    return allMessages;
  };
}

/** Create a mock contact lookup that returns predefined contacts. */
export function _makeMockContactLookup(contacts: ScoringContact[]): ContactLookup {
  return async () => contacts;
}
