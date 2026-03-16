import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import {
  logCheck,
  logChange,
  logRoleAssign,
  logRoleRevoke,
  logPermissionChange,
  writeBatch,
  queryAuditLog,
  getEntityActivity,
  flushBuffer,
  setFlushCallback,
  _getBufferSize,
  _clearBuffer,
  type AuditEntry,
} from "../src/permission-audit.ts";

const migrationSql = readFileSync(
  new URL("../migrations/forest/20260316_permission_audit_log.sql", import.meta.url),
  "utf-8"
);

beforeEach(() => _clearBuffer());

function mockSql(returnValue: any = []) {
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

describe("ELLIE-798: Permission audit logging", () => {
  describe("migration", () => {
    it("creates audit_event_type enum", () => {
      expect(migrationSql).toContain("CREATE TYPE audit_event_type AS ENUM");
      expect(migrationSql).toContain("'check'");
      expect(migrationSql).toContain("'change'");
      expect(migrationSql).toContain("'role_assign'");
      expect(migrationSql).toContain("'role_revoke'");
    });

    it("creates permission_audit_log table", () => {
      expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS permission_audit_log");
    });

    it("has entity_id column", () => {
      expect(migrationSql).toContain("entity_id UUID NOT NULL");
    });

    it("has indexes for common queries", () => {
      expect(migrationSql).toContain("idx_perm_audit_entity");
      expect(migrationSql).toContain("idx_perm_audit_event_type");
      expect(migrationSql).toContain("idx_perm_audit_created");
      expect(migrationSql).toContain("idx_perm_audit_resource");
    });

    it("has partial index on denials", () => {
      expect(migrationSql).toContain("idx_perm_audit_result");
      expect(migrationSql).toContain("WHERE result = 'deny'");
    });

    it("has change tracking fields", () => {
      expect(migrationSql).toContain("changed_by UUID");
      expect(migrationSql).toContain("old_value TEXT");
      expect(migrationSql).toContain("new_value TEXT");
    });
  });

  describe("logCheck (buffered)", () => {
    it("adds to buffer", () => {
      logCheck("entity-1", "git", "commit", "allow");
      expect(_getBufferSize()).toBe(1);
    });

    it("buffers multiple checks", () => {
      logCheck("entity-1", "git", "commit", "allow");
      logCheck("entity-1", "plane", "read_issue", "allow");
      logCheck("entity-2", "tools", "use_bash", "deny");
      expect(_getBufferSize()).toBe(3);
    });

    it("includes scope and entity name", () => {
      logCheck("entity-1", "plane", "read_issue", "allow", "project:ELLIE", "James");
      expect(_getBufferSize()).toBe(1);
    });
  });

  describe("flushBuffer", () => {
    it("flushes buffer to callback", async () => {
      const flushed: AuditEntry[][] = [];
      setFlushCallback(async (entries) => { flushed.push(entries); });

      logCheck("e1", "git", "commit", "allow");
      logCheck("e2", "plane", "read", "deny");
      const count = await flushBuffer();

      expect(count).toBe(2);
      expect(flushed).toHaveLength(1);
      expect(flushed[0]).toHaveLength(2);
      expect(_getBufferSize()).toBe(0);
    });

    it("returns 0 for empty buffer", async () => {
      expect(await flushBuffer()).toBe(0);
    });
  });

  describe("logChange (immediate)", () => {
    it("writes to DB immediately", async () => {
      const sql = mockSql();
      await logChange(sql, {
        event_type: "change",
        entity_id: "entity-1",
        resource: "plane",
        action: "update_issue",
        old_value: "denied",
        new_value: "allowed",
        changed_by: "admin-1",
      });
      expect(sql.calls).toHaveLength(1);
    });
  });

  describe("logRoleAssign", () => {
    it("logs role assignment event", async () => {
      const sql = mockSql();
      await logRoleAssign(sql, "entity-1", "dev_agent", "admin-1");
      expect(sql.calls).toHaveLength(1);
    });
  });

  describe("logRoleRevoke", () => {
    it("logs role revoke event", async () => {
      const sql = mockSql();
      await logRoleRevoke(sql, "entity-1", "dev_agent", "admin-1");
      expect(sql.calls).toHaveLength(1);
    });
  });

  describe("logPermissionChange", () => {
    it("logs permission change with old/new values", async () => {
      const sql = mockSql();
      await logPermissionChange(sql, "tools", "use_bash", "denied", "allowed", "admin-1");
      expect(sql.calls).toHaveLength(1);
    });
  });

  describe("writeBatch", () => {
    it("writes multiple entries", async () => {
      const sql = mockSql();
      const entries: AuditEntry[] = [
        { event_type: "check", entity_id: "e1", resource: "git", action: "commit", result: "allow" },
        { event_type: "check", entity_id: "e2", resource: "git", action: "push", result: "deny" },
      ];
      const written = await writeBatch(sql, entries);
      expect(written).toBe(2);
      expect(sql.calls).toHaveLength(2);
    });

    it("skips failed entries", async () => {
      let callIdx = 0;
      const sql: any = function () {
        callIdx++;
        if (callIdx === 1) return Promise.reject(new Error("fail"));
        return Promise.resolve([]);
      };
      const entries: AuditEntry[] = [
        { event_type: "check", entity_id: "e1" },
        { event_type: "check", entity_id: "e2" },
      ];
      const written = await writeBatch(sql, entries);
      expect(written).toBe(1);
    });
  });

  describe("queryAuditLog", () => {
    it("queries with filters", async () => {
      const sql = mockSql([{ total: 5 }]);
      // Override unsafe to return entries on second call
      let callCount = 0;
      sql.unsafe = (q: string) => {
        callCount++;
        if (q.includes("COUNT")) return Promise.resolve([{ total: 5 }]);
        return Promise.resolve([{ id: "a1", event_type: "check", entity_id: "e1", created_at: "2026-03-16" }]);
      };

      const result = await queryAuditLog(sql, { entity_id: "e1", result: "deny" });
      expect(result.total).toBe(5);
      expect(result.entries).toHaveLength(1);
    });

    it("caps limit at 200", async () => {
      const queries: string[] = [];
      const sql: any = { unsafe: (q: string) => { queries.push(q); return Promise.resolve(q.includes("COUNT") ? [{ total: 0 }] : []); } };
      sql[Symbol.for("tag")] = true;
      await queryAuditLog(sql, { limit: 500 });
      expect(queries.some(q => q.includes("LIMIT 200"))).toBe(true);
    });
  });

  describe("getEntityActivity", () => {
    it("returns activity summary", async () => {
      const sql = mockSql([{ checks: 42, denials: 3, changes: 1 }]);
      const result = await getEntityActivity(sql, "entity-1", 24);
      expect(result.checks).toBe(42);
      expect(result.denials).toBe(3);
      expect(result.changes).toBe(1);
    });
  });
});
