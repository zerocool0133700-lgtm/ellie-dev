/**
 * ELLIE-94 — Relay-side integration tests for work session API handlers.
 *
 * Tests the full lifecycle: start → update → decision → complete, plus pause/resume.
 * Runs against the live relay (http://localhost:3001) and real forest DB.
 * Cleans up test data after each run.
 */
import { describe, test, expect, afterAll } from "bun:test"
import sql from '../../ellie-forest/src/db'

const RELAY = process.env.RELAY_URL || "http://localhost:3001"

// Track trees created so we can clean up
const testTreeIds: string[] = []

async function post(path: string, body: Record<string, any>) {
  const res = await fetch(`${RELAY}/api/work-session/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return {
    status: res.status,
    data: await res.json() as Record<string, any>,
  }
}

// ── Cleanup ─────────────────────────────────────────────────

afterAll(async () => {
  if (testTreeIds.length === 0) return
  // Clean in reverse dependency order
  await sql`DELETE FROM shared_memories WHERE source_tree_id = ANY(${testTreeIds})`
  await sql`DELETE FROM forest_events WHERE tree_id = ANY(${testTreeIds})`
  await sql`DELETE FROM creatures WHERE tree_id = ANY(${testTreeIds})`
  await sql`UPDATE branches SET head_commit_id = NULL WHERE tree_id = ANY(${testTreeIds})`
  await sql`UPDATE trunks SET head_commit_id = NULL WHERE tree_id = ANY(${testTreeIds})`
  await sql`DELETE FROM commits WHERE tree_id = ANY(${testTreeIds})`
  await sql`DELETE FROM branches WHERE tree_id = ANY(${testTreeIds})`
  await sql`DELETE FROM trunks WHERE tree_id = ANY(${testTreeIds})`
  await sql`DELETE FROM tree_entities WHERE tree_id = ANY(${testTreeIds})`
  await sql`DELETE FROM trees WHERE id = ANY(${testTreeIds})`
})

// ── startWorkSession ──────────────────────────────────────────

describe("POST /api/work-session/start", () => {
  test("creates session and returns tree_id", async () => {
    const { status, data } = await post("start", {
      work_item_id: "TEST-E94-1",
      title: "ELLIE-94 Test Session",
      project: "ellie-dev",
      agent: "dev",
    })

    expect(status).toBe(200)
    expect(data.success).toBe(true)
    expect(data.session_id).toBeDefined()
    expect(data.tree_id).toBeDefined()
    expect(data.work_item_id).toBe("TEST-E94-1")
    testTreeIds.push(data.tree_id)
  })

  test("deduplicates — same work_item_id resumes existing session", async () => {
    const { data: first } = await post("start", {
      work_item_id: "TEST-E94-1",
      title: "ELLIE-94 Test Session",
      project: "ellie-dev",
    })
    // Same work_item_id should return the same tree
    expect(first.success).toBe(true)
    expect(testTreeIds).toContain(first.tree_id)
  })

  test("rejects missing required fields", async () => {
    const { status, data } = await post("start", {
      work_item_id: "TEST-E94-BAD",
    })

    expect(status).toBe(400)
    expect(data.error).toBeDefined()
  })
})

// ── updateWorkSession ─────────────────────────────────────────

describe("POST /api/work-session/update", () => {
  test("logs progress update to session", async () => {
    const { status, data } = await post("update", {
      work_item_id: "TEST-E94-1",
      message: "Completed phase 1 of implementation",
    })

    expect(status).toBe(200)
    expect(data.success).toBe(true)
    expect(data.session_id).toBeDefined()
  })

  test("rejects missing message", async () => {
    const { status, data } = await post("update", {
      work_item_id: "TEST-E94-1",
    })

    expect(status).toBe(400)
    expect(data.error).toBeDefined()
  })

  test("returns 404 for unknown work_item_id", async () => {
    const { status, data } = await post("update", {
      work_item_id: "TEST-NONEXISTENT-999",
      message: "Should fail",
    })

    expect(status).toBe(404)
    expect(data.error).toContain("No active session")
  })
})

// ── logDecision ───────────────────────────────────────────────

describe("POST /api/work-session/decision", () => {
  test("logs decision to session", async () => {
    const { status, data } = await post("decision", {
      work_item_id: "TEST-E94-1",
      message: "Decision: Use integration tests over unit tests for better coverage",
    })

    expect(status).toBe(200)
    expect(data.success).toBe(true)
    expect(data.session_id).toBeDefined()
  })

  test("rejects missing message", async () => {
    const { status, data } = await post("decision", {
      work_item_id: "TEST-E94-1",
    })

    expect(status).toBe(400)
    expect(data.error).toBeDefined()
  })
})

// ── pauseWorkSession & resumeWorkSession ──────────────────────

describe("POST /api/work-session/pause + resume", () => {
  let pauseTreeId: string

  test("pause transitions session to dormant", async () => {
    // Create a dedicated session for pause/resume
    const { data: startData } = await post("start", {
      work_item_id: "TEST-E94-PAUSE",
      title: "ELLIE-94 Pause Test",
      project: "ellie-dev",
    })
    pauseTreeId = startData.tree_id
    testTreeIds.push(pauseTreeId)

    const { status, data } = await post("pause", {
      work_item_id: "TEST-E94-PAUSE",
      reason: "Waiting on design review",
    })

    expect(status).toBe(200)
    expect(data.success).toBe(true)
    expect(data.state).toBe("dormant")
  })

  test("resume transitions dormant session back to growing", async () => {
    const { status, data } = await post("resume", {
      work_item_id: "TEST-E94-PAUSE",
    })

    expect(status).toBe(200)
    expect(data.success).toBe(true)
    expect(data.state).toBe("growing")
  })

  test("resume rejects non-dormant session", async () => {
    // Session is now 'growing' from the resume above
    const { status, data } = await post("resume", {
      work_item_id: "TEST-E94-PAUSE",
    })

    expect(status).toBe(409)
    expect(data.error).toContain("not paused")
  })

  test("pause rejects missing work_item_id", async () => {
    const { status } = await post("pause", {})
    expect(status).toBe(400)
  })

  test("pause returns 404 for unknown session", async () => {
    const { status } = await post("pause", {
      work_item_id: "TEST-NONEXISTENT-999",
    })
    expect(status).toBe(404)
  })
})

// ── completeWorkSession ───────────────────────────────────────

describe("POST /api/work-session/complete", () => {
  test("completes session and returns duration", async () => {
    // Complete the pause test session
    const { status, data } = await post("complete", {
      work_item_id: "TEST-E94-PAUSE",
      summary: "Pause/resume cycle validated",
    })

    expect(status).toBe(200)
    expect(data.success).toBe(true)
    expect(data.duration_minutes).toBeDefined()
    expect(typeof data.duration_minutes).toBe("number")
  })

  test("rejects missing summary", async () => {
    const { status, data } = await post("complete", {
      work_item_id: "TEST-E94-1",
    })

    expect(status).toBe(400)
    expect(data.error).toBeDefined()
  })

  test("completes the main test session", async () => {
    const { status, data } = await post("complete", {
      work_item_id: "TEST-E94-1",
      summary: "All work session integration tests passed",
    })

    expect(status).toBe(200)
    expect(data.success).toBe(true)
  })

  test("returns 200 (idempotent) after session is already completed", async () => {
    const { status, data } = await post("complete", {
      work_item_id: "TEST-E94-1",
      summary: "Should succeed idempotently",
    })

    // completeWorkSession is idempotent — dormant trees are found and returned
    expect(status).toBe(200)
    expect(data.success).toBe(true)
  })
})
