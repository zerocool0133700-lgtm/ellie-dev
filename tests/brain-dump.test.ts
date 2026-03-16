import { describe, it, expect, beforeEach } from "bun:test";
import {
  isTriggerPhrase,
  isExitPhrase,
  startSession,
  getSession,
  addMessage,
  cancelSession,
  isSessionActive,
  segmentDump,
  classifySegment,
  processDump,
  endSession,
  buildStartMessage,
  buildResultsMessage,
  _clearSessions,
  type DumpSession,
  type DumpMessage,
} from "../src/capture/brain-dump.ts";

beforeEach(() => _clearSessions());

describe("ELLIE-774: Brain dump mode", () => {
  describe("isTriggerPhrase", () => {
    it("detects 'brain dump'", () => {
      expect(isTriggerPhrase("brain dump")).toBe(true);
      expect(isTriggerPhrase("Brain Dump")).toBe(true);
      expect(isTriggerPhrase("I want to brain dump")).toBe(true);
    });

    it("detects variations", () => {
      expect(isTriggerPhrase("braindump")).toBe(true);
      expect(isTriggerPhrase("brain-dump")).toBe(true);
      expect(isTriggerPhrase("start dump")).toBe(true);
      expect(isTriggerPhrase("capture mode")).toBe(true);
    });

    it("rejects non-trigger phrases", () => {
      expect(isTriggerPhrase("hello")).toBe(false);
      expect(isTriggerPhrase("dump the database")).toBe(false);
    });
  });

  describe("isExitPhrase", () => {
    it("detects 'done'", () => {
      expect(isExitPhrase("done")).toBe(true);
      expect(isExitPhrase("Done")).toBe(true);
    });

    it("detects variations", () => {
      expect(isExitPhrase("that's it")).toBe(true);
      expect(isExitPhrase("thats it")).toBe(true);
      expect(isExitPhrase("end dump")).toBe(true);
      expect(isExitPhrase("i'm done")).toBe(true);
      expect(isExitPhrase("all done")).toBe(true);
    });

    it("rejects long messages containing exit words", () => {
      expect(isExitPhrase("I need to get this done before the meeting tomorrow and also finish the report")).toBe(false);
    });

    it("rejects non-exit phrases", () => {
      expect(isExitPhrase("hello")).toBe(false);
      expect(isExitPhrase("continue")).toBe(false);
    });
  });

  describe("session management", () => {
    it("starts a new session", () => {
      const session = startSession("user-123", "telegram");
      expect(session.id).toBe("user-123");
      expect(session.channel).toBe("telegram");
      expect(session.status).toBe("active");
      expect(session.messages).toHaveLength(0);
    });

    it("retrieves an existing session", () => {
      startSession("user-123", "telegram");
      const session = getSession("user-123");
      expect(session).not.toBeNull();
      expect(session!.id).toBe("user-123");
    });

    it("returns null for non-existent session", () => {
      expect(getSession("nonexistent")).toBeNull();
    });

    it("adds messages to active session", () => {
      startSession("user-123", "telegram");
      expect(addMessage("user-123", "First thought")).toBe(true);
      expect(addMessage("user-123", "Second thought", true)).toBe(true);
      const session = getSession("user-123");
      expect(session!.messages).toHaveLength(2);
      expect(session!.messages[1].is_voice).toBe(true);
    });

    it("rejects messages to non-existent session", () => {
      expect(addMessage("nonexistent", "text")).toBe(false);
    });

    it("cancels a session", () => {
      startSession("user-123", "telegram");
      expect(cancelSession("user-123")).toBe(true);
      expect(getSession("user-123")).toBeNull();
    });

    it("checks if session is active", () => {
      startSession("user-123", "telegram");
      expect(isSessionActive("user-123")).toBe(true);
      expect(isSessionActive("nonexistent")).toBe(false);
    });
  });

  describe("segmentDump", () => {
    it("splits on double newlines", () => {
      const messages: DumpMessage[] = [
        { text: "First topic here\n\nSecond topic here", timestamp: "2026-03-16T12:00:00Z", is_voice: false },
      ];
      const segments = segmentDump(messages);
      expect(segments.length).toBe(2);
    });

    it("splits on topic transition words", () => {
      const messages: DumpMessage[] = [
        { text: "First thing about deployment", timestamp: "2026-03-16T12:00:00Z", is_voice: false },
        { text: "Also we need to fix the CI pipeline", timestamp: "2026-03-16T12:01:00Z", is_voice: false },
        { text: "Another thing — the monitoring is broken", timestamp: "2026-03-16T12:02:00Z", is_voice: false },
      ];
      const segments = segmentDump(messages);
      expect(segments.length).toBe(3);
    });

    it("returns empty for empty messages", () => {
      expect(segmentDump([])).toEqual([]);
    });

    it("keeps single topic as one segment", () => {
      const messages: DumpMessage[] = [
        { text: "We need to refactor the auth module because it's too complex", timestamp: "2026-03-16T12:00:00Z", is_voice: false },
      ];
      const segments = segmentDump(messages);
      expect(segments.length).toBe(1);
    });
  });

  describe("classifySegment", () => {
    it("classifies questions", () => {
      expect(classifySegment("Should we switch to Postgres? I'm wondering if it's worth it")).toBe("question");
    });

    it("classifies tickets", () => {
      expect(classifySegment("We need to fix the broken login page, it's a bug")).toBe("ticket");
    });

    it("classifies decisions", () => {
      expect(classifySegment("We decided to go with Redis, picking it over Memcached")).toBe("decision");
    });

    it("classifies workflows", () => {
      expect(classifySegment("The deployment flow: first build, then test, push to staging")).toBe("workflow");
    });

    it("classifies policies", () => {
      expect(classifySegment("The rule is we must always review PRs, never merge without approval")).toBe("policy");
    });

    it("classifies processes", () => {
      expect(classifySegment("How to onboard: the procedure is every time someone joins we do this")).toBe("process");
    });

    it("defaults to reference", () => {
      expect(classifySegment("The sky is blue today")).toBe("reference");
    });
  });

  describe("processDump", () => {
    it("processes a multi-topic dump", () => {
      const session: DumpSession = {
        id: "test",
        channel: "telegram",
        started_at: "2026-03-16T12:00:00Z",
        messages: [
          { text: "We decided to use Postgres for the new service, going with it over MongoDB", timestamp: "2026-03-16T12:01:00Z", is_voice: false },
          { text: "Also we need to fix the broken search feature, it's a bug", timestamp: "2026-03-16T12:02:00Z", is_voice: false },
          { text: "Another thing — should we switch to Kubernetes? What if we outgrow our current setup?", timestamp: "2026-03-16T12:03:00Z", is_voice: false },
        ],
        status: "active",
      };

      const results = processDump(session);
      expect(results.items.length).toBeGreaterThanOrEqual(2);
      expect(results.total_words).toBeGreaterThan(0);
      expect(results.summary).toContain("Found");
      expect(session.status).toBe("complete");

      // Check that items have refinement results
      for (const item of results.items) {
        expect(item.refinement.markdown).toContain("---");
        expect(item.refinement.suggested_path).toMatch(/\.md$/);
      }
    });

    it("handles empty dump", () => {
      const session: DumpSession = {
        id: "empty",
        channel: "telegram",
        started_at: "2026-03-16T12:00:00Z",
        messages: [],
        status: "active",
      };
      const results = processDump(session);
      expect(results.items).toHaveLength(0);
      expect(results.total_words).toBe(0);
    });
  });

  describe("endSession", () => {
    it("processes and removes session", () => {
      startSession("user-1", "ellie-chat");
      addMessage("user-1", "We decided to use TypeScript everywhere");
      addMessage("user-1", "Also need to fix the broken API endpoint");
      const results = endSession("user-1");
      expect(results).not.toBeNull();
      expect(results!.items.length).toBeGreaterThan(0);
      expect(getSession("user-1")).toBeNull();
    });

    it("returns null for non-existent session", () => {
      expect(endSession("nonexistent")).toBeNull();
    });
  });

  describe("buildStartMessage", () => {
    it("returns channel-appropriate start message", () => {
      expect(buildStartMessage("voice")).toContain("listening");
      expect(buildStartMessage("telegram")).toContain("📝");
      expect(buildStartMessage("ellie-chat")).toContain("Brain dump");
    });
  });

  describe("buildResultsMessage", () => {
    it("formats results with icons and paths", () => {
      startSession("fmt-test", "telegram");
      addMessage("fmt-test", "We decided to use Redis for caching, going with it over Memcached");
      addMessage("fmt-test", "Also we need to fix the broken login bug");
      const results = endSession("fmt-test")!;
      const msg = buildResultsMessage(results);
      expect(msg).toContain("Brain Dump Complete");
      expect(msg).toContain("approve");
    });

    it("handles empty results", () => {
      const msg = buildResultsMessage({ items: [], summary: "", total_words: 0, duration_seconds: 0 });
      expect(msg).toContain("no actionable items");
    });
  });
});
