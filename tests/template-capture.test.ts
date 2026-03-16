import { describe, it, expect, beforeEach } from "bun:test";
import {
  extractTopic,
  detectTopicGap,
  startTemplateCapture,
  getTemplateSession,
  isTemplateCaptureActive,
  getCurrentQuestion,
  processAnswer,
  buildDocFromSession,
  getProgress,
  buildGapOfferMessage,
  buildQuestionMessage,
  _clearSessions,
} from "../src/capture/template-capture.ts";
import type { QmdClient, QmdSearchResult } from "../src/capture/dedup-detector.ts";

beforeEach(() => _clearSessions());

function mockQmd(results: QmdSearchResult[] = []): QmdClient {
  return { search: async () => results };
}

describe("ELLIE-782: Template-prompted capture flow", () => {
  describe("extractTopic", () => {
    it("extracts 'let's talk about X'", () => {
      expect(extractTopic("let's talk about the onboarding flow")).toBe("the onboarding flow");
    });

    it("extracts 'how does X work'", () => {
      expect(extractTopic("how does the deploy pipeline work?")).toBe("the deploy pipeline");
    });

    it("extracts 'what's the process for X'", () => {
      expect(extractTopic("what's the process for releasing a hotfix?")).toBe("process for releasing a hotfix");
    });

    it("extracts 'explain X'", () => {
      expect(extractTopic("explain the billing integration")).toBe("the billing integration");
    });

    it("extracts 'tell me about X'", () => {
      expect(extractTopic("tell me about the monitoring setup")).toBe("the monitoring setup");
    });

    it("returns null for non-topic text", () => {
      expect(extractTopic("hello how are you")).toBeNull();
      expect(extractTopic("yes that sounds good")).toBeNull();
    });
  });

  describe("detectTopicGap", () => {
    it("detects gap when no docs exist", async () => {
      const result = await detectTopicGap("let's talk about the onboarding flow", mockQmd([]));
      expect(result).not.toBeNull();
      expect(result!.is_gap).toBe(true);
      expect(result!.topic).toBe("the onboarding flow");
    });

    it("returns not-gap when docs exist", async () => {
      const qmd = mockQmd([{ path: "processes/onboarding.md", content: "existing doc", score: 0.8 }]);
      const result = await detectTopicGap("let's talk about the onboarding flow", qmd);
      expect(result).not.toBeNull();
      expect(result!.is_gap).toBe(false);
      expect(result!.existing_docs).toContain("processes/onboarding.md");
    });

    it("returns null for non-topic text", async () => {
      expect(await detectTopicGap("ok sounds good", mockQmd())).toBeNull();
    });

    it("infers workflow type from context", async () => {
      const result = await detectTopicGap("how does the deploy pipeline work?", mockQmd([]));
      expect(result!.suggested_type).toBe("workflow");
    });

    it("infers process type from context", async () => {
      const result = await detectTopicGap("what's the process for onboarding new hires?", mockQmd([]));
      expect(result!.suggested_type).toBe("process");
    });

    it("infers integration type from context", async () => {
      const result = await detectTopicGap("explain the Stripe API integration", mockQmd([]));
      expect(result!.suggested_type).toBe("integration");
    });

    it("handles QMD failure gracefully", async () => {
      const failQmd: QmdClient = { search: async () => { throw new Error("down"); } };
      expect(await detectTopicGap("let's talk about something", failQmd)).toBeNull();
    });
  });

  describe("session management", () => {
    it("starts a session with correct template", () => {
      const session = startTemplateCapture("u1", "telegram", "Deploy Pipeline", "workflow");
      expect(session.status).toBe("active");
      expect(session.template.id).toBe("workflow");
      expect(session.topic).toBe("Deploy Pipeline");
      expect(session.answers.title).toBe("Deploy Pipeline");
      expect(session.current_section).toBe(0);
    });

    it("retrieves session", () => {
      startTemplateCapture("u1", "telegram", "Test", "process");
      expect(getTemplateSession("u1")).not.toBeNull();
      expect(isTemplateCaptureActive("u1")).toBe(true);
    });

    it("returns null for non-existent", () => {
      expect(getTemplateSession("nope")).toBeNull();
      expect(isTemplateCaptureActive("nope")).toBe(false);
    });
  });

  describe("getCurrentQuestion", () => {
    it("returns first question on start", () => {
      const session = startTemplateCapture("u1", "telegram", "Deploy", "workflow");
      const q = getCurrentQuestion(session);
      expect(q).not.toBeNull();
      expect(q!.heading).toBe("Trigger");
      expect(q!.index).toBe(0);
      expect(q!.total).toBe(5);
    });

    it("returns null when past end", () => {
      const session = startTemplateCapture("u1", "telegram", "Deploy", "workflow");
      session.current_section = 99;
      expect(getCurrentQuestion(session)).toBeNull();
    });
  });

  describe("processAnswer", () => {
    it("stores answer and advances", () => {
      startTemplateCapture("u1", "telegram", "Deploy", "workflow");
      const result = processAnswer("u1", "A push to main triggers this workflow");
      expect(result.advanced).toBe(true);
      expect(result.finished).toBe(false);
      const session = getTemplateSession("u1")!;
      expect(session.current_section).toBe(1);
      expect(session.answers["trigger"]).toBe("A push to main triggers this workflow");
    });

    it("handles skip", () => {
      startTemplateCapture("u1", "telegram", "Test", "workflow");
      const result = processAnswer("u1", "skip");
      expect(result.advanced).toBe(true);
      const session = getTemplateSession("u1")!;
      expect(session.answers["trigger"]).toBeUndefined();
    });

    it("handles cancel", () => {
      startTemplateCapture("u1", "telegram", "Test", "workflow");
      const result = processAnswer("u1", "cancel");
      expect(result.finished).toBe(true);
      expect(result.message).toContain("cancelled");
      expect(getTemplateSession("u1")).toBeNull();
    });

    it("finishes after last answer", () => {
      startTemplateCapture("u1", "ellie-chat", "Test", "policy"); // 4 sections
      processAnswer("u1", "Rule answer");
      processAnswer("u1", "Scope answer");
      processAnswer("u1", "Exception answer");
      const result = processAnswer("u1", "Enforcement answer");
      expect(result.finished).toBe(true);
      expect(result.message).toContain("Template Capture Complete");
    });

    it("handles non-existent session", () => {
      const result = processAnswer("nonexistent", "answer");
      expect(result.finished).toBe(true);
      expect(result.message).toContain("No active");
    });
  });

  describe("buildDocFromSession", () => {
    it("renders markdown from answers", () => {
      const session = startTemplateCapture("u1", "telegram", "Deploy Flow", "workflow");
      session.answers["trigger"] = "Push to main branch";
      session.answers["steps"] = "1. Build\n2. Test\n3. Deploy";
      const md = buildDocFromSession(session);
      expect(md).toContain("---");
      expect(md).toContain("title: Deploy Flow");
      expect(md).toContain("type: workflow");
      expect(md).toContain("## Trigger");
      expect(md).toContain("Push to main branch");
      expect(md).toContain("## Steps");
      expect(md).toContain("1. Build");
    });
  });

  describe("getProgress", () => {
    it("tracks filled sections", () => {
      const session = startTemplateCapture("u1", "telegram", "Test", "workflow");
      session.answers["trigger"] = "Something";
      session.answers["steps"] = "1. Do thing";
      const p = getProgress(session);
      expect(p.completed).toBe(2);
      expect(p.total).toBe(5);
      expect(p.percent).toBe(40);
      expect(p.filled_sections).toContain("Trigger");
      expect(p.filled_sections).toContain("Steps");
    });

    it("shows 0% at start", () => {
      const session = startTemplateCapture("u1", "telegram", "Test", "decision");
      const p = getProgress(session);
      expect(p.completed).toBe(0);
      expect(p.percent).toBe(0);
    });
  });

  describe("messages", () => {
    it("buildGapOfferMessage includes topic and type", () => {
      const msg = buildGapOfferMessage("onboarding flow", "process");
      expect(msg).toContain("onboarding flow");
      expect(msg).toContain("process");
      expect(msg).toContain("River");
    });

    it("buildQuestionMessage includes heading and progress", () => {
      const msg = buildQuestionMessage("Trigger", "What starts this?", 0, 5);
      expect(msg).toContain("Trigger");
      expect(msg).toContain("1/5");
      expect(msg).toContain("What starts this?");
      expect(msg).toContain("skip");
    });
  });
});
