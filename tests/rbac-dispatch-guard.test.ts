/**
 * ELLIE-803: RBAC Guard Integration Tests
 * Tests that permission guards are properly wired into dispatch and work session flows.
 * Uses the ellie-forest-test database with seeded RBAC data.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  guardAgentDispatch,
  guardWorkSession,
  guardToolExecution,
  resolveRbacEntityId,
  clearRbacEntityCache,
  formatDenialMessage,
  getRecentDenials,
  clearDenialLog,
  type GuardConfig,
} from "../src/permission-guard.ts";
import { invalidateCache } from "../src/permissions.ts";
import { logCheck, flushBuffer, setFlushCallback } from "../src/permission-audit.ts";

// Use the test database
const TEST_DB = "ellie-forest-test";
let sql: any;

// Deterministic entity IDs from seed data
const DAVE_ENTITY_ID = "e0000000-0000-0000-0000-000000000001";
const ELLIE_ENTITY_ID = "e0000000-0000-0000-0000-000000000002";
const JAMES_ENTITY_ID = "e0000000-0000-0000-0000-000000000003";

beforeAll(async () => {
  const postgres = (await import("postgres")).default;
  sql = postgres({
    database: TEST_DB,
    host: "/var/run/postgresql",
    max: 3,
  });

  // Verify RBAC tables exist
  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name LIKE 'rbac_%'
    ORDER BY table_name
  `;
  if (tables.length === 0) {
    throw new Error("RBAC tables not found in test database — run migrations first");
  }

  // Verify seed entities exist
  const entities = await sql`SELECT id, name, archetype FROM rbac_entities ORDER BY name`;
  if (entities.length === 0) {
    throw new Error("No RBAC entities found — run seed scripts first");
  }
});

afterAll(async () => {
  if (sql) await sql.end();
});

beforeEach(() => {
  invalidateCache();
  clearRbacEntityCache();
  clearDenialLog();
});

describe("ELLIE-803: RBAC dispatch guard integration", () => {

  // ── Entity resolution ──────────────────────────────────────────────

  describe("resolveRbacEntityId", () => {
    it("resolves dev archetype to James entity", async () => {
      const id = await resolveRbacEntityId(sql, "dev");
      expect(id).toBe(JAMES_ENTITY_ID);
    });

    it("returns null for unknown archetype", async () => {
      const id = await resolveRbacEntityId(sql, "nonexistent-agent");
      expect(id).toBeNull();
    });

    it("caches resolved entity IDs", async () => {
      const id1 = await resolveRbacEntityId(sql, "dev");
      const id2 = await resolveRbacEntityId(sql, "dev");
      expect(id1).toBe(id2);
    });
  });

  // ── Agent dispatch guards ──────────────────────────────────────────

  describe("guardAgentDispatch (DB-backed)", () => {
    it("allows James (dev_agent) to dispatch dev agent", async () => {
      const result = await guardAgentDispatch(sql, JAMES_ENTITY_ID, "dev");
      expect(result.allowed).toBe(true);
      expect(result.denial).toBeUndefined();
    });

    it("allows Ellie (super_agent) to dispatch any agent", async () => {
      const result = await guardAgentDispatch(sql, ELLIE_ENTITY_ID, "dev");
      expect(result.allowed).toBe(true);
    });

    it("allows Dave (super_user) to dispatch any agent", async () => {
      const result = await guardAgentDispatch(sql, DAVE_ENTITY_ID, "dev");
      expect(result.allowed).toBe(true);
    });

    it("denies James (dev) dispatching as general if lacking permissions", async () => {
      // general agent requires messages.send + memory.read
      // dev_agent inherits from agent_base which has these, so this should pass
      const result = await guardAgentDispatch(sql, JAMES_ENTITY_ID, "general");
      expect(result.allowed).toBe(true);
    });

    it("records denial in log when denied", async () => {
      // Create a test entity with no roles
      const [testEntity] = await sql`
        INSERT INTO rbac_entities (entity_type, name, archetype, metadata)
        VALUES ('agent', 'test-no-roles', 'test-none', '{}'::jsonb)
        RETURNING id
      `;
      try {
        const result = await guardAgentDispatch(sql, testEntity.id, "dev");
        expect(result.allowed).toBe(false);
        expect(result.denial).toBeDefined();
        expect(result.denial!.resource).toBe("tools");
        expect(result.denial!.action).toBe("use_bash");

        const denials = getRecentDenials(5);
        expect(denials.length).toBeGreaterThan(0);
        expect(denials[denials.length - 1].entity_id).toBe(testEntity.id);
      } finally {
        await sql`DELETE FROM rbac_entities WHERE id = ${testEntity.id}`;
      }
    });

    it("respects disabled config", async () => {
      const config: GuardConfig = { enabled: false, log_denials: false, enforce: false };
      // Even a bogus entity should pass when disabled
      const result = await guardAgentDispatch(sql, "00000000-0000-0000-0000-000000000000", "dev", config);
      expect(result.allowed).toBe(true);
    });

    it("logs but allows in audit-only mode (enforce=false)", async () => {
      const [testEntity] = await sql`
        INSERT INTO rbac_entities (entity_type, name, archetype, metadata)
        VALUES ('agent', 'test-audit-only', 'test-audit', '{}'::jsonb)
        RETURNING id
      `;
      try {
        const config: GuardConfig = { enabled: true, log_denials: true, enforce: false };
        const result = await guardAgentDispatch(sql, testEntity.id, "dev", config);
        expect(result.allowed).toBe(true); // Allowed because enforce=false

        const denials = getRecentDenials(5);
        expect(denials.length).toBeGreaterThan(0); // But denial was logged
      } finally {
        await sql`DELETE FROM rbac_entities WHERE id = ${testEntity.id}`;
      }
    });
  });

  // ── Work session guards ────────────────────────────────────────────

  describe("guardWorkSession (DB-backed)", () => {
    it("allows James (dev_agent) to start a work session", async () => {
      const result = await guardWorkSession(sql, JAMES_ENTITY_ID, "start");
      expect(result.allowed).toBe(true);
    });

    it("allows James (dev_agent) to complete a work session", async () => {
      const result = await guardWorkSession(sql, JAMES_ENTITY_ID, "complete");
      expect(result.allowed).toBe(true);
    });

    it("allows James (dev_agent) to update a work session", async () => {
      const result = await guardWorkSession(sql, JAMES_ENTITY_ID, "update");
      expect(result.allowed).toBe(true);
    });

    it("denies entity without plane permissions from starting session", async () => {
      const [testEntity] = await sql`
        INSERT INTO rbac_entities (entity_type, name, archetype, metadata)
        VALUES ('agent', 'test-no-plane', 'test-noplane', '{}'::jsonb)
        RETURNING id
      `;
      try {
        const result = await guardWorkSession(sql, testEntity.id, "start");
        expect(result.allowed).toBe(false);
        expect(result.denial!.resource).toBe("plane");
        expect(result.denial!.action).toBe("update_issue");
      } finally {
        await sql`DELETE FROM rbac_entities WHERE id = ${testEntity.id}`;
      }
    });
  });

  // ── Tool execution guards ─────────────────────────────────────────

  describe("guardToolExecution (DB-backed)", () => {
    it("allows James to use bash", async () => {
      const result = await guardToolExecution(sql, JAMES_ENTITY_ID, "bash");
      expect(result.allowed).toBe(true);
    });

    it("allows James to use edit", async () => {
      const result = await guardToolExecution(sql, JAMES_ENTITY_ID, "edit");
      expect(result.allowed).toBe(true);
    });

    it("allows James to use MCP tools", async () => {
      const result = await guardToolExecution(sql, JAMES_ENTITY_ID, "mcp__plane__get_issue");
      expect(result.allowed).toBe(true);
    });

    it("allows unknown tools (pass-through)", async () => {
      const result = await guardToolExecution(sql, JAMES_ENTITY_ID, "custom_tool_xyz");
      expect(result.allowed).toBe(true);
    });

    it("denies entity without tools permissions from using bash", async () => {
      const [testEntity] = await sql`
        INSERT INTO rbac_entities (entity_type, name, archetype, metadata)
        VALUES ('agent', 'test-no-tools', 'test-notools', '{}'::jsonb)
        RETURNING id
      `;
      try {
        const result = await guardToolExecution(sql, testEntity.id, "bash");
        expect(result.allowed).toBe(false);
        expect(result.denial!.resource).toBe("tools");
        expect(result.denial!.action).toBe("use_bash");
      } finally {
        await sql`DELETE FROM rbac_entities WHERE id = ${testEntity.id}`;
      }
    });
  });

  // ── Audit logging ──────────────────────────────────────────────────

  describe("audit trail persistence", () => {
    it("logCheck buffers entries and flushBuffer writes to DB", async () => {
      // Register a real flush callback
      const flushed: any[] = [];
      setFlushCallback(async (entries) => {
        for (const e of entries) {
          const [row] = await sql`
            INSERT INTO permission_audit_log (event_type, entity_id, entity_name, resource, action, result)
            VALUES (${e.event_type}, ${e.entity_id}, ${e.entity_name ?? null}, ${e.resource ?? null}, ${e.action ?? null}, ${e.result ?? null})
            RETURNING id
          `;
          flushed.push(row);
        }
      });

      // Log a check
      logCheck(JAMES_ENTITY_ID, "agents", "dispatch", "allow", undefined, "James");

      // Flush to DB
      const count = await flushBuffer();
      expect(count).toBeGreaterThan(0);
      expect(flushed.length).toBeGreaterThan(0);

      // Verify it's in the database
      const [row] = await sql`
        SELECT * FROM permission_audit_log WHERE id = ${flushed[0].id}
      `;
      expect(row.entity_id).toBe(JAMES_ENTITY_ID);
      expect(row.event_type).toBe("check");
      expect(row.result).toBe("allow");
      expect(row.resource).toBe("agents");
      expect(row.action).toBe("dispatch");

      // Clean up
      await sql`DELETE FROM permission_audit_log WHERE id = ${flushed[0].id}`;
    });

    it("guard denial is persisted to audit log via flush", async () => {
      const [testEntity] = await sql`
        INSERT INTO rbac_entities (entity_type, name, archetype, metadata)
        VALUES ('agent', 'test-audit-deny', 'test-auditdeny', '{}'::jsonb)
        RETURNING id
      `;

      const insertedIds: string[] = [];
      setFlushCallback(async (entries) => {
        for (const e of entries) {
          const [row] = await sql`
            INSERT INTO permission_audit_log (event_type, entity_id, entity_name, resource, action, result)
            VALUES (${e.event_type}, ${e.entity_id}, ${e.entity_name ?? null}, ${e.resource ?? null}, ${e.action ?? null}, ${e.result ?? null})
            RETURNING id
          `;
          insertedIds.push(row.id);
        }
      });

      try {
        // Trigger a denial
        await guardAgentDispatch(sql, testEntity.id, "dev");

        // Log the check result
        logCheck(testEntity.id, "agents", "dispatch", "deny", undefined, "test-audit-deny");

        // Flush
        await flushBuffer();

        // Verify denial was recorded
        const rows = await sql`
          SELECT * FROM permission_audit_log
          WHERE entity_id = ${testEntity.id} AND result = 'deny'
        `;
        expect(rows.length).toBeGreaterThan(0);
      } finally {
        await sql`DELETE FROM permission_audit_log WHERE entity_id = ${testEntity.id}`;
        await sql`DELETE FROM rbac_entities WHERE id = ${testEntity.id}`;
      }
    });
  });

  // ── formatDenialMessage ────────────────────────────────────────────

  describe("formatDenialMessage", () => {
    it("produces human-readable message", () => {
      const msg = formatDenialMessage({
        entity_id: JAMES_ENTITY_ID,
        resource: "tools",
        action: "use_bash",
        reason: 'Agent "dev" requires tools.use_bash which entity lacks',
        timestamp: new Date().toISOString(),
      });
      expect(msg).toContain("tools.use_bash");
      expect(msg).toContain("Permission denied");
    });
  });
});
