import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import {
  findOrphanedItemsPure,
  deduplicateInFlightPure,
  buildCaptureAnchor,
  buildResumptionPrompt,
  saveCaptureSession,
  loadCaptureSession,
  deleteCaptureSession,
  listActiveSessions,
  recoverFromPriorSession,
  type CaptureSessionState,
} from "../src/capture/session-persistence.ts";

const migrationSql = readFileSync(
  new URL("../migrations/supabase/20260316_capture_session_state.sql", import.meta.url),
  "utf-8"
);

function mockSql(returnValue: any = []) {
  const calls: any[] = [];
  const fn: any = function (...args: any[]) {
    calls.push(args);
    return Promise.resolve(returnValue);
  };
  fn.calls = calls;
  return fn;
}

const ACTIVE_SESSION: CaptureSessionState = {
  session_id: "sess-1",
  agent: "dev",
  mode: "review",
  started_at: "2026-03-16T12:00:00Z",
  items_in_flight: ["cap-1", "cap-2", "cap-3"],
  current_index: 1,
  metadata: { source: "telegram" },
};

const IDLE_SESSION: CaptureSessionState = {
  session_id: "sess-2",
  agent: "dev",
  mode: "idle",
  started_at: "2026-03-16T10:00:00Z",
  items_in_flight: [],
  current_index: 0,
  metadata: {},
};

describe("ELLIE-800: Session persistence for captured content", () => {
  describe("migration", () => {
    it("creates capture_session_state table", () => {
      expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS capture_session_state");
    });

    it("has session_id as primary key", () => {
      expect(migrationSql).toContain("session_id TEXT PRIMARY KEY");
    });

    it("has mode check constraint", () => {
      expect(migrationSql).toContain("brain_dump");
      expect(migrationSql).toContain("review");
      expect(migrationSql).toContain("template");
      expect(migrationSql).toContain("idle");
    });

    it("has items_in_flight JSONB", () => {
      expect(migrationSql).toContain("items_in_flight JSONB");
    });

    it("has indexes", () => {
      expect(migrationSql).toContain("idx_capture_session_agent");
      expect(migrationSql).toContain("idx_capture_session_mode");
    });

    it("has updated_at trigger", () => {
      expect(migrationSql).toContain("update_capture_session_updated_at");
    });
  });

  describe("saveCaptureSession", () => {
    it("inserts session state", async () => {
      const sql = mockSql();
      await saveCaptureSession(sql, ACTIVE_SESSION);
      expect(sql.calls).toHaveLength(1);
    });
  });

  describe("loadCaptureSession", () => {
    it("returns session when found", async () => {
      const sql = mockSql([{
        session_id: "sess-1",
        agent: "dev",
        mode: "review",
        started_at: "2026-03-16T12:00:00Z",
        items_in_flight: ["cap-1"],
        current_index: 0,
        metadata: {},
      }]);
      const result = await loadCaptureSession(sql, "sess-1");
      expect(result).not.toBeNull();
      expect(result!.session_id).toBe("sess-1");
      expect(result!.mode).toBe("review");
    });

    it("returns null when not found", async () => {
      const result = await loadCaptureSession(mockSql([]), "nonexistent");
      expect(result).toBeNull();
    });

    it("handles string JSON fields", async () => {
      const sql = mockSql([{
        session_id: "sess-1",
        agent: "dev",
        mode: "review",
        started_at: "2026-03-16T12:00:00Z",
        items_in_flight: '["cap-1","cap-2"]',
        current_index: 1,
        metadata: '{"key":"val"}',
      }]);
      const result = await loadCaptureSession(sql, "sess-1");
      expect(result!.items_in_flight).toEqual(["cap-1", "cap-2"]);
      expect(result!.metadata).toEqual({ key: "val" });
    });
  });

  describe("deleteCaptureSession", () => {
    it("deletes by session_id", async () => {
      const sql = mockSql();
      await deleteCaptureSession(sql, "sess-1");
      expect(sql.calls).toHaveLength(1);
    });
  });

  describe("listActiveSessions", () => {
    it("returns non-idle sessions", async () => {
      const sql = mockSql([{
        session_id: "sess-1", agent: "dev", mode: "review",
        started_at: "2026-03-16T12:00:00Z", items_in_flight: [], current_index: 0, metadata: {},
      }]);
      const result = await listActiveSessions(sql);
      expect(result).toHaveLength(1);
      expect(result[0].mode).toBe("review");
    });
  });

  describe("findOrphanedItemsPure", () => {
    it("finds items not in any active session", () => {
      const items = [
        { id: "cap-1", status: "queued", updated_at: "2026-03-16T10:00:00Z" },
        { id: "cap-2", status: "queued", updated_at: "2026-03-16T10:00:00Z" },
        { id: "cap-3", status: "written", updated_at: "2026-03-16T10:00:00Z" },
      ];
      const activeItems = new Set(["cap-1"]);
      const threshold = new Date("2026-03-16T11:00:00Z");

      const orphans = findOrphanedItemsPure(items, activeItems, threshold);
      expect(orphans).toEqual(["cap-2"]); // cap-1 is active, cap-3 is written
    });

    it("returns empty when all items are active or terminal", () => {
      const items = [
        { id: "cap-1", status: "queued", updated_at: "2026-03-16T10:00:00Z" },
        { id: "cap-2", status: "written", updated_at: "2026-03-16T10:00:00Z" },
      ];
      const orphans = findOrphanedItemsPure(items, new Set(["cap-1"]), new Date("2026-03-16T11:00:00Z"));
      expect(orphans).toEqual([]);
    });

    it("ignores items newer than threshold", () => {
      const items = [
        { id: "cap-1", status: "queued", updated_at: "2026-03-16T12:00:00Z" },
      ];
      const orphans = findOrphanedItemsPure(items, new Set(), new Date("2026-03-16T11:00:00Z"));
      expect(orphans).toEqual([]); // updated after threshold
    });
  });

  describe("deduplicateInFlightPure", () => {
    it("separates unique from duplicate message IDs", () => {
      const existing = new Set(["msg-1", "msg-3"]);
      const result = deduplicateInFlightPure(["msg-1", "msg-2", "msg-3", "msg-4"], existing);
      expect(result.unique).toEqual(["msg-2", "msg-4"]);
      expect(result.duplicates).toEqual(["msg-1", "msg-3"]);
    });

    it("returns all unique when no existing", () => {
      const result = deduplicateInFlightPure(["msg-1", "msg-2"], new Set());
      expect(result.unique).toEqual(["msg-1", "msg-2"]);
      expect(result.duplicates).toEqual([]);
    });

    it("handles empty input", () => {
      const result = deduplicateInFlightPure([], new Set(["msg-1"]));
      expect(result.unique).toEqual([]);
      expect(result.duplicates).toEqual([]);
    });
  });

  describe("buildCaptureAnchor", () => {
    it("builds anchor for active session", () => {
      const anchor = buildCaptureAnchor(ACTIVE_SESSION);
      expect(anchor).toContain("review mode");
      expect(anchor).toContain("3"); // items count
      expect(anchor).toContain("1/3"); // progress
    });

    it("returns empty for idle session", () => {
      expect(buildCaptureAnchor(IDLE_SESSION)).toBe("");
    });
  });

  describe("buildResumptionPrompt", () => {
    it("builds resumption prompt for active session", () => {
      const prompt = buildResumptionPrompt(ACTIVE_SESSION);
      expect(prompt).toContain("review");
      expect(prompt).toContain("3 items");
      expect(prompt).toContain("index 1");
    });

    it("returns empty for idle session", () => {
      expect(buildResumptionPrompt(IDLE_SESSION)).toBe("");
    });
  });

  describe("recoverFromPriorSession", () => {
    it("cleans up stale sessions", async () => {
      let callIdx = 0;
      const sql: any = function () {
        callIdx++;
        if (callIdx === 1) return Promise.resolve([{
          session_id: "old-sess",
          agent: "dev",
          mode: "review",
          items_in_flight: '["cap-1","cap-2"]',
        }]);
        return Promise.resolve([]);
      };

      const report = await recoverFromPriorSession(sql, "new-sess", "dev");
      expect(report.recovered_sessions).toBe(1);
      expect(report.orphaned_items).toBe(2);
      expect(report.actions_taken.length).toBeGreaterThan(0);
    });

    it("returns clean report when no stale sessions", async () => {
      const sql = mockSql([]);
      const report = await recoverFromPriorSession(sql, "new-sess", "dev");
      expect(report.recovered_sessions).toBe(0);
      expect(report.orphaned_items).toBe(0);
    });
  });
});
