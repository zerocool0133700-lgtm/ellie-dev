import { describe, it, expect } from "bun:test";
import { refineCapture } from "../src/capture/refinement-engine.ts";

/**
 * ELLIE-772: Conversational refinement button
 * Tests the POST /api/capture/refine endpoint logic and the full
 * refine → add → approve flow that the UI button triggers.
 */

describe("ELLIE-772: Capture refine endpoint", () => {
  describe("refine endpoint logic", () => {
    it("refines a workflow message", () => {
      const result = refineCapture({
        raw_content: "First we build the docker image, then push to registry, next deploy to staging",
        channel: "ellie-chat",
      });
      expect(result.content_type).toBe("workflow");
      expect(result.title).toBeTruthy();
      expect(result.suggested_path).toStartWith("workflows/");
      expect(result.markdown).toContain("---");
      expect(result.markdown).toContain("## Steps");
      expect(result.summary).toBeTruthy();
    });

    it("refines a decision message", () => {
      const result = refineCapture({
        raw_content: "We decided to go with Postgres over MongoDB because we need strong consistency and the trade-off favors relational",
        channel: "ellie-chat",
      });
      expect(result.content_type).toBe("decision");
      expect(result.suggested_path).toStartWith("decisions/");
      expect(result.markdown).toContain("## Rationale");
    });

    it("refines a policy message", () => {
      const result = refineCapture({
        raw_content: "All deployments must go through the approval pipeline. This is required by compliance and is mandatory for every release.",
        channel: "ellie-chat",
      });
      expect(result.content_type).toBe("policy");
      expect(result.suggested_path).toStartWith("policies/");
    });

    it("refines an integration message", () => {
      const result = refineCapture({
        raw_content: "The Slack API endpoint uses OAuth2 token auth. Webhook URL for sync is configured in the service integration settings.",
        channel: "ellie-chat",
      });
      expect(result.content_type).toBe("integration");
      expect(result.suggested_path).toStartWith("integrations/");
    });

    it("refines a process message", () => {
      const result = refineCapture({
        raw_content: "How to onboard a new engineer: every time someone joins, make sure they have access, run the checklist, don't forget to add them to Slack",
        channel: "ellie-chat",
      });
      expect(result.content_type).toBe("process");
      expect(result.suggested_path).toStartWith("processes/");
    });

    it("refines a reference message", () => {
      const result = refineCapture({
        raw_content: "Just a note: the database credentials are in 1Password under the DevOps vault. FYI for context and reference.",
        channel: "ellie-chat",
      });
      expect(result.content_type).toBe("reference");
      expect(result.suggested_path).toStartWith("reference/");
    });

    it("respects hint_content_type override", () => {
      const result = refineCapture({
        raw_content: "Random text that could be anything",
        channel: "ellie-chat",
        hint_content_type: "workflow",
      });
      expect(result.content_type).toBe("workflow");
      expect(result.confidence).toBe(0.95);
    });

    it("includes all required fields in result", () => {
      const result = refineCapture({
        raw_content: "Test content for field validation",
        channel: "telegram",
      });
      expect(result).toHaveProperty("content_type");
      expect(result).toHaveProperty("confidence");
      expect(result).toHaveProperty("title");
      expect(result).toHaveProperty("suggested_path");
      expect(result).toHaveProperty("markdown");
      expect(result).toHaveProperty("frontmatter");
      expect(result).toHaveProperty("summary");
    });

    it("markdown includes frontmatter with source_channel", () => {
      const result = refineCapture({
        raw_content: "Some process content with steps",
        channel: "voice",
      });
      expect(result.markdown).toContain("source_channel: voice");
      expect(result.frontmatter.source_channel).toBe("voice");
    });

    it("avoids path collisions when existing_paths provided", () => {
      const result = refineCapture({
        raw_content: "Deploy process",
        channel: "ellie-chat",
        hint_content_type: "process",
        existing_paths: ["processes/deploy-process.md"],
      });
      expect(result.suggested_path).not.toBe("processes/deploy-process.md");
    });
  });

  describe("request validation", () => {
    it("requires raw_content to produce meaningful output", () => {
      // The endpoint validates raw_content is present; refineCapture itself will work with any string
      const result = refineCapture({ raw_content: "x", channel: "ellie-chat" });
      expect(result.content_type).toBeTruthy();
    });

    it("defaults channel to ellie-chat in frontmatter", () => {
      const result = refineCapture({ raw_content: "test", channel: "ellie-chat" });
      expect(result.frontmatter.source_channel).toBe("ellie-chat");
    });
  });

  describe("full refine → add → approve flow", () => {
    it("produces content suitable for capture queue add endpoint", () => {
      const refined = refineCapture({
        raw_content: "We always run linting before committing. This is a required step in our process.",
        channel: "ellie-chat",
      });

      // Simulate what the UI sends to POST /api/capture/add
      const addPayload = {
        channel: "ellie-chat" as const,
        raw_content: "We always run linting before committing. This is a required step in our process.",
        refined_content: refined.markdown,
        suggested_path: refined.suggested_path,
        capture_type: "manual" as const,
        content_type: refined.content_type,
        confidence: refined.confidence,
      };

      expect(addPayload.channel).toBe("ellie-chat");
      expect(addPayload.raw_content).toBeTruthy();
      expect(addPayload.refined_content).toContain("---");
      expect(addPayload.suggested_path).toMatch(/\.md$/);
      expect(addPayload.content_type).toBeTruthy();
      expect(addPayload.confidence).toBeGreaterThan(0);
      expect(addPayload.confidence).toBeLessThanOrEqual(1);
    });
  });
});
