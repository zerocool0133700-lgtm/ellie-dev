import { describe, it, expect } from "bun:test";
import {
  classifyContent,
  suggestPath,
  extractTitle,
  buildFrontmatter,
  formatFrontmatter,
  structureContent,
  generateSummary,
  refineCapture,
  refineWithLLM,
  type LLMProvider,
} from "../src/capture/refinement-engine.ts";

describe("ELLIE-770: Refinement engine", () => {
  describe("classifyContent", () => {
    it("classifies workflow content", () => {
      const result = classifyContent("First we build the image, then deploy to staging, next run tests, after that promote to prod");
      expect(result.type).toBe("workflow");
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it("classifies decision content", () => {
      const result = classifyContent("We decided to go with Postgres because the trade-off between consistency and speed favored option A over the alternative");
      expect(result.type).toBe("decision");
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it("classifies process content", () => {
      const result = classifyContent("How to deploy: every time you push, make sure the checklist is complete, don't forget to run the routine checks");
      expect(result.type).toBe("process");
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it("classifies policy content", () => {
      const result = classifyContent("All engineers must follow the compliance standard. It is required and mandatory. Never bypass the rule.");
      expect(result.type).toBe("policy");
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it("classifies integration content", () => {
      const result = classifyContent("The API endpoint requires auth token, webhook URL, and sync configuration for the service integration");
      expect(result.type).toBe("integration");
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it("classifies reference content", () => {
      const result = classifyContent("Just a note for context: here is some background info and a definition for reference lookup");
      expect(result.type).toBe("reference");
      expect(result.confidence).toBeGreaterThan(0.3);
    });

    it("defaults to reference with low confidence for ambiguous text", () => {
      const result = classifyContent("Hello world this is a test");
      expect(result.type).toBe("reference");
      expect(result.confidence).toBe(0.3);
    });

    it("uses hint when provided", () => {
      const result = classifyContent("Some random text", "policy");
      expect(result.type).toBe("policy");
      expect(result.confidence).toBe(0.95);
    });

    it("returns confidence between 0 and 1", () => {
      const texts = [
        "steps to deploy the pipeline stage by stage",
        "we decided because of the trade-off",
        "random text with no signals at all",
      ];
      for (const text of texts) {
        const result = classifyContent(text);
        expect(result.confidence).toBeGreaterThanOrEqual(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("suggestPath", () => {
    it("generates path from title and type", () => {
      expect(suggestPath("Deploy to Staging", "workflow")).toBe("workflows/deploy-to-staging.md");
    });

    it("maps each content type to correct directory", () => {
      expect(suggestPath("Test", "workflow")).toStartWith("workflows/");
      expect(suggestPath("Test", "decision")).toStartWith("decisions/");
      expect(suggestPath("Test", "process")).toStartWith("processes/");
      expect(suggestPath("Test", "policy")).toStartWith("policies/");
      expect(suggestPath("Test", "integration")).toStartWith("integrations/");
      expect(suggestPath("Test", "reference")).toStartWith("reference/");
    });

    it("slugifies special characters", () => {
      const path = suggestPath("API Auth: Token & Keys!", "integration");
      expect(path).toBe("integrations/api-auth-token-keys.md");
    });

    it("truncates long titles to 60 chars", () => {
      const longTitle = "This is a very long title that should be truncated because it exceeds the maximum character limit we set";
      const path = suggestPath(longTitle, "reference");
      const slug = path.replace("reference/", "").replace(".md", "");
      expect(slug.length).toBeLessThanOrEqual(60);
    });

    it("avoids collision with existing paths", () => {
      const existing = ["workflows/deploy.md"];
      const path = suggestPath("Deploy", "workflow", existing);
      expect(path).not.toBe("workflows/deploy.md");
      expect(path).toContain("deploy-");
    });

    it("returns base path when no collision", () => {
      const path = suggestPath("Deploy", "workflow", ["workflows/other.md"]);
      expect(path).toBe("workflows/deploy.md");
    });
  });

  describe("extractTitle", () => {
    it("uses first line if short enough", () => {
      expect(extractTitle("Deploy process overview\nMore details here")).toBe("Deploy process overview");
    });

    it("strips trailing punctuation", () => {
      expect(extractTitle("How we deploy to prod.")).toBe("How we deploy to prod");
      expect(extractTitle("What is the policy?")).toBe("What is the policy");
    });

    it("truncates long text to ~80 chars at word boundary", () => {
      const long = "This is a very long piece of text that goes well beyond eighty characters and should be truncated at a reasonable word boundary";
      const title = extractTitle(long);
      expect(title.length).toBeLessThanOrEqual(80);
    });

    it("handles very short text", () => {
      expect(extractTitle("Hello world test content here")).toBe("Hello world test content here");
    });
  });

  describe("buildFrontmatter", () => {
    it("includes all required fields", () => {
      const fm = buildFrontmatter("Test Title", "workflow", "telegram");
      expect(fm.title).toBe("Test Title");
      expect(fm.type).toBe("workflow");
      expect(fm.source_channel).toBe("telegram");
      expect(fm.status).toBe("draft");
      expect(fm.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("merges extra fields", () => {
      const fm = buildFrontmatter("Test", "decision", "voice", { tags: ["important"] });
      expect(fm.tags).toEqual(["important"]);
    });
  });

  describe("formatFrontmatter", () => {
    it("produces valid YAML frontmatter", () => {
      const result = formatFrontmatter({ title: "Test", type: "workflow" });
      expect(result).toStartWith("---\n");
      expect(result).toEndWith("\n---");
      expect(result).toContain("title: Test");
      expect(result).toContain("type: workflow");
    });

    it("formats arrays with dash notation", () => {
      const result = formatFrontmatter({ tags: ["a", "b"] });
      expect(result).toContain("tags:\n  - a\n  - b");
    });

    it("skips null/undefined values", () => {
      const result = formatFrontmatter({ title: "Test", empty: null, missing: undefined });
      expect(result).not.toContain("empty");
      expect(result).not.toContain("missing");
    });
  });

  describe("structureContent", () => {
    it("uses workflow template", () => {
      const result = structureContent("Deploy Flow", "Raw content here", "workflow");
      expect(result).toContain("# Deploy Flow");
      expect(result).toContain("## Overview");
      expect(result).toContain("## Steps");
      expect(result).toContain("## Triggers");
      expect(result).toContain("Raw content here");
    });

    it("uses decision template", () => {
      const result = structureContent("Pick DB", "We chose Postgres", "decision");
      expect(result).toContain("## Context");
      expect(result).toContain("## Decision");
      expect(result).toContain("## Alternatives Considered");
      expect(result).toContain("## Rationale");
    });

    it("uses process template", () => {
      const result = structureContent("Release Process", "How we release", "process");
      expect(result).toContain("## Purpose");
      expect(result).toContain("## Procedure");
      expect(result).toContain("## Frequency");
    });

    it("uses policy template", () => {
      const result = structureContent("Security Policy", "Must use MFA", "policy");
      expect(result).toContain("## Policy");
      expect(result).toContain("## Scope");
      expect(result).toContain("## Enforcement");
    });

    it("uses integration template", () => {
      const result = structureContent("Slack Integration", "Connect to Slack", "integration");
      expect(result).toContain("## Configuration");
      expect(result).toContain("## Endpoints");
      expect(result).toContain("## Authentication");
    });

    it("uses reference template as fallback", () => {
      const result = structureContent("Quick Note", "Some info", "reference");
      expect(result).toContain("# Quick Note");
      expect(result).toContain("Some info");
    });
  });

  describe("generateSummary", () => {
    it("returns short text as-is", () => {
      expect(generateSummary("Short text")).toBe("Short text");
    });

    it("truncates long text with ellipsis", () => {
      const long = "A ".repeat(100);
      const summary = generateSummary(long, 50);
      expect(summary.length).toBeLessThanOrEqual(54); // 50 + "..."
      expect(summary).toEndWith("...");
    });

    it("collapses whitespace", () => {
      expect(generateSummary("hello   world\n\ntest")).toBe("hello world test");
    });
  });

  describe("refineCapture (full pipeline)", () => {
    it("produces a complete refinement result", () => {
      const result = refineCapture({
        raw_content: "First deploy to staging, then run the integration tests, next check monitoring, after that promote to production",
        channel: "telegram",
      });

      expect(result.content_type).toBe("workflow");
      expect(result.confidence).toBeGreaterThan(0.5);
      expect(result.title).toBeTruthy();
      expect(result.suggested_path).toStartWith("workflows/");
      expect(result.suggested_path).toEndWith(".md");
      expect(result.markdown).toContain("---");
      expect(result.markdown).toContain("type: workflow");
      expect(result.markdown).toContain("## Steps");
      expect(result.frontmatter.type).toBe("workflow");
      expect(result.frontmatter.source_channel).toBe("telegram");
      expect(result.summary).toBeTruthy();
    });

    it("respects hint_content_type", () => {
      const result = refineCapture({
        raw_content: "Some generic text",
        channel: "voice",
        hint_content_type: "policy",
      });
      expect(result.content_type).toBe("policy");
      expect(result.confidence).toBe(0.95);
      expect(result.suggested_path).toStartWith("policies/");
    });

    it("avoids path collisions with existing_paths", () => {
      const result = refineCapture({
        raw_content: "Deploy process",
        channel: "telegram",
        hint_content_type: "process",
        existing_paths: ["processes/deploy-process.md"],
      });
      expect(result.suggested_path).not.toBe("processes/deploy-process.md");
    });

    it("works for all content types", () => {
      const types: Array<"workflow" | "decision" | "process" | "policy" | "integration" | "reference"> = [
        "workflow", "decision", "process", "policy", "integration", "reference",
      ];
      for (const type of types) {
        const result = refineCapture({
          raw_content: `Test content for ${type}`,
          channel: "ellie-chat",
          hint_content_type: type,
        });
        expect(result.content_type).toBe(type);
        expect(result.markdown).toContain(`# Test content for ${type}`);
        expect(result.frontmatter.type).toBe(type);
      }
    });
  });

  describe("refineWithLLM", () => {
    it("enhances result with LLM response", async () => {
      const mockLLM: LLMProvider = {
        complete: async () => JSON.stringify({
          content_type: "decision",
          title: "LLM-Improved Title",
          summary: "LLM summary of the decision",
          structured_content: "# LLM-Improved Title\n\n## Context\n\nImproved content",
        }),
      };

      const result = await refineWithLLM({
        raw_content: "We decided to use Redis",
        channel: "telegram",
      }, mockLLM);

      expect(result.content_type).toBe("decision");
      expect(result.title).toBe("LLM-Improved Title");
      expect(result.summary).toBe("LLM summary of the decision");
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it("falls back to heuristic on LLM failure", async () => {
      const mockLLM: LLMProvider = {
        complete: async () => { throw new Error("LLM unavailable"); },
      };

      const result = await refineWithLLM({
        raw_content: "First do step one, then step two, next step three",
        channel: "telegram",
      }, mockLLM);

      // Should still produce a valid result via heuristic
      expect(result.content_type).toBeTruthy();
      expect(result.title).toBeTruthy();
      expect(result.markdown).toContain("---");
    });

    it("falls back on invalid JSON from LLM", async () => {
      const mockLLM: LLMProvider = {
        complete: async () => "not valid json at all",
      };

      const result = await refineWithLLM({
        raw_content: "Some policy that must be followed",
        channel: "voice",
      }, mockLLM);

      expect(result.content_type).toBeTruthy();
      expect(result.markdown).toBeTruthy();
    });
  });
});
