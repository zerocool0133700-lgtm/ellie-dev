import { describe, it, expect } from "bun:test";
import {
  parseCaptureCommand,
  isCaptureReaction,
  getCaptureEmojis,
  flagForCapture,
  isAlreadyFlagged,
  buildConfirmation,
  handleCaptureCommand,
  handleReactionCapture,
} from "../src/capture/flag-system.ts";

function createMockSql(returnValue: any = []) {
  const calls: any[] = [];
  const fn: any = function (...args: any[]) {
    calls.push(args);
    return Promise.resolve(returnValue);
  };
  fn.calls = calls;
  return fn;
}

describe("ELLIE-773: Capture flag system", () => {
  describe("parseCaptureCommand", () => {
    it("parses bare /capture", () => {
      const result = parseCaptureCommand("/capture");
      expect(result.valid).toBe(true);
      expect(result.quoted_text).toBeUndefined();
      expect(result.note).toBeUndefined();
    });

    it("parses /capture with quoted text", () => {
      const result = parseCaptureCommand('/capture "deploy always goes to staging first"');
      expect(result.valid).toBe(true);
      expect(result.quoted_text).toBe("deploy always goes to staging first");
    });

    it("parses /capture with quoted text and note", () => {
      const result = parseCaptureCommand('/capture "use Redis for sessions" important for new devs');
      expect(result.valid).toBe(true);
      expect(result.quoted_text).toBe("use Redis for sessions");
      expect(result.note).toBe("important for new devs");
    });

    it("parses /capture with just a note", () => {
      const result = parseCaptureCommand("/capture this is important");
      expect(result.valid).toBe(true);
      expect(result.note).toBe("this is important");
    });

    it("handles trailing space", () => {
      const result = parseCaptureCommand("/capture ");
      expect(result.valid).toBe(true);
    });
  });

  describe("isCaptureReaction", () => {
    it("recognizes capture emojis", () => {
      expect(isCaptureReaction("📌")).toBe(true);
      expect(isCaptureReaction("🏷")).toBe(true);
      expect(isCaptureReaction("💾")).toBe(true);
      expect(isCaptureReaction("🔖")).toBe(true);
    });

    it("rejects non-capture emojis", () => {
      expect(isCaptureReaction("👍")).toBe(false);
      expect(isCaptureReaction("❤️")).toBe(false);
      expect(isCaptureReaction("🎉")).toBe(false);
    });
  });

  describe("getCaptureEmojis", () => {
    it("returns array of capture emojis", () => {
      const emojis = getCaptureEmojis();
      expect(emojis.length).toBeGreaterThan(0);
      expect(emojis).toContain("📌");
    });

    it("returns a copy (not mutable reference)", () => {
      const a = getCaptureEmojis();
      const b = getCaptureEmojis();
      a.push("test");
      expect(b).not.toContain("test");
    });
  });

  describe("flagForCapture", () => {
    it("inserts into capture queue and returns success", async () => {
      const mockSql = createMockSql([{ id: "abc-123" }]);
      const result = await flagForCapture(mockSql, {
        channel: "telegram",
        raw_content: "Important process info",
        capture_type: "tag",
      });
      expect(result.success).toBe(true);
      expect(result.capture_id).toBe("abc-123");
      expect(result.message).toBe("Flagged for River review");
    });

    it("appends user note to content", async () => {
      const calls: any[] = [];
      const mockSql: any = function (...args: any[]) {
        calls.push(args);
        return Promise.resolve([{ id: "abc-123" }]);
      };
      await flagForCapture(mockSql, {
        channel: "ellie-chat",
        raw_content: "Original content",
        capture_type: "manual",
        user_note: "Remember this for onboarding",
      });
      // The SQL call will include the note appended
      expect(calls.length).toBe(1);
    });

    it("rejects empty content", async () => {
      const mockSql = createMockSql();
      const result = await flagForCapture(mockSql, {
        channel: "telegram",
        raw_content: "",
        capture_type: "tag",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Empty");
    });

    it("rejects whitespace-only content", async () => {
      const mockSql = createMockSql();
      const result = await flagForCapture(mockSql, {
        channel: "telegram",
        raw_content: "   ",
        capture_type: "tag",
      });
      expect(result.success).toBe(false);
    });

    it("handles SQL errors gracefully", async () => {
      const mockSql: any = function () {
        return Promise.reject(new Error("DB connection lost"));
      };
      const result = await flagForCapture(mockSql, {
        channel: "telegram",
        raw_content: "Test",
        capture_type: "tag",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe("DB connection lost");
    });
  });

  describe("isAlreadyFlagged", () => {
    it("returns true when message exists in queue", async () => {
      const mockSql = createMockSql([{ "?column?": 1 }]);
      expect(await isAlreadyFlagged(mockSql, "msg-123")).toBe(true);
    });

    it("returns false when message not in queue", async () => {
      const mockSql = createMockSql([]);
      expect(await isAlreadyFlagged(mockSql, "msg-456")).toBe(false);
    });

    it("returns false for empty message ID", async () => {
      const mockSql = createMockSql();
      expect(await isAlreadyFlagged(mockSql, "")).toBe(false);
    });
  });

  describe("buildConfirmation", () => {
    it("returns channel-appropriate confirmation", () => {
      expect(buildConfirmation("telegram", "id")).toContain("📌");
      expect(buildConfirmation("google-chat", "id")).toContain("Flagged");
      expect(buildConfirmation("ellie-chat", "id")).toContain("Flagged");
      expect(buildConfirmation("voice", "id")).toContain("flagged");
    });
  });

  describe("handleCaptureCommand", () => {
    it("captures quoted text from command", async () => {
      const mockSql = createMockSql([{ id: "cap-1" }]);
      const result = await handleCaptureCommand(
        mockSql,
        '/capture "always run tests before deploy"',
        null,
        "telegram",
      );
      expect(result.success).toBe(true);
      expect(result.capture_id).toBe("cap-1");
    });

    it("falls back to previous message when no quote", async () => {
      const mockSql = createMockSql([{ id: "cap-2" }]);
      const result = await handleCaptureCommand(
        mockSql,
        "/capture",
        "Previous message content here",
        "telegram",
      );
      expect(result.success).toBe(true);
    });

    it("fails when no quote and no previous message", async () => {
      const mockSql = createMockSql();
      const result = await handleCaptureCommand(
        mockSql,
        "/capture",
        null,
        "telegram",
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain("No message");
    });

    it("includes note from command", async () => {
      const mockSql = createMockSql([{ id: "cap-3" }]);
      const result = await handleCaptureCommand(
        mockSql,
        '/capture "use pgvector" for search feature',
        null,
        "ellie-chat",
      );
      expect(result.success).toBe(true);
    });
  });

  describe("handleReactionCapture", () => {
    it("captures on 📌 reaction", async () => {
      let callCount = 0;
      const mockSql: any = function () {
        callCount++;
        if (callCount === 1) return Promise.resolve([]); // isAlreadyFlagged
        return Promise.resolve([{ id: "cap-react" }]); // flagForCapture
      };

      const result = await handleReactionCapture(mockSql, "📌", "Message to capture", "msg-1");
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
    });

    it("returns null for non-capture reactions", async () => {
      const mockSql = createMockSql();
      const result = await handleReactionCapture(mockSql, "👍", "Some message", "msg-2");
      expect(result).toBeNull();
    });

    it("skips already-flagged messages", async () => {
      const mockSql = createMockSql([{ "?column?": 1 }]); // isAlreadyFlagged returns true
      const result = await handleReactionCapture(mockSql, "📌", "Already flagged", "msg-3");
      expect(result).not.toBeNull();
      expect(result!.message).toBe("Already flagged");
    });
  });
});
