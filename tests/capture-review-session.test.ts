import { describe, it, expect, beforeEach } from "bun:test";
import {
  isReviewTrigger,
  parseReviewAction,
  startReviewSession,
  getReviewSession,
  isReviewActive,
  getCurrentItem,
  processAction,
  buildItemPresentation,
  buildSummary,
  buildStartMessage,
  _clearSessions,
  type ReviewSession,
} from "../src/capture/review-session.ts";

beforeEach(() => _clearSessions());

const MOCK_ITEMS = [
  {
    id: "item-1",
    source_message_id: null,
    channel: "telegram",
    raw_content: "We always deploy to staging first",
    refined_content: null,
    suggested_path: null,
    suggested_section: null,
    capture_type: "tag",
    content_type: "process",
    status: "queued",
    confidence: 0.8,
    created_at: "2026-03-16T10:00:00Z",
    updated_at: "2026-03-16T10:00:00Z",
    processed_at: null,
  },
  {
    id: "item-2",
    source_message_id: null,
    channel: "ellie-chat",
    raw_content: "We decided to use Postgres over MongoDB",
    refined_content: null,
    suggested_path: null,
    suggested_section: null,
    capture_type: "manual",
    content_type: "decision",
    status: "queued",
    confidence: 0.9,
    created_at: "2026-03-16T10:05:00Z",
    updated_at: "2026-03-16T10:05:00Z",
    processed_at: null,
  },
  {
    id: "item-3",
    source_message_id: null,
    channel: "voice",
    raw_content: "The API endpoint requires OAuth2 token auth",
    refined_content: null,
    suggested_path: null,
    suggested_section: null,
    capture_type: "proactive",
    content_type: "integration",
    status: "queued",
    confidence: 0.7,
    created_at: "2026-03-16T10:10:00Z",
    updated_at: "2026-03-16T10:10:00Z",
    processed_at: null,
  },
];

function createMockSql(items: any[] = MOCK_ITEMS) {
  const calls: any[] = [];
  const fn: any = function (...args: any[]) {
    calls.push(args);
    return Promise.resolve(items);
  };
  fn.calls = calls;
  return fn;
}

describe("ELLIE-776: Guided capture review session", () => {
  describe("isReviewTrigger", () => {
    it("detects review phrases", () => {
      expect(isReviewTrigger("review captures")).toBe(true);
      expect(isReviewTrigger("let's review")).toBe(true);
      expect(isReviewTrigger("capture review")).toBe(true);
      expect(isReviewTrigger("review queue")).toBe(true);
      expect(isReviewTrigger("review flagged")).toBe(true);
    });

    it("is case insensitive", () => {
      expect(isReviewTrigger("Review Captures")).toBe(true);
      expect(isReviewTrigger("LET'S REVIEW")).toBe(true);
    });

    it("rejects non-trigger phrases", () => {
      expect(isReviewTrigger("hello")).toBe(false);
      expect(isReviewTrigger("review my code")).toBe(false);
    });
  });

  describe("parseReviewAction", () => {
    it("parses approve actions", () => {
      expect(parseReviewAction("approve")?.action).toBe("approve");
      expect(parseReviewAction("yes")?.action).toBe("approve");
      expect(parseReviewAction("y")?.action).toBe("approve");
      expect(parseReviewAction("lgtm")?.action).toBe("approve");
    });

    it("parses skip actions", () => {
      expect(parseReviewAction("skip")?.action).toBe("skip");
      expect(parseReviewAction("next")?.action).toBe("skip");
      expect(parseReviewAction("pass")?.action).toBe("skip");
    });

    it("parses dismiss actions", () => {
      expect(parseReviewAction("dismiss")?.action).toBe("dismiss");
      expect(parseReviewAction("no")?.action).toBe("dismiss");
      expect(parseReviewAction("drop")?.action).toBe("dismiss");
    });

    it("parses approve all", () => {
      expect(parseReviewAction("approve all")?.action).toBe("approve_all");
      expect(parseReviewAction("approve remaining")?.action).toBe("approve_all");
    });

    it("parses skip all", () => {
      expect(parseReviewAction("skip all")?.action).toBe("skip_all");
      expect(parseReviewAction("done")?.action).toBe("skip_all");
    });

    it("parses edit with content", () => {
      const result = parseReviewAction("edit This is the updated content");
      expect(result?.action).toBe("edit");
      expect(result?.editContent).toBe("This is the updated content");
    });

    it("returns null for unknown actions", () => {
      expect(parseReviewAction("something else")).toBeNull();
      expect(parseReviewAction("maybe later")).toBeNull();
    });
  });

  describe("startReviewSession", () => {
    it("creates session with queued items", async () => {
      const mockSql = createMockSql();
      const session = await startReviewSession(mockSql, "user-1", "telegram");
      expect(session).not.toBeNull();
      expect(session!.items).toHaveLength(3);
      expect(session!.current_index).toBe(0);
      expect(session!.status).toBe("active");
    });

    it("returns null when no items", async () => {
      const mockSql = createMockSql([]);
      const session = await startReviewSession(mockSql, "user-1", "telegram");
      expect(session).toBeNull();
    });
  });

  describe("session state", () => {
    it("retrieves active session", async () => {
      const mockSql = createMockSql();
      await startReviewSession(mockSql, "user-1", "telegram");
      expect(getReviewSession("user-1")).not.toBeNull();
      expect(isReviewActive("user-1")).toBe(true);
    });

    it("returns null for non-existent session", () => {
      expect(getReviewSession("nonexistent")).toBeNull();
      expect(isReviewActive("nonexistent")).toBe(false);
    });
  });

  describe("getCurrentItem", () => {
    it("returns current item with refinement", async () => {
      const mockSql = createMockSql();
      const session = await startReviewSession(mockSql, "user-1", "telegram");
      const current = getCurrentItem(session!);
      expect(current).not.toBeNull();
      expect(current!.item.id).toBe("item-1");
      expect(current!.refinement.markdown).toContain("---");
      expect(current!.refinement.suggested_path).toMatch(/\.md$/);
    });

    it("returns null when past end", async () => {
      const mockSql = createMockSql();
      const session = await startReviewSession(mockSql, "user-1", "telegram");
      session!.current_index = 99;
      expect(getCurrentItem(session!)).toBeNull();
    });

    it("caches refinement results", async () => {
      const mockSql = createMockSql();
      const session = await startReviewSession(mockSql, "user-1", "telegram");
      getCurrentItem(session!);
      getCurrentItem(session!);
      expect(session!.refinements.size).toBe(1);
    });
  });

  describe("processAction", () => {
    it("approve advances to next item", async () => {
      const mockSql = createMockSql();
      await startReviewSession(mockSql, "user-1", "telegram");
      const result = await processAction(mockSql, "user-1", "approve");
      expect(result.moved).toBe(true);
      expect(result.finished).toBe(false);
      const session = getReviewSession("user-1")!;
      expect(session.current_index).toBe(1);
      expect(session.approved).toContain("item-1");
    });

    it("skip advances without DB update", async () => {
      const mockSql = createMockSql();
      await startReviewSession(mockSql, "user-1", "telegram");
      const result = await processAction(mockSql, "user-1", "skip");
      expect(result.moved).toBe(true);
      const session = getReviewSession("user-1")!;
      expect(session.skipped).toContain("item-1");
      // Only 1 SQL call (the initial fetch), skip doesn't call SQL
      expect(mockSql.calls.length).toBe(1);
    });

    it("dismiss advances with DB update", async () => {
      const mockSql = createMockSql();
      await startReviewSession(mockSql, "user-1", "telegram");
      await processAction(mockSql, "user-1", "dismiss");
      const session = getReviewSession("user-1")!;
      expect(session.dismissed).toContain("item-1");
    });

    it("edit does not advance", async () => {
      const mockSql = createMockSql();
      await startReviewSession(mockSql, "user-1", "telegram");
      const result = await processAction(mockSql, "user-1", "edit", "Updated content");
      expect(result.moved).toBe(false);
      expect(result.finished).toBe(false);
      expect(result.message).toContain("Updated");
      const session = getReviewSession("user-1")!;
      expect(session.current_index).toBe(0);
    });

    it("approve_all approves all remaining and finishes", async () => {
      const mockSql = createMockSql();
      await startReviewSession(mockSql, "user-1", "telegram");
      await processAction(mockSql, "user-1", "skip"); // skip first
      const result = await processAction(mockSql, "user-1", "approve_all");
      expect(result.finished).toBe(true);
      expect(result.message).toContain("Approved: 2");
      expect(result.message).toContain("Skipped: 1");
    });

    it("skip_all skips remaining and finishes", async () => {
      const mockSql = createMockSql();
      await startReviewSession(mockSql, "user-1", "telegram");
      await processAction(mockSql, "user-1", "approve"); // approve first
      const result = await processAction(mockSql, "user-1", "skip_all");
      expect(result.finished).toBe(true);
      expect(result.message).toContain("Approved: 1");
      expect(result.message).toContain("Skipped: 2");
    });

    it("finishes after last item", async () => {
      const mockSql = createMockSql([MOCK_ITEMS[0]]); // only 1 item
      await startReviewSession(mockSql, "user-1", "telegram");
      const result = await processAction(mockSql, "user-1", "approve");
      expect(result.finished).toBe(true);
      expect(result.message).toContain("Review Complete");
    });

    it("handles no active session", async () => {
      const mockSql = createMockSql();
      const result = await processAction(mockSql, "nonexistent", "approve");
      expect(result.finished).toBe(true);
      expect(result.message).toContain("No active");
    });
  });

  describe("buildItemPresentation", () => {
    it("formats item with all fields", () => {
      const item = MOCK_ITEMS[0] as any;
      const refinement = {
        content_type: "process" as const,
        confidence: 0.85,
        title: "Staging-First Deploy",
        suggested_path: "processes/staging-first-deploy.md",
        suggested_section: null,
        markdown: "---\ntitle: test\n---\n# Test",
        frontmatter: {},
        summary: "Deploy to staging first",
      };
      const msg = buildItemPresentation(item, refinement, 0, 3);
      expect(msg).toContain("Item 1 of 3");
      expect(msg).toContain("telegram");
      expect(msg).toContain("process");
      expect(msg).toContain("85%");
      expect(msg).toContain("Staging-First Deploy");
      expect(msg).toContain("processes/staging-first-deploy.md");
      expect(msg).toContain("Approve, skip, dismiss, or edit?");
    });
  });

  describe("buildSummary", () => {
    it("includes all counts", () => {
      const session: ReviewSession = {
        id: "test",
        channel: "telegram",
        started_at: "2026-03-16T12:00:00Z",
        items: MOCK_ITEMS as any,
        current_index: 3,
        status: "complete",
        approved: ["item-1"],
        dismissed: ["item-2"],
        skipped: ["item-3"],
        refinements: new Map(),
      };
      const msg = buildSummary(session);
      expect(msg).toContain("Approved: 1");
      expect(msg).toContain("Dismissed: 1");
      expect(msg).toContain("Skipped: 1");
      expect(msg).toContain("Total reviewed: 3");
    });
  });

  describe("buildStartMessage", () => {
    it("shows count", () => {
      expect(buildStartMessage(5, "telegram")).toContain("5 items");
    });

    it("handles singular", () => {
      expect(buildStartMessage(1, "telegram")).toContain("1 item");
    });

    it("handles empty queue", () => {
      expect(buildStartMessage(0, "telegram")).toContain("No items");
    });
  });
});
