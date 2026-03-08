/**
 * ELLIE-650 — Setup Tier 3: Working Memory (ellie-forest + Postgres)
 *
 * Verifies Tier 3 infrastructure: Postgres running, Forest DB exists,
 * working_memory table schema, Working Memory API lifecycle (init, read,
 * update, checkpoint, promote), and Forest Bridge connectivity.
 */

import { describe, test, expect, afterAll } from "bun:test";
import sql from "../../ellie-forest/src/db";

const WM_API = "http://localhost:3001/api/working-memory";
const BRIDGE_API = "http://localhost:3001/api/bridge";
const BRIDGE_KEY = "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";

const TEST_SESSION = `test-650-${Date.now()}`;
const TEST_AGENT = "test-agent-650";

// Track IDs for cleanup
const createdMemoryIds: string[] = [];

afterAll(async () => {
  // Clean up working memory test records
  await sql`DELETE FROM working_memory WHERE session_id = ${TEST_SESSION}`;
  // Clean up bridge test writes
  for (const id of createdMemoryIds) {
    await sql`DELETE FROM shared_memories WHERE id = ${id}`.catch(() => {});
  }
});

// ── Infrastructure Checks ───────────────────────────────────

describe("Tier 3 Infrastructure", () => {
  test("Postgres is running and Forest DB exists", async () => {
    const [result] = await sql`SELECT current_database() as db`;
    expect(result.db).toBe("ellie-forest");
  });

  test("working_memory table exists with correct columns", async () => {
    const columns = await sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'working_memory'
      ORDER BY ordinal_position
    `;

    const colNames = columns.map((c: { column_name: string }) => c.column_name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("session_id");
    expect(colNames).toContain("agent");
    expect(colNames).toContain("sections");
    expect(colNames).toContain("turn_number");
    expect(colNames).toContain("channel");
    expect(colNames).toContain("created_at");
    expect(colNames).toContain("updated_at");
    expect(colNames).toContain("archived_at");
  });

  test("working_memory has unique index on active sessions", async () => {
    const indexes = await sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'working_memory'
    `;
    const names = indexes.map((i: { indexname: string }) => i.indexname);
    expect(names.some((n: string) => n.includes("active_session"))).toBe(true);
  });

  test("shared_memories table exists (Forest Bridge storage)", async () => {
    const [result] = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'shared_memories'
      ) as exists
    `;
    expect(result.exists).toBe(true);
  });

  test("knowledge_scopes table exists (scope tree)", async () => {
    const [result] = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'knowledge_scopes'
      ) as exists
    `;
    expect(result.exists).toBe(true);
  });
});

// ── Working Memory API: Init ────────────────────────────────

describe("Working Memory API — init", () => {
  test("creates a new working memory session", async () => {
    const res = await fetch(`${WM_API}/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: TEST_SESSION,
        agent: TEST_AGENT,
        sections: {
          session_identity: "ELLIE-650 test session",
          task_stack: "1. Verify infrastructure",
        },
        channel: "test",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.working_memory).toBeDefined();
    expect(data.working_memory.session_id).toBe(TEST_SESSION);
    expect(data.working_memory.agent).toBe(TEST_AGENT);
    expect(data.working_memory.sections.session_identity).toBe("ELLIE-650 test session");
    expect(data.working_memory.turn_number).toBe(0);
    expect(data.working_memory.channel).toBe("test");
  });

  test("re-init replaces existing session", async () => {
    const res = await fetch(`${WM_API}/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: TEST_SESSION,
        agent: TEST_AGENT,
        sections: {
          session_identity: "ELLIE-650 re-initialized",
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.working_memory.sections.session_identity).toBe("ELLIE-650 re-initialized");
    // task_stack should be gone since we re-initialized with only session_identity
    expect(data.working_memory.sections.task_stack).toBeUndefined();
  });
});

// ── Working Memory API: Read ────────────────────────────────

describe("Working Memory API — read", () => {
  test("reads an active working memory session", async () => {
    const res = await fetch(
      `${WM_API}/read?session_id=${TEST_SESSION}&agent=${TEST_AGENT}`
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.working_memory).toBeDefined();
    expect(data.working_memory.session_id).toBe(TEST_SESSION);
  });

  test("returns 404 for non-existent session", async () => {
    const res = await fetch(
      `${WM_API}/read?session_id=nonexistent-session-650&agent=ghost`
    );

    expect(res.status).toBe(404);
  });
});

// ── Working Memory API: Update ──────────────────────────────

describe("Working Memory API — update", () => {
  test("merges new sections into existing session", async () => {
    const res = await fetch(`${WM_API}/update`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: TEST_SESSION,
        agent: TEST_AGENT,
        sections: {
          task_stack: "1. [done] Verify infra\n2. [active] Run tests",
          investigation_state: "Exploring working memory endpoints",
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    // Original section should still be there
    expect(data.working_memory.sections.session_identity).toBe("ELLIE-650 re-initialized");
    // New sections should be merged in
    expect(data.working_memory.sections.task_stack).toContain("Run tests");
    expect(data.working_memory.sections.investigation_state).toContain("Exploring");
  });

  test("overwrites an existing section", async () => {
    const res = await fetch(`${WM_API}/update`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: TEST_SESSION,
        agent: TEST_AGENT,
        sections: {
          task_stack: "All tasks complete",
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.working_memory.sections.task_stack).toBe("All tasks complete");
    // Other sections preserved
    expect(data.working_memory.sections.session_identity).toBe("ELLIE-650 re-initialized");
  });
});

// ── Working Memory API: Checkpoint ──────────────────────────

describe("Working Memory API — checkpoint", () => {
  test("increments turn number", async () => {
    // Read current turn
    const readRes = await fetch(
      `${WM_API}/read?session_id=${TEST_SESSION}&agent=${TEST_AGENT}`
    );
    const readData = await readRes.json();
    const currentTurn = readData.working_memory.turn_number;

    // Checkpoint
    const res = await fetch(`${WM_API}/checkpoint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: TEST_SESSION,
        agent: TEST_AGENT,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.working_memory.turn_number).toBe(currentTurn + 1);
  });

  test("multiple checkpoints increment sequentially", async () => {
    const res1 = await fetch(`${WM_API}/checkpoint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: TEST_SESSION, agent: TEST_AGENT }),
    });
    const data1 = await res1.json();
    const turn1 = data1.working_memory.turn_number;

    const res2 = await fetch(`${WM_API}/checkpoint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: TEST_SESSION, agent: TEST_AGENT }),
    });
    const data2 = await res2.json();
    expect(data2.working_memory.turn_number).toBe(turn1 + 1);
  });
});

// ── Working Memory API: Promote ─────────────────────────────

describe("Working Memory API — promote", () => {
  test("archives the working memory session", async () => {
    // Add a decision to promote
    await fetch(`${WM_API}/update`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: TEST_SESSION,
        agent: TEST_AGENT,
        sections: {
          decision_log: "Decision: Use Postgres for working memory because it provides ACID guarantees",
        },
      }),
    });

    const res = await fetch(`${WM_API}/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: TEST_SESSION,
        agent: TEST_AGENT,
        scope_path: "2/1",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    // Session should now be archived — read returns 404
    const readRes = await fetch(
      `${WM_API}/read?session_id=${TEST_SESSION}&agent=${TEST_AGENT}`
    );
    expect(readRes.status).toBe(404);
  });
});

// ── Forest Bridge API ───────────────────────────────────────

describe("Forest Bridge API", () => {
  test("GET /api/bridge/scopes returns scope tree", async () => {
    const res = await fetch(`${BRIDGE_API}/scopes`, {
      headers: { "x-bridge-key": BRIDGE_KEY },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(Array.isArray(data.scopes)).toBe(true);
    expect(data.scopes.length).toBeGreaterThan(0);
    // Should have a top-level scope
    expect(data.scopes.some((s: { path: string }) => s.path === "1" || s.path === "2")).toBe(true);
  });

  test("POST /api/bridge/write stores a memory", async () => {
    const res = await fetch(`${BRIDGE_API}/write`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-key": BRIDGE_KEY,
      },
      body: JSON.stringify({
        content: `ELLIE-650 bridge write test ${Date.now()}`,
        type: "fact",
        scope_path: "2/1",
        confidence: 0.5,
        metadata: { work_item_id: "ELLIE-650", test: true },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.memory_id).toBeTruthy();
    createdMemoryIds.push(data.memory_id);
  });

  test("POST /api/bridge/read searches memories", async () => {
    const res = await fetch(`${BRIDGE_API}/read`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-key": BRIDGE_KEY,
      },
      body: JSON.stringify({
        query: "ELLIE-650",
        scope_path: "2/1",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(Array.isArray(data.memories)).toBe(true);
  });

  test("rejects requests without bridge key", async () => {
    const res = await fetch(`${BRIDGE_API}/scopes`);
    // Should fail without auth
    expect(res.status).toBe(401);
  });

  test("rejects invalid bridge key", async () => {
    const res = await fetch(`${BRIDGE_API}/scopes`, {
      headers: { "x-bridge-key": "bk_invalid_key_here" },
    });
    expect(res.status).toBe(401);
  });
});

// ── Direct DB Verification ──────────────────────────────────

describe("Direct DB — Working Memory", () => {
  test("can insert and read working memory directly", async () => {
    const sessionId = `direct-test-650-${Date.now()}`;

    const [row] = await sql`
      INSERT INTO working_memory (session_id, agent, sections, turn_number)
      VALUES (${sessionId}, 'direct-agent', ${{ test: true }}::jsonb, 0)
      RETURNING id, session_id, agent, sections, turn_number
    `;

    expect(row.session_id).toBe(sessionId);
    expect(row.agent).toBe("direct-agent");
    expect(row.sections.test).toBe(true);
    expect(row.turn_number).toBe(0);

    // Clean up
    await sql`DELETE FROM working_memory WHERE session_id = ${sessionId}`;
  });

  test("unique index prevents duplicate active sessions", async () => {
    const sessionId = `dup-test-650-${Date.now()}`;

    await sql`
      INSERT INTO working_memory (session_id, agent, sections)
      VALUES (${sessionId}, 'dup-agent', '{}'::jsonb)
    `;

    let threw = false;
    try {
      await sql`
        INSERT INTO working_memory (session_id, agent, sections)
        VALUES (${sessionId}, 'dup-agent', '{}'::jsonb)
      `;
    } catch (e: unknown) {
      threw = true;
      expect((e as Error).message).toContain("unique");
    }
    expect(threw).toBe(true);

    // Clean up
    await sql`DELETE FROM working_memory WHERE session_id = ${sessionId}`;
  });

  test("archived sessions don't conflict with new ones", async () => {
    const sessionId = `archive-test-650-${Date.now()}`;

    // Insert and archive
    await sql`
      INSERT INTO working_memory (session_id, agent, sections, archived_at)
      VALUES (${sessionId}, 'archive-agent', '{}'::jsonb, NOW())
    `;

    // Should be able to insert a new active one with same session/agent
    const [row] = await sql`
      INSERT INTO working_memory (session_id, agent, sections)
      VALUES (${sessionId}, 'archive-agent', '{"new": true}'::jsonb)
      RETURNING id
    `;
    expect(row.id).toBeTruthy();

    // Clean up
    await sql`DELETE FROM working_memory WHERE session_id = ${sessionId}`;
  });
});

// ── Relay ↔ Forest DB Connection ────────────────────────────

describe("Relay ↔ Forest DB", () => {
  test("relay is running and responds", async () => {
    const res = await fetch("http://localhost:3001/health");
    // 200 = healthy, 503 = degraded but running — both prove relay is alive
    expect([200, 503]).toContain(res.status);
  });

  test("relay can write to Forest via Bridge", async () => {
    const content = `ELLIE-650 relay-forest connectivity test ${Date.now()}`;
    const res = await fetch(`${BRIDGE_API}/write`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-key": BRIDGE_KEY,
      },
      body: JSON.stringify({
        content,
        type: "fact",
        scope_path: "2/1",
        confidence: 0.3,
      }),
    });

    const data = await res.json();
    expect(data.success).toBe(true);
    createdMemoryIds.push(data.memory_id);

    // Verify it landed in the DB
    const [row] = await sql`
      SELECT content FROM shared_memories WHERE id = ${data.memory_id}
    `;
    expect(row.content).toBe(content);
  });
});
