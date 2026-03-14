/**
 * UMS Consumer Tests: Relationship — ELLIE-709
 */

import { describe, test, expect } from "bun:test";
import { _testing, type RelationshipProfile } from "../src/ums/consumers/relationship.ts";
import type { UnifiedMessage } from "../src/ums/types.ts";

const { resolveIdentifier, shouldAutoSuppress, calculateHealthScores, deriveHealthStatus, aggregateContacts } = _testing;

function makeMsg(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: crypto.randomUUID(),
    provider: "telegram",
    provider_id: "test-1",
    channel: "telegram:12345",
    sender: null,
    content: "Test message",
    content_type: "text",
    raw: {},
    received_at: new Date().toISOString(),
    provider_timestamp: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

function makeProfile(overrides: Partial<RelationshipProfile> = {}): RelationshipProfile {
  return {
    id: "prof-1",
    identifier: "alice@example.com",
    display_name: "Alice",
    emails: ["alice@example.com"],
    usernames: [],
    names: ["Alice"],
    provider_ids: {},
    channels: ["telegram"],
    importance: 3,
    tags: [],
    notes: null,
    suppressed: false,
    health_score: 0.5,
    health_status: "active",
    recency_score: 0.5,
    frequency_score: 0.5,
    consistency_score: 0.5,
    quality_score: 0.5,
    message_count: 10,
    last_interaction_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
    first_interaction_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days ago
    avg_gap_hours: 48,
    typical_gap_hours: 36,
    needs_follow_up: false,
    follow_up_reason: null,
    follow_up_since: null,
    person_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("relationship consumer", () => {
  describe("resolveIdentifier", () => {
    test("prefers email", () => {
      expect(resolveIdentifier({ email: "A@B.com", username: "alice", name: "Alice" })).toBe("a@b.com");
    });

    test("falls back to username", () => {
      expect(resolveIdentifier({ username: "Alice", name: "Alice Smith" })).toBe("alice");
    });

    test("falls back to name", () => {
      expect(resolveIdentifier({ name: "Alice Smith" })).toBe("alice smith");
    });

    test("returns null when no identifiable fields", () => {
      expect(resolveIdentifier({})).toBeNull();
      expect(resolveIdentifier({ id: "123" })).toBeNull();
    });

    test("lowercases all results", () => {
      expect(resolveIdentifier({ email: "Dave@Example.COM" })).toBe("dave@example.com");
    });
  });

  describe("shouldAutoSuppress", () => {
    test("suppresses noreply addresses", () => {
      expect(shouldAutoSuppress("noreply@github.com", { email: "noreply@github.com" })).toBe(true);
    });

    test("suppresses no-reply addresses", () => {
      expect(shouldAutoSuppress("no-reply@service.com", { email: "no-reply@service.com" })).toBe(true);
    });

    test("suppresses notification senders", () => {
      expect(shouldAutoSuppress("notification@slack.com", { email: "notification@slack.com" })).toBe(true);
    });

    test("suppresses mailer-daemon", () => {
      expect(shouldAutoSuppress("mailer-daemon@mail.com", { email: "mailer-daemon@mail.com" })).toBe(true);
    });

    test("suppresses bounce addresses", () => {
      expect(shouldAutoSuppress("bounce@service.com", { email: "bounce@service.com" })).toBe(true);
    });

    test("does not suppress normal addresses", () => {
      expect(shouldAutoSuppress("alice@example.com", { email: "alice@example.com" })).toBe(false);
    });

    test("case insensitive check", () => {
      expect(shouldAutoSuppress("NoReply@GitHub.com", { email: "NoReply@GitHub.com" })).toBe(true);
    });
  });

  describe("calculateHealthScores", () => {
    const now = Date.now();

    test("recent interaction → high recency score", () => {
      const profile = makeProfile({
        last_interaction_at: new Date(now - 12 * 60 * 60 * 1000).toISOString(), // 12 hours ago
      });
      const scores = calculateHealthScores(profile, now);
      expect(scores.recency).toBe(1);
    });

    test("1-7 days ago → 0.8 recency", () => {
      const profile = makeProfile({
        last_interaction_at: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const scores = calculateHealthScores(profile, now);
      expect(scores.recency).toBe(0.8);
    });

    test("60+ days ago → 0.1 recency", () => {
      const profile = makeProfile({
        last_interaction_at: new Date(now - 100 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const scores = calculateHealthScores(profile, now);
      expect(scores.recency).toBe(0.1);
    });

    test("no last_interaction → 0 recency", () => {
      const profile = makeProfile({ last_interaction_at: null });
      const scores = calculateHealthScores(profile, now);
      expect(scores.recency).toBe(0);
    });

    test("high message frequency → high frequency score", () => {
      const profile = makeProfile({
        first_interaction_at: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
        message_count: 100, // 10 msgs/day
      });
      const scores = calculateHealthScores(profile, now);
      expect(scores.frequency).toBe(1);
    });

    test("low message frequency → low frequency score", () => {
      const profile = makeProfile({
        first_interaction_at: new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString(),
        message_count: 5, // ~0.014 msgs/day
      });
      const scores = calculateHealthScores(profile, now);
      expect(scores.frequency).toBe(0.2);
    });

    test("consistent communication → high consistency", () => {
      const profile = makeProfile({ avg_gap_hours: 48, typical_gap_hours: 40 }); // ratio 1.2
      const scores = calculateHealthScores(profile, now);
      expect(scores.consistency).toBe(1);
    });

    test("inconsistent communication → low consistency", () => {
      const profile = makeProfile({ avg_gap_hours: 200, typical_gap_hours: 40 }); // ratio 5
      const scores = calculateHealthScores(profile, now);
      expect(scores.consistency).toBe(0.2);
    });

    test("multi-channel + high count → high quality", () => {
      const profile = makeProfile({ channels: ["telegram", "gmail", "gchat"], message_count: 100 });
      const scores = calculateHealthScores(profile, now);
      expect(scores.quality).toBeGreaterThan(0.7);
    });

    test("single channel + low count → low quality", () => {
      const profile = makeProfile({ channels: ["telegram"], message_count: 2 });
      const scores = calculateHealthScores(profile, now);
      expect(scores.quality).toBeLessThan(0.5);
    });
  });

  describe("deriveHealthStatus", () => {
    const now = Date.now();

    test("no last_interaction → new", () => {
      const profile = makeProfile({ last_interaction_at: null });
      expect(deriveHealthStatus(0.5, profile, now)).toBe("new");
    });

    test("dormant: > 90 days", () => {
      const profile = makeProfile({
        last_interaction_at: new Date(now - 100 * 24 * 60 * 60 * 1000).toISOString(),
      });
      expect(deriveHealthStatus(0.1, profile, now)).toBe("dormant");
    });

    test("at_risk: VIP (importance >= 4) and > 30 days", () => {
      const profile = makeProfile({
        importance: 5,
        last_interaction_at: new Date(now - 35 * 24 * 60 * 60 * 1000).toISOString(),
      });
      expect(deriveHealthStatus(0.3, profile, now)).toBe("at_risk");
    });

    test("healthy: score >= 0.7", () => {
      const profile = makeProfile({
        last_interaction_at: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
      });
      expect(deriveHealthStatus(0.75, profile, now)).toBe("healthy");
    });

    test("active: score >= 0.4", () => {
      const profile = makeProfile({
        last_interaction_at: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
      });
      expect(deriveHealthStatus(0.5, profile, now)).toBe("active");
    });

    test("declining: score < 0.4 and > 30 days", () => {
      const profile = makeProfile({
        last_interaction_at: new Date(now - 35 * 24 * 60 * 60 * 1000).toISOString(),
      });
      expect(deriveHealthStatus(0.3, profile, now)).toBe("declining");
    });
  });

  describe("aggregateContacts", () => {
    test("groups messages by sender identifier", () => {
      const messages = [
        makeMsg({ sender: { email: "alice@test.com", name: "Alice" }, provider: "telegram" }),
        makeMsg({ sender: { email: "alice@test.com" }, provider: "gmail" }),
        makeMsg({ sender: { email: "bob@test.com", name: "Bob" }, provider: "telegram" }),
      ];
      const contacts = aggregateContacts(messages, 30);
      expect(contacts).toHaveLength(2);
      const alice = contacts.find(c => c.identifier === "alice@test.com");
      expect(alice!.message_count).toBe(2);
      expect(alice!.channels).toContain("telegram");
      expect(alice!.channels).toContain("gmail");
    });

    test("skips messages with no sender", () => {
      const messages = [makeMsg({ sender: null })];
      const contacts = aggregateContacts(messages, 30);
      expect(contacts).toHaveLength(0);
    });

    test("returns empty for no messages", () => {
      expect(aggregateContacts([], 30)).toEqual([]);
    });

    test("computes avg_messages_per_day", () => {
      const messages = Array.from({ length: 10 }, () =>
        makeMsg({ sender: { email: "a@b.com" } })
      );
      const contacts = aggregateContacts(messages, 30);
      expect(contacts[0].avg_messages_per_day).toBeCloseTo(0.33, 1);
    });
  });
});
