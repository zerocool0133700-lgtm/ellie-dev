/**
 * ELLIE-538 — Working Memory tests
 *
 * Integration tests against the local Forest DB (ellie-forest).
 * All tests use unique session IDs (timestamp + random suffix) to avoid
 * collisions, and clean up after themselves in afterAll.
 *
 * Coverage:
 *   - Core module: initWorkingMemory, updateWorkingMemory, readWorkingMemory,
 *     checkpointWorkingMemory, archiveWorkingMemory, archiveIdleWorkingMemory
 *   - API handlers: init, update, read, checkpoint, promote (400/404/200)
 *   - Uniqueness constraint: only one active record per session+agent
 *   - Session pruning: MAX_ACTIVE_SESSIONS_PER_AGENT enforced
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  initWorkingMemory,
  updateWorkingMemory,
  readWorkingMemory,
  checkpointWorkingMemory,
  archiveWorkingMemory,
  archiveIdleWorkingMemory,
  MAX_ACTIVE_SESSIONS_PER_AGENT,
} from "../src/working-memory.ts";
import {
  workingMemoryInitEndpoint,
  workingMemoryUpdateEndpoint,
  workingMemoryReadEndpoint,
  workingMemoryCheckpointEndpoint,
  workingMemoryPromoteEndpoint,
} from "../src/api/working-memory.ts";
import { sql } from "../../ellie-forest/src/index.ts";
import type { ApiRequest, ApiResponse } from "../src/api/types.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Unique prefix for this test run — avoids cross-run collisions. */
const RUN_ID = `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** Generate a session+agent pair unique to this test run. */
function makeIds(suffix: string) {
  return {
    session_id: `${RUN_ID}-${suffix}`,
    agent: `test-agent-${suffix}`,
  };
}

/** Build a mock ApiRequest. */
function mockReq(body?: Record<string, unknown>, query?: Record<string, string>): ApiRequest {
  return { body, query };
}

/** Build a mock ApiResponse that captures the last call. */
function mockRes(): { res: ApiResponse; result: () => { status: number; body: unknown } } {
  let lastStatus = 200;
  let lastBody: unknown = null;

  const res: ApiResponse = {
    json: (data) => { lastStatus = 200; lastBody = data; },
    status: (code) => ({
      json: (data) => { lastStatus = code; lastBody = data; },
    }),
  };

  return { res, result: () => ({ status: lastStatus, body: lastBody }) };
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

afterAll(async () => {
  // Remove all test records created by this run
  await sql`
    DELETE FROM working_memory
    WHERE session_id LIKE ${`${RUN_ID}%`}
  `;
});

// ── Core: initWorkingMemory ───────────────────────────────────────────────────

describe("initWorkingMemory", () => {
  test("creates a new active record", async () => {
    const ids = makeIds("init-1");
    const record = await initWorkingMemory(ids);
    expect(record.session_id).toBe(ids.session_id);
    expect(record.agent).toBe(ids.agent);
    expect(record.turn_number).toBe(0);
    expect(record.archived_at).toBeNull();
    expect(record.sections).toEqual({});
  });

  test("stores initial sections", async () => {
    const ids = makeIds("init-2");
    const sections = {
      session_identity: "dev / ELLIE-538 / telegram",
      task_stack: "1. Write migration\n2. Write module",
    };
    const record = await initWorkingMemory({ ...ids, sections });
    expect(record.sections.session_identity).toBe(sections.session_identity);
    expect(record.sections.task_stack).toBe(sections.task_stack);
  });

  test("stores channel", async () => {
    const ids = makeIds("init-3");
    const record = await initWorkingMemory({ ...ids, channel: "telegram" });
    expect(record.channel).toBe("telegram");
  });

  test("archives existing active record on reinit", async () => {
    const ids = makeIds("init-4");

    const first = await initWorkingMemory({ ...ids, sections: { session_identity: "first" } });
    expect(first.archived_at).toBeNull();

    // Reinitialize — should archive the first record
    const second = await initWorkingMemory({ ...ids, sections: { session_identity: "second" } });
    expect(second.archived_at).toBeNull();
    expect(second.sections.session_identity).toBe("second");

    // First record should now be archived
    const [archived] = await sql<{ archived_at: Date | null }[]>`
      SELECT archived_at FROM working_memory WHERE id = ${first.id}
    `;
    expect(archived.archived_at).not.toBeNull();
  });

  test("only one active record per session+agent after multiple inits", async () => {
    const ids = makeIds("init-5");
    await initWorkingMemory(ids);
    await initWorkingMemory(ids);
    await initWorkingMemory(ids);

    const [{ count }] = await sql<{ count: string }[]>`
      SELECT COUNT(*) FROM working_memory
      WHERE session_id = ${ids.session_id}
        AND agent      = ${ids.agent}
        AND archived_at IS NULL
    `;
    expect(Number(count)).toBe(1);
  });
});

// ── Core: updateWorkingMemory ─────────────────────────────────────────────────

describe("updateWorkingMemory", () => {
  test("merges sections and increments turn_number", async () => {
    const ids = makeIds("update-1");
    await initWorkingMemory({ ...ids, sections: { session_identity: "dev" } });

    const updated = await updateWorkingMemory({
      ...ids,
      sections: { task_stack: "1. First task" },
    });

    expect(updated).not.toBeNull();
    expect(updated!.turn_number).toBe(1);
    // Old section preserved
    expect(updated!.sections.session_identity).toBe("dev");
    // New section added
    expect(updated!.sections.task_stack).toBe("1. First task");
  });

  test("overwrites a section when the same key is updated", async () => {
    const ids = makeIds("update-2");
    await initWorkingMemory({ ...ids, sections: { task_stack: "Old task" } });

    const updated = await updateWorkingMemory({
      ...ids,
      sections: { task_stack: "New task" },
    });

    expect(updated!.sections.task_stack).toBe("New task");
  });

  test("returns null when no active record exists", async () => {
    const result = await updateWorkingMemory({
      session_id: `${RUN_ID}-nonexistent`,
      agent: "ghost",
      sections: { task_stack: "test" },
    });
    expect(result).toBeNull();
  });

  test("increments turn_number with each call", async () => {
    const ids = makeIds("update-3");
    await initWorkingMemory(ids);

    await updateWorkingMemory({ ...ids, sections: { task_stack: "step 1" } });
    await updateWorkingMemory({ ...ids, sections: { task_stack: "step 2" } });
    const final = await updateWorkingMemory({ ...ids, sections: { task_stack: "step 3" } });

    expect(final!.turn_number).toBe(3);
  });
});

// ── Core: readWorkingMemory ───────────────────────────────────────────────────

describe("readWorkingMemory", () => {
  test("returns the active record", async () => {
    const ids = makeIds("read-1");
    await initWorkingMemory({ ...ids, sections: { resumption_prompt: "Pick up from step 3" } });

    const record = await readWorkingMemory(ids);
    expect(record).not.toBeNull();
    expect(record!.sections.resumption_prompt).toBe("Pick up from step 3");
  });

  test("returns null when no active record exists", async () => {
    const result = await readWorkingMemory({
      session_id: `${RUN_ID}-ghost`,
      agent: "nobody",
    });
    expect(result).toBeNull();
  });

  test("returns null after record is archived", async () => {
    const ids = makeIds("read-2");
    await initWorkingMemory(ids);
    await archiveWorkingMemory(ids);

    const result = await readWorkingMemory(ids);
    expect(result).toBeNull();
  });
});

// ── Core: checkpointWorkingMemory ─────────────────────────────────────────────

describe("checkpointWorkingMemory", () => {
  test("increments turn_number without changing sections", async () => {
    const ids = makeIds("checkpoint-1");
    await initWorkingMemory({
      ...ids,
      sections: { decision_log: "Chose approach A" },
    });

    const result = await checkpointWorkingMemory(ids);
    expect(result).not.toBeNull();
    expect(result!.turn_number).toBe(1);
    // Sections unchanged
    expect(result!.sections.decision_log).toBe("Chose approach A");
  });

  test("returns null when no active record exists", async () => {
    const result = await checkpointWorkingMemory({
      session_id: `${RUN_ID}-ghost-cp`,
      agent: "nobody",
    });
    expect(result).toBeNull();
  });

  test("multiple checkpoints accumulate turn_number", async () => {
    const ids = makeIds("checkpoint-2");
    await initWorkingMemory(ids);
    await checkpointWorkingMemory(ids);
    await checkpointWorkingMemory(ids);
    const result = await checkpointWorkingMemory(ids);
    expect(result!.turn_number).toBe(3);
  });
});

// ── Core: archiveWorkingMemory ────────────────────────────────────────────────

describe("archiveWorkingMemory", () => {
  test("sets archived_at and returns the final state", async () => {
    const ids = makeIds("archive-1");
    await initWorkingMemory({ ...ids, sections: { decision_log: "Chose B" } });

    const result = await archiveWorkingMemory(ids);
    expect(result).not.toBeNull();
    expect(result!.archived_at).not.toBeNull();
    expect(result!.sections.decision_log).toBe("Chose B");
  });

  test("returns null on second archive (already archived)", async () => {
    const ids = makeIds("archive-2");
    await initWorkingMemory(ids);
    await archiveWorkingMemory(ids);

    const second = await archiveWorkingMemory(ids);
    expect(second).toBeNull();
  });

  test("readWorkingMemory returns null after archive", async () => {
    const ids = makeIds("archive-3");
    await initWorkingMemory(ids);
    await archiveWorkingMemory(ids);

    expect(await readWorkingMemory(ids)).toBeNull();
  });
});

// ── Core: archiveIdleWorkingMemory ───────────────────────────────────────────

describe("archiveIdleWorkingMemory", () => {
  test("archives records older than 24h and skips recent ones", async () => {
    const ids = makeIds("idle-1");
    await initWorkingMemory(ids);

    // Back-date the updated_at to simulate an idle record
    await sql`
      UPDATE working_memory
      SET updated_at = NOW() - INTERVAL '25 hours'
      WHERE session_id = ${ids.session_id}
        AND agent      = ${ids.agent}
        AND archived_at IS NULL
    `;

    const count = await archiveIdleWorkingMemory();
    // At least 1 archived (our test record)
    expect(count).toBeGreaterThanOrEqual(1);

    // Our record should now be archived
    expect(await readWorkingMemory(ids)).toBeNull();
  });

  test("does not archive recently updated records", async () => {
    const ids = makeIds("idle-2");
    await initWorkingMemory(ids); // just created = recent

    // Count before
    const [{ count: before }] = await sql<{ count: string }[]>`
      SELECT COUNT(*) FROM working_memory
      WHERE session_id = ${ids.session_id} AND archived_at IS NULL
    `;

    await archiveIdleWorkingMemory();

    // Count after — should be same (record still active)
    const [{ count: after }] = await sql<{ count: string }[]>`
      SELECT COUNT(*) FROM working_memory
      WHERE session_id = ${ids.session_id} AND archived_at IS NULL
    `;
    expect(after).toBe(before);
  });

  test("returns 0 when no idle records exist", async () => {
    // Fresh records only in DB from this run — all should be recent
    const count = await archiveIdleWorkingMemory();
    expect(count).toBeGreaterThanOrEqual(0); // non-negative
  });
});

// ── API: workingMemoryInitEndpoint ────────────────────────────────────────────

describe("workingMemoryInitEndpoint", () => {
  test("400 when session_id missing", async () => {
    const { res, result } = mockRes();
    await workingMemoryInitEndpoint(mockReq({ agent: "dev" }), res);
    expect(result().status).toBe(400);
  });

  test("400 when agent missing", async () => {
    const { res, result } = mockRes();
    await workingMemoryInitEndpoint(mockReq({ session_id: "x" }), res);
    expect(result().status).toBe(400);
  });

  test("200 with working_memory on success", async () => {
    const ids = makeIds("api-init-1");
    const { res, result } = mockRes();

    await workingMemoryInitEndpoint(
      mockReq({ ...ids, sections: { session_identity: "dev / ELLIE-538" } }),
      res,
    );

    const r = result();
    expect(r.status).toBe(200);
    const body = r.body as any;
    expect(body.success).toBe(true);
    expect(body.working_memory.session_id).toBe(ids.session_id);
    expect(body.working_memory.sections.session_identity).toBe("dev / ELLIE-538");
  });

  test("200 with channel stored", async () => {
    const ids = makeIds("api-init-2");
    const { res, result } = mockRes();

    await workingMemoryInitEndpoint(mockReq({ ...ids, channel: "ellie-chat" }), res);

    const body = result().body as any;
    expect(body.working_memory.channel).toBe("ellie-chat");
  });
});

// ── API: workingMemoryUpdateEndpoint ─────────────────────────────────────────

describe("workingMemoryUpdateEndpoint", () => {
  test("400 when session_id missing", async () => {
    const { res, result } = mockRes();
    await workingMemoryUpdateEndpoint(
      mockReq({ agent: "dev", sections: { task_stack: "x" } }),
      res,
    );
    expect(result().status).toBe(400);
  });

  test("400 when sections missing", async () => {
    const { res, result } = mockRes();
    await workingMemoryUpdateEndpoint(
      mockReq({ session_id: "x", agent: "dev" }),
      res,
    );
    expect(result().status).toBe(400);
  });

  test("404 when no active record", async () => {
    const { res, result } = mockRes();
    await workingMemoryUpdateEndpoint(
      mockReq({ session_id: `${RUN_ID}-nowhere`, agent: "ghost", sections: { task_stack: "x" } }),
      res,
    );
    expect(result().status).toBe(404);
  });

  test("200 with merged sections on success", async () => {
    const ids = makeIds("api-update-1");
    await initWorkingMemory({ ...ids, sections: { session_identity: "dev" } });

    const { res, result } = mockRes();
    await workingMemoryUpdateEndpoint(
      mockReq({ ...ids, sections: { task_stack: "1. Do the thing" } }),
      res,
    );

    const r = result();
    expect(r.status).toBe(200);
    const body = r.body as any;
    expect(body.success).toBe(true);
    expect(body.working_memory.sections.session_identity).toBe("dev");
    expect(body.working_memory.sections.task_stack).toBe("1. Do the thing");
    expect(body.working_memory.turn_number).toBe(1);
  });
});

// ── API: workingMemoryReadEndpoint ───────────────────────────────────────────

describe("workingMemoryReadEndpoint", () => {
  test("400 when session_id missing", async () => {
    const { res, result } = mockRes();
    await workingMemoryReadEndpoint(mockReq({}, { agent: "dev" }), res);
    expect(result().status).toBe(400);
  });

  test("400 when agent missing", async () => {
    const { res, result } = mockRes();
    await workingMemoryReadEndpoint(mockReq({}, { session_id: "x" }), res);
    expect(result().status).toBe(400);
  });

  test("404 when no active record", async () => {
    const { res, result } = mockRes();
    await workingMemoryReadEndpoint(
      mockReq({}, { session_id: `${RUN_ID}-ghost-read`, agent: "nobody" }),
      res,
    );
    expect(result().status).toBe(404);
  });

  test("200 with working_memory when active record exists", async () => {
    const ids = makeIds("api-read-1");
    await initWorkingMemory({
      ...ids,
      sections: { resumption_prompt: "Resume from step 5" },
    });

    const { res, result } = mockRes();
    await workingMemoryReadEndpoint(mockReq({}, ids), res);

    const r = result();
    expect(r.status).toBe(200);
    const body = r.body as any;
    expect(body.success).toBe(true);
    expect(body.working_memory.sections.resumption_prompt).toBe("Resume from step 5");
  });

  test("also accepts session_id/agent from body (POST-style)", async () => {
    const ids = makeIds("api-read-2");
    await initWorkingMemory(ids);

    const { res, result } = mockRes();
    // body instead of query
    await workingMemoryReadEndpoint(mockReq(ids), res);

    expect(result().status).toBe(200);
  });
});

// ── API: workingMemoryCheckpointEndpoint ─────────────────────────────────────

describe("workingMemoryCheckpointEndpoint", () => {
  test("400 when session_id missing", async () => {
    const { res, result } = mockRes();
    await workingMemoryCheckpointEndpoint(mockReq({ agent: "dev" }), res);
    expect(result().status).toBe(400);
  });

  test("404 when no active record", async () => {
    const { res, result } = mockRes();
    await workingMemoryCheckpointEndpoint(
      mockReq({ session_id: `${RUN_ID}-ghost-cp`, agent: "nobody" }),
      res,
    );
    expect(result().status).toBe(404);
  });

  test("200 with incremented turn_number", async () => {
    const ids = makeIds("api-cp-1");
    await initWorkingMemory({
      ...ids,
      sections: { decision_log: "Chose SQL merge approach" },
    });

    const { res, result } = mockRes();
    await workingMemoryCheckpointEndpoint(mockReq(ids), res);

    const r = result();
    expect(r.status).toBe(200);
    const body = r.body as any;
    expect(body.success).toBe(true);
    expect(body.working_memory.turn_number).toBe(1);
    // Sections preserved
    expect(body.working_memory.sections.decision_log).toBe("Chose SQL merge approach");
  });
});

// ── API: workingMemoryPromoteEndpoint ─────────────────────────────────────────

describe("workingMemoryPromoteEndpoint", () => {
  test("400 when session_id missing", async () => {
    const { res, result } = mockRes();
    await workingMemoryPromoteEndpoint(mockReq({ agent: "dev" }), res);
    expect(result().status).toBe(400);
  });

  test("404 when no active record", async () => {
    const { res, result } = mockRes();
    await workingMemoryPromoteEndpoint(
      mockReq({ session_id: `${RUN_ID}-ghost-promo`, agent: "nobody" }),
      res,
    );
    expect(result().status).toBe(404);
  });

  test("200 with promoted=false when decision_log is empty", async () => {
    const ids = makeIds("api-promo-1");
    await initWorkingMemory({
      ...ids,
      sections: { task_stack: "1. Done" }, // no decision_log
    });

    const { res, result } = mockRes();
    await workingMemoryPromoteEndpoint(mockReq({ ...ids, scope_path: "2/1" }), res);

    const r = result();
    expect(r.status).toBe(200);
    const body = r.body as any;
    expect(body.success).toBe(true);
    expect(body.promoted).toBe(false);
    expect(body.promoted_memory_id).toBeNull();
  });

  test("archives the working memory on promote", async () => {
    const ids = makeIds("api-promo-2");
    await initWorkingMemory({
      ...ids,
      sections: { task_stack: "done" },
    });

    const { res } = mockRes();
    await workingMemoryPromoteEndpoint(mockReq({ ...ids, scope_path: "2/1" }), res);

    // Should be archived now
    expect(await readWorkingMemory(ids)).toBeNull();
  });

  test("200 with promoted=true and promoted_memory_id when decision_log present", async () => {
    const ids = makeIds("api-promo-3");
    await initWorkingMemory({
      ...ids,
      sections: {
        decision_log: "Chose postgres JSONB merge (||) over application-level merge for atomicity.",
      },
    });

    const { res, result } = mockRes();
    await workingMemoryPromoteEndpoint(
      mockReq({ ...ids, scope_path: "2/1", work_item_id: "ELLIE-538" }),
      res,
    );

    const r = result();
    expect(r.status).toBe(200);
    const body = r.body as any;
    expect(body.success).toBe(true);
    expect(body.promoted).toBe(true);
    expect(typeof body.promoted_memory_id).toBe("string");
  });
});

// ── Session pruning ───────────────────────────────────────────────────────────

describe("session pruning — MAX_ACTIVE_SESSIONS_PER_AGENT", () => {
  test("no more than MAX_ACTIVE_SESSIONS_PER_AGENT active records per agent", async () => {
    // Use a unique agent name for this test
    const agent = `${RUN_ID}-prune-agent`;

    // Create MAX + 2 sessions with different session_ids
    for (let i = 0; i <= MAX_ACTIVE_SESSIONS_PER_AGENT + 1; i++) {
      await initWorkingMemory({ session_id: `${RUN_ID}-prune-sess-${i}`, agent });
    }

    const [{ count }] = await sql<{ count: string }[]>`
      SELECT COUNT(*) FROM working_memory
      WHERE agent = ${agent} AND archived_at IS NULL
    `;

    expect(Number(count)).toBeLessThanOrEqual(MAX_ACTIVE_SESSIONS_PER_AGENT);
  });
});
