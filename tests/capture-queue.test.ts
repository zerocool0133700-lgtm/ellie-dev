import { describe, it, expect, mock, beforeEach } from "bun:test";
import {
  validateAddInput,
  validateUpdateInput,
  addCapture,
  listQueue,
  getCapture,
  updateCapture,
  approveCapture,
  dismissCapture,
  getStats,
} from "../src/capture-queue.ts";

// Mock SQL helper
function createMockSql(returnValue: any = []) {
  const calls: any[] = [];
  const fn: any = function (...args: any[]) {
    calls.push({ type: "tagged", args });
    return Promise.resolve(returnValue);
  };
  fn.unsafe = function (query: string) {
    calls.push({ type: "unsafe", query });
    return Promise.resolve(returnValue);
  };
  fn.calls = calls;
  return fn;
}

const VALID_INPUT = {
  channel: "telegram" as const,
  raw_content: "We always deploy to staging first before prod",
  capture_type: "manual" as const,
  content_type: "process" as const,
  confidence: 0.85,
};

const MOCK_ITEM = {
  id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  source_message_id: null,
  channel: "telegram",
  raw_content: "We always deploy to staging first before prod",
  refined_content: null,
  suggested_path: null,
  suggested_section: null,
  capture_type: "manual",
  content_type: "process",
  status: "queued",
  confidence: 0.85,
  created_at: "2026-03-16T12:00:00Z",
  updated_at: "2026-03-16T12:00:00Z",
  processed_at: null,
};

describe("ELLIE-769: Capture queue API", () => {
  describe("validateAddInput", () => {
    it("accepts valid input", () => {
      expect(validateAddInput(VALID_INPUT)).toEqual({ valid: true });
    });

    it("rejects null/undefined input", () => {
      expect(validateAddInput(null).valid).toBe(false);
      expect(validateAddInput(undefined).valid).toBe(false);
    });

    it("rejects missing channel", () => {
      const input = { ...VALID_INPUT, channel: undefined };
      expect(validateAddInput(input).valid).toBe(false);
      expect(validateAddInput(input).error).toContain("channel");
    });

    it("rejects invalid channel", () => {
      const input = { ...VALID_INPUT, channel: "discord" };
      expect(validateAddInput(input).valid).toBe(false);
    });

    it("accepts all valid channels", () => {
      for (const ch of ["telegram", "ellie-chat", "google-chat", "voice"]) {
        expect(validateAddInput({ ...VALID_INPUT, channel: ch }).valid).toBe(true);
      }
    });

    it("rejects empty raw_content", () => {
      expect(validateAddInput({ ...VALID_INPUT, raw_content: "" }).valid).toBe(false);
      expect(validateAddInput({ ...VALID_INPUT, raw_content: "   " }).valid).toBe(false);
    });

    it("rejects missing raw_content", () => {
      const { raw_content, ...rest } = VALID_INPUT;
      expect(validateAddInput(rest).valid).toBe(false);
    });

    it("rejects invalid capture_type", () => {
      expect(validateAddInput({ ...VALID_INPUT, capture_type: "auto" }).valid).toBe(false);
    });

    it("accepts all valid capture_types", () => {
      for (const t of ["manual", "tag", "proactive", "replay", "braindump", "template"]) {
        expect(validateAddInput({ ...VALID_INPUT, capture_type: t }).valid).toBe(true);
      }
    });

    it("rejects invalid content_type", () => {
      expect(validateAddInput({ ...VALID_INPUT, content_type: "note" }).valid).toBe(false);
    });

    it("accepts all valid content_types", () => {
      for (const t of ["workflow", "decision", "process", "policy", "integration", "reference"]) {
        expect(validateAddInput({ ...VALID_INPUT, content_type: t }).valid).toBe(true);
      }
    });

    it("rejects confidence out of range", () => {
      expect(validateAddInput({ ...VALID_INPUT, confidence: -0.1 }).valid).toBe(false);
      expect(validateAddInput({ ...VALID_INPUT, confidence: 1.1 }).valid).toBe(false);
    });

    it("accepts confidence at boundaries", () => {
      expect(validateAddInput({ ...VALID_INPUT, confidence: 0 }).valid).toBe(true);
      expect(validateAddInput({ ...VALID_INPUT, confidence: 1 }).valid).toBe(true);
    });

    it("accepts input without optional fields", () => {
      expect(validateAddInput({ channel: "telegram", raw_content: "test" }).valid).toBe(true);
    });
  });

  describe("validateUpdateInput", () => {
    it("accepts valid update with refined_content", () => {
      expect(validateUpdateInput({ refined_content: "refined text" })).toEqual({ valid: true });
    });

    it("accepts valid update with status", () => {
      expect(validateUpdateInput({ status: "refined" })).toEqual({ valid: true });
    });

    it("rejects empty update", () => {
      expect(validateUpdateInput({}).valid).toBe(false);
    });

    it("rejects null input", () => {
      expect(validateUpdateInput(null).valid).toBe(false);
    });

    it("rejects invalid content_type", () => {
      expect(validateUpdateInput({ content_type: "invalid" }).valid).toBe(false);
    });

    it("rejects invalid status", () => {
      expect(validateUpdateInput({ status: "invalid" }).valid).toBe(false);
    });

    it("accepts all valid statuses", () => {
      for (const s of ["queued", "refined", "approved", "written", "dismissed"]) {
        expect(validateUpdateInput({ status: s }).valid).toBe(true);
      }
    });
  });

  describe("addCapture", () => {
    it("inserts and returns the new item", async () => {
      const mockSql = createMockSql([MOCK_ITEM]);
      const result = await addCapture(mockSql, VALID_INPUT);
      expect(result).toEqual(MOCK_ITEM);
      expect(mockSql.calls.length).toBe(1);
      expect(mockSql.calls[0].type).toBe("tagged");
    });

    it("passes defaults for optional fields", async () => {
      const mockSql = createMockSql([MOCK_ITEM]);
      await addCapture(mockSql, { channel: "telegram", raw_content: "test" });
      expect(mockSql.calls.length).toBe(1);
    });
  });

  describe("listQueue", () => {
    it("returns items and total count", async () => {
      let callCount = 0;
      const mockSql: any = function (...args: any[]) {
        callCount++;
        if (callCount === 1) return Promise.resolve([{ total: 5 }]);
        return Promise.resolve([MOCK_ITEM]);
      };
      const result = await listQueue(mockSql, {});
      expect(result.total).toBe(5);
      expect(result.items).toEqual([MOCK_ITEM]);
    });

    it("calls sql twice (count + items)", async () => {
      let callCount = 0;
      const mockSql: any = function () {
        callCount++;
        if (callCount === 1) return Promise.resolve([{ total: 0 }]);
        return Promise.resolve([]);
      };
      await listQueue(mockSql, { status: "queued" });
      expect(callCount).toBe(2);
    });

    it("passes filters through to parameterized query", async () => {
      let callCount = 0;
      const mockSql: any = function () {
        callCount++;
        if (callCount === 1) return Promise.resolve([{ total: 0 }]);
        return Promise.resolve([]);
      };
      await listQueue(mockSql, { channel: "voice", limit: 500 });
      expect(callCount).toBe(2);
    });
  });

  describe("getCapture", () => {
    it("returns item by ID", async () => {
      const mockSql = createMockSql([MOCK_ITEM]);
      const result = await getCapture(mockSql, "a1b2c3d4-e5f6-7890-abcd-ef1234567890");
      expect(result).toEqual(MOCK_ITEM);
    });

    it("returns null for invalid UUID", async () => {
      const mockSql = createMockSql();
      const result = await getCapture(mockSql, "not-a-uuid");
      expect(result).toBeNull();
      expect(mockSql.calls.length).toBe(0);
    });

    it("returns null when not found", async () => {
      const mockSql = createMockSql([]);
      const result = await getCapture(mockSql, "a1b2c3d4-e5f6-7890-abcd-ef1234567890");
      expect(result).toBeNull();
    });
  });

  describe("updateCapture", () => {
    it("updates and returns the item", async () => {
      const updated = { ...MOCK_ITEM, refined_content: "refined" };
      const mockSql = createMockSql([updated]);
      const result = await updateCapture(mockSql, MOCK_ITEM.id, { refined_content: "refined" });
      expect(result).toEqual(updated);
    });

    it("returns null for invalid UUID", async () => {
      const mockSql = createMockSql();
      const result = await updateCapture(mockSql, "bad", { refined_content: "test" });
      expect(result).toBeNull();
    });

    it("returns null when not found", async () => {
      const mockSql = createMockSql([]);
      const result = await updateCapture(mockSql, MOCK_ITEM.id, { status: "refined" });
      expect(result).toBeNull();
    });
  });

  describe("approveCapture", () => {
    it("approves and sets processed_at", async () => {
      const approved = { ...MOCK_ITEM, status: "approved", processed_at: "2026-03-16T12:05:00Z" };
      const mockSql = createMockSql([approved]);
      const result = await approveCapture(mockSql, MOCK_ITEM.id);
      expect(result).toEqual(approved);
      expect(result!.status).toBe("approved");
    });

    it("returns null for invalid UUID", async () => {
      const mockSql = createMockSql();
      const result = await approveCapture(mockSql, "bad-id");
      expect(result).toBeNull();
    });

    it("returns null when item not in approvable state", async () => {
      const mockSql = createMockSql([]);
      const result = await approveCapture(mockSql, MOCK_ITEM.id);
      expect(result).toBeNull();
    });
  });

  describe("dismissCapture", () => {
    it("dismisses and sets processed_at", async () => {
      const dismissed = { ...MOCK_ITEM, status: "dismissed", processed_at: "2026-03-16T12:05:00Z" };
      const mockSql = createMockSql([dismissed]);
      const result = await dismissCapture(mockSql, MOCK_ITEM.id);
      expect(result).toEqual(dismissed);
      expect(result!.status).toBe("dismissed");
    });

    it("returns null for invalid UUID", async () => {
      const mockSql = createMockSql();
      const result = await dismissCapture(mockSql, "bad-id");
      expect(result).toBeNull();
    });
  });

  describe("getStats", () => {
    it("returns aggregated stats", async () => {
      let callIndex = 0;
      const responses = [
        [{ total: 10 }],                              // total
        [{ status: "queued", count: 5 }, { status: "refined", count: 3 }, { status: "approved", count: 2 }],
        [{ content_type: "workflow", count: 4 }, { content_type: "decision", count: 6 }],
        [{ channel: "telegram", count: 7 }, { channel: "voice", count: 3 }],
        [{ date: "2026-03-16", count: 3 }, { date: "2026-03-15", count: 7 }],
      ];
      const mockSql: any = function () {
        return Promise.resolve(responses[callIndex++]);
      };

      const stats = await getStats(mockSql);
      expect(stats.total).toBe(10);
      expect(stats.by_status.queued).toBe(5);
      expect(stats.by_status.refined).toBe(3);
      expect(stats.by_status.approved).toBe(2);
      expect(stats.by_type.workflow).toBe(4);
      expect(stats.by_type.decision).toBe(6);
      expect(stats.by_channel.telegram).toBe(7);
      expect(stats.by_channel.voice).toBe(3);
      expect(stats.recent_activity).toHaveLength(2);
      expect(stats.recent_activity[0].date).toBe("2026-03-16");
    });
  });
});
