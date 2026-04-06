import { describe, test, expect } from "bun:test";
import {
  matchSkillTriggers,
  buildScopeFromMode,
  VOICE_SUMMARY_FILTER,
  renderKnowledge,
} from "../src/prompt-layers/knowledge";
import type { SkillRegistryEntry, KnowledgeResult } from "../src/prompt-layers/types";

const MOCK_REGISTRY: SkillRegistryEntry[] = [
  { name: "plane", triggers: ["check plane", "create ticket", "work items", "plane"], file: "skills/plane/SKILL.md", description: "Manage tickets" },
  { name: "forest", triggers: ["search forest", "forest", "knowledge tree"], file: "skills/forest/SKILL.md", description: "Query Forest" },
  { name: "github", triggers: ["github", "pull request", "PR", "repo"], file: "skills/github/SKILL.md", description: "GitHub operations" },
];

describe("Layer 3: Knowledge", () => {
  describe("Channel A: Skill trigger matching", () => {
    test("matches plane skill from trigger phrase", () => {
      const matches = matchSkillTriggers("can you check plane for open items", MOCK_REGISTRY);
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches.some(m => m.name === "plane")).toBe(true);
    });

    test("matches multiple skills if message hits both", () => {
      const matches = matchSkillTriggers("check the forest and create a plane ticket", MOCK_REGISTRY);
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    test("returns empty for unmatched message", () => {
      const matches = matchSkillTriggers("how was your weekend", MOCK_REGISTRY);
      expect(matches).toHaveLength(0);
    });
  });

  describe("Channel B: Scope resolution", () => {
    test("dev-session defaults to 2 (projects)", () => {
      expect(buildScopeFromMode("dev-session", "working on the relay")).toBe("2/1");
    });

    test("dev-session with forest keywords → 2/2", () => {
      expect(buildScopeFromMode("dev-session", "the forest tree structure")).toBe("2/2");
    });

    test("personal mode searches Y (Dave's tree)", () => {
      expect(buildScopeFromMode("personal", "how is Georgia")).toBe("Y");
    });

    test("voice-casual with personal keywords → Y", () => {
      expect(buildScopeFromMode("voice-casual", "georgia had a great day")).toBe("Y");
    });

    test("voice-casual without personal keywords → 2", () => {
      expect(buildScopeFromMode("voice-casual", "something random")).toBe("2");
    });

    test("planning → 2", () => {
      expect(buildScopeFromMode("planning", "what should we do next")).toBe("2");
    });

    test("heartbeat → 2", () => {
      expect(buildScopeFromMode("heartbeat", "")).toBe("2");
    });
  });

  describe("Voice summary filter", () => {
    test("filters out voice call summaries", () => {
      expect(VOICE_SUMMARY_FILTER.test("Voice call (12 exchanges). Topics: Hey, Ellie")).toBe(true);
      expect(VOICE_SUMMARY_FILTER.test("Voice call (4 exchanges). Topics: How's it going")).toBe(true);
    });

    test("does not filter real memories", () => {
      expect(VOICE_SUMMARY_FILTER.test("Dave values ownership over perfection")).toBe(false);
      expect(VOICE_SUMMARY_FILTER.test("ELLIE-459 covers Phase 2 improvements")).toBe(false);
    });

    test("filters conversation summary patterns", () => {
      expect(VOICE_SUMMARY_FILTER.test("Conversation summary: discussed Forest architecture")).toBe(true);
    });
  });

  describe("renderKnowledge budget enforcement", () => {
    test("renders combined knowledge", () => {
      const result: KnowledgeResult = {
        skillDocs: "### Skill: plane\nManage tickets",
        forestKnowledge: "## KNOWLEDGE\n- [fact, 2/1] Some fact",
        expansion: "Related: something",
      };
      const rendered = renderKnowledge(result);
      expect(rendered).toContain("plane");
      expect(rendered).toContain("Some fact");
    });

    test("returns empty string for empty result", () => {
      const result: KnowledgeResult = { skillDocs: "", forestKnowledge: "", expansion: "" };
      expect(renderKnowledge(result)).toBe("");
    });

    test("trims expansion first when over budget", () => {
      const bigExpansion = "x".repeat(5000);
      const result: KnowledgeResult = {
        skillDocs: "skill content",
        forestKnowledge: "forest content",
        expansion: bigExpansion,
      };
      const rendered = renderKnowledge(result);
      expect(rendered).toContain("skill content");
      expect(rendered).toContain("forest content");
      expect(rendered).not.toContain(bigExpansion);
    });
  });
});
