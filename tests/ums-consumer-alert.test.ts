/**
 * UMS Consumer Tests: Alert — ELLIE-709
 */

import { describe, test, expect } from "bun:test";
import { _testing, type AlertRuleRow } from "../src/ums/consumers/alert.ts";
import type { UnifiedMessage } from "../src/ums/types.ts";

const { matchRule, formatAlert, isDuplicate, dedupKey, markFired } = _testing;

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

function makeRule(overrides: Partial<AlertRuleRow> = {}): AlertRuleRow {
  return {
    id: "rule-1",
    name: "Test Rule",
    type: "keyword",
    config: {},
    priority: "normal",
    enabled: true,
    cooldown_minutes: 30,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("alert consumer", () => {
  describe("matchRule", () => {
    // ci_failure
    test("matches ci_failure rule", () => {
      const rule = makeRule({ type: "ci_failure" });
      const msg = makeMsg({
        provider: "github",
        metadata: { event_type: "ci", ci_conclusion: "failure" },
      });
      expect(matchRule(rule, msg)).toBe(true);
    });

    test("ci_failure does not match success", () => {
      const rule = makeRule({ type: "ci_failure" });
      const msg = makeMsg({
        provider: "github",
        metadata: { event_type: "ci", ci_conclusion: "success" },
      });
      expect(matchRule(rule, msg)).toBe(false);
    });

    test("ci_failure does not match non-github", () => {
      const rule = makeRule({ type: "ci_failure" });
      const msg = makeMsg({ provider: "telegram" });
      expect(matchRule(rule, msg)).toBe(false);
    });

    // vip_sender
    test("matches vip_sender by email", () => {
      const rule = makeRule({
        type: "vip_sender",
        config: { senders: ["ceo@company.com"] },
      });
      const msg = makeMsg({ sender: { email: "CEO@Company.com" } });
      expect(matchRule(rule, msg)).toBe(true);
    });

    test("matches vip_sender by username", () => {
      const rule = makeRule({
        type: "vip_sender",
        config: { senders: ["davey"] },
      });
      const msg = makeMsg({ sender: { username: "davey" } });
      expect(matchRule(rule, msg)).toBe(true);
    });

    test("vip_sender no match for unknown sender", () => {
      const rule = makeRule({
        type: "vip_sender",
        config: { senders: ["boss@company.com"] },
      });
      const msg = makeMsg({ sender: { email: "random@test.com" } });
      expect(matchRule(rule, msg)).toBe(false);
    });

    test("vip_sender no match without sender", () => {
      const rule = makeRule({ type: "vip_sender", config: { senders: ["test"] } });
      const msg = makeMsg({ sender: null });
      expect(matchRule(rule, msg)).toBe(false);
    });

    // keyword
    test("matches keyword rule", () => {
      const rule = makeRule({
        type: "keyword",
        config: { keywords: ["urgent", "emergency"] },
      });
      const msg = makeMsg({ content: "This is an urgent matter" });
      expect(matchRule(rule, msg)).toBe(true);
    });

    test("keyword matches word boundary", () => {
      const rule = makeRule({
        type: "keyword",
        config: { keywords: ["deploy"] },
      });
      expect(matchRule(rule, makeMsg({ content: "We need to deploy now" }))).toBe(true);
      // "deployed" contains "deploy" but word boundary should handle it
    });

    test("keyword supports regex pattern", () => {
      const rule = makeRule({
        type: "keyword",
        config: { pattern: "error.*production" },
      });
      expect(matchRule(rule, makeMsg({ content: "error detected in production" }))).toBe(true);
      expect(matchRule(rule, makeMsg({ content: "all systems normal" }))).toBe(false);
    });

    test("keyword no match without content", () => {
      const rule = makeRule({ type: "keyword", config: { keywords: ["test"] } });
      expect(matchRule(rule, makeMsg({ content: null }))).toBe(false);
    });

    // security
    test("matches security advisory", () => {
      const rule = makeRule({ type: "security" });
      const msg = makeMsg({
        provider: "github",
        metadata: { event_type: "security_advisory" },
      });
      expect(matchRule(rule, msg)).toBe(true);
    });

    test("matches security keyword in content", () => {
      const rule = makeRule({ type: "security" });
      const msg = makeMsg({
        provider: "github",
        content: "Security vulnerability found in dependency",
      });
      expect(matchRule(rule, msg)).toBe(true);
    });

    // calendar_conflict
    test("matches calendar conflict", () => {
      const rule = makeRule({ type: "calendar_conflict" });
      const msg = makeMsg({
        provider: "calendar",
        metadata: { change_type: "conflict" },
      });
      expect(matchRule(rule, msg)).toBe(true);
    });

    // custom
    test("matches custom rule with provider + pattern", () => {
      const rule = makeRule({
        type: "custom",
        config: { providers: ["telegram"], pattern: "help me" },
      });
      expect(matchRule(rule, makeMsg({ provider: "telegram", content: "Can you help me?" }))).toBe(true);
      expect(matchRule(rule, makeMsg({ provider: "gmail", content: "Can you help me?" }))).toBe(false);
    });

    // unknown
    test("returns false for unknown rule type", () => {
      const rule = makeRule({ type: "nonexistent" });
      expect(matchRule(rule, makeMsg())).toBe(false);
    });

    // cross-module types
    test("returns false for gtd_overdue (cross-module)", () => {
      expect(matchRule(makeRule({ type: "gtd_overdue" }), makeMsg())).toBe(false);
    });

    test("returns false for stale_thread (cross-module)", () => {
      expect(matchRule(makeRule({ type: "stale_thread" }), makeMsg())).toBe(false);
    });
  });

  describe("formatAlert", () => {
    test("formats ci_failure alert", () => {
      const rule = makeRule({ type: "ci_failure" });
      const result = formatAlert(rule, makeMsg({ content: "CI failed on main" }));
      expect(result).toContain("CI Failed");
      expect(result).toContain("CI failed on main");
    });

    test("formats vip_sender alert with sender name", () => {
      const rule = makeRule({ type: "vip_sender" });
      const result = formatAlert(rule, makeMsg({
        sender: { name: "CEO" },
        content: "Important update",
      }));
      expect(result).toContain("CEO");
      expect(result).toContain("Important update");
    });

    test("formats keyword alert", () => {
      const rule = makeRule({ type: "keyword" });
      const result = formatAlert(rule, makeMsg({
        provider: "telegram",
        content: "Urgent issue",
      }));
      expect(result).toContain("Urgent");
      expect(result).toContain("telegram");
    });

    test("truncates content to 200 chars", () => {
      const rule = makeRule({ type: "keyword" });
      const result = formatAlert(rule, makeMsg({ content: "x".repeat(300) }));
      expect(result.length).toBeLessThan(350); // format prefix + 200 chars
    });
  });

  describe("dedup", () => {
    test("dedupKey combines rule+provider+sender", () => {
      const rule = makeRule({ id: "r-1" });
      const msg = makeMsg({ provider: "telegram", sender: { email: "a@b.com" } });
      expect(dedupKey(rule, msg)).toBe("r-1:telegram:a@b.com");
    });

    test("isDuplicate returns false when no prior fire", () => {
      const rule = makeRule({ id: "fresh-rule", cooldown_minutes: 30 });
      expect(isDuplicate(rule, makeMsg())).toBe(false);
    });

    test("isDuplicate returns true within cooldown", () => {
      const rule = makeRule({ id: "dup-test-rule", cooldown_minutes: 30 });
      const msg = makeMsg({ provider: "test-dedup", sender: { email: "dup@test.com" } });
      markFired(rule, msg);
      expect(isDuplicate(rule, msg)).toBe(true);
    });

    test("isDuplicate returns false when cooldown is 0", () => {
      const rule = makeRule({ id: "no-cooldown", cooldown_minutes: 0 });
      const msg = makeMsg();
      markFired(rule, msg);
      expect(isDuplicate(rule, msg)).toBe(false);
    });
  });
});
