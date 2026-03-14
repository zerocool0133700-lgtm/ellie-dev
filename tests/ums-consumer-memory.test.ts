/**
 * UMS Consumer Tests: Memory — ELLIE-709
 */

import { describe, test, expect } from "bun:test";
import { _testing } from "../src/ums/consumers/memory.ts";

const { parseTags, extractPatterns, classifyFactType, classifyCategory, inferTags } = _testing;

describe("memory consumer", () => {
  describe("parseTags", () => {
    test("parses [REMEMBER: text]", () => {
      const facts = parseTags("Some preamble [REMEMBER: Dave prefers dark mode] more text");
      expect(facts).toHaveLength(1);
      expect(facts[0].content).toBe("Dave prefers dark mode");
      expect(facts[0].confidence).toBe(1.0);
      expect(facts[0].extraction_method).toBe("tag");
      expect(facts[0].tags).toContain("user-tagged");
    });

    test("parses multiple [REMEMBER:] tags", () => {
      const facts = parseTags("[REMEMBER: fact one] and [REMEMBER: fact two]");
      expect(facts).toHaveLength(2);
      expect(facts[0].content).toBe("fact one");
      expect(facts[1].content).toBe("fact two");
    });

    test("parses [GOAL: text]", () => {
      const facts = parseTags("[GOAL: Ship UMS consumers this week]");
      expect(facts).toHaveLength(1);
      expect(facts[0].type).toBe("goal");
      expect(facts[0].category).toBe("work");
      expect(facts[0].confidence).toBe(1.0);
    });

    test("parses [GOAL: text | DEADLINE: date]", () => {
      const facts = parseTags("[GOAL: Finish docs | DEADLINE: 2026-03-20]");
      expect(facts).toHaveLength(1);
      expect(facts[0].type).toBe("goal");
      expect(facts[0].deadline).toBe("2026-03-20");
    });

    test("skips short content (< 3 chars) in REMEMBER", () => {
      const facts = parseTags("[REMEMBER: ab]");
      expect(facts).toHaveLength(0);
    });

    test("returns empty for text with no tags", () => {
      expect(parseTags("Just a normal message with no tags")).toEqual([]);
    });

    test("case insensitive", () => {
      const facts = parseTags("[remember: test fact] [goal: test goal]");
      expect(facts).toHaveLength(2);
    });
  });

  describe("extractPatterns", () => {
    test("extracts preference pattern: I prefer", () => {
      const facts = extractPatterns("I prefer TypeScript over JavaScript for backend work.");
      expect(facts).toHaveLength(1);
      expect(facts[0].type).toBe("preference");
      expect(facts[0].confidence).toBe(0.7);
      expect(facts[0].extraction_method).toBe("pattern");
    });

    test("extracts preference: I always use", () => {
      const facts = extractPatterns("I always use Bun for new TypeScript projects.");
      expect(facts).toHaveLength(1);
      expect(facts[0].type).toBe("preference");
    });

    test("extracts decision: let's go with", () => {
      const facts = extractPatterns("Let's go with Postgres for the new database layer.");
      expect(facts).toHaveLength(1);
      expect(facts[0].type).toBe("decision");
      expect(facts[0].confidence).toBe(0.7);
    });

    test("extracts decision: I've decided", () => {
      const facts = extractPatterns("I've decided to switch to Nuxt for the frontend.");
      expect(facts).toHaveLength(1);
      expect(facts[0].type).toBe("decision");
    });

    test("extracts constraint: I can't", () => {
      const facts = extractPatterns("I can't do meetings on Friday afternoons.");
      expect(facts).toHaveLength(1);
      expect(facts[0].type).toBe("constraint");
      expect(facts[0].category).toBe("schedule");
    });

    test("extracts constraint: I'm not available", () => {
      const facts = extractPatterns("I'm not available on Monday mornings before 10.");
      expect(facts).toHaveLength(1);
      expect(facts[0].type).toBe("constraint");
    });

    test("extracts contact pattern: X works at Y", () => {
      const facts = extractPatterns("Sarah works at Google as a product manager.");
      expect(facts).toHaveLength(1);
      expect(facts[0].type).toBe("contact");
      expect(facts[0].category).toBe("people");
    });

    test("extracts fact: I work at", () => {
      const facts = extractPatterns("I work at Ellie Labs building AI tools.");
      expect(facts).toHaveLength(1);
      expect(facts[0].type).toBe("fact");
      expect(facts[0].confidence).toBe(0.6);
    });

    test("extracts fact: My X is Y", () => {
      const facts = extractPatterns("My timezone is Central Standard Time.");
      expect(facts).toHaveLength(1);
      expect(facts[0].type).toBe("fact");
    });

    test("extracts schedule: appointment", () => {
      const facts = extractPatterns("I have a dentist appointment next Thursday.");
      expect(facts).toHaveLength(1);
      expect(facts[0].category).toBe("schedule");
    });

    test("skips questions", () => {
      const facts = extractPatterns("What do you think about TypeScript?");
      expect(facts).toHaveLength(0);
    });

    test("skips short sentences (< 10 chars)", () => {
      const facts = extractPatterns("I am ok.");
      expect(facts).toHaveLength(0);
    });

    test("returns empty for non-factual content", () => {
      const facts = extractPatterns("The weather is nice today and the birds are singing.");
      expect(facts).toHaveLength(0);
    });

    test("handles multi-sentence text", () => {
      const text = "I prefer dark mode for coding. Let's go with the Nuxt approach.";
      const facts = extractPatterns(text);
      expect(facts.length).toBeGreaterThanOrEqual(2);
      expect(facts.some(f => f.type === "preference")).toBe(true);
      expect(facts.some(f => f.type === "decision")).toBe(true);
    });
  });

  describe("classifyCategory", () => {
    test("classifies work-related content", () => {
      expect(classifyCategory("deploy the new API endpoint")).toBe("work");
    });

    test("classifies schedule content with vacation", () => {
      // "vacation" is a schedule keyword
      expect(classifyCategory("my wife and I are going on vacation")).toBe("schedule");
    });

    test("classifies technical content", () => {
      expect(classifyCategory("the TypeScript compiler handles generics")).toBe("technical");
    });

    test("classifies schedule content", () => {
      expect(classifyCategory("meeting with the team on Thursday")).toBe("schedule");
    });

    test("classifies people-related content", () => {
      expect(classifyCategory("Alice is the product manager at the company")).toBe("people");
    });
  });

  describe("classifyFactType", () => {
    test("classifies preference content", () => {
      expect(classifyFactType("I prefer dark mode for everything")).toBe("preference");
    });

    test("classifies preference-like content", () => {
      expect(classifyFactType("I prefer working in the morning")).toBe("preference");
    });

    test("defaults to fact", () => {
      expect(classifyFactType("The sky is blue on sunny days")).toBe("fact");
    });
  });
});
