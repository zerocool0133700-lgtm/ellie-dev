/**
 * ELLIE-651 — Test Tier 3: Working Memory (session-scoped context)
 *
 * Deeper lifecycle coverage beyond ELLIE-650's infrastructure checks:
 * - All 7 working memory sections populated and persisted
 * - Full lifecycle: init → populate all sections → checkpoint → promote
 * - Promote-to-Forest verification (decision_log → shared_memories)
 * - Session isolation between different agents
 * - Resumption prompt persistence
 * - Work item ID passthrough to Forest metadata
 */

import { describe, test, expect, afterAll } from "bun:test";
import sql from "../../ellie-forest/src/db";

const WM_API = "http://localhost:3001/api/working-memory";
const BRIDGE_KEY = "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";

const TS = Date.now();
const SESSION_A = `lifecycle-651-a-${TS}`;
const SESSION_B = `lifecycle-651-b-${TS}`;
const AGENT_A = "agent-651-alpha";
const AGENT_B = "agent-651-beta";

// Track promoted memory IDs for cleanup
const promotedMemoryIds: string[] = [];

afterAll(async () => {
  await sql`DELETE FROM working_memory WHERE session_id LIKE ${"lifecycle-651-%-" + TS}`;
  for (const id of promotedMemoryIds) {
    await sql`DELETE FROM shared_memories WHERE id = ${id}`.catch(() => {});
  }
});

// ── Helper ──────────────────────────────────────────────────

async function wmFetch(
  path: string,
  method: string = "GET",
  body?: Record<string, unknown>,
) {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${WM_API}/${path}`, opts);
}

// ── All 7 Sections ──────────────────────────────────────────

describe("Working Memory — All 7 Sections", () => {
  const ALL_SECTIONS = {
    session_identity: "ELLIE-651 lifecycle test | agent-651-alpha | test channel",
    task_stack: "1. [active] Verify all 7 sections\n2. [ ] Test promote\n3. [ ] Test isolation",
    conversation_thread: "User asked to verify working memory lifecycle. Started with section population.",
    investigation_state: "Hypothesis: all sections round-trip through init and update. Testing now.",
    decision_log: "Decision: Test all sections in a single session to verify JSONB merge behavior.",
    context_anchors: "Error: none yet. Key file: src/api/working-memory.ts:216",
    resumption_prompt: "Continue with promote verification after confirming all sections persist.",
  };

  test("init with all 7 sections", async () => {
    const res = await wmFetch("init", "POST", {
      session_id: SESSION_A,
      agent: AGENT_A,
      sections: ALL_SECTIONS,
      channel: "test",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    const wm = data.working_memory;

    // Verify all 7 sections came back
    expect(wm.sections.session_identity).toBe(ALL_SECTIONS.session_identity);
    expect(wm.sections.task_stack).toBe(ALL_SECTIONS.task_stack);
    expect(wm.sections.conversation_thread).toBe(ALL_SECTIONS.conversation_thread);
    expect(wm.sections.investigation_state).toBe(ALL_SECTIONS.investigation_state);
    expect(wm.sections.decision_log).toBe(ALL_SECTIONS.decision_log);
    expect(wm.sections.context_anchors).toBe(ALL_SECTIONS.context_anchors);
    expect(wm.sections.resumption_prompt).toBe(ALL_SECTIONS.resumption_prompt);
  });

  test("read returns all 7 sections", async () => {
    const res = await wmFetch(
      `read?session_id=${SESSION_A}&agent=${AGENT_A}`,
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    const sections = data.working_memory.sections;

    for (const [key, value] of Object.entries(ALL_SECTIONS)) {
      expect(sections[key]).toBe(value);
    }
  });

  test("update merges partial section changes without losing others", async () => {
    const res = await wmFetch("update", "PATCH", {
      session_id: SESSION_A,
      agent: AGENT_A,
      sections: {
        task_stack: "1. [done] Verify all 7 sections\n2. [active] Test promote\n3. [ ] Test isolation",
        investigation_state: "Confirmed: all 7 sections round-trip. Moving to promote test.",
      },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    const sections = data.working_memory.sections;

    // Updated sections should reflect new values
    expect(sections.task_stack).toContain("[done] Verify all 7 sections");
    expect(sections.investigation_state).toContain("Moving to promote test");

    // Untouched sections should be preserved
    expect(sections.session_identity).toBe(ALL_SECTIONS.session_identity);
    expect(sections.decision_log).toBe(ALL_SECTIONS.decision_log);
    expect(sections.context_anchors).toBe(ALL_SECTIONS.context_anchors);
    expect(sections.resumption_prompt).toBe(ALL_SECTIONS.resumption_prompt);
    expect(sections.conversation_thread).toBe(ALL_SECTIONS.conversation_thread);
  });

  test("update can clear a section by setting it to empty string", async () => {
    const res = await wmFetch("update", "PATCH", {
      session_id: SESSION_A,
      agent: AGENT_A,
      sections: {
        investigation_state: "",
      },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.working_memory.sections.investigation_state).toBe("");
    // Other sections still intact
    expect(data.working_memory.sections.decision_log).toBe(ALL_SECTIONS.decision_log);
  });
});

// ── Full Lifecycle: Init → Update → Checkpoint → Promote ────

describe("Working Memory — Full Lifecycle", () => {
  const LIFECYCLE_SESSION = `lifecycle-651-full-${TS}`;
  const LIFECYCLE_AGENT = "agent-651-lifecycle";
  const DECISION_CONTENT = `Decision: Use working_memory table for session context because it supports JSONB merge and survives context compression. Alternatives: Redis (no ACID), file-based (no concurrency). Timestamp: ${TS}`;
  const WORK_ITEM = "ELLIE-651";

  afterAll(async () => {
    await sql`DELETE FROM working_memory WHERE session_id = ${LIFECYCLE_SESSION}`;
  });

  test("step 1: init a fresh session", async () => {
    const res = await wmFetch("init", "POST", {
      session_id: LIFECYCLE_SESSION,
      agent: LIFECYCLE_AGENT,
      sections: {
        session_identity: `${WORK_ITEM} lifecycle test`,
      },
      channel: "test",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.working_memory.turn_number).toBe(0);
    expect(data.working_memory.sections.session_identity).toContain(WORK_ITEM);
  });

  test("step 2: populate all sections via sequential updates", async () => {
    // First update: task + conversation
    await wmFetch("update", "PATCH", {
      session_id: LIFECYCLE_SESSION,
      agent: LIFECYCLE_AGENT,
      sections: {
        task_stack: "1. [active] Full lifecycle\n2. [ ] Verify promote",
        conversation_thread: "Started lifecycle test. Populating sections incrementally.",
      },
    });

    // Second update: investigation + decisions + anchors
    await wmFetch("update", "PATCH", {
      session_id: LIFECYCLE_SESSION,
      agent: LIFECYCLE_AGENT,
      sections: {
        investigation_state: "Testing incremental section population via PATCH.",
        decision_log: DECISION_CONTENT,
        context_anchors: "promote endpoint: working-memory.ts:216-277",
      },
    });

    // Third update: resumption prompt
    const res = await wmFetch("update", "PATCH", {
      session_id: LIFECYCLE_SESSION,
      agent: LIFECYCLE_AGENT,
      sections: {
        resumption_prompt: "All sections populated. Ready for checkpoint + promote.",
      },
    });

    expect(res.status).toBe(200);
    const sections = (await res.json()).working_memory.sections;

    // All 7 should be present after incremental updates
    expect(sections.session_identity).toContain(WORK_ITEM);
    expect(sections.task_stack).toContain("Full lifecycle");
    expect(sections.conversation_thread).toContain("lifecycle test");
    expect(sections.investigation_state).toContain("incremental");
    expect(sections.decision_log).toContain("JSONB merge");
    expect(sections.context_anchors).toContain("working-memory.ts");
    expect(sections.resumption_prompt).toContain("Ready for checkpoint");
  });

  let turnBeforeCheckpoints: number;

  test("step 3: checkpoint advances turn number", async () => {
    // Read current turn before checkpointing
    const readRes = await wmFetch(`read?session_id=${LIFECYCLE_SESSION}&agent=${LIFECYCLE_AGENT}`);
    turnBeforeCheckpoints = (await readRes.json()).working_memory.turn_number;

    const res = await wmFetch("checkpoint", "POST", {
      session_id: LIFECYCLE_SESSION,
      agent: LIFECYCLE_AGENT,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.working_memory.turn_number).toBe(turnBeforeCheckpoints + 1);
    // Sections should be untouched
    expect(data.working_memory.sections.decision_log).toContain("JSONB merge");
  });

  test("step 4: second checkpoint advances again", async () => {
    const res = await wmFetch("checkpoint", "POST", {
      session_id: LIFECYCLE_SESSION,
      agent: LIFECYCLE_AGENT,
    });

    expect(res.status).toBe(200);
    expect((await res.json()).working_memory.turn_number).toBe(turnBeforeCheckpoints + 2);
  });

  let turnAtPromote: number;

  test("step 5: promote archives session and writes decision_log to Forest", async () => {
    const res = await wmFetch("promote", "POST", {
      session_id: LIFECYCLE_SESSION,
      agent: LIFECYCLE_AGENT,
      scope_path: "2/1",
      work_item_id: WORK_ITEM,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.promoted).toBe(true);
    expect(data.promoted_memory_id).toBeTruthy();

    promotedMemoryIds.push(data.promoted_memory_id);
    turnAtPromote = data.working_memory.turn_number;

    // Verify the archived record has archived_at set
    expect(data.working_memory.archived_at).toBeTruthy();
    // Turn number should reflect the checkpoints
    expect(turnAtPromote).toBe(turnBeforeCheckpoints + 2);
  });

  test("step 6: session is no longer readable after promote", async () => {
    const res = await wmFetch(
      `read?session_id=${LIFECYCLE_SESSION}&agent=${LIFECYCLE_AGENT}`,
    );
    expect(res.status).toBe(404);
  });

  test("step 7: decision_log appears in shared_memories with correct metadata", async () => {
    const memoryId = promotedMemoryIds[promotedMemoryIds.length - 1];
    expect(memoryId).toBeTruthy();

    const [row] = await sql`
      SELECT content, type, confidence, scope_path, metadata
      FROM shared_memories WHERE id = ${memoryId}
    `;

    expect(row).toBeTruthy();
    // Content should contain the decision log prefixed with session info
    expect(row.content).toContain(DECISION_CONTENT);
    expect(row.content).toContain(LIFECYCLE_AGENT);
    expect(row.content).toContain(LIFECYCLE_SESSION);
    // Type should be "decision"
    expect(row.type).toBe("decision");
    // Confidence should be 0.8
    expect(Number(row.confidence)).toBeCloseTo(0.8, 1);
    // Scope should be 2/1 (ellie-dev)
    expect(row.scope_path).toBe("2/1");
    // Metadata should include work_item_id and source
    expect(row.metadata.work_item_id).toBe(WORK_ITEM);
    expect(row.metadata.source).toBe("working_memory_promote");
    expect(row.metadata.agent).toBe(LIFECYCLE_AGENT);
    expect(row.metadata.turn_number).toBe(turnAtPromote);
  });
});

// ── Promote Without Decision Log ────────────────────────────

describe("Working Memory — Promote without decision_log", () => {
  const NO_DECISION_SESSION = `lifecycle-651-nodec-${TS}`;

  afterAll(async () => {
    await sql`DELETE FROM working_memory WHERE session_id = ${NO_DECISION_SESSION}`;
  });

  test("promotes with promoted=false when no decision_log", async () => {
    // Init with no decision_log
    await wmFetch("init", "POST", {
      session_id: NO_DECISION_SESSION,
      agent: AGENT_A,
      sections: {
        session_identity: "No decisions session",
        task_stack: "Just exploring",
      },
    });

    const res = await wmFetch("promote", "POST", {
      session_id: NO_DECISION_SESSION,
      agent: AGENT_A,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.promoted).toBe(false);
    expect(data.promoted_memory_id).toBeNull();
    // Session should still be archived
    expect(data.working_memory.archived_at).toBeTruthy();
  });
});

// ── Session Isolation ───────────────────────────────────────

describe("Working Memory — Session Isolation", () => {
  afterAll(async () => {
    await sql`DELETE FROM working_memory WHERE session_id = ${SESSION_B}`;
  });

  test("different agent on same session_id has separate working memory", async () => {
    // Init session B for agent A (session A already exists from earlier tests)
    await wmFetch("init", "POST", {
      session_id: SESSION_B,
      agent: AGENT_A,
      sections: { session_identity: "Agent A on session B" },
    });

    // Init session B for agent B
    await wmFetch("init", "POST", {
      session_id: SESSION_B,
      agent: AGENT_B,
      sections: { session_identity: "Agent B on session B" },
    });

    // Read agent A
    const resA = await wmFetch(`read?session_id=${SESSION_B}&agent=${AGENT_A}`);
    const dataA = await resA.json();
    expect(dataA.working_memory.sections.session_identity).toBe("Agent A on session B");

    // Read agent B
    const resB = await wmFetch(`read?session_id=${SESSION_B}&agent=${AGENT_B}`);
    const dataB = await resB.json();
    expect(dataB.working_memory.sections.session_identity).toBe("Agent B on session B");
  });

  test("updating one agent does not affect another", async () => {
    await wmFetch("update", "PATCH", {
      session_id: SESSION_B,
      agent: AGENT_A,
      sections: { task_stack: "Agent A's tasks" },
    });

    // Agent B should not have task_stack
    const resB = await wmFetch(`read?session_id=${SESSION_B}&agent=${AGENT_B}`);
    const dataB = await resB.json();
    expect(dataB.working_memory.sections.task_stack).toBeUndefined();
    expect(dataB.working_memory.sections.session_identity).toBe("Agent B on session B");
  });

  test("checkpointing one agent does not affect another's turn", async () => {
    // Read current turns
    const readA = await wmFetch(`read?session_id=${SESSION_B}&agent=${AGENT_A}`);
    const turnA0 = (await readA.json()).working_memory.turn_number;
    const readB = await wmFetch(`read?session_id=${SESSION_B}&agent=${AGENT_B}`);
    const turnB0 = (await readB.json()).working_memory.turn_number;

    // Checkpoint agent A twice
    await wmFetch("checkpoint", "POST", { session_id: SESSION_B, agent: AGENT_A });
    await wmFetch("checkpoint", "POST", { session_id: SESSION_B, agent: AGENT_A });

    // Agent B should be unchanged
    const resB = await wmFetch(`read?session_id=${SESSION_B}&agent=${AGENT_B}`);
    const dataB = await resB.json();
    expect(dataB.working_memory.turn_number).toBe(turnB0);

    // Agent A should be +2
    const resA = await wmFetch(`read?session_id=${SESSION_B}&agent=${AGENT_A}`);
    const dataA = await resA.json();
    expect(dataA.working_memory.turn_number).toBe(turnA0 + 2);
  });

  test("promoting one agent does not affect another", async () => {
    await wmFetch("promote", "POST", {
      session_id: SESSION_B,
      agent: AGENT_A,
    });

    // Agent A is gone
    const resA = await wmFetch(`read?session_id=${SESSION_B}&agent=${AGENT_A}`);
    expect(resA.status).toBe(404);

    // Agent B is still alive
    const resB = await wmFetch(`read?session_id=${SESSION_B}&agent=${AGENT_B}`);
    expect(resB.status).toBe(200);
    const dataB = await resB.json();
    expect(dataB.working_memory.sections.session_identity).toBe("Agent B on session B");
  });
});

// ── Resumption Prompt Persistence ───────────────────────────

describe("Working Memory — Resumption Prompt", () => {
  const RESUME_SESSION = `lifecycle-651-resume-${TS}`;

  afterAll(async () => {
    await sql`DELETE FROM working_memory WHERE session_id = ${RESUME_SESSION}`;
  });

  test("resumption_prompt survives multiple updates to other sections", async () => {
    const RESUME_TEXT = "Continue: verify promote writes to Forest. Check shared_memories for decision type.";

    await wmFetch("init", "POST", {
      session_id: RESUME_SESSION,
      agent: AGENT_A,
      sections: {
        resumption_prompt: RESUME_TEXT,
        session_identity: "Resumption test",
      },
    });

    // Update other sections multiple times
    for (let i = 0; i < 3; i++) {
      await wmFetch("update", "PATCH", {
        session_id: RESUME_SESSION,
        agent: AGENT_A,
        sections: {
          task_stack: `Iteration ${i + 1}`,
          conversation_thread: `Turn ${i + 1} conversation update`,
        },
      });
    }

    // Resumption prompt should be unchanged
    const res = await wmFetch(`read?session_id=${RESUME_SESSION}&agent=${AGENT_A}`);
    const data = await res.json();
    expect(data.working_memory.sections.resumption_prompt).toBe(RESUME_TEXT);
    expect(data.working_memory.sections.task_stack).toBe("Iteration 3");
  });

  test("resumption_prompt can be updated independently", async () => {
    const NEW_RESUME = "New context: all tests passing. Ready for commit.";

    const res = await wmFetch("update", "PATCH", {
      session_id: RESUME_SESSION,
      agent: AGENT_A,
      sections: {
        resumption_prompt: NEW_RESUME,
      },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.working_memory.sections.resumption_prompt).toBe(NEW_RESUME);
    // Other sections preserved
    expect(data.working_memory.sections.task_stack).toBe("Iteration 3");
    expect(data.working_memory.sections.session_identity).toBe("Resumption test");
  });
});

// ── Validation / Edge Cases ─────────────────────────────────

describe("Working Memory — Validation", () => {
  test("init requires session_id", async () => {
    const res = await wmFetch("init", "POST", { agent: AGENT_A });
    expect(res.status).toBe(400);
  });

  test("init requires agent", async () => {
    const res = await wmFetch("init", "POST", { session_id: "test" });
    expect(res.status).toBe(400);
  });

  test("update requires sections", async () => {
    const res = await wmFetch("update", "PATCH", {
      session_id: SESSION_A,
      agent: AGENT_A,
    });
    expect(res.status).toBe(400);
  });

  test("update on non-existent session returns 404", async () => {
    const res = await wmFetch("update", "PATCH", {
      session_id: "nonexistent-651-phantom",
      agent: "ghost",
      sections: { task_stack: "nope" },
    });
    expect(res.status).toBe(404);
  });

  test("checkpoint on non-existent session returns 404", async () => {
    const res = await wmFetch("checkpoint", "POST", {
      session_id: "nonexistent-651-phantom",
      agent: "ghost",
    });
    expect(res.status).toBe(404);
  });

  test("promote on non-existent session returns 404", async () => {
    const res = await wmFetch("promote", "POST", {
      session_id: "nonexistent-651-phantom",
      agent: "ghost",
    });
    expect(res.status).toBe(404);
  });
});

// ── Re-init After Promote ───────────────────────────────────

describe("Working Memory — Re-init After Promote", () => {
  const REINIT_SESSION = `lifecycle-651-reinit-${TS}`;

  afterAll(async () => {
    await sql`DELETE FROM working_memory WHERE session_id = ${REINIT_SESSION}`;
  });

  test("can re-init a session after it was promoted (archived)", async () => {
    // Init
    await wmFetch("init", "POST", {
      session_id: REINIT_SESSION,
      agent: AGENT_A,
      sections: { session_identity: "First run" },
    });

    // Promote (archives it)
    const promoteRes = await wmFetch("promote", "POST", {
      session_id: REINIT_SESSION,
      agent: AGENT_A,
    });
    expect((await promoteRes.json()).success).toBe(true);

    // Should be gone
    const readRes = await wmFetch(`read?session_id=${REINIT_SESSION}&agent=${AGENT_A}`);
    expect(readRes.status).toBe(404);

    // Re-init with fresh data
    const reinitRes = await wmFetch("init", "POST", {
      session_id: REINIT_SESSION,
      agent: AGENT_A,
      sections: { session_identity: "Second run — fresh start" },
    });

    expect(reinitRes.status).toBe(200);
    const data = await reinitRes.json();
    expect(data.working_memory.sections.session_identity).toBe("Second run — fresh start");
    expect(data.working_memory.turn_number).toBe(0);
    // Previous sections should NOT carry over
    expect(data.working_memory.sections.task_stack).toBeUndefined();
  });
});
